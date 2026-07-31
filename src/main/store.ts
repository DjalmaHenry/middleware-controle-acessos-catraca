import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccessRecord, IntegrationLog, IntegrationLogCategory, Settings, Student } from "../shared/types";

interface PersistedData {
  settings: Omit<Settings, "activeSoftToken"> & { encryptedToken?: string; plainToken?: string };
  students: Student[];
  recentAccesses: AccessRecord[];
  queue: AccessRecord[];
  integrationLogs: IntegrationLog[];
  controlIdMappings: Record<string, string>;
  pendingControlIdAccesses: Record<string, { userId: number; time: number; registration?: string }>;
}

const defaults: PersistedData = {
  settings: {
    configured: false,
    activeSoftBaseUrl: "https://siga01.activesoft.com.br",
    listenerPort: 8787,
    autoStart: true,
    direction: "E",
    turnLeftDirection: "E",
    turnRightDirection: "S",
    demoMode: true,
    developerMode: false
  },
  students: [],
  recentAccesses: [],
  queue: [],
  integrationLogs: [],
  controlIdMappings: {},
  pendingControlIdAccesses: {}
};

export class JsonStore {
  private readonly file: string;
  private data: PersistedData;

  constructor() {
    const directory = app.getPath("userData");
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, "ponte-id.json");
    this.data = this.load();
  }

  getSettings(): Settings {
    const { encryptedToken, plainToken, ...settings } = this.data.settings;
    let activeSoftToken = "";
    if (encryptedToken && safeStorage.isEncryptionAvailable()) {
      try {
        activeSoftToken = safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
      } catch {
        activeSoftToken = "";
      }
    } else if (plainToken) {
      activeSoftToken = plainToken;
    }
    return { ...settings, activeSoftToken };
  }

  saveSettings(settings: Settings): void {
    const { activeSoftToken, ...rest } = settings;
    const secret = safeStorage.isEncryptionAvailable()
      ? { encryptedToken: safeStorage.encryptString(activeSoftToken).toString("base64") }
      : { plainToken: activeSoftToken };
    this.data.settings = { ...rest, ...secret };
    this.persist();
  }

  getStudents(): Student[] { return [...this.data.students]; }
  saveStudents(students: Student[]): void { this.data.students = students; this.persist(); }
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

  private load(): PersistedData {
    try {
      const loaded = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedData>;
      return {
        settings: { ...defaults.settings, ...loaded.settings },
        students: loaded.students ?? [],
        recentAccesses: loaded.recentAccesses ?? [],
        queue: loaded.queue ?? [],
        integrationLogs: loaded.integrationLogs ?? [],
        controlIdMappings: loaded.controlIdMappings ?? {},
        pendingControlIdAccesses: loaded.pendingControlIdAccesses ?? {}
      };
    } catch {
      return structuredClone(defaults);
    }
  }

  private persist(): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
  }
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
