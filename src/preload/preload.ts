import { contextBridge, ipcRenderer } from "electron";
import { AppState, InstallationReport, SaveSettingsInput } from "../shared/types";

contextBridge.exposeInMainWorld("ponte", {
  getState: (): Promise<AppState> => ipcRenderer.invoke("state:get"),
  saveSettings: (settings: SaveSettingsInput): Promise<AppState> => ipcRenderer.invoke("settings:save", settings),
  synchronize: (): Promise<void> => ipcRenderer.invoke("sync:run"),
  testConnection: (): Promise<boolean> => ipcRenderer.invoke("connection:test"),
  getAccessPhoto: (accessId: string): Promise<string | null> => ipcRenderer.invoke("photo:get", accessId),
  simulateAccess: (studentId: number) => ipcRenderer.invoke("demo:access", studentId),
  clearLogs: (): Promise<void> => ipcRenderer.invoke("logs:clear"),
  prepareInstallation: (): Promise<InstallationReport> => ipcRenderer.invoke("installation:prepare"),
  validateInstallation: (): Promise<InstallationReport> => ipcRenderer.invoke("installation:validate"),
  openExternal: (url: string) => ipcRenderer.invoke("external:open", url),
  onStateChanged: (callback: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on("state:changed", listener);
    return () => ipcRenderer.removeListener("state:changed", listener);
  }
});
