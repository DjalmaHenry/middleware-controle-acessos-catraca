const $ = (selector) => document.querySelector(selector);
let appState;
let consoleFilter = "all";
const photoCache = new Map();
const photoRequests = new Map();
const photoObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    photoObserver.unobserve(entry.target);
    hydrateAccessPhoto(entry.target);
  }), { rootMargin: "120px" })
  : null;

const titles = {
  dashboard: ["Monitor de acesso", "Acompanhe as entradas em tempo real"],
  history: ["Histórico", "Passagens processadas por este computador"],
  console: ["Console de integração", "Eventos recebidos e enviados em tempo real"],
  installation: ["Guia de instalação", "Validação técnica para implantação no Windows"],
  settings: ["Configurações", "Conexões e funcionamento do aplicativo"],
  "token-guide": ["Token ActiveSoft", "Criação e permissões da credencial"]
};
let initialViewSelected = false;

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  selectView(button.dataset.view, button);
}));

function selectView(view, navButton) {
  document.querySelectorAll(".nav-item,.view").forEach((item) => item.classList.remove("active"));
  if (navButton) navButton.classList.add("active");
  else if (view === "token-guide") document.querySelector('.nav-item[data-view="settings"]').classList.add("active");
  $(`#${view}`).classList.add("active");
  $("#page-title").textContent = titles[view][0];
  $("#page-subtitle").textContent = titles[view][1];
  $("#sync-button").style.display = ["dashboard", "history"].includes(view) ? "block" : "none";
  if (view === "history" && appState) renderHistory(appState);
  hydrateAccessPhotos();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function timeParts(iso) {
  const date = new Date(iso);
  return { time: date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), date: date.toLocaleDateString("pt-BR") };
}

function render(state) {
  appState = state;
  document.body.classList.toggle("developer-mode", state.settings.developerMode);
  const activeView = document.querySelector(".view.active")?.id;
  if (!state.settings.developerMode && ["console", "installation"].includes(activeView)) {
    document.querySelector('.nav-item[data-view="dashboard"]').click();
  }
  if (!initialViewSelected && !state.settings.configured) {
    initialViewSelected = true;
    document.querySelector('.nav-item[data-view="settings"]').click();
  }
  renderControlIdStatus(state);
  const activeDot = $("#active-dot");
  activeDot.className = `dot ${state.activeSoft.status === "online" ? "ok" : state.activeSoft.status === "offline" ? "bad" : ""}`;
  $("#active-status").textContent = state.activeSoft.status === "online" ? "Conectada" : state.activeSoft.status === "offline" ? "Sem conexão" : "Aguardando teste";
  $("#queue-status").textContent = `${state.pendingCount} ${state.pendingCount === 1 ? "pendência" : "pendências"}`;
  $("#clear-queue").hidden = state.pendingCount === 0;
  $("#student-count").textContent = `${state.students.length} sincronizados`;
  const latest = state.recentAccesses[0];
  if (latest) {
    const parts = timeParts(latest.occurredAt);
    $("#last-access").innerHTML = `<div class="access-hero"><div class="access-photo-frame"><span class="access-photo-fallback"><img src="assets/ponte-id-logo.png" alt=""><b>${escapeHtml(studentInitial(latest.studentName))}</b></span>${accessPhotoImage(latest, "access-photo", `Foto de ${latest.studentName}`)}</div><div class="access-overlay"><span class="eyebrow">Último acesso</span><h2>${escapeHtml(latest.studentName)}</h2><p>${escapeHtml(latest.matricula)} · ${latest.direction === "E" ? "Entrada" : "Saída"}</p><div class="access-time"><strong>${parts.time}</strong><small>${parts.date}</small></div></div></div>`;
  }
  $("#recent-list").innerHTML = state.recentAccesses.length ? state.recentAccesses.slice(0, 7).map(recentRow).join("") : `<div class="empty-state" style="padding:55px 20px"><p>Nenhuma passagem registrada.</p></div>`;
  if ($("#history").classList.contains("active")) renderHistory(state);
  hydrateAccessPhotos();
  renderConsole(state);
  renderInstallationGuide(state);
  renderInstallationReport(state.installationReport);
  fillSettings(state);
}

function renderControlIdStatus(state) {
  const dot = $("#listener-dot");
  const status = $("#listener-status");
  if (!state.settings.idSecurePasswordConfigured || !state.settings.idSecureUsername) {
    dot.className = "dot";
    status.textContent = "Configure o iDSecure";
    status.title = "Informe o usuário e a senha do painel geral iDSecure";
    return;
  }
  if (state.idSecure?.status === "online") {
    dot.className = "dot ok";
    status.textContent = "Monitor iDSecure conectado";
    status.title = state.idSecure.lastSeenAt
      ? `Última consulta: ${new Date(state.idSecure.lastSeenAt).toLocaleString("pt-BR")}`
      : state.idSecure.message;
    return;
  }
  if (state.idSecure?.status === "offline") {
    dot.className = "dot bad";
    status.textContent = "Monitor iDSecure offline";
    status.title = state.idSecure.message || "Abra o Console para consultar o erro";
    return;
  }
  dot.className = "dot";
  status.textContent = "Conectando ao iDSecure";
  status.title = state.idSecure?.message || "Aguardando a primeira consulta";
}

const consoleLabels = {
  "device-in": "DISPOSITIVO → APP",
  "device-out": "APP → DISPOSITIVO",
  "api-out": "APP → API",
  "api-in": "API → APP",
  system: "SISTEMA",
  error: "ERRO"
};

function renderConsole(state) {
  const output = $("#console-output");
  if (!output) return;
  const shouldScroll = $("#console-autoscroll").checked;
  const visibleLogs = consoleFilter === "all"
    ? state.integrationLogs
    : state.integrationLogs.filter((entry) => entry.category === consoleFilter);
  output.innerHTML = visibleLogs.length
    ? visibleLogs.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString("pt-BR", { hour12: false });
      const payload = entry.payload === undefined ? "" : `<pre>${escapeHtml(JSON.stringify(entry.payload, null, 2))}</pre>`;
      return `<div class="console-entry ${entry.category}"><time>${time}</time><span class="channel">${consoleLabels[entry.category]}</span><div><strong>${escapeHtml(entry.title)}</strong>${payload}</div></div>`;
    }).join("")
    : `<div class="console-empty">${state.integrationLogs.length ? "Nenhum evento deste tipo." : "Aguardando eventos de integração."}</div>`;
  if (shouldScroll) output.scrollTop = output.scrollHeight;
}

function selectConsoleFilter(category) {
  consoleFilter = category;
  document.querySelectorAll(".console-filter").forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (appState) renderConsole(appState);
}

function renderInstallationGuide(state) {
  const polling = state.settings.controlIdMode === "polling";
  $("#guide-port").textContent = polling ? "Consulta ativa (saída)" : `Receptor TCP ${state.listener.port}`;
  $("#guide-idsecure").textContent = state.settings.idSecureBaseUrl;
  $("#guide-idsecure-step").textContent = state.settings.idSecureBaseUrl;
  $("#guide-addresses").textContent = state.networkAddresses.length
    ? state.networkAddresses.map((address) => polling ? address : `${address}:${state.listener.port}`).join(" · ")
    : "Nenhum IPv4 de rede detectado";
  $("#guide-mappings").textContent = `${state.controlIdMappingCount} ${state.controlIdMappingCount === 1 ? "matrícula" : "matrículas"}`;
  const remoteScope = ["localsubnet", idSecureSubnet(state.settings.idSecureBaseUrl)].filter(Boolean).join(",");
  $("#firewall-command").textContent = polling
    ? "Nenhuma regra de entrada é necessária no modo Consulta ativa."
    : `netsh advfirewall firewall add rule name="Ponte ID - Control iD" dir=in action=allow protocol=TCP localport=${state.listener.port} profile=any remoteip=${remoteScope}`;
}

function idSecureSubnet(baseUrl) {
  try {
    const parts = new URL(baseUrl).hostname.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "";
    const isPrivate = parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
    return isPrivate ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : "";
  } catch { return ""; }
}

function renderInstallationReport(report) {
  if (!report) return;
  const badge = $("#installation-status-badge");
  badge.className = `installation-status ${report.ready ? "ready" : "blocked"}`;
  badge.textContent = report.ready ? "Pronto para produção" : "Pendências encontradas";
  $("#installation-status-title").textContent = report.ready
    ? "Instalação validada"
    : `${report.checks.filter((check) => check.blocking && check.status !== "pass").length} bloqueios precisam de atenção`;
  $("#installation-status-text").textContent = `Última validação: ${new Date(report.checkedAt).toLocaleString("pt-BR")}. Avisos não impedem o funcionamento, mas devem ser revisados antes da entrega.`;
  const statusSymbol = { pass: "✓", warning: "!", fail: "×", running: "…" };
  $("#installation-results").innerHTML = report.checks.map((check) => `
    <article class="installation-result ${check.status}">
      <header><span>${statusSymbol[check.status]}</span><strong>${escapeHtml(check.title)}</strong></header>
      <p>${escapeHtml(check.detail)}</p>
      ${check.resolution ? `<p class="resolution">Como corrigir: ${escapeHtml(check.resolution)}</p>` : ""}
    </article>
  `).join("");
}

async function runInstallationAction(action, message) {
  const progress = $("#installation-progress");
  const prepare = $("#prepare-installation");
  const validate = $("#validate-installation");
  progress.hidden = false;
  progress.textContent = message;
  prepare.disabled = true;
  validate.disabled = true;
  try {
    const report = await action();
    renderInstallationReport(report);
  } catch (error) {
    progress.textContent = `Falha durante a operação: ${error.message}`;
  } finally {
    prepare.disabled = false;
    validate.disabled = false;
    progress.hidden = true;
  }
}

function recentRow(item) {
  const parts = timeParts(item.occurredAt);
  const avatar = `<span class="avatar-shell"><span class="recent-avatar">${escapeHtml(studentInitial(item.studentName))}</span>${accessPhotoImage(item, "avatar-photo", `Foto de ${item.studentName}`)}</span>`;
  return `<div class="recent-item">${avatar}<div><strong>${escapeHtml(item.studentName)}</strong><small>${parts.time} · ${item.direction === "E" ? "Entrada" : "Saída"}</small></div>${accessStatus(item)}</div>`;
}

function historyRow(item) {
  const parts = timeParts(item.occurredAt);
  return `<tr><td><div class="student-cell"><span class="avatar-shell history-avatar"><span class="recent-avatar">${escapeHtml(studentInitial(item.studentName))}</span>${accessPhotoImage(item, "avatar-photo", `Foto de ${item.studentName}`)}</span><strong>${escapeHtml(item.studentName)}</strong></div></td><td>${escapeHtml(item.matricula)}</td><td>${parts.date} às ${parts.time}</td><td>${item.direction === "E" ? "Entrada" : "Saída"}</td><td>${accessStatus(item)}</td></tr>`;
}

function renderHistory(state) {
  $("#history-body").innerHTML = state.recentAccesses.map(historyRow).join("");
}

function accessStatus(item) {
  const labels = { sent: "Enviado", queued: "Na fila", sending: "Enviando", failed: "Não enviado" };
  const title = item.message ? ` title="${escapeHtml(item.message)}"` : "";
  return `<span class="status-pill ${item.status}"${title}>${labels[item.status] || "Não enviado"}</span>`;
}

function accessPhotoImage(item, className, alt) {
  const cached = photoCache.get(item.id);
  const cachedSource = cached?.value && cached.expiresAt > Date.now() ? cached.value : null;
  const readyClass = cachedSource ? " is-ready" : "";
  const source = cachedSource ? ` src="${escapeHtml(cachedSource)}"` : "";
  return `<img class="${className}${readyClass}" data-access-photo-id="${escapeHtml(item.id)}"${source} alt="${escapeHtml(alt)}" decoding="async">`;
}

function studentInitial(name) {
  return String(name || "?").trim().charAt(0).toUpperCase() || "?";
}

function hydrateAccessPhotos() {
  photoObserver?.disconnect();
  document.querySelectorAll("img[data-access-photo-id]").forEach((image) => {
    if (photoObserver) photoObserver.observe(image);
    else hydrateAccessPhoto(image);
  });
}

function hydrateAccessPhoto(image) {
  const accessId = image.dataset.accessPhotoId;
  if (!accessId || image.dataset.photoLoading === "true" || image.classList.contains("is-ready")) return;
  image.dataset.photoLoading = "true";
  void resolveAccessPhoto(accessId).then((source) => {
    if (!image.isConnected || image.dataset.accessPhotoId !== accessId) return;
    if (!source) {
      image.remove();
      return;
    }
    image.addEventListener("load", () => image.classList.add("is-ready"), { once: true });
    image.addEventListener("error", () => {
      photoCache.delete(accessId);
      image.remove();
    }, { once: true });
    image.src = source;
  });
}

function resolveAccessPhoto(accessId) {
  const cached = photoCache.get(accessId);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (cached) photoCache.delete(accessId);
  if (photoRequests.has(accessId)) return photoRequests.get(accessId);

  const request = window.ponte.getAccessPhoto(accessId)
    .catch(() => null)
    .then((value) => {
      photoCache.set(accessId, {
        value,
        expiresAt: Date.now() + (value ? 6 * 60 * 60 * 1000 : 30 * 1000)
      });
      while (photoCache.size > 60) photoCache.delete(photoCache.keys().next().value);
      return value;
    })
    .finally(() => photoRequests.delete(accessId));
  photoRequests.set(accessId, request);
  return request;
}

function fillSettings(state) {
  $("#app-version").textContent = `Versão ${state.appVersion}`;
  if (document.activeElement?.closest("#settings-form")) return;
  $("#api-url").value = state.settings.activeSoftBaseUrl;
  $("#idsecure-url").value = state.settings.idSecureBaseUrl;
  $("#idsecure-username").value = state.settings.idSecureUsername;
  $("#idsecure-password-hint").textContent = state.settings.idSecurePasswordConfigured
    ? "Senha armazenada com proteção do Windows."
    : "Nenhuma senha configurada.";
  $("#control-id-mode").value = state.settings.controlIdMode;
  $("#control-id-username").value = state.settings.controlIdUsername;
  $("#control-id-password-hint").textContent = state.settings.controlIdPasswordConfigured
    ? "Senha armazenada com proteção do Windows."
    : "Nenhuma senha configurada.";
  renderControlIdDevices(state.settings.controlIdDevices);
  updateControlIdModeVisibility();
  $("#listener-port").value = state.settings.listenerPort;
  $("#direction").value = state.settings.direction;
  $("#turn-left-direction").value = state.settings.turnLeftDirection;
  $("#turn-right-direction").value = state.settings.turnRightDirection;
  $("#auto-start").checked = state.settings.autoStart;
  $("#developer-mode").checked = state.settings.developerMode;
  $("#token-hint").textContent = state.settings.tokenConfigured ? "Token armazenado com proteção do Windows." : "Nenhum token configurado.";
}

function renderControlIdDevices(devices) {
  $("#control-id-devices").innerHTML = devices.map((device) => `
    <div class="device-config-row" data-device-id="${escapeHtml(device.id)}">
      <label class="device-enabled" title="Consultar esta catraca"><input type="checkbox" ${device.enabled ? "checked" : ""}><span></span></label>
      <label>Nome<input class="device-name" type="text" value="${escapeHtml(device.name)}" required></label>
      <label>IP ou host<input class="device-host" type="text" value="${escapeHtml(device.host)}" placeholder="192.168.1.189" required></label>
      <label class="device-port">Porta<input type="number" min="1" max="65535" value="${Number(device.port) || 80}" required></label>
      <button class="remove-device" type="button" title="Remover catraca" aria-label="Remover catraca">×</button>
    </div>
  `).join("");
}

function readControlIdDevices() {
  return [...document.querySelectorAll(".device-config-row")].map((row, index) => ({
    id: row.dataset.deviceId || `device-${Date.now()}-${index}`,
    name: row.querySelector(".device-name").value.trim() || `Catraca ${index + 1}`,
    host: row.querySelector(".device-host").value.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""),
    port: Number(row.querySelector(".device-port input").value),
    enabled: row.querySelector(".device-enabled input").checked
  }));
}

function updateControlIdModeVisibility() {
  const polling = $("#control-id-mode").value === "polling";
  $("#polling-settings").hidden = !polling;
  $("#listener-settings").hidden = polling;
  $("#polling-settings").querySelectorAll("input").forEach((input) => { input.disabled = !polling; });
  $("#listener-settings").querySelectorAll("input").forEach((input) => { input.disabled = polling; });
}

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#form-message");
  message.className = "form-message"; message.textContent = "Salvando e verificando conexões...";
  try {
    const state = await window.ponte.saveSettings({
      activeSoftBaseUrl: $("#api-url").value.trim(), activeSoftToken: $("#api-token").value.trim() || undefined,
      idSecureBaseUrl: $("#idsecure-url").value.trim(),
      idSecureUsername: $("#idsecure-username").value.trim(),
      idSecurePassword: $("#idsecure-password").value.trim() || undefined,
      controlIdMode: $("#control-id-mode").value,
      controlIdUsername: $("#control-id-username").value.trim(),
      controlIdPassword: $("#control-id-password").value.trim() || undefined,
      controlIdDevices: readControlIdDevices(),
      listenerPort: Number($("#listener-port").value), direction: $("#direction").value,
      turnLeftDirection: $("#turn-left-direction").value, turnRightDirection: $("#turn-right-direction").value,
      autoStart: true,
      developerMode: $("#developer-mode").checked
    });
    $("#api-token").value = ""; $("#control-id-password").value = ""; $("#idsecure-password").value = ""; render(state); message.textContent = "Configurações salvas.";
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
});

$("#sync-button").addEventListener("click", async () => { $("#sync-button").disabled = true; try { await window.ponte.synchronize(); } finally { $("#sync-button").disabled = false; } });
$("#clear-queue").addEventListener("click", async () => {
  if (!window.confirm("Zerar todas as pendências? Os registros já exibidos continuarão no histórico como não enviados.")) return;
  const button = $("#clear-queue");
  button.disabled = true;
  button.textContent = "Limpando...";
  try {
    const state = await window.ponte.clearQueue();
    render(state);
  } catch (error) {
    window.alert(`Não foi possível zerar a fila: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Zerar fila";
  }
});
$("#clear-console").addEventListener("click", () => window.ponte.clearLogs());
document.querySelectorAll(".console-filter").forEach((button) => {
  button.addEventListener("click", () => selectConsoleFilter(button.dataset.category));
});
$("#control-id-mode").addEventListener("change", updateControlIdModeVisibility);
$("#add-control-id-device").addEventListener("click", () => {
  const devices = readControlIdDevices();
  devices.push({ id: `device-${Date.now()}`, name: `Catraca ${devices.length + 1}`, host: "", port: 80, enabled: true });
  renderControlIdDevices(devices);
});
$("#control-id-devices").addEventListener("click", (event) => {
  const button = event.target.closest(".remove-device");
  if (!button) return;
  button.closest(".device-config-row").remove();
});
$("#prepare-installation").addEventListener("click", () => runInstallationAction(
  () => window.ponte.prepareInstallation(),
  "Preparando auto-início e verificando a comunicação configurada."
));
$("#validate-installation").addEventListener("click", () => runInstallationAction(
  () => window.ponte.validateInstallation(),
  "Executando verificações de rede, ActiveSoft, catracas e matrículas..."
));
$("#token-guide-link").addEventListener("click", (event) => {
  event.preventDefault();
  selectView("token-guide");
});
$("#token-guide-back").addEventListener("click", (event) => {
  event.preventDefault();
  selectView("settings", document.querySelector('.nav-item[data-view="settings"]'));
});
$("#open-token-portal").addEventListener("click", async () => {
  const message = $("#token-portal-message");
  try {
    const configuredBase = $("#api-url").value.trim() || appState?.settings.activeSoftBaseUrl;
    const portalUrl = new URL("/gerar_token/", configuredBase);
    if (portalUrl.protocol !== "https:") throw new Error("O endereço da ActiveSoft deve usar HTTPS.");
    await window.ponte.openExternal(portalUrl.toString());
    message.className = "token-portal-message";
    message.textContent = "Portal aberto no navegador padrão.";
  } catch (error) {
    message.className = "token-portal-message error";
    message.textContent = error.message;
  }
});

window.ponte.onStateChanged(render);
window.ponte.getState().then(render);
setInterval(() => { if (appState) renderControlIdStatus(appState); }, 15_000);
