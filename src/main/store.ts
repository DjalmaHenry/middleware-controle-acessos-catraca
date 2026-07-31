import { app, safeStorage } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccessRecord, ControlIdDeviceConfig, IntegrationLog, IntegrationLogCategory, PendingIdSecureAccess, Settings, Student, StudentSyncState } from "../shared/types";
import { normalizeStudentSync } from "./student-cache-check";

interface PersistedData {
  settings: Omit<Settings, "activeSoftToken" | "controlIdPassword" | "idSecurePassword"> & {
    encryptedToken?: string;
    plainToken?: string;
    encryptedControlIdPassword?: string;
    plainControlIdPassword?: string;
    encryptedIdSecurePassword?: string;
    plainIdSecurePassword?: string;
  };
  students: Student[];
  studentSync?: StudentSyncState;
  recentAccesses: AccessRecord[];
  queue: AccessRecord[];
  integrationLogs: IntegrationLog[];
  controlIdMappings: Record<string, string>;
  pendingControlIdAccesses: Record<string, { userId: number; time: number; registration?: string }>;
  controlIdPollingCursors: Record<string, number>;
  idSecureMonitorCursor?: number;
  pendingIdSecureAccesses: Record<string, PendingIdSecureAccess>;
  processedControlIdAccesses: Record<string, string>;
}

const defaults: PersistedData = {
  settings: {
    configured: false,
    activeSoftBaseUrl: "https://siga01.activesoft.com.br",
    idSecureBaseUrl: "https://192.168.1.2:30443",
    idSecureUsername: "",
    controlIdMode: "polling",
    controlIdUsername: "admin",
    controlIdDevices: [
      { id: "catraca-1", name: "CATRACA 1", host: "192.168.1.189", port: 80, enabled: true },
      { id: "catraca-2", name: "CATRACA 2", host: "192.168.1.178", port: 80, enabled: true }
    ],
    listenerPort: 8787,
    autoStart: true,
    direction: "E",
    turnLeftDirection: "E",
    turnRightDirection: "S",
    developerMode: false
  },
  students: [],
  studentSync: undefined,
  recentAccesses: [],
  queue: [],
  integrationLogs: [],
  controlIdMappings: {},
  pendingControlIdAccesses: {},
  controlIdPollingCursors: {},
  idSecureMonitorCursor: undefined,
  pendingIdSecureAccesses: {},
  processedControlIdAccesses: {}
};

export class JsonStore {
  private readonly file: string;
  private readonly backupFile: string;
  private data: PersistedData;

  constructor() {
    const directory = app.getPath("userData");
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, "ponte-id.json");
    this.backupFile = path.join(directory, "ponte-id.backup.json");
    this.data = this.load();
  }

  getSettings(): Settings {
    const {
      encryptedToken, plainToken,
      encryptedControlIdPassword, plainControlIdPassword,
      encryptedIdSecurePassword, plainIdSecurePassword,
      ...settings
    } = this.data.settings;
    return {
      ...settings,
      activeSoftToken: decryptSecret(encryptedToken, plainToken),
      controlIdPassword: decryptSecret(encryptedControlIdPassword, plainControlIdPassword),
      idSecurePassword: decryptSecret(encryptedIdSecurePassword, plainIdSecurePassword)
    };
  }

  saveSettings(settings: Settings): void {
    const { activeSoftToken, controlIdPassword, idSecurePassword, ...rest } = settings;
    const activeSoftSecret = encryptSecret("Token", activeSoftToken);
    const controlIdSecret = encryptSecret("ControlIdPassword", controlIdPassword);
    const idSecureSecret = encryptSecret("IdSecurePassword", idSecurePassword);
    this.data.settings = { ...rest, ...activeSoftSecret, ...controlIdSecret, ...idSecureSecret };
    this.persist();
  }

  getStudents(): Student[] { return [...this.data.students]; }
  getStudentSync(): StudentSyncState | undefined {
    return this.data.studentSync ? { ...this.data.studentSync } : undefined;
  }
  saveStudents(students: Student[]): void {
    this.data.students = students;
    this.data.studentSync = { syncedAt: new Date().toISOString() };
    this.persist();
  }
  getRecentAccesses(): AccessRecord[] { return [...this.data.recentAccesses]; }
  addAccess(record: AccessRecord): void {
    this.data.recentAccesses = [record, ...this.data.recentAccesses.filter((item) => item.id !== record.id)].slice(0, 50);
    this.persist();
  }
  getQueue(): AccessRecord[] { return [...this.data.queue]; }
  enqueue(record: AccessRecord): void {
    this.data.queue = [record, ...this.data.queue.filter((item) => item.id !== record.id)];
    this.persist();
  }
  dequeue(id: string): void { this.data.queue = this.data.queue.filter((item) => item.id !== id); this.persist(); }
  getIntegrationLogs(): IntegrationLog[] { return [...this.data.integrationLogs]; }
  addIntegrationLog(category: IntegrationLogCategory, title: string, payload?: unknown): IntegrationLog {
    const entry: IntegrationLog = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      category,
      title,
      payload: sanitizeLogPayload(payload)
    };
    this.data.integrationLogs = [...this.data.integrationLogs, entry].slice(-500);
    this.persist();
    return entry;
  }
  clearIntegrationLogs(): void { this.data.integrationLogs = []; this.persist(); }
  saveControlIdMapping(userId: number | string, registration: string): void {
    if (!registration) return;
    this.data.controlIdMappings[String(userId)] = registration;
    this.persist();
  }
  getControlIdRegistration(userId: number | string): string | undefined {
    return this.data.controlIdMappings[String(userId)];
  }
  getControlIdMappingCount(): number { return Object.keys(this.data.controlIdMappings).length; }
  savePendingControlIdAccess(
    accessEventId: string,
    pending: { userId: number; time: number; registration?: string }
  ): void {
    this.data.pendingControlIdAccesses[accessEventId] = pending;
    this.persist();
  }
  getPendingControlIdAccess(accessEventId: string): { userId: number; time: number; registration?: string } | undefined {
    return this.data.pendingControlIdAccesses[accessEventId];
  }
  removePendingControlIdAccess(accessEventId: string): void {
    delete this.data.pendingControlIdAccesses[accessEventId];
    this.persist();
  }
  getControlIdPollingCursor(deviceKey: string): number | undefined {
    return this.data.controlIdPollingCursors[deviceKey];
  }
  saveControlIdPollingCursor(deviceKey: string, cursor: number): void {
    this.data.controlIdPollingCursors[deviceKey] = cursor;
    this.persist();
  }
  getIdSecureMonitorCursor(): number | undefined { return this.data.idSecureMonitorCursor; }
  saveIdSecureMonitorCursor(cursor: number): void {
    this.data.idSecureMonitorCursor = cursor;
    this.persist();
  }
  getPendingIdSecureAccesses(): PendingIdSecureAccess[] {
    return Object.values(this.data.pendingIdSecureAccesses).map((access) => ({ ...access }));
  }
  savePendingIdSecureAccess(access: PendingIdSecureAccess): void {
    const key = String(access.idLog);
    this.data.pendingIdSecureAccesses[key] = {
      ...this.data.pendingIdSecureAccesses[key],
      ...access
    };
    this.persist();
  }
  removePendingIdSecureAccess(idLog: number): void {
    delete this.data.pendingIdSecureAccesses[String(idLog)];
    this.persist();
  }
  hasProcessedControlIdAccess(sourceId: string): boolean {
    return Boolean(this.data.processedControlIdAccesses[sourceId]);
  }
  markProcessedControlIdAccess(sourceId: string): void {
    this.data.processedControlIdAccesses[sourceId] = new Date().toISOString();
    const entries = Object.entries(this.data.processedControlIdAccesses);
    if (entries.length > 5_000) {
      this.data.processedControlIdAccesses = Object.fromEntries(entries.sort((a, b) => a[1].localeCompare(b[1])).slice(-4_000));
    }
    this.persist();
  }

  private load(): PersistedData {
    const primary = this.read(this.file);
    if (primary) return normalizePersistedData(primary);

    const backup = this.read(this.backupFile);
    if (backup) {
      const recovered = normalizePersistedData(backup);
      try {
        writeFileSync(this.file, JSON.stringify(recovered, null, 2), { encoding: "utf8", mode: 0o600 });
      } catch {
        // The in-memory recovery remains usable even if the disk cannot be repaired yet.
      }
      return recovered;
    }

    return structuredClone(defaults);
  }

  private persist(): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    if (existsSync(this.file)) {
      try {
        copyFileSync(this.file, this.backupFile);
      } catch {
        // A backup failure must not prevent the primary atomic write.
      }
    }
    renameSync(temporary, this.file);
  }

  private read(file: string): Partial<PersistedData> | undefined {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedData>;
    } catch {
      return undefined;
    }
  }
}

function normalizePersistedData(loaded: Partial<PersistedData>): PersistedData {
  const studentSync = normalizeStudentSync(loaded.studentSync);
  const hasVerifiedStudentCache = Boolean(studentSync);
  return {
    settings: normalizeSettings(loaded.settings),
    students: hasVerifiedStudentCache && Array.isArray(loaded.students) ? loaded.students : [],
    studentSync,
    recentAccesses: hasVerifiedStudentCache && Array.isArray(loaded.recentAccesses) ? loaded.recentAccesses : [],
    queue: hasVerifiedStudentCache && Array.isArray(loaded.queue) ? loaded.queue : [],
    integrationLogs: hasVerifiedStudentCache && Array.isArray(loaded.integrationLogs) ? loaded.integrationLogs : [],
    controlIdMappings: loaded.controlIdMappings && typeof loaded.controlIdMappings === "object"
      ? loaded.controlIdMappings
      : {},
    pendingControlIdAccesses: loaded.pendingControlIdAccesses && typeof loaded.pendingControlIdAccesses === "object"
      ? loaded.pendingControlIdAccesses
      : {},
    controlIdPollingCursors: loaded.controlIdPollingCursors && typeof loaded.controlIdPollingCursors === "object"
      ? loaded.controlIdPollingCursors
      : {},
    idSecureMonitorCursor: typeof loaded.idSecureMonitorCursor === "number"
      ? loaded.idSecureMonitorCursor
      : undefined,
    pendingIdSecureAccesses: normalizePendingIdSecureAccesses(loaded.pendingIdSecureAccesses),
    processedControlIdAccesses: loaded.processedControlIdAccesses && typeof loaded.processedControlIdAccesses === "object"
      ? loaded.processedControlIdAccesses
      : {}
  };
}

function normalizePendingIdSecureAccesses(value: unknown): Record<string, PendingIdSecureAccess> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Partial<PendingIdSecureAccess>;
    const idLog = Number(source.idLog ?? key);
    const userId = Number(source.userId);
    if (!Number.isFinite(idLog) || !Number.isFinite(userId) || idLog <= 0 || userId <= 0) return [];
    return [[String(idLog), {
      idLog,
      userId,
      registration: typeof source.registration === "string" ? source.registration : undefined,
      name: typeof source.name === "string" ? source.name : undefined,
      device: typeof source.device === "string" ? source.device : undefined,
      info: typeof source.info === "string" ? source.info : undefined,
      time: typeof source.time === "string" ? source.time : undefined,
      attempts: Number.isFinite(Number(source.attempts)) ? Math.max(0, Number(source.attempts)) : 0,
      lastAttemptAt: typeof source.lastAttemptAt === "string" ? source.lastAttemptAt : undefined,
      lastError: typeof source.lastError === "string" ? source.lastError : undefined
    } satisfies PendingIdSecureAccess]];
  }));
}

function normalizeSettings(value: unknown): PersistedData["settings"] {
  const source = value && typeof value === "object"
    ? value as Partial<PersistedData["settings"]>
    : {};
  return {
    configured: typeof source.configured === "boolean" ? source.configured : defaults.settings.configured,
    activeSoftBaseUrl: typeof source.activeSoftBaseUrl === "string"
      ? source.activeSoftBaseUrl
      : defaults.settings.activeSoftBaseUrl,
    idSecureBaseUrl: typeof source.idSecureBaseUrl === "string"
      ? source.idSecureBaseUrl
      : defaults.settings.idSecureBaseUrl,
    idSecureUsername: typeof source.idSecureUsername === "string"
      ? source.idSecureUsername
      : defaults.settings.idSecureUsername,
    controlIdMode: source.controlIdMode === "listener" ? "listener" : "polling",
    controlIdUsername: typeof source.controlIdUsername === "string"
      ? source.controlIdUsername
      : defaults.settings.controlIdUsername,
    controlIdDevices: normalizeControlIdDevices(source.controlIdDevices),
    listenerPort: typeof source.listenerPort === "number" ? source.listenerPort : defaults.settings.listenerPort,
    autoStart: typeof source.autoStart === "boolean" ? source.autoStart : defaults.settings.autoStart,
    direction: source.direction === "S" ? "S" : "E",
    turnLeftDirection: source.turnLeftDirection === "S" ? "S" : "E",
    turnRightDirection: source.turnRightDirection === "E" ? "E" : "S",
    developerMode: typeof source.developerMode === "boolean"
      ? source.developerMode
      : defaults.settings.developerMode,
    ...(typeof source.encryptedToken === "string" ? { encryptedToken: source.encryptedToken } : {}),
    ...(typeof source.plainToken === "string" ? { plainToken: source.plainToken } : {}),
    ...(typeof source.encryptedControlIdPassword === "string" ? { encryptedControlIdPassword: source.encryptedControlIdPassword } : {}),
    ...(typeof source.plainControlIdPassword === "string" ? { plainControlIdPassword: source.plainControlIdPassword } : {}),
    ...(typeof source.encryptedIdSecurePassword === "string" ? { encryptedIdSecurePassword: source.encryptedIdSecurePassword } : {}),
    ...(typeof source.plainIdSecurePassword === "string" ? { plainIdSecurePassword: source.plainIdSecurePassword } : {})
  };
}

function normalizeControlIdDevices(value: unknown): ControlIdDeviceConfig[] {
  if (!Array.isArray(value)) return structuredClone(defaults.settings.controlIdDevices);
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Partial<ControlIdDeviceConfig>;
    if (typeof source.host !== "string" || !source.host.trim()) return [];
    return [{
      id: typeof source.id === "string" && source.id ? source.id : `device-${index + 1}`,
      name: typeof source.name === "string" && source.name ? source.name : `Catraca ${index + 1}`,
      host: source.host.trim(),
      port: typeof source.port === "number" && source.port > 0 && source.port <= 65535 ? source.port : 80,
      enabled: source.enabled !== false
    }];
  });
}

function decryptSecret(encrypted?: string, plain?: string): string {
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(encrypted, "base64")); } catch { return ""; }
  }
  return plain ?? "";
}

function encryptSecret(name: "Token" | "ControlIdPassword" | "IdSecurePassword", value: string): Record<string, string> {
  const encryptedKey = `encrypted${name}`;
  const plainKey = `plain${name}`;
  return safeStorage.isEncryptionAvailable()
    ? { [encryptedKey]: safeStorage.encryptString(value).toString("base64") }
    : { [plainKey]: value };
}

function sanitizeLogPayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  if (typeof payload === "string") return summarizeLargeValue(payload);
  if (Array.isArray(payload)) return payload.map(sanitizeLogPayload);
  if (payload && typeof payload === "object") {
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => {
      if (/authorization|token|password|senha|secret/i.test(key)) return [key, "[PROTEGIDO]"];
      if (/access_photo|image|imagem/i.test(key) && typeof value === "string" && value.length > 500) {
        return [key, `[IMAGEM BASE64: ${value.length} caracteres]`];
      }
      return [key, sanitizeLogPayload(value)];
    }));
  }
  return payload;
}

function summarizeLargeValue(value: string): string {
  return value.length > 30_000 ? `${value.slice(0, 30_000)}\n[CONTEÚDO TRUNCADO: ${value.length} caracteres]` : value;
}
