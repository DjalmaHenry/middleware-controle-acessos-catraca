import { AccessService } from "./access-service";
import { PhysicalTurnEvent } from "./idsecure-monitor";
import { IntegrationLogger } from "./integration-logger";
import { JsonStore } from "./store";
import { ControlIdDeviceConfig, ControlIdDeviceContact, Settings } from "../shared/types";

const POLL_INTERVAL_MS = 5_000;

interface AccessEvent {
  id: number | string;
  event?: string;
  type?: string;
  device_id?: number | string;
  timestamp?: number | string;
}

type PollingStore = Pick<JsonStore,
  "getControlIdPollingCursor" |
  "saveControlIdPollingCursor" |
  "savePendingPhysicalTurn" |
  "removePendingPhysicalTurn" |
  "hasProcessedControlIdAccess"
>;

export class ControlIdPollingService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly sessions = new Map<string, string>();
  private readonly lastEventIds = new Map<string, number>();
  private readonly lastErrors = new Map<string, { message: string; loggedAt: number }>();

  constructor(
    _accessService: AccessService | unknown,
    private readonly store: PollingStore,
    private readonly getSettings: () => Settings,
    private readonly log: IntegrationLogger,
    private readonly onDeviceContact: (contact: ControlIdDeviceContact) => void = () => undefined,
    private readonly onPhysicalEvent: (deviceName: string, event: PhysicalTurnEvent, sourceId: string) => Promise<boolean> = async () => false,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  start(): void { void this.restart(); }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sessions.clear();
    this.lastEventIds.clear();
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
    const events = await this.loadObjects<AccessEvent>(device, settings, {
      object: "access_events",
      fields: ["id", "event", "type", "device_id", "timestamp"],
      order: ["id", "descending"],
      limit: 50
    });
    const orderedEvents = events
      .filter((event) => Number.isFinite(Number(event.id)))
      .sort((left, right) => Number(left.id) - Number(right.id));
    const event = orderedEvents.at(-1);
    const eventId = Number(event?.id) || 0;
    const key = keyFor(device);
    const previous = this.lastEventIds.get(key) ?? this.store.getControlIdPollingCursor(key);

    const turn = normalizeTurn(event?.type);
    this.registerContact(device, "/load_objects.fcgi (confirmação física)", turn);
    if (previous === undefined) {
      this.lastEventIds.set(key, eventId);
      this.store.saveControlIdPollingCursor(key, eventId);
      this.log("system", `${device.name} conectada para confirmação física`, {
        address: baseUrl(device),
        latestAccessEventId: eventId,
        detail: "As identidades e matrículas são lidas no monitor central do iDSecure."
      });
      return;
    }

    for (const accessEvent of orderedEvents.filter((item) => Number(item.id) > previous)) {
      const physicalEvent = normalizePhysicalEvent(accessEvent.type);
      this.log("device-in", `${device.name}: evento físico observado`, { accessEvent });
      if (physicalEvent) {
        const physicalKey = `${key}:${Number(accessEvent.id)}`;
        const physicalSourceId = `controlid:turn:${physicalKey}`;
        if (this.store.hasProcessedControlIdAccess(physicalSourceId)) {
          this.store.removePendingPhysicalTurn(physicalKey);
          const currentId = Number(accessEvent.id);
          this.lastEventIds.set(key, currentId);
          this.store.saveControlIdPollingCursor(key, currentId);
          continue;
        }
        this.store.savePendingPhysicalTurn({
          key: physicalKey,
          device: device.name,
          eventId: Number(accessEvent.id),
          event: physicalEvent,
          receivedAt: new Date().toISOString()
        });
        if (await this.onPhysicalEvent(device.name, physicalEvent, physicalSourceId)) {
          this.store.removePendingPhysicalTurn(physicalKey);
        }
      }
      const currentId = Number(accessEvent.id);
      this.lastEventIds.set(key, currentId);
      this.store.saveControlIdPollingCursor(key, currentId);
    }
  }

  private async loadObjects<T>(
    device: ControlIdDeviceConfig,
    settings: Settings,
    body: Record<string, unknown>
  ): Promise<T[]> {
    let session = await this.sessionFor(device, settings);
    try {
      return await this.requestObjects<T>(device, session, body);
    } catch (error) {
      if (!isSessionError(error)) throw error;
      this.sessions.delete(keyFor(device));
      session = await this.sessionFor(device, settings);
      return this.requestObjects<T>(device, session, body);
    }
  }

  private async requestObjects<T>(
    device: ControlIdDeviceConfig,
    session: string,
    body: Record<string, unknown>
  ): Promise<T[]> {
    const result = await this.request(
      device,
      `/load_objects.fcgi?session=${encodeURIComponent(session)}`,
      body
    );
    const objectName = String(body.object);
    const objects = result[objectName];
    if (!Array.isArray(objects)) throw new Error(`Resposta inválida de ${device.name}: coleção ${objectName} ausente.`);
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
    turn?: "TURN_LEFT" | "TURN_RIGHT"
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

function baseUrl(device: ControlIdDeviceConfig): string {
  const host = device.host.includes(":") && !device.host.startsWith("[") ? `[${device.host}]` : device.host;
  return `http://${host}:${device.port}`;
}

function keyFor(device: ControlIdDeviceConfig): string { return `${device.host}:${device.port}`; }

function normalizeTurn(value: unknown): "TURN_LEFT" | "TURN_RIGHT" | undefined {
  const normalized = String(value ?? "").trim().replaceAll(" ", "_").toUpperCase();
  return normalized === "TURN_LEFT" || normalized === "TURN_RIGHT" ? normalized : undefined;
}

function normalizePhysicalEvent(value: unknown): PhysicalTurnEvent | undefined {
  const normalized = String(value ?? "").trim().replaceAll(" ", "_").toUpperCase();
  if (normalized === "TURN_LEFT" || normalized === "TURN_RIGHT" || normalized === "GIVE_UP") return normalized;
  return undefined;
}

function isSessionError(error: unknown): boolean {
  return error instanceof Error && /invalid session|sess[aã]o.*inv[aá]lida|sess[aã]o.*expirada/i.test(error.message);
}
