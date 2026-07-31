import { app } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ActiveSoftClient } from "./active-soft";
import { IntegrationLogger } from "./integration-logger";
import { JsonStore } from "./store";
import { ControlIdDeviceContact, InstallationCheck, InstallationReport } from "../shared/types";

const execFileAsync = promisify(execFile);
const FIREWALL_RULE_NAME = "Ponte ID - Control iD";
const CONTROL_ID_ONLINE_WINDOW_MS = 2 * 60 * 1000;

interface InstallationDependencies {
  store: JsonStore;
  activeSoft: ActiveSoftClient;
  listenerState: () => { running: boolean; port: number; error?: string };
  controlIdDevices: () => ControlIdDeviceContact[];
  networkAddresses: () => string[];
  restartListener: () => Promise<void>;
  log: IntegrationLogger;
}

export class InstallationService {
  constructor(private readonly dependencies: InstallationDependencies) {}

  async prepareComputer(): Promise<InstallationReport> {
    const settings = this.dependencies.store.getSettings();
    this.dependencies.log("system", "Preparação automática iniciada", {
      platform: process.platform,
      listenerPort: settings.listenerPort
    });

    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    if (!settings.autoStart) this.dependencies.store.saveSettings({ ...settings, autoStart: true });
    await this.dependencies.restartListener();

    if (process.platform === "win32") {
      try {
        await installWindowsFirewallRule(settings.listenerPort);
        this.dependencies.log("system", "Regra de Firewall do Windows criada", {
          name: FIREWALL_RULE_NAME,
          port: settings.listenerPort,
          remoteAddress: "LocalSubnet"
        });
      } catch (error) {
        this.dependencies.log("error", "Não foi possível criar a regra de Firewall", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return this.validate();
  }

  async validate(): Promise<InstallationReport> {
    const checks: InstallationCheck[] = [];
    const settings = this.dependencies.store.getSettings();
    const listener = this.dependencies.listenerState();
    const addresses = this.dependencies.networkAddresses();
    const students = this.dependencies.store.getStudents();
    const devices = this.dependencies.controlIdDevices();

    checks.push({
      id: "listener",
      title: "Receptor Control iD",
      status: listener.running ? "pass" : "fail",
      blocking: true,
      detail: listener.running
        ? `Escutando em 0.0.0.0:${listener.port}.`
        : `O receptor não iniciou na porta ${listener.port}: ${listener.error ?? "erro desconhecido"}.`,
      resolution: listener.running ? undefined : "Escolha outra porta livre, salve as configurações e execute a preparação novamente."
    });

    checks.push({
      id: "network-address",
      title: "Endereço de rede do computador",
      status: addresses.length ? "pass" : "fail",
      blocking: true,
      detail: addresses.length
        ? `Endereço disponível para as catracas: ${addresses.map((address) => `${address}:${listener.port}`).join(", ")}.`
        : "Nenhum endereço IPv4 de rede local foi detectado.",
      resolution: addresses.length ? undefined : "Conecte o computador por Ethernet à rede das catracas e tente novamente."
    });

    if (process.platform === "win32") {
      checks.push(await validateFirewall(listener.port));
      checks.push(await validateWindowsNetworkProfile());
      checks.push(await validateDhcp());
    } else {
      checks.push({
        id: "firewall",
        title: "Firewall do Windows",
        status: "warning",
        blocking: false,
        detail: "Esta verificação só pode ser concluída no computador Windows de destino.",
        resolution: "No Windows, clique em Preparar este computador e aceite a solicitação de administrador."
      });
    }

    const loginSettings = app.getLoginItemSettings();
    checks.push({
      id: "autostart",
      title: "Inicialização automática",
      status: loginSettings.openAtLogin ? "pass" : "fail",
      blocking: true,
      detail: loginSettings.openAtLogin
        ? "O Ponte ID está registrado para iniciar após o login do Windows."
        : "O auto-início ainda não está registrado no sistema.",
      resolution: loginSettings.openAtLogin ? undefined : "Clique em Preparar este computador ou ative Iniciar com o Windows nas Configurações."
    });

    if (settings.demoMode) {
      checks.push({
        id: "activesoft",
        title: "ActiveSoft SIGA",
        status: "fail",
        blocking: true,
        detail: "O modo demonstração está ativo; nenhuma conexão real foi validada.",
        resolution: "Desative o modo demonstração, informe o token e salve antes de validar a instalação."
      });
    } else {
      try {
        await this.dependencies.activeSoft.testConnection();
        await this.dependencies.activeSoft.testAttendancePermission();
        checks.push({
          id: "activesoft",
          title: "ActiveSoft SIGA",
          status: "pass",
          blocking: true,
          detail: "Leitura de alunos e autorização do endpoint de frequência confirmadas sem alterar dados."
        });
      } catch (error) {
        checks.push({
          id: "activesoft",
          title: "ActiveSoft SIGA",
          status: "fail",
          blocking: true,
          detail: error instanceof Error ? error.message : String(error),
          resolution: "Confira endereço, token, permissões e acesso à internet. O Console mostra a resposta completa da API."
        });
      }
    }

    checks.push({
      id: "students",
      title: "Cadastro local de alunos",
      status: students.length > 0 ? "pass" : "fail",
      blocking: true,
      detail: students.length > 0
        ? `${students.length} alunos sincronizados; ${students.filter((student) => student.urlFoto).length} possuem foto.`
        : "Nenhum aluno está disponível no cache local.",
      resolution: students.length > 0 ? undefined : "Corrija a conexão ActiveSoft e clique em Sincronizar."
    });

    const recentDevices = devices.filter((device) =>
      Date.now() - new Date(device.lastSeenAt).getTime() <= CONTROL_ID_ONLINE_WINDOW_MS
    );
    const latestDevice = [...devices].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
    checks.push({
      id: "device-event",
      title: "Comunicação da catraca",
      status: recentDevices.length ? "pass" : "fail",
      blocking: true,
      detail: recentDevices.length
        ? `${recentDevices.length} ${recentDevices.length === 1 ? "catraca conectada" : "catracas conectadas"}; último contato em ${new Date(latestDevice!.lastSeenAt).toLocaleString("pt-BR")}.`
        : latestDevice
          ? `A última comunicação ocorreu em ${new Date(latestDevice.lastSeenAt).toLocaleString("pt-BR")} e já está inativa.`
          : "O aplicativo ainda não recebeu nenhuma notificação Control iD.",
      resolution: recentDevices.length ? undefined : `Configure o Monitor para http://IP-DESTE-PC:${listener.port}/api/notifications e confirme o heartbeat ou faça uma passagem de teste.`
    });

    const mappingCount = this.dependencies.store.getControlIdMappingCount();
    checks.push({
      id: "registration-mapping",
      title: "Vínculo por matrícula",
      status: mappingCount > 0 ? "pass" : "warning",
      blocking: false,
      detail: mappingCount > 0
        ? `${mappingCount} associações user_id → matrícula conhecidas.`
        : "Nenhum vínculo por matrícula foi observado nos eventos recebidos. Isso não confirma que os cadastros estejam incorretos.",
      resolution: mappingCount > 0
        ? undefined
        : "No iDSecure, confira em Cadastros → Pessoas se o campo Matrícula/Registro contém a matrícula ActiveSoft. Uma atualização de usuário recebida pelo Ponte ID fará o contador aumentar."
    });

    checks.push({
      id: "turn-directions",
      title: "Sentidos da catraca",
      status: settings.turnLeftDirection !== settings.turnRightDirection ? "pass" : "warning",
      blocking: false,
      detail: `TURN LEFT = ${directionName(settings.turnLeftDirection)}; TURN RIGHT = ${directionName(settings.turnRightDirection)}.`,
      resolution: settings.turnLeftDirection !== settings.turnRightDirection
        ? undefined
        : "Faça uma entrada e uma saída físicas e ajuste os sentidos nas Configurações."
    });

    const report: InstallationReport = {
      checkedAt: new Date().toISOString(),
      ready: checks.every((check) => !check.blocking || check.status === "pass"),
      checks
    };
    this.dependencies.log(report.ready ? "system" : "error", report.ready ? "Instalação validada e pronta" : "Validação encontrou pendências", {
      ready: report.ready,
      checks: checks.map(({ id, status, detail }) => ({ id, status, detail }))
    });
    return report;
  }
}

async function installWindowsFirewallRule(port: number): Promise<void> {
  const innerScript = [
    `$existing=Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue`,
    "if($existing){$existing|Remove-NetFirewallRule}",
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Private -RemoteAddress LocalSubnet | Out-Null`
  ].join(";");
  const innerEncoded = Buffer.from(innerScript, "utf16le").toString("base64");
  const outerScript = `$p=Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${innerEncoded}'); exit $p.ExitCode`;
  const outerEncoded = Buffer.from(outerScript, "utf16le").toString("base64");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", outerEncoded], { timeout: 120_000 });
}

async function validateFirewall(port: number): Promise<InstallationCheck> {
  try {
    const script = `$r=Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue | Where-Object {$_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Profile.ToString().Contains('Private')}; if($r){$p=$r|Get-NetFirewallPortFilter|Where-Object {$_.Protocol -eq 'TCP' -and $_.LocalPort -eq '${port}'}; if($p){'PASS'}else{'WRONG_PORT'}}else{'MISSING'}`;
    const output = (await runPowerShell(script)).trim();
    if (output === "PASS") {
      return { id: "firewall", title: "Firewall do Windows", status: "pass", blocking: true, detail: `Entrada TCP ${port} liberada somente no perfil privado e rede local.` };
    }
    return {
      id: "firewall", title: "Firewall do Windows", status: "fail", blocking: true,
      detail: output === "WRONG_PORT" ? "A regra existe, mas aponta para outra porta." : "A regra de entrada não foi encontrada.",
      resolution: "Clique em Preparar este computador e aceite a confirmação de administrador do Windows."
    };
  } catch (error) {
    return {
      id: "firewall", title: "Firewall do Windows", status: "fail", blocking: true,
      detail: `Não foi possível consultar o Firewall: ${error instanceof Error ? error.message : String(error)}`,
      resolution: "Execute o aplicativo como administrador apenas durante a preparação e tente novamente."
    };
  }
}

async function validateWindowsNetworkProfile(): Promise<InstallationCheck> {
  try {
    const output = (await runPowerShell("(Get-NetConnectionProfile | Where-Object {$_.IPv4Connectivity -ne 'Disconnected'} | Select-Object -ExpandProperty NetworkCategory) -join ','")).trim();
    const isPrivate = output.split(",").some((profile) => profile === "Private" || profile === "DomainAuthenticated");
    return {
      id: "network-profile", title: "Perfil da rede Windows",
      status: isPrivate ? "pass" : "fail", blocking: true,
      detail: isPrivate ? `Perfil de rede adequado: ${output}.` : `Perfil atual: ${output || "não identificado"}. A regra privada do Firewall não será aplicada numa rede pública.`,
      resolution: isPrivate ? undefined : "Abra Configurações > Rede e Internet > Ethernet > Propriedades e altere Tipo de perfil de rede para Privada."
    };
  } catch (error) {
    return { id: "network-profile", title: "Perfil da rede Windows", status: "warning", blocking: false, detail: `Não foi possível consultar o perfil: ${String(error)}`, resolution: "Confirme manualmente que a conexão Ethernet está como Rede privada." };
  }
}

async function validateDhcp(): Promise<InstallationCheck> {
  try {
    const output = (await runPowerShell("(Get-NetIPInterface -AddressFamily IPv4 | Where-Object {$_.ConnectionState -eq 'Connected'} | Select-Object -ExpandProperty Dhcp) -join ','")).trim();
    const usesDhcp = output.split(",").some((value) => value === "Enabled");
    return {
      id: "stable-ip", title: "IP estável",
      status: usesDhcp ? "warning" : "pass", blocking: false,
      detail: usesDhcp ? "A interface utiliza DHCP; o endereço pode mudar após reiniciar." : "A interface conectada não depende de DHCP.",
      resolution: usesDhcp ? "No roteador da escola, crie uma reserva DHCP para o endereço MAC deste computador. É mais seguro que alterar IP manualmente." : undefined
    };
  } catch (error) {
    return { id: "stable-ip", title: "IP estável", status: "warning", blocking: false, detail: `Não foi possível verificar DHCP: ${String(error)}`, resolution: "Confirme uma reserva DHCP no roteador da escola." };
  }
}

async function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 30_000 });
  return stdout;
}

function directionName(direction: "E" | "S"): string {
  return direction === "E" ? "Entrada" : "Saída";
}
