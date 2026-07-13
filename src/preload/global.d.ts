import { AppState, SaveSettingsInput } from "../shared/types";

declare global {
  interface Window {
    ponte: {
      getState(): Promise<AppState>;
      saveSettings(settings: SaveSettingsInput): Promise<AppState>;
      synchronize(): Promise<void>;
      testConnection(): Promise<boolean>;
      simulateAccess(studentId: number): Promise<void>;
      openExternal(url: string): Promise<void>;
      onStateChanged(callback: (state: AppState) => void): () => void;
    };
  }
}
