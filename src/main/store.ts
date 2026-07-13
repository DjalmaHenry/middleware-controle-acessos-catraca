import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AccessRecord, Settings, Student } from "../shared/types";

interface PersistedData {
  settings: Omit<Settings, "activeSoftToken"> & { encryptedToken?: string; plainToken?: string };
  students: Student[];
  recentAccesses: AccessRecord[];
  queue: AccessRecord[];
}

const defaults: PersistedData = {
  settings: {
    configured: false,
    activeSoftBaseUrl: "https://siga01.activesoft.com.br",
    listenerPort: 8787,
    autoStart: true,
    direction: "E",
    demoMode: true
  },
  students: [],
  recentAccesses: [],
  queue: []
};

export class JsonStore {
  private readonly file: string;
  private data: PersistedData;

  constructor() {
    const directory = app.getPath("userData");
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, "ponte-escolar.json");
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

  private load(): PersistedData {
    try {
      const loaded = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedData>;
      return {
        settings: { ...defaults.settings, ...loaded.settings },
        students: loaded.students ?? [],
        recentAccesses: loaded.recentAccesses ?? [],
        queue: loaded.queue ?? []
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
