import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { AccessService } from "./access-service";
import { IntegrationLogger } from "./integration-logger";
import { JsonStore } from "./store";
import { Direction, PendingIdSecureAccess, PendingPhysicalTurn, Settings } from "../shared/types";
import { detectImageMime } from "./photo-service";

const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const PHYSICAL_CONFIRMATION_WINDOW_MS = 60_000;

export type PhysicalTurnEvent = "TURN_LEFT" | "TURN_RIGHT" | "GIVE_UP";

interface IdSecureAccess {
  idLog: number | string;
  eventCode: number | string;
  eventName?: string;
  idUser?: number | string;
  name?: string;
  device?: string;
  info?: string;
  time?: string;
  ipCamera?: string;
  [key: string]: unknown;
}

interface IdSecureUser {
  id?: number | string;
  idDevice?: number | string;
  name?: string;
  registration?: number | string;
  [key: string]: unknown;
}

interface MonitorResponse {
  data?: IdSecureAccess[];
  error?: unknown;
}

interface UserResponse {
  data?: IdSecureUser[];
  error?: unknown;
}

interface LoginResponse {
  accessToken?: string;
  error?: unknown;
}

export interface IdSecureMonitorStatus {
  status: "unknown" | "online" | "offline";
  lastSeenAt?: string;
  message?: string;
}

interface MonitorStore {
  getIdSecureMonitorCursor(): number | undefined;
  saveIdSecureMonitorCursor(cursor: number): void;
  getPendingIdSecureAccesses(): PendingIdSecureAccess[];
  savePendingIdSecureAccess(access: PendingIdSecureAccess): void;
  removePendingIdSecureAccess(idLog: number): void;
  getPendingPhysicalTurns(): PendingPhysicalTurn[];
  removePendingPhysicalTurn(key: string): void;
  hasProcessedControlIdAccess(sourceId: string): boolean;
  markProcessedControlIdAccess(sourceId: string): void;
  saveControlIdMapping(userId: number | string, registration: string): void;
}

interface MonitorAccessService {
  registerControlIdUser(
    userId: number,
    direction?: Direction,
    occurredAt?: string,
    registration?: string,
    sourceId?: string,
    photoContext?: {
      idSecurePhotoPath?: string;
      controlIdUserId?: number;
      controlIdDeviceName?: string;
    }
  ): Promise<unknown>;
  recordUnlinkedControlIdUser?(
    userId: number,
    studentName: string | undefined,
    direction: Direction,
    occurredAt: string,
    sourceId: string,
    message: string,
    photoContext?: {
      idSecurePhotoPath?: string;
      controlIdUserId?: number;
      controlIdDeviceName?: string;
    }
  ): unknown;
}

export interface JsonRequestOptions {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export type JsonRequester = (url: URL, options: JsonRequestOptions) => Promise<{
  status: number;
  body: Record<string, unknown>;
}>;

export type BinaryRequester = (url: URL, headers: Record<string, string>, timeoutMs?: number) => Promise<{
  status: number;
  body: Buffer;
}>;

export class IdSecureMonitorService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private readonly users = new Map<string, IdSecureUser>();
  private lastError?: { message: string; loggedAt: number };
  private lastIdleLogAt = 0;
  private processingPending = false;
  private readonly photoCache = new Map<string, { value: string | null; expiresAt: number }>();

  constructor(
    private readonly accessService: MonitorAccessService | AccessService,
    private readonly store: MonitorStore | JsonStore,
    private readonly getSettings: () => Settings,
    private readonly log: IntegrationLogger,
    private readonly onStatus: (status: IdSecureMonitorStatus) => void = () => undefined,
    private readonly onDirection: (direction: Direction) => void = () => undefined,
    private readonly requester: JsonRequester = defaultJsonRequester,
    private readonly binaryRequester: BinaryRequester = defaultBinaryRequester
  ) {}

  async resolveAccessPhoto(photoPath?: string): Promise<string | null> {
    if (!photoPath) return null;
    const settings = this.getSettings();
    let url: URL;
    try {
      url = idSecureImageUrl(settings.idSecureBaseUrl, photoPath);
    } catch (error) {
      this.log("error", "Caminho de foto inválido recebido do iDSecure", {
        path: photoPath,
        message: error instanceof Error ? error.message : String(error)
      });
      return null;
    }

    const cacheKey = url.toString();
    const cached = this.photoCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) this.photoCache.delete(cacheKey);

    try {
      let token = await this.tokenFor(settings);
      let response = await this.requestPhoto(url, token);
      if (response.status === 401) {
        this.clearToken();
        token = await this.tokenFor(settings);
        response = await this.requestPhoto(url, token);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Servidor respondeu HTTP ${response.status}.`);
      }
      const mime = detectImageMime(response.body);
      if (!mime) throw new Error("O conteúdo recebido não é uma imagem compatível.");
      const value = `data:${mime};base64,${response.body.toString("base64")}`;
      this.photoCache.set(cacheKey, { value, expiresAt: Date.now() + 6 * 60 * 60_000 });
      trimPhotoCache(this.photoCache);
      return value;
    } catch (error) {
      this.photoCache.set(cacheKey, { value: null, expiresAt: Date.now() + 30_000 });
      trimPhotoCache(this.photoCache);
      this.log("error", "Não foi possível obter a foto do acesso no iDSecure", {
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  async restart(): Promise<void> {
    this.stop();
    await this.pollNow();
    this.timer = setInterval(() => void this.pollNow(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.accessToken = undefined;
    this.tokenExpiresAt = 0;
  }

  async testConnection(): Promise<void> {
    const settings = this.getSettings();
    this.validateSettings(settings);
    const token = await this.tokenFor(settings);
    await this.loadMonitorWithRetry(settings, token, this.store.getIdSecureMonitorCursor() ?? 0);
    this.online("Login e consulta do monitor confirmados.");
  }

  async handlePhysicalTurn(deviceName: string, event: PhysicalTurnEvent, physicalSourceId?: string): Promise<boolean> {
    const now = Date.now();
    const normalizedDevice = normalizeDeviceName(deviceName);
    const pending = this.store.getPendingIdSecureAccesses()
      .filter((access) => access.awaitingTurn)
      .filter((access) => normalizeDeviceName(access.device) === normalizedDevice)
      .filter((access) => !access.receivedAt || now - Date.parse(access.receivedAt) <= PHYSICAL_CONFIRMATION_WINDOW_MS)
      .sort((left, right) => Date.parse(left.receivedAt ?? "") - Date.parse(right.receivedAt ?? "") || left.idLog - right.idLog)[0];
    if (!pending) return false;

    const sourceId = `idsecure:log:${pending.idLog}`;
    if (event === "GIVE_UP") {
      this.store.markProcessedControlIdAccess(sourceId);
      this.store.removePendingIdSecureAccess(pending.idLog);
      if (physicalSourceId) this.store.markProcessedControlIdAccess(physicalSourceId);
      this.log("system", "Acesso liberado cancelado por desistência", {
        idLog: pending.idLog,
        idUser: pending.userId,
        device: deviceName
      });
      return true;
    }

    const settings = this.getSettings();
    const direction = directionForTurn(event, settings);
    this.store.savePendingIdSecureAccess({
      ...pending,
      awaitingTurn: false,
      info: direction === "E" ? "Entrada" : "Saída"
    });
    this.log("system", "Giro físico associado ao acesso do iDSecure", {
      idLog: pending.idLog,
      idUser: pending.userId,
      device: deviceName,
      turn: event,
      direction
    });
    await this.processPending(settings);
    if (physicalSourceId) this.store.markProcessedControlIdAccess(physicalSourceId);
    return true;
  }

  async pollNow(): Promise<void> {
    if (this.running) return;
    const settings = this.getSettings();
    if (!settings.idSecureUsername || !settings.idSecurePassword) {
      this.onStatus({ status: "unknown", message: "Informe as credenciais do painel iDSecure." });
      return;
    }

    this.running = true;
    try {
      await this.poll(settings);
      this.lastError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onStatus({ status: "offline", message });
      const now = Date.now();
      if (!this.lastError || this.lastError.message !== message || now - this.lastError.loggedAt >= 60_000) {
        this.lastError = { message, loggedAt: now };
        this.log("error", "Falha ao consultar o monitor do iDSecure", {
          address: settings.idSecureBaseUrl,
          message,
          suggestion: "Confirme o endereço e as credenciais do painel geral iDSecure."
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async poll(settings: Settings): Promise<void> {
    const cursor = this.store.getIdSecureMonitorCursor();
    const token = await this.tokenFor(settings);
    const accesses = await this.loadMonitorWithRetry(settings, token, cursor ?? 0);
    this.online("Monitor de acessos sendo consultado.");

    if (cursor === undefined) {
      const baseline = accesses.reduce((latest, access) => Math.max(latest, Number(access.idLog) || 0), 0);
      this.store.saveIdSecureMonitorCursor(baseline);
      this.log("system", "Monitor iDSecure conectado", {
        address: originFor(settings.idSecureBaseUrl),
        initialCursor: baseline,
        detail: "O histórico anterior à conexão não será reenviado."
      });
      await this.processPending(settings);
      return;
    }

    for (const access of accesses.sort((left, right) => Number(left.idLog) - Number(right.idLog))) {
      const idLog = Number(access.idLog);
      if (!Number.isFinite(idLog) || idLog <= cursor) continue;
      const sourceId = `idsecure:log:${idLog}`;
      if (this.store.hasProcessedControlIdAccess(sourceId)) {
        this.store.saveIdSecureMonitorCursor(idLog);
        continue;
      }

      this.log("device-in", `iDSecure: ${access.eventName || eventName(access.eventCode)}`, {
        idLog,
        eventCode: Number(access.eventCode),
        idUser: Number(access.idUser) || 0,
        name: access.name || null,
        device: access.device || null,
        direction: access.info || null,
        photoAvailable: Boolean(access.ipCamera),
        occurredAt: parseIdSecureDate(access.time)
      });

      const code = Number(access.eventCode);
      const awaitingTurn = code === 7 || (code === 8 && isReleased(access.info));
      if ((code !== 7 && !awaitingTurn) || !Number(access.idUser)) {
        this.store.markProcessedControlIdAccess(sourceId);
        this.store.saveIdSecureMonitorCursor(idLog);
        continue;
      }

      this.store.savePendingIdSecureAccess({
        idLog,
        userId: Number(access.idUser),
        name: access.name,
        device: access.device,
        photoPath: typeof access.ipCamera === "string" ? access.ipCamera : undefined,
        info: access.info,
        time: access.time,
        receivedAt: new Date().toISOString(),
        awaitingTurn,
        attempts: 0
      });
      this.store.saveIdSecureMonitorCursor(idLog);
      if (awaitingTurn) await this.matchStoredPhysicalTurn(access.device);
    }

    await this.processPending(settings);
  }

  private async matchStoredPhysicalTurn(deviceName: unknown): Promise<void> {
    const normalizedDevice = normalizeDeviceName(deviceName);
    const now = Date.now();
    const turn = this.store.getPendingPhysicalTurns()
      .filter((item) => normalizeDeviceName(item.device) === normalizedDevice)
      .filter((item) => now - Date.parse(item.receivedAt) <= PHYSICAL_CONFIRMATION_WINDOW_MS)
      .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))[0];
    if (!turn) return;
    if (await this.handlePhysicalTurn(turn.device, turn.event, `controlid:turn:${turn.key}`)) {
      this.store.removePendingPhysicalTurn(turn.key);
    }
  }

  private async processPending(settings: Settings): Promise<void> {
    if (this.processingPending) return;
    this.processingPending = true;
    const pendingAccesses = this.store.getPendingIdSecureAccesses()
      .filter((access) => !access.awaitingTurn)
      .sort((left, right) => left.idLog - right.idLog);
    try {
      for (const pending of pendingAccesses) {
        const sourceId = `idsecure:log:${pending.idLog}`;
        if (this.store.hasProcessedControlIdAccess(sourceId)) {
          this.store.removePendingIdSecureAccess(pending.idLog);
          continue;
        }

        try {
          let registration = String(pending.registration ?? "").trim();
          if (!registration) {
            const user = await this.loadUserWithRetry(settings, pending.userId, pending.name);
            registration = String(user.registration ?? "").trim();
          }
          if (!registration) {
            const message = `O usuário ${pending.userId} (${pending.name || "sem nome"}) não possui matrícula no iDSecure.`;
            if (pending.attempts < 1) throw new Error(message);
            if (!this.accessService.recordUnlinkedControlIdUser) {
              throw new Error("O serviço de histórico local não está disponível.");
            }
            const direction = directionFor(pending.info, settings.direction);
            await this.accessService.recordUnlinkedControlIdUser(
              pending.userId,
              pending.name,
              direction,
              parseIdSecureDate(pending.time),
              sourceId,
              message,
              {
                idSecurePhotoPath: pending.photoPath,
                controlIdUserId: pending.userId,
                controlIdDeviceName: pending.device
              }
            );
            this.onDirection(direction);
            this.store.markProcessedControlIdAccess(sourceId);
            this.store.removePendingIdSecureAccess(pending.idLog);
            this.log("system", "Acesso arquivado sem envio à ActiveSoft", {
              idLog: pending.idLog,
              idUser: pending.userId,
              name: pending.name || null,
              reason: "Matrícula ausente no campo registration do iDSecure",
              attempts: pending.attempts + 1
            });
            continue;
          }

          const direction = directionFor(pending.info, settings.direction);
          this.store.savePendingIdSecureAccess({ ...pending, registration });
          this.store.saveControlIdMapping(pending.userId, registration);
          await this.accessService.registerControlIdUser(
            pending.userId,
            direction,
            parseIdSecureDate(pending.time),
            registration,
            sourceId,
            {
              idSecurePhotoPath: pending.photoPath,
              controlIdUserId: pending.userId,
              controlIdDeviceName: pending.device
            }
          );
          this.onDirection(direction);
          this.store.markProcessedControlIdAccess(sourceId);
          this.store.removePendingIdSecureAccess(pending.idLog);
        } catch (error) {
          const attempts = pending.attempts + 1;
          const message = error instanceof Error ? error.message : String(error);
          this.store.savePendingIdSecureAccess({
            ...pending,
            attempts,
            lastAttemptAt: new Date().toISOString(),
            lastError: message
          });
          if (attempts === 1 || attempts % 10 === 0) {
            this.log("error", "Acesso autorizado guardado para nova tentativa", {
              idLog: pending.idLog,
              idUser: pending.userId,
              name: pending.name || null,
              attempt: attempts,
              message,
              detail: "O evento permanece salvo no computador e não será descartado."
            });
          }
        }
      }
    } finally {
      this.processingPending = false;
    }
  }

  private async loadMonitorWithRetry(settings: Settings, token: string, cursor: number): Promise<IdSecureAccess[]> {
    try {
      return await this.loadMonitor(settings, token, cursor);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        this.clearToken();
        return this.loadMonitor(settings, await this.tokenFor(settings), cursor);
      }
      if (error instanceof IdSecureRequestTimeoutError) {
        this.clearToken();
        await this.tokenFor(settings);
        const now = Date.now();
        if (now - this.lastIdleLogAt >= 5 * 60_000) {
          this.lastIdleLogAt = now;
          this.log("system", "iDSecure conectado e aguardando um novo acesso", {
            address: originFor(settings.idSecureBaseUrl),
            detail: "O monitor usa uma conexão longa e não retornou eventos dentro de 15 segundos. O login de confirmação respondeu normalmente."
          });
        }
        return [];
      }
      throw error;
    }
  }

  private async loadMonitor(settings: Settings, token: string, cursor: number): Promise<IdSecureAccess[]> {
    const url = apiUrl(settings.idSecureBaseUrl, "/api/access/monitor");
    url.search = new URLSearchParams({
      areas: "",
      events: "",
      limite: "50",
      mode: "loop",
      modevalue: String(cursor),
      parkings: "",
      time: new Date().toISOString()
    }).toString();
    const result = await this.authorizedRequest(url, token, { method: "GET", timeoutMs: REQUEST_TIMEOUT_MS });
    const payload = result as MonitorResponse;
    if (!Array.isArray(payload.data)) throw new Error("O iDSecure retornou uma resposta de monitor sem a lista data.");
    return payload.data;
  }

  private async loadUserWithRetry(settings: Settings, userId: number, name?: string): Promise<IdSecureUser> {
    const cached = this.users.get(String(userId));
    if (cached && String(cached.registration ?? "").trim()) {
      this.log("system", "Cadastro iDSecure reutilizado", {
        idUser: userId,
        name: cached.name || name || null,
        registration: cached.registration ?? null
      });
      return cached;
    }
    if (cached) this.users.delete(String(userId));
    let token = await this.tokenFor(settings);
    try {
      return await this.loadUser(settings, token, userId, name);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      this.clearToken();
      token = await this.tokenFor(settings);
      return this.loadUser(settings, token, userId, name);
    }
  }

  private async loadUser(settings: Settings, token: string, userId: number, name?: string): Promise<IdSecureUser> {
    let users = name ? await this.queryUsers(settings, token, name, "name") : [];
    let user = users.find((item) => Number(item.idDevice ?? item.id) === userId);
    if (!user) {
      users = await this.queryUsers(settings, token, String(userId), "idDevice");
      user = users.find((item) => Number(item.idDevice ?? item.id) === userId);
    }
    if (!user) throw new Error(`Usuário iDSecure ${userId} não encontrado em Cadastros → Pessoas.`);
    this.users.set(String(userId), user);
    return user;
  }

  private async queryUsers(
    settings: Settings,
    token: string,
    search: string,
    filterColumn: "idDevice" | "name"
  ): Promise<IdSecureUser[]> {
    const url = apiUrl(settings.idSecureBaseUrl, "/api/user/list");
    const params = new URLSearchParams({
      idType: "0",
      deleted: "false",
      draw: "1",
      start: "0",
      length: "25",
      "search[value]": search,
      "search[regex]": "false",
      inactive: "0",
      blacklist: "0",
      filterCol: filterColumn
    });
    ["", "idDevice", "name", "registration", "rg", "cpf", "phone", "cargo", "inativo", "blackList", "", ""].forEach((field, index) => {
      params.set(`columns[${index}][data]`, field);
      params.set(`columns[${index}][name]`, "");
      params.set(`columns[${index}][searchable]`, "true");
      params.set(`columns[${index}][orderable]`, "true");
      params.set(`columns[${index}][search][value]`, "");
      params.set(`columns[${index}][search][regex]`, "false");
    });
    params.set("order[0][column]", filterColumn === "name" ? "2" : "1");
    params.set("order[0][dir]", "asc");
    url.search = params.toString();
    this.log("device-out", "Ponte ID → iDSecure /api/user/list", {
      filter: filterColumn,
      search
    });
    const result = await this.authorizedRequest(url, token, { method: "POST" });
    const payload = result as UserResponse;
    if (!Array.isArray(payload.data)) throw new Error("O iDSecure retornou uma consulta de pessoas sem a lista data.");
    this.log("device-in", "iDSecure → Ponte ID /api/user/list", {
      results: payload.data.length,
      people: payload.data.map((user) => ({
        idUser: Number(user.idDevice ?? user.id) || null,
        name: user.name || null,
        registration: user.registration ?? null
      }))
    });
    return payload.data;
  }

  private async tokenFor(settings: Settings): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    this.validateSettings(settings);
    const url = apiUrl(settings.idSecureBaseUrl, "/api/login/");
    this.log("device-out", "Ponte ID → iDSecure /api/login/", {
      address: originFor(settings.idSecureBaseUrl),
      username: settings.idSecureUsername,
      password: "[PROTEGIDA]"
    });
    const response = await this.requester(url, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: { username: settings.idSecureUsername, password: settings.idSecurePassword }
    });
    if (response.status < 200 || response.status >= 300) throw responseError("Login no iDSecure", response);
    const payload = response.body as LoginResponse;
    if (typeof payload.accessToken !== "string" || !payload.accessToken) {
      throw new Error(`Login no iDSecure recusado: ${errorDetail(payload.error ?? payload)}.`);
    }
    this.accessToken = payload.accessToken;
    this.tokenExpiresAt = jwtExpiration(payload.accessToken) ?? Date.now() + 30 * 60_000;
    this.log("device-in", "iDSecure autenticado", {
      address: originFor(settings.idSecureBaseUrl),
      accessToken: "[PROTEGIDO]",
      expiresAt: new Date(this.tokenExpiresAt).toISOString()
    });
    return payload.accessToken;
  }

  private async authorizedRequest(
    url: URL,
    token: string,
    options: Omit<JsonRequestOptions, "headers">
  ): Promise<Record<string, unknown>> {
    const response = await this.requester(url, {
      ...options,
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json;charset=UTF-8"
      }
    });
    if (response.status < 200 || response.status >= 300) throw responseError("Consulta ao iDSecure", response);
    if (response.body.error) throw new Error(`iDSecure retornou erro: ${errorDetail(response.body.error)}.`);
    return response.body;
  }

  private requestPhoto(url: URL, token: string): Promise<{ status: number; body: Buffer }> {
    return this.binaryRequester(url, {
      Accept: "image/avif,image/webp,image/png,image/jpeg,image/*",
      Authorization: `Bearer ${token}`
    }, REQUEST_TIMEOUT_MS);
  }

  private validateSettings(settings: Settings): void {
    const origin = originFor(settings.idSecureBaseUrl);
    if (!origin) throw new Error("Informe um endereço HTTPS válido para o iDSecure.");
    if (!settings.idSecureUsername || !settings.idSecurePassword) {
      throw new Error("Informe o usuário e a senha do painel geral iDSecure.");
    }
  }

  private clearToken(): void {
    this.accessToken = undefined;
    this.tokenExpiresAt = 0;
  }

  private online(message: string): void {
    this.onStatus({ status: "online", lastSeenAt: new Date().toISOString(), message });
  }
}

export async function defaultJsonRequester(url: URL, options: JsonRequestOptions): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Protocolo não suportado: ${url.protocol}`);
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: options.method,
      headers: {
        ...(options.method === "POST" ? { "Content-Length": String(body?.length ?? 0) } : {}),
        ...options.headers
      },
      ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {})
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          outgoing.destroy(new Error("A resposta do iDSecure excedeu o limite de 5 MB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: text ? JSON.parse(text) as Record<string, unknown> : {}
          });
        } catch {
          reject(new Error(`O iDSecure retornou conteúdo inválido (HTTP ${response.statusCode ?? 0}).`));
        }
      });
    });
    outgoing.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new IdSecureRequestTimeoutError(`Tempo limite ao acessar ${url.origin}.`));
    });
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

export async function defaultBinaryRequester(
  url: URL,
  headers: Record<string, string>,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<{ status: number; body: Buffer }> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Protocolo não suportado: ${url.protocol}`);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: "GET",
      headers,
      ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {})
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          outgoing.destroy(new Error("A foto do iDSecure excedeu o limite de 5 MB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks, size)
      }));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`Tempo limite ao acessar ${url.origin}.`)));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class IdSecureRequestTimeoutError extends Error {}

function responseError(action: string, response: { status: number; body: Record<string, unknown> }): HttpError {
  return new HttpError(response.status, `${action} respondeu HTTP ${response.status}: ${errorDetail(response.body.error ?? response.body)}`);
}

function errorDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    if (typeof source.error === "string") return source.error;
    if (typeof source.message === "string") return source.message;
  }
  return JSON.stringify(value);
}

function apiUrl(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error("O endereço do iDSecure deve usar HTTP ou HTTPS.");
  return new URL(pathname, base.origin);
}

function idSecureImageUrl(baseUrl: string, photoPath: string): URL {
  const base = new URL(baseUrl);
  const target = new URL(photoPath, `${base.origin}/`);
  if (target.origin !== base.origin || !target.pathname.startsWith("/image/")) {
    throw new Error("A foto não pertence ao servidor iDSecure configurado.");
  }
  return target;
}

function trimPhotoCache(cache: Map<string, { value: string | null; expiresAt: number }>): void {
  while (cache.size > 60) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) return;
    cache.delete(oldest);
  }
}

function originFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

function jwtExpiration(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: unknown };
    const seconds = Number(payload.exp);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function directionFor(info: unknown, fallback: Direction): Direction {
  const normalized = String(info ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (normalized.includes("entrada")) return "E";
  if (normalized.includes("saida")) return "S";
  return fallback;
}

function directionForTurn(event: "TURN_LEFT" | "TURN_RIGHT", settings: Settings): Direction {
  return event === "TURN_LEFT" ? settings.turnLeftDirection : settings.turnRightDirection;
}

function isReleased(value: unknown): boolean {
  const normalized = String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  return normalized.includes("liberad");
}

function normalizeDeviceName(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function parseIdSecureDate(value: unknown): string {
  const match = String(value ?? "").match(/\/Date\((\d+)/);
  const milliseconds = match ? Number(match[1]) : Date.parse(String(value ?? ""));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : new Date().toISOString();
}

function eventName(value: unknown): string {
  const names: Record<number, string> = {
    3: "Não identificado",
    4: "Identificação pendente",
    5: "Tempo de identificação esgotado",
    6: "Acesso negado",
    7: "Acesso autorizado",
    8: "Acesso pendente",
    11: "Abertura por botoeira",
    12: "Abertura pela interface web",
    13: "Desistência"
  };
  return names[Number(value)] ?? `Evento ${String(value)}`;
}
