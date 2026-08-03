import { AppState, InstallationReport, SaveSettingsInput } from "../shared/types";

declare global {
  interface Window {
    ponte: {
      getState(): Promise<AppState>;
      saveSettings(settings: SaveSettingsInput): Promise<AppState>;
      synchronize(): Promise<void>;
      clearQueue(): Promise<AppState>;
      testConnection(): Promise<boolean>;
      getAccessPhoto(accessId: string): Promise<string | null>;
      clearLogs(): Promise<void>;
      prepareInstallation(): Promise<InstallationReport>;
      validateInstallation(): Promise<InstallationReport>;
      openExternal(url: string): Promise<void>;
      onStateChanged(callback: (state: AppState) => void): () => void;
    };
  }
}
