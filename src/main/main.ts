import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import path from "node:path";
import { networkInterfaces } from "node:os";
import { ActiveSoftClient } from "./active-soft";
import { AccessService } from "./access-service";
import { ControlIdServer } from "./control-id-server";
import { ControlIdPollingService } from "./control-id-polling";
import { JsonStore } from "./store";
import { AppState, ControlIdDeviceContact, InstallationReport, SaveSettingsInput, Settings } from "../shared/types";
import { createIntegrationLogger, IntegrationLogger } from "./integration-logger";
import { InstallationService } from "./installation-service";
import { PhotoService } from "./photo-service";
import { enableAutoStart } from "./startup";
import { probePonteListener } from "./listener-health";
import { IdSecureMonitorService, IdSecureMonitorStatus } from "./idsecure-monitor";

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: JsonStore;
let activeSoft: ActiveSoftClient;
let accessService: AccessService;
let controlIdServer: ControlIdServer;
let controlIdPolling: ControlIdPollingService;
let idSecureMonitor: IdSecureMonitorService;
let integrationLog: IntegrationLogger;
let installationService: InstallationService;
let photoService: PhotoService;
let installationReport: InstallationReport | undefined;
let listenerState: AppState["listener"] = { running: false, port: 8787 };
let activeSoftState: AppState["activeSoft"] = { status: "unknown" };
let idSecureState: IdSecureMonitorStatus = { status: "unknown" };
let listenerRestartPromise: Promise<void> | undefined;
const controlIdDevices = new Map<string, ControlIdDeviceContact>();
const observedAccessDirections = new Set<"E" | "S">();
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
  controlIdPolling = new ControlIdPollingService(
    accessService,
    store,
    () => store.getSettings(),
    integrationLog,
    registerControlIdContact,
    (deviceName, event, sourceId) => idSecureMonitor.handlePhysicalTurn(deviceName, event, sourceId)
  );
  idSecureMonitor = new IdSecureMonitorService(
    accessService,
    store,
    () => store.getSettings(),
    integrationLog,
    (status) => { idSecureState = status; broadcastState(); },
    (direction) => { observedAccessDirections.add(direction); }
  );
  installationService = new InstallationService({
    store,
    activeSoft,
    controlIdDevices: () => [...controlIdDevices.values()],
    observedAccessDirections: () => [...observedAccessDirections],
    idSecureMonitor,
    networkAddresses: localIpv4Addresses,
    ensureListener: ensureListenerHealthy,
    ensureControlIdTransport: configureControlIdTransport,
    log: integrationLog
  });
  registerIpc();
  createTray();
  createWindow();
  await configureControlIdTransport();
  await idSecureMonitor.restart();
  integrationLog("system", "Ponte ID iniciado", {
    version: app.getVersion(),
    platform: process.platform,
    controlIdMode: startupSettings.controlIdMode,
    listenerPort: startupSettings.controlIdMode === "listener" ? startupSettings.listenerPort : undefined,
    devices: startupSettings.controlIdDevices.filter((device) => device.enabled).map((device) => `${device.host}:${device.port}`)
  });
  const listenerWatchdog = setInterval(() => {
    if (store.getSettings().controlIdMode === "listener") void ensureListenerHealthy();
  }, 30_000);
  listenerWatchdog.unref();
  if (store.getSettings().configured) void synchronize();
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
  window.once("ready-to-show", showWindow);
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
  const { activeSoftToken, controlIdPassword, idSecurePassword, ...publicSettings } = settings;
  const students = store.getStudents();
  const studentSync = store.getStudentSync();
  const visibleStudents = studentSync ? students : [];
  return {
    appVersion: app.getVersion(),
    settings: {
      ...publicSettings,
      tokenConfigured: Boolean(activeSoftToken),
      controlIdPasswordConfigured: Boolean(controlIdPassword),
      idSecurePasswordConfigured: Boolean(idSecurePassword)
    },
    listener: listenerState,
    controlId: { devices: [...controlIdDevices.values()] },
    idSecure: idSecureState,
    activeSoft: activeSoftState,
    students: visibleStudents,
    recentAccesses: store.getRecentAccesses(),
    pendingCount: 0,
    integrationLogs: store.getIntegrationLogs(),
    networkAddresses: localIpv4Addresses(),
    controlIdMappingCount: store.getControlIdMappingCount(),
    platform: process.platform,
    installationReport
  };
}

function broadcastState(): void { if (window && !window.isDestroyed()) window.webContents.send("state:changed", state()); }

async function restartListener(): Promise<void> {
  if (listenerRestartPromise) return listenerRestartPromise;
  listenerRestartPromise = restartListenerNow().finally(() => { listenerRestartPromise = undefined; });
  return listenerRestartPromise;
}

async function restartListenerNow(): Promise<void> {
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

async function ensureListenerHealthy(): Promise<AppState["listener"]> {
  const port = store.getSettings().listenerPort;
  const currentHealth = await probePonteListener(port);
  if (currentHealth.ok) {
    if (!listenerState.running || listenerState.port !== port) {
      listenerState = { running: true, port };
      broadcastState();
    }
    return listenerState;
  }

  await restartListener();
  const repairedHealth = await probePonteListener(port);
  if (!repairedHealth.ok) {
    const detail = repairedHealth.detail ?? "A verificação local não recebeu resposta.";
    listenerState = { running: false, port, error: detail };
    integrationLog?.("error", `Receptor Control iD indisponível após tentativa automática de reparo`, {
      port,
      detail
    });
    broadcastState();
  }
  return listenerState;
}

async function configureControlIdTransport(): Promise<void> {
  const settings = store.getSettings();
  if (settings.controlIdMode === "polling") {
    await controlIdServer.stop();
    listenerState = { running: false, port: settings.listenerPort };
    await controlIdPolling.restart();
    broadcastState();
    return;
  }

  controlIdPolling.stop();
  await ensureListenerHealthy();
}

async function synchronize(): Promise<void> {
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
    const controlIdMode = input.controlIdMode === "listener" ? "listener" : "polling";
    const listenerPort = validPort(input.listenerPort, "Porta do receptor");
    const controlIdDevices = validateControlIdDevices(input.controlIdDevices);
    const settings: Settings = {
      ...input,
      configured: true,
      autoStart: true,
      controlIdMode,
      controlIdUsername: input.controlIdUsername.trim() || "admin",
      controlIdDevices,
      listenerPort,
      activeSoftToken: input.activeSoftToken?.trim() || current.activeSoftToken,
      controlIdPassword: input.controlIdPassword?.trim() || current.controlIdPassword,
      idSecureUsername: input.idSecureUsername.trim(),
      idSecurePassword: input.idSecurePassword?.trim() || current.idSecurePassword
    };
    store.saveSettings(settings);
    enableAutoStart();
    await configureControlIdTransport();
    await idSecureMonitor.restart();
    await synchronize();
    return state();
  });
  ipcMain.handle("sync:run", synchronize);
  ipcMain.handle("connection:test", async () => { await activeSoft.testConnection(); return true; });
  ipcMain.handle("photo:get", async (_event, accessId: string) => {
    if (typeof accessId !== "string" || accessId.length > 100) return null;
    const access = store.getRecentAccesses().find((item) => item.id === accessId);
    if (!access) return null;
    const currentStudent = store.getStudents().find((student) => student.id === access.studentId)
      ?? store.getStudents().find((student) => normalizeRegistration(student.matricula) === normalizeRegistration(access.matricula));
    const activeSoftPhoto = await photoService.resolve(currentStudent?.urlFoto ?? access.photoUrl);
    if (activeSoftPhoto) return activeSoftPhoto;
    const idSecurePhoto = await idSecureMonitor.resolveAccessPhoto(access.idSecurePhotoPath);
    if (idSecurePhoto) return idSecurePhoto;
    return controlIdPolling.resolveUserPhoto(access.controlIdUserId, access.controlIdDeviceName);
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

app.on("before-quit", () => {
  quitting = true;
  controlIdPolling?.stop();
  idSecureMonitor?.stop();
  void controlIdServer?.stop();
});
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

function validateControlIdDevices(value: unknown): Settings["controlIdDevices"] {
  if (!Array.isArray(value)) throw new Error("A lista de catracas é inválida.");
  const addresses = new Set<string>();
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`A catraca ${index + 1} é inválida.`);
    const source = entry as Partial<Settings["controlIdDevices"][number]>;
    const name = String(source.name ?? "").trim() || `Catraca ${index + 1}`;
    const rawHost = String(source.host ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(`http://${rawHost}`);
    } catch {
      throw new Error(`${name}: informe somente um IP ou nome de rede válido.`);
    }
    if (!rawHost || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
      throw new Error(`${name}: informe o IP sem http://, caminho ou porta. Use o campo Porta ao lado.`);
    }
    const host = parsed.hostname;
    const port = validPort(Number(source.port), `${name}: porta`);
    const address = `${host}:${port}`.toLowerCase();
    if (addresses.has(address)) throw new Error(`${name}: o endereço ${host}:${port} está repetido.`);
    addresses.add(address);

    const baseId = String(source.id ?? "").trim() || `device-${index + 1}`;
    let id = baseId;
    while (ids.has(id)) id = `${baseId}-${index + 1}`;
    ids.add(id);
    return { id, name, host, port, enabled: source.enabled !== false };
  });
}

function validPort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label}: informe um número entre 1 e 65535.`);
  }
  return value;
}

function normalizeRegistration(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, "");
}
