import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import path from "node:path";
import { ActiveSoftClient } from "./active-soft";
import { AccessService } from "./access-service";
import { ControlIdServer } from "./control-id-server";
import { JsonStore } from "./store";
import { AppState, SaveSettingsInput, Settings } from "../shared/types";

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: JsonStore;
let activeSoft: ActiveSoftClient;
let accessService: AccessService;
let controlIdServer: ControlIdServer;
let listenerState: AppState["listener"] = { running: false, port: 8787 };
let activeSoftState: AppState["activeSoft"] = { status: "unknown" };
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(bootstrap);
}

async function bootstrap(): Promise<void> {
  store = new JsonStore();
  const startupSettings = store.getSettings();
  app.setLoginItemSettings({ openAtLogin: startupSettings.autoStart, openAsHidden: true });
  activeSoft = new ActiveSoftClient(() => store.getSettings());
  accessService = new AccessService(store, activeSoft, broadcastState);
  controlIdServer = new ControlIdServer(accessService);
  registerIpc();
  createTray();
  createWindow();
  await restartListener();
  if (store.getSettings().demoMode && store.getStudents().length === 0) accessService.seedDemoStudents();
  setInterval(() => void accessService.retryQueue(), 30_000);
  if (store.getSettings().configured && !store.getSettings().demoMode) void synchronize();
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 620,
    backgroundColor: "#f4f6f5", show: false,
    webPreferences: { preload: path.join(__dirname, "../preload/preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  window.setMenuBarVisibility(false);
  void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAATklEQVR42mNgGAWjYBSMglEwCkbBSGBgYPjPwMDA8J+BgYGBkZGR4T8DAwPDf4aGhv8MDAwM/xkYGBj+MzAwMPxnYGBg+M/AwMAAAOpFCZtG+gUAAAAASUVORK5CYII=");
  tray = new Tray(icon);
  tray.setToolTip("Ponte Escolar");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir Ponte Escolar", click: showWindow },
    { type: "separator" },
    { label: "Sair", click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("double-click", showWindow);
}

function showWindow(): void { window?.show(); window?.focus(); }

function state(): AppState {
  const settings = store.getSettings();
  const { activeSoftToken, ...publicSettings } = settings;
  return {
    settings: { ...publicSettings, tokenConfigured: Boolean(activeSoftToken) },
    listener: listenerState, activeSoft: activeSoftState,
    students: store.getStudents(), recentAccesses: store.getRecentAccesses(), pendingCount: store.getQueue().length
  };
}

function broadcastState(): void { if (window && !window.isDestroyed()) window.webContents.send("state:changed", state()); }

async function restartListener(): Promise<void> {
  const port = store.getSettings().listenerPort;
  try {
    const actualPort = await controlIdServer.start(port);
    listenerState = { running: true, port: actualPort };
  } catch (error) {
    listenerState = { running: false, port, error: error instanceof Error ? error.message : String(error) };
  }
  broadcastState();
}

async function synchronize(): Promise<void> {
  if (store.getSettings().demoMode) {
    if (store.getStudents().length === 0) accessService.seedDemoStudents();
    activeSoftState = { status: "unknown", message: "Modo demonstração ativo" };
    broadcastState();
    return;
  }
  try {
    const students = await activeSoft.listStudents();
    store.saveStudents(students);
    activeSoftState = { status: "online", message: `${students.length} alunos sincronizados` };
  } catch (error) {
    activeSoftState = { status: "offline", message: error instanceof Error ? error.message : String(error) };
  }
  broadcastState();
}

function registerIpc(): void {
  ipcMain.handle("state:get", () => state());
  ipcMain.handle("settings:save", async (_event, input: SaveSettingsInput) => {
    const current = store.getSettings();
    const settings: Settings = { ...input, configured: true, activeSoftToken: input.activeSoftToken?.trim() || current.activeSoftToken };
    store.saveSettings(settings);
    app.setLoginItemSettings({ openAtLogin: settings.autoStart, openAsHidden: true });
    if (settings.demoMode && store.getStudents().length === 0) accessService.seedDemoStudents();
    await restartListener();
    if (!settings.demoMode) await synchronize();
    return state();
  });
  ipcMain.handle("sync:run", synchronize);
  ipcMain.handle("connection:test", async () => { await activeSoft.testConnection(); return true; });
  ipcMain.handle("demo:access", async (_event, studentId: number) => accessService.register(studentId));
  ipcMain.handle("external:open", (_event, url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); });
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* resident process stays in the tray */ });
