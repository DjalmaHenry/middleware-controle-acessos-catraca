import { app, LoginItemSettings } from "electron";

export const AUTO_START_ARGUMENT = "--autostart";
const LOGIN_ITEM_NAME = "Ponte ID";

export function enableAutoStart(): void {
  if (process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: true,
      enabled: true,
      name: LOGIN_ITEM_NAME,
      path: process.execPath,
      args: [AUTO_START_ARGUMENT]
    });
    return;
  }

  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
}

export function isAutoStartEnabled(): boolean {
  const settings = process.platform === "win32"
    ? app.getLoginItemSettings({ path: process.execPath, args: [AUTO_START_ARGUMENT] })
    : app.getLoginItemSettings();

  return loginItemWillLaunch(settings, process.platform);
}

export function wasStartedAutomatically(): boolean {
  return process.argv.includes(AUTO_START_ARGUMENT);
}

export function loginItemWillLaunch(
  settings: Pick<LoginItemSettings, "openAtLogin" | "executableWillLaunchAtLogin">,
  platform: NodeJS.Platform
): boolean {
  return platform === "win32"
    ? settings.executableWillLaunchAtLogin || settings.openAtLogin
    : settings.openAtLogin;
}
