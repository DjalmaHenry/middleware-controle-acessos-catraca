export type Direction = "E" | "S";

export interface Settings {
  configured: boolean;
  activeSoftBaseUrl: string;
  activeSoftToken: string;
  listenerPort: number;
  autoStart: boolean;
  direction: Direction;
  demoMode: boolean;
}

export interface Student {
  id: number;
  matricula: string;
  nome: string;
  urlFoto?: string;
  turma?: string;
}

export interface AccessRecord {
  id: string;
  studentId: number;
  studentName: string;
  matricula: string;
  photoUrl?: string;
  direction: Direction;
  occurredAt: string;
  status: "sending" | "sent" | "queued" | "failed";
  message?: string;
}

export interface AppState {
  settings: Omit<Settings, "activeSoftToken"> & { tokenConfigured: boolean };
  listener: { running: boolean; port: number; error?: string };
  activeSoft: { status: "unknown" | "online" | "offline"; message?: string };
  students: Student[];
  recentAccesses: AccessRecord[];
  pendingCount: number;
}

export interface SaveSettingsInput {
  activeSoftBaseUrl: string;
  activeSoftToken?: string;
  listenerPort: number;
  autoStart: boolean;
  direction: Direction;
  demoMode: boolean;
}
