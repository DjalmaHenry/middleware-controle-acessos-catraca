import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ActiveSoftClient } from "./active-soft";
import { IntegrationLogger } from "./integration-logger";
import { JsonStore } from "./store";
import { ControlIdDeviceContact, InstallationCheck, InstallationReport } from "../shared/types";
import { enableAutoStart, isAutoStartEnabled } from "./startup";
import { buildInstallationLog } from "./installation-log";
import { buildStudentCacheCheck } from "./student-cache-check";

const execFileAsync = promisify(execFile);
const FIREWALL_RULE_NAME = "Ponte ID - Control iD";
const CONTROL_ID_ONLINE_WINDOW_MS = 2 * 60 * 1000;

interface InstallationDependencies {
  store: JsonStore;
  activeSoft: ActiveSoftClient;
  controlIdDevices: () => ControlIdDeviceContact[];
  observedControlIdTurns: () => Array<"left" | "right">;
  networkAddresses: () => string[];
  ensureListener: () => Promise<{ running: boolean; port: number; error?: string }>;
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

    enableAutoStart();
    if (!settings.autoStart) this.dependencies.store.saveSettings({ ...settings, autoStart: true });
    await this.dependencies.ensureListener();

    if (process.platform === "win32") {
      try {
        const remoteAddresses = firewallRemoteAddresses(settings.idSecureBaseUrl);
        await installWindowsFirewallRule(settings.listenerPort, remoteAddresses);
        this.dependencies.log("system", "Regra de Firewall do Windows criada", {
          name: FIREWALL_RULE_NAME,
          port: settings.listenerPort,
          profiles: ["Domain", "Private", "Public"],
          remoteAddresses
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
    const listener = await this.dependencies.ensureListener();
    const addresses = this.dependencies.networkAddresses();
    const students = this.dependencies.store.getStudents();
    const studentSync = this.dependencies.store.getStudentSync();
    const devices = this.dependencies.controlIdDevices();
    const observedTurns = this.dependencies.observedControlIdTurns();

    checks.push({
      id: "listener",
      title: "Receptor Control iD",
      status: listener.running ? "pass" : "fail",
      blocking: true,
      detail: listener.running
        ? `Escutando em 0.0.0.0:${listener.port}; resposta local /health confirmada.`
        : `O receptor não iniciou na porta ${listener.port}: ${listener.error ?? "erro desconhecido"}.`,
      resolution: listener.running ? undefined : "O Ponte ID já tentou reiniciar o receptor. Feche outro programa que esteja usando essa porta ou escolha uma porta livre e execute a preparação novamente."
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

    const autoStartEnabled = isAutoStartEnabled();
    checks.push({
      id: "autostart",
      title: "Inicialização automática",
      status: autoStartEnabled ? "pass" : "fail",
      blocking: true,
      detail: autoStartEnabled
        ? "O Ponte ID está registrado e habilitado para iniciar após o login do Windows."
        : "O auto-início não está registrado ou foi desabilitado nas Aplicações de Arranque do Windows.",
      resolution: autoStartEnabled ? undefined : "Clique em Preparar este computador e confirme no Gerenciador de Tarefas que Ponte ID está habilitado em Aplicativos de inicialização."
    });

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

    checks.push(buildStudentCacheCheck(students, studentSync));

    checks.push(await validateIdSecure(settings.idSecureBaseUrl));

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
          : `O receptor local está pronto, mas nenhuma catraca enviou notificações. O painel iDSecure em ${settings.idSecureBaseUrl} não encaminha esses eventos automaticamente.`,
      resolution: recentDevices.length ? undefined : `No iDSecure, abra Acesso → Dispositivos, obtenha o IP de uma catraca e configure o Monitor dela para http://IP-DESTE-PC:${listener.port}/api/notifications. Depois faça uma passagem de teste.`
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

    const directionsDiffer = settings.turnLeftDirection !== settings.turnRightDirection;
    const observedBothTurns = observedTurns.includes("left") && observedTurns.includes("right");
    const directionsValidated = recentDevices.length > 0 && observedBothTurns && directionsDiffer;
    checks.push({
      id: "turn-directions",
      title: "Calibração dos sentidos",
      status: directionsValidated ? "pass" : "warning",
      blocking: false,
      detail: directionsValidated
        ? `TURN LEFT e TURN RIGHT foram recebidos; configuração local: esquerda = ${directionName(settings.turnLeftDirection)}, direita = ${directionName(settings.turnRightDirection)}.`
        : recentDevices.length === 0
          ? "Não validado: nenhuma catraca comunicou com o Ponte ID nos últimos 2 minutos."
          : !observedBothTurns
            ? `Contato recebido, mas o teste físico ainda não observou os dois giros. Eventos observados: ${observedTurns.length ? observedTurns.map(turnName).join(", ") : "nenhum TURN LEFT/RIGHT"}.`
            : "Os dois giros foram observados, mas estão configurados com o mesmo movimento.",
      resolution: directionsValidated
        ? undefined
        : recentDevices.length === 0
          ? "Conecte uma catraca e faça uma entrada e uma saída físicas antes de validar os sentidos."
          : !observedBothTurns
            ? "Faça uma passagem em cada sentido para o Ponte ID receber TURN LEFT e TURN RIGHT."
            : "Nas Configurações, atribua movimentos diferentes para giro à esquerda e giro à direita."
    });

    const logResult = buildInstallationLog(checks);
    const report: InstallationReport = {
      checkedAt: new Date().toISOString(),
      ready: logResult.ready,
      checks
    };
    this.dependencies.log(report.ready ? "system" : "error", logResult.title, logResult.payload);
    return report;
  }
}

async function installWindowsFirewallRule(port: number, remoteAddresses: string[]): Promise<void> {
  const resultFile = path.join(tmpdir(), `ponte-id-firewall-${randomUUID()}.txt`).replaceAll("'", "''");
  const addressList = remoteAddresses.map((address) => `'${address.replaceAll("'", "''")}'`).join(",");
  const innerScript = [
    "$ErrorActionPreference='Stop'",
    "try{",
    `  $existing=Get-NetFirewallRule -PolicyStore PersistentStore -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue`,
    "  if($existing){$existing|Remove-NetFirewallRule}",
    `  $created=New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any -RemoteAddress @(${addressList})`,
    "  if(-not $created){throw 'A regra do Firewall não foi criada.'}",
    `  'PASS'|Set-Content -LiteralPath '${resultFile}' -Encoding UTF8`,
    "  exit 0",
    "}catch{",
    `  ($_|Out-String)|Set-Content -LiteralPath '${resultFile}' -Encoding UTF8`,
    "  exit 1",
    "}"
  ].join(";");
  const innerEncoded = Buffer.from(innerScript, "utf16le").toString("base64");
  const outerScript = [
    `$p=Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${innerEncoded}')`,
    `$detail=if(Test-Path -LiteralPath '${resultFile}'){Get-Content -LiteralPath '${resultFile}' -Raw}else{'O processo elevado não retornou detalhes.'}`,
    `Remove-Item -LiteralPath '${resultFile}' -Force -ErrorAction SilentlyContinue`,
    "if($p.ExitCode -ne 0){Write-Error $detail;exit $p.ExitCode}",
    "Write-Output $detail"
  ].join(";");
  const outerEncoded = Buffer.from(outerScript, "utf16le").toString("base64");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", outerEncoded], { timeout: 120_000 });
}

export function firewallRemoteAddresses(idSecureBaseUrl: string): string[] {
  const addresses = ["LocalSubnet"];
  try {
    const octets = new URL(idSecureBaseUrl).hostname.split(".").map(Number);
    const isIpv4 = octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
    const isPrivate = isIpv4 && (
      octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
    );
    if (isPrivate) addresses.push(`${octets[0]}.${octets[1]}.${octets[2]}.0/24`);
  } catch {
    // LocalSubnet remains the safe fallback when the configured URL is invalid.
  }
  return [...new Set(addresses)];
}

async function validateIdSecure(baseUrl: string): Promise<InstallationCheck> {
  const result = await probeIdSecure(baseUrl);
  return {
    id: "idsecure",
    title: "Servidor iDSecure",
    status: result.ok ? "pass" : "warning",
    blocking: false,
    detail: result.ok
      ? `${result.url} está acessível${result.statusCode ? ` (HTTP ${result.statusCode})` : ""}. Esta é a interface central; não é a porta receptora do Ponte ID.`
      : `Não foi possível alcançar ${result.url}: ${result.detail ?? "sem resposta"}.`,
    resolution: result.ok
      ? undefined
      : "Confirme se o endereço do iDSecure está correto e se este computador está na rede 192.168.1.x. Esse aviso não substitui o teste da porta 8787."
  };
}

export async function probeIdSecure(baseUrl: string, timeoutMs = 3_000): Promise<{
  ok: boolean;
  url: string;
  statusCode?: number;
  detail?: string;
}> {
  let target: URL;
  try {
    target = new URL(baseUrl);
    if (target.protocol !== "https:") throw new Error("o endereço deve usar HTTPS");
  } catch (error) {
    return { ok: false, url: baseUrl, detail: error instanceof Error ? error.message : String(error) };
  }

  target.hash = "";
  return new Promise((resolve) => {
    const request = httpsRequest(target, {
      method: "HEAD",
      rejectUnauthorized: false
    }, (response) => {
      response.resume();
      resolve({ ok: true, url: target.origin, statusCode: response.statusCode });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`tempo limite de ${timeoutMs} ms excedido`)));
    request.on("error", (error) => resolve({ ok: false, url: target.origin, detail: error.message }));
    request.end();
  });
}

async function validateFirewall(port: number): Promise<InstallationCheck> {
  try {
    const script = [
      `$categories=@(Get-NetConnectionProfile | Where-Object {$_.IPv4Connectivity -ne 'Disconnected'} | Select-Object -ExpandProperty NetworkCategory)`,
      `$required=@($categories | ForEach-Object {if($_ -eq 'DomainAuthenticated'){'Domain'}elseif($_ -eq 'Private'){'Private'}elseif($_ -eq 'Public'){'Public'}} | Select-Object -Unique)`,
      "if($required.Count -eq 0){'UNSUPPORTED_PROFILE';exit}",
      `$r=Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue | Where-Object {`,
      "  $profile=$_.Profile.ToString(); $missing=@($required | Where-Object {$profile -ne 'Any' -and -not $profile.Contains($_)});",
      "  $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $missing.Count -eq 0",
      "}",
      "if(-not $r){'MISSING_EFFECTIVE';exit}",
      `$p=$r|Get-NetFirewallPortFilter|Where-Object {$_.Protocol -eq 'TCP' -and $_.LocalPort -eq '${port}'}`,
      "if(-not $p){'WRONG_PORT';exit}",
      "$a=$r|Get-NetFirewallAddressFilter|Where-Object {$_.RemoteAddress -contains 'LocalSubnet'}",
      "if(-not $a){'WRONG_SCOPE';exit}",
      "'PASS'"
    ].join(";");
    const output = (await runPowerShell(script)).trim();
    if (output === "PASS") {
      return { id: "firewall", title: "Firewall do Windows", status: "pass", blocking: true, detail: `Entrada TCP ${port} efetiva no perfil atual, limitada à sub-rede local.` };
    }
    const details: Record<string, string> = {
      WRONG_PORT: "A regra efetiva existe, mas aponta para outra porta.",
      WRONG_SCOPE: "A regra efetiva não está limitada à sub-rede local.",
      UNSUPPORTED_PROFILE: "A rede ativa não pôde ser classificada pelo Windows.",
      MISSING_EFFECTIVE: "A regra não aparece na política efetiva do Firewall. Uma política da organização pode estar ignorando regras locais."
    };
    return {
      id: "firewall", title: "Firewall do Windows", status: "fail", blocking: true,
      detail: details[output] ?? `A regra de entrada não foi validada: ${output || "sem resposta"}.`,
      resolution: output === "MISSING_EFFECTIVE"
        ? `Solicite ao TI uma regra corporativa de entrada TCP ${port}, todos os perfis, origem restrita à rede local. Não desative o Firewall.`
        : "Clique em Preparar este computador. Em equipamento gerenciado, solicite ao TI a aplicação da regra por política da organização."
    };
  } catch (error) {
    return {
      id: "firewall", title: "Firewall do Windows", status: "fail", blocking: true,
      detail: `Não foi possível consultar o Firewall: ${error instanceof Error ? error.message : String(error)}`,
      resolution: "Execute a preparação com elevação. Se o computador for gerenciado, solicite ao TI a regra pelo Firewall corporativo."
    };
  }
}

async function validateWindowsNetworkProfile(): Promise<InstallationCheck> {
  try {
    const output = (await runPowerShell("(Get-NetConnectionProfile | Where-Object {$_.IPv4Connectivity -ne 'Disconnected'} | Select-Object -ExpandProperty NetworkCategory) -join ','")).trim();
    const profiles = output.split(",").filter(Boolean);
    const isTrusted = profiles.some((profile) => profile === "Private" || profile === "DomainAuthenticated");
    const isPublic = profiles.includes("Public");
    const isManagedDomain = profiles.includes("DomainAuthenticated");
    return {
      id: "network-profile", title: "Perfil da rede Windows",
      status: isTrusted ? "pass" : isPublic ? "warning" : "fail", blocking: !isPublic,
      detail: isManagedDomain
        ? `Perfil gerenciado por domínio adequado: ${output}. Não é necessário alterá-lo para Privado.`
        : isTrusted
          ? `Perfil de rede adequado: ${output}.`
          : isPublic
            ? "Perfil Público gerenciado detectado. O Ponte ID mantém esse perfil e usa uma regra de entrada própria, restrita às redes internas configuradas."
            : `Perfil atual: ${output || "não identificado"}.`,
      resolution: isTrusted
        ? undefined
        : isPublic
          ? "Não é necessário alterar uma configuração gerenciada pela organização. Confirme apenas que a verificação do Firewall ficou verde."
          : "Solicite ao TI a classificação da rede e uma regra corporativa do Ponte ID. Não tente contornar a política."
    };
  } catch (error) {
    return { id: "network-profile", title: "Perfil da rede Windows", status: "warning", blocking: false, detail: `Não foi possível consultar o perfil: ${String(error)}`, resolution: "Confirme com o TI se a conexão usa o perfil Domínio ou Privado." };
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

function turnName(turn: "left" | "right"): string {
  return turn === "left" ? "TURN LEFT" : "TURN RIGHT";
}
