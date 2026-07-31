import { AccessService } from "./access-service";
import { IntegrationLogger } from "./integration-logger";
import { JsonStore } from "./store";
import { ControlIdDeviceConfig, ControlIdDeviceContact, Direction, Settings } from "../shared/types";

const POLL_INTERVAL_MS = 5_000;
const ACCESS_GRACE_SECONDS = 12;
const ACCESS_MAX_WAIT_SECONDS = 60;

interface AccessLog {
  id: number;
  time: number;
  event: number;
  device_id?: number;
  user_id?: number;
}

interface AccessEvent {
  id: number;
  event: string;
  type: "TURN_LEFT" | "TURN_RIGHT" | "GIVE_UP" | string;
  device_id?: number;
  timestamp: number;
}

interface ControlIdUser {
  id: number;
  registration: string;
  name: string;
}

type WhereClause = {
  object: string;
  field: string;
  operator: string;
  value: string | number;
  connector?: string;
};

interface PollingStore {
  getControlIdPollingCursor(deviceKey: string): number | undefined;
  saveControlIdPollingCursor(deviceKey: string, cursor: number): void;
  hasProcessedControlIdAccess(sourceId: string): boolean;
  markProcessedControlIdAccess(sourceId: string): void;
  saveControlIdMapping(userId: number | string, registration: string): void;
}

interface PollingAccessService {
  registerControlIdUser(
    userId: number,
    direction?: Direction,
    occurredAt?: string,
    registration?: string
  ): Promise<unknown>;
}

export class ControlIdPollingService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly sessions = new Map<string, string>();
  private readonly users = new Map<string, ControlIdUser>();
  private readonly lastErrors = new Map<string, { message: string; loggedAt: number }>();

  constructor(
    private readonly accessService: PollingAccessService | AccessService,
    private readonly store: PollingStore | JsonStore,
    private readonly getSettings: () => Settings,
    private readonly log: IntegrationLogger,
    private readonly onDeviceContact: (contact: ControlIdDeviceContact) => void = () => undefined,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  start(): void {
    void this.restart();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sessions.clear();
  }

  async restart(): Promise<void> {
    this.stop();
    await this.pollNow();
    this.timer = setInterval(() => void this.pollNow(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async pollNow(): Promise<void> {
    if (this.running) return;
    const settings = this.getSettings();
    if (settings.controlIdMode !== "polling" || !settings.controlIdPassword) return;

    this.running = true;
    try {
      for (const device of settings.controlIdDevices.filter((item) => item.enabled)) {
        try {
          await this.pollDevice(device, settings);
          this.lastErrors.delete(device.id);
        } catch (error) {
          this.logDeviceError(device, error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollDevice(device: ControlIdDeviceConfig, settings: Settings): Promise<void> {
    const deviceKey = keyFor(device);
    const cursor = this.store.getControlIdPollingCursor(deviceKey);

    if (cursor === undefined) {
      const latest = await this.loadObjects<AccessLog>(device, settings, {
        object: "access_logs",
        fields: ["id"],
        order: ["id", "descending"],
        limit: 1
      }, true);
      const baseline = Number(latest[0]?.id) || 0;
      this.store.saveControlIdPollingCursor(deviceKey, baseline);
      this.registerContact(device, "/load_objects.fcgi (consulta inicial)");
      this.log("system", `${device.name} conectada por consulta ativa`, {
        address: baseUrl(device),
        initialCursor: baseline,
        detail: "O histórico anterior à instalação não será reenviado."
      });
      return;
    }

    const logs = await this.loadObjects<AccessLog>(device, settings, {
      object: "access_logs",
      fields: ["id", "time", "event", "device_id", "user_id"],
      where: where("access_logs", [
        ["id", ">", cursor]
      ]),
      order: ["id", "ascending"],
      limit: 100
    }, false);
    this.registerContact(device, "/load_objects.fcgi (consulta ativa)");

    for (const access of logs.sort((left, right) => left.id - right.id)) {
      if (!Number.isFinite(access.id) || access.id <= cursor) continue;
      const ageSeconds = Math.floor(Date.now() / 1000) - Number(access.time);
      if (ageSeconds < ACCESS_GRACE_SECONDS) break;

      if (access.event !== 7 || !access.user_id) {
        this.store.saveControlIdPollingCursor(deviceKey, access.id);
        continue;
      }

      const sourceId = `poll:${deviceKey}:access:${access.id}`;
      if (this.store.hasProcessedControlIdAccess(sourceId)) {
        this.store.saveControlIdPollingCursor(deviceKey, access.id);
        continue;
      }

      const turn = await this.findTurn(device, settings, access);
      if (!turn) {
        if (ageSeconds < ACCESS_MAX_WAIT_SECONDS) break;
        this.log("error", `${device.name}: acesso sem giro físico confirmado`, {
          accessLog: access,
          detail: "O evento não foi enviado à ActiveSoft."
        });
        this.store.markProcessedControlIdAccess(sourceId);
        this.store.saveControlIdPollingCursor(deviceKey, access.id);
        continue;
      }

      const turnId = `poll:${deviceKey}:turn:${turn.id}`;
      if (turn.type === "GIVE_UP") {
        this.log("system", `${device.name}: desistência de passagem ignorada`, { accessLog: access, accessEvent: turn });
        this.store.markProcessedControlIdAccess(sourceId);
        this.store.markProcessedControlIdAccess(turnId);
        this.store.saveControlIdPollingCursor(deviceKey, access.id);
        continue;
      }

      const user = await this.loadUser(device, settings, Number(access.user_id));
      if (!user.registration?.trim()) {
        throw new Error(`O usuário ${access.user_id} (${user.name || "sem nome"}) não possui matrícula no campo registration.`);
      }

      this.log("device-in", `${device.name}: passagem física confirmada`, {
        accessLog: access,
        accessEvent: turn,
        user: { id: user.id, registration: user.registration, name: user.name }
      });
      this.store.saveControlIdMapping(user.id, user.registration);
      await this.accessService.registerControlIdUser(
        user.id,
        directionForTurn(turn.type, settings),
        new Date(Number(turn.timestamp || access.time) * 1000).toISOString(),
        user.registration
      );
      this.store.markProcessedControlIdAccess(sourceId);
      this.store.markProcessedControlIdAccess(turnId);
      this.store.saveControlIdPollingCursor(deviceKey, access.id);
      this.registerContact(device, "/load_objects.fcgi (giro confirmado)", turn.type);
    }
  }

  private async findTurn(
    device: ControlIdDeviceConfig,
    settings: Settings,
    access: AccessLog
  ): Promise<AccessEvent | undefined> {
    const constraints: Array<[string, string, string | number]> = [
      ["event", "=", "catra"],
      ["timestamp", ">=", Number(access.time) - 2],
      ["timestamp", "<=", Number(access.time) + ACCESS_MAX_WAIT_SECONDS]
    ];
    if (access.device_id) constraints.push(["device_id", "=", access.device_id]);

    const events = await this.loadObjects<AccessEvent>(device, settings, {
      object: "access_events",
      fields: ["id", "event", "type", "device_id", "timestamp"],
      where: where("access_events", constraints),
      order: ["timestamp", "ascending", "id", "ascending"],
      limit: 20
    }, true);
    return events
      .filter((event) => ["TURN_LEFT", "TURN_RIGHT", "GIVE_UP"].includes(String(event.type).toUpperCase()))
      .filter((event) => !this.store.hasProcessedControlIdAccess(`poll:${keyFor(device)}:turn:${event.id}`))
      .sort((left, right) => {
        const leftAfter = left.timestamp >= access.time ? 0 : 1;
        const rightAfter = right.timestamp >= access.time ? 0 : 1;
        return leftAfter - rightAfter || Math.abs(left.timestamp - access.time) - Math.abs(right.timestamp - access.time);
      })[0];
  }

  private async loadUser(device: ControlIdDeviceConfig, settings: Settings, userId: number): Promise<ControlIdUser> {
    const cacheKey = `${keyFor(device)}:${userId}`;
    const cached = this.users.get(cacheKey);
    if (cached) return cached;
    const users = await this.loadObjects<ControlIdUser>(device, settings, {
      object: "users",
      fields: ["id", "registration", "name"],
      where: where("users", [["id", "=", userId]]),
      limit: 1
    }, true);
    const user = users[0];
    if (!user) throw new Error(`Usuário Control iD ${userId} não encontrado em ${device.name}.`);
    this.users.set(cacheKey, user);
    return user;
  }

  private async loadObjects<T>(
    device: ControlIdDeviceConfig,
    settings: Settings,
    body: Record<string, unknown>,
    logTraffic: boolean
  ): Promise<T[]> {
    let session = await this.sessionFor(device, settings);
    try {
      return await this.requestObjects<T>(device, session, body, logTraffic);
    } catch (error) {
      if (!isSessionError(error)) throw error;
      this.sessions.delete(keyFor(device));
      session = await this.sessionFor(device, settings);
      return this.requestObjects<T>(device, session, body, logTraffic);
    }
  }

  private async requestObjects<T>(
    device: ControlIdDeviceConfig,
    session: string,
    body: Record<string, unknown>,
    logTraffic: boolean
  ): Promise<T[]> {
    const pathname = "/load_objects.fcgi";
    if (logTraffic) this.log("device-out", `Ponte ID → ${device.name} ${pathname}`, body);
    const result = await this.request(device, `${pathname}?session=${encodeURIComponent(session)}`, body);
    const objectName = String(body.object);
    const objects = result[objectName];
    if (!Array.isArray(objects)) throw new Error(`Resposta inválida de ${device.name}: coleção ${objectName} ausente.`);
    if (logTraffic) this.log("device-in", `${device.name} → Ponte ID ${pathname}`, result);
    return objects as T[];
  }

  private async sessionFor(device: ControlIdDeviceConfig, settings: Settings): Promise<string> {
    const key = keyFor(device);
    const current = this.sessions.get(key);
    if (current) return current;

    this.log("device-out", `Ponte ID → ${device.name} /login.fcgi`, {
      address: baseUrl(device),
      login: settings.controlIdUsername,
      password: "[PROTEGIDO]"
    });
    const result = await this.request(device, "/login.fcgi", {
      login: settings.controlIdUsername,
      password: settings.controlIdPassword
    });
    if (typeof result.session !== "string" || !result.session) {
      throw new Error(`Login recusado por ${device.name}: sessão não retornada.`);
    }
    this.sessions.set(key, result.session);
    this.log("device-in", `${device.name} autenticada`, { address: baseUrl(device), session: "[PROTEGIDA]" });
    return result.session;
  }

  private async request(
    device: ControlIdDeviceConfig,
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${baseUrl(device)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000)
    });
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      throw new Error(`${device.name} retornou conteúdo inválido (HTTP ${response.status}).`);
    }
    if (!response.ok || payload.error) {
      const detail = typeof payload.error === "string"
        ? payload.error
        : JSON.stringify(payload.error ?? payload);
      throw new Error(`${device.name} respondeu HTTP ${response.status}: ${detail}`);
    }
    return payload;
  }

  private registerContact(
    device: ControlIdDeviceConfig,
    path: string,
    turn?: string
  ): void {
    this.onDeviceContact({
      key: `poll:${keyFor(device)}`,
      lastSeenAt: new Date().toISOString(),
      path,
      remoteAddress: device.host,
      deviceId: device.id,
      observedTurn: turn === "TURN_LEFT" ? "left" : turn === "TURN_RIGHT" ? "right" : undefined
    });
  }

  private logDeviceError(device: ControlIdDeviceConfig, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const previous = this.lastErrors.get(device.id);
    const now = Date.now();
    if (previous?.message === message && now - previous.loggedAt < 60_000) return;
    this.lastErrors.set(device.id, { message, loggedAt: now });
    this.log("error", `Falha ao consultar ${device.name}`, {
      address: baseUrl(device),
      message,
      suggestion: "Confirme IP, porta, usuário, senha e se este computador alcança a rede da catraca."
    });
  }
}

function where(object: string, values: Array<[string, string, string | number]>): WhereClause[] {
  return values.map(([field, operator, value], index) => ({
    object,
    field,
    operator,
    value,
    ...(index < values.length - 1 ? { connector: ") AND (" } : {})
  }));
}

function directionForTurn(turn: string, settings: Settings): Direction {
  if (turn === "TURN_LEFT") return settings.turnLeftDirection;
  if (turn === "TURN_RIGHT") return settings.turnRightDirection;
  return settings.direction;
}

function keyFor(device: ControlIdDeviceConfig): string {
  return `${device.host}:${device.port}`;
}

function baseUrl(device: ControlIdDeviceConfig): string {
  return `http://${device.host}:${device.port}`;
}

function isSessionError(error: unknown): boolean {
  return /session|sessão|invalid.*token|not logged/i.test(error instanceof Error ? error.message : String(error));
}
