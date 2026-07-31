import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import path from "node:path";
import { networkInterfaces } from "node:os";
import { ActiveSoftClient } from "./active-soft";
import { AccessService } from "./access-service";
import { ControlIdServer } from "./control-id-server";
import { JsonStore } from "./store";
import { AppState, ControlIdDeviceContact, InstallationReport, SaveSettingsInput, Settings } from "../shared/types";
import { createIntegrationLogger, IntegrationLogger } from "./integration-logger";
import { InstallationService } from "./installation-service";
import { PhotoService } from "./photo-service";
import { enableAutoStart, wasStartedAutomatically } from "./startup";

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: JsonStore;
let activeSoft: ActiveSoftClient;
let accessService: AccessService;
let controlIdServer: ControlIdServer;
let integrationLog: IntegrationLogger;
let installationService: InstallationService;
let photoService: PhotoService;
let installationReport: InstallationReport | undefined;
let listenerState: AppState["listener"] = { running: false, port: 8787 };
let activeSoftState: AppState["activeSoft"] = { status: "unknown" };
const controlIdDevices = new Map<string, ControlIdDeviceContact>();
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => showWindow());
  void app.whenReady().then(bootstrap);
}

async function bootstrap(): Promise<void> {
  store = new JsonStore();
  let startupSettings = store.getSettings();
  if (!startupSettings.autoStart) {
    startupSettings = { ...startupSettings, autoStart: true };
    store.saveSettings(startupSettings);
  }
  enableAutoStart();
  integrationLog = createIntegrationLogger(store, broadcastState);
  photoService = new PhotoService(integrationLog);
  activeSoft = new ActiveSoftClient(() => store.getSettings(), integrationLog);
  accessService = new AccessService(store, activeSoft, broadcastState, integrationLog);
  controlIdServer = new ControlIdServer(
    accessService,
    store,
    () => store.getSettings(),
    integrationLog,
    registerControlIdContact
  );
  installationService = new InstallationService({
    store,
    activeSoft,
    listenerState: () => listenerState,
    controlIdDevices: () => [...controlIdDevices.values()],
    networkAddresses: localIpv4Addresses,
    restartListener,
    log: integrationLog
  });
  registerIpc();
  createTray();
  createWindow();
  await restartListener();
  integrationLog("system", "Ponte ID iniciado", {
    version: app.getVersion(),
    platform: process.platform,
    listenerPort: startupSettings.listenerPort
  });
  if (store.getSettings().demoMode && store.getStudents().length === 0) accessService.seedDemoStudents();
  setInterval(() => void accessService.retryQueue(), 30_000);
  if (store.getSettings().configured && !store.getSettings().demoMode) void synchronize();
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 620,
    backgroundColor: "#f4f6f5", show: false,
    icon: path.join(__dirname, "../assets/icon.png"),
    webPreferences: { preload: path.join(__dirname, "../preload/preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  window.setMenuBarVisibility(false);
  void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  window.once("ready-to-show", () => {
    if (!wasStartedAutomatically()) window?.show();
  });
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(__dirname, "../assets/icon.png")).resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  tray.setToolTip("Ponte ID");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir Ponte ID", click: showWindow },
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
    listener: listenerState,
    controlId: { devices: [...controlIdDevices.values()] },
    activeSoft: activeSoftState,
    students: store.getStudents(),
    recentAccesses: store.getRecentAccesses(),
    pendingCount: store.getQueue().length,
    integrationLogs: store.getIntegrationLogs(),
    networkAddresses: localIpv4Addresses(),
    controlIdMappingCount: store.getControlIdMappingCount(),
    platform: process.platform,
    installationReport
  };
}

function broadcastState(): void { if (window && !window.isDestroyed()) window.webContents.send("state:changed", state()); }

async function restartListener(): Promise<void> {
  const port = store.getSettings().listenerPort;
  controlIdDevices.clear();
  try {
    const actualPort = await controlIdServer.start(port);
    listenerState = { running: true, port: actualPort };
    integrationLog?.("system", `Receptor Control iD ativo na porta ${actualPort}`, {
      endpoints: [
        "/api/notifications/dao",
        "/api/notifications/catra_event",
        "/api/notifications/access_photo",
        "/api/notifications/device_is_alive"
      ]
    });
  } catch (error) {
    listenerState = { running: false, port, error: error instanceof Error ? error.message : String(error) };
    integrationLog?.("error", `Não foi possível iniciar o receptor na porta ${port}`, listenerState);
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
    const settings: Settings = {
      ...input,
      configured: true,
      autoStart: true,
      activeSoftToken: input.activeSoftToken?.trim() || current.activeSoftToken
    };
    store.saveSettings(settings);
    enableAutoStart();
    if (settings.demoMode && store.getStudents().length === 0) accessService.seedDemoStudents();
    await restartListener();
    if (!settings.demoMode) await synchronize();
    return state();
  });
  ipcMain.handle("sync:run", synchronize);
  ipcMain.handle("connection:test", async () => { await activeSoft.testConnection(); return true; });
  ipcMain.handle("photo:get", async (_event, accessId: string) => {
    if (typeof accessId !== "string" || accessId.length > 100) return null;
    const access = store.getRecentAccesses().find((item) => item.id === accessId);
    return photoService.resolve(access?.photoUrl);
  });
  ipcMain.handle("demo:access", async (_event, studentId: number) => {
    const student = store.getStudents().find((item) => item.id === studentId);
    integrationLog("device-in", "SIMULAÇÃO giro confirmado pela catraca", {
      event: { type: 7, name: "TURN LEFT", time: Math.floor(Date.now() / 1000) },
      user_id: studentId,
      registration: student?.matricula,
      device_id: 999001
    });
    return accessService.registerControlIdUser(
      studentId,
      store.getSettings().turnLeftDirection,
      new Date().toISOString(),
      student?.matricula
    );
  });
  ipcMain.handle("logs:clear", () => { store.clearIntegrationLogs(); broadcastState(); });
  ipcMain.handle("installation:prepare", async () => {
    installationReport = await installationService.prepareComputer();
    broadcastState();
    return installationReport;
  });
  ipcMain.handle("installation:validate", async () => {
    installationReport = await installationService.validate();
    broadcastState();
    return installationReport;
  });
  ipcMain.handle("external:open", (_event, url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); });
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* resident process stays in the tray */ });

function localIpv4Addresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return [...new Set(addresses)];
}

function registerControlIdContact(contact: ControlIdDeviceContact): void {
  controlIdDevices.set(contact.key, contact);
  if (controlIdDevices.size > 50) {
    const oldest = [...controlIdDevices.values()]
      .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))[0];
    if (oldest) controlIdDevices.delete(oldest.key);
  }
  broadcastState();
}
