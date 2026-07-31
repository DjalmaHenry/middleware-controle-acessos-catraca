export type Direction = "E" | "S";

export interface Settings {
  configured: boolean;
  activeSoftBaseUrl: string;
  activeSoftToken: string;
  listenerPort: number;
  autoStart: boolean;
  direction: Direction;
  turnLeftDirection: Direction;
  turnRightDirection: Direction;
  demoMode: boolean;
  developerMode: boolean;
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

export type IntegrationLogCategory =
  | "device-in"
  | "device-out"
  | "api-out"
  | "api-in"
  | "system"
  | "error";

export interface IntegrationLog {
  id: string;
  timestamp: string;
  category: IntegrationLogCategory;
  title: string;
  payload?: unknown;
}

export type InstallationCheckStatus = "pass" | "warning" | "fail" | "running";

export interface InstallationCheck {
  id: string;
  title: string;
  status: InstallationCheckStatus;
  blocking: boolean;
  detail: string;
  resolution?: string;
}

export interface InstallationReport {
  checkedAt: string;
  ready: boolean;
  checks: InstallationCheck[];
}

export interface AppState {
  settings: Omit<Settings, "activeSoftToken"> & { tokenConfigured: boolean };
  listener: { running: boolean; port: number; error?: string };
  activeSoft: { status: "unknown" | "online" | "offline"; message?: string };
  students: Student[];
  recentAccesses: AccessRecord[];
  pendingCount: number;
  integrationLogs: IntegrationLog[];
  networkAddresses: string[];
  controlIdMappingCount: number;
  platform: NodeJS.Platform;
  installationReport?: InstallationReport;
}

export interface SaveSettingsInput {
  activeSoftBaseUrl: string;
  activeSoftToken?: string;
  listenerPort: number;
  autoStart: boolean;
  direction: Direction;
  turnLeftDirection: Direction;
  turnRightDirection: Direction;
  demoMode: boolean;
  developerMode: boolean;
}
