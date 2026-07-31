const $ = (selector) => document.querySelector(selector);
let appState;
const photoCache = new Map();
const photoRequests = new Map();
const CONTROL_ID_ONLINE_WINDOW_MS = 2 * 60 * 1000;

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
  $("#student-count").textContent = `${state.students.length} sincronizados`;
  const latest = state.recentAccesses[0];
  if (latest) {
    const parts = timeParts(latest.occurredAt);
    $("#last-access").innerHTML = `<div class="access-hero"><div class="access-photo-frame"><span class="access-photo-fallback">${escapeHtml(studentInitial(latest.studentName))}</span>${accessPhotoImage(latest, "access-photo", `Foto de ${latest.studentName}`)}</div><div class="access-overlay"><span class="eyebrow">Último acesso</span><h2>${escapeHtml(latest.studentName)}</h2><p>${escapeHtml(latest.matricula)} · ${latest.direction === "E" ? "Entrada" : "Saída"}</p><div class="access-time"><strong>${parts.time}</strong><small>${parts.date}</small></div></div></div>`;
  }
  $("#recent-list").innerHTML = state.recentAccesses.length ? state.recentAccesses.slice(0, 7).map(recentRow).join("") : `<div class="empty-state" style="padding:55px 20px"><p>Nenhuma passagem registrada.</p></div>`;
  $("#history-body").innerHTML = state.recentAccesses.map(historyRow).join("");
  hydrateAccessPhotos();
  renderConsole(state);
  renderInstallationGuide(state);
  renderInstallationReport(state.installationReport);
  fillSettings(state);
}

function renderControlIdStatus(state) {
  const dot = $("#listener-dot");
  const status = $("#listener-status");
  if (!state.listener.running) {
    dot.className = "dot bad";
    status.textContent = "Receptor parado";
    status.title = state.listener.error || `Porta ${state.listener.port} indisponível`;
    return;
  }

  const devices = state.controlId?.devices ?? [];
  const now = Date.now();
  const recent = devices.filter((device) => now - new Date(device.lastSeenAt).getTime() <= CONTROL_ID_ONLINE_WINDOW_MS);
  const latest = [...devices].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  if (recent.length) {
    dot.className = "dot ok";
    status.textContent = `${recent.length} ${recent.length === 1 ? "catraca conectada" : "catracas conectadas"}`;
    status.title = `Último contato: ${new Date(latest.lastSeenAt).toLocaleString("pt-BR")} · receptor na porta ${state.listener.port}`;
    return;
  }
  if (latest) {
    dot.className = "dot bad";
    status.textContent = `Sem contato ${elapsedLabel(new Date(latest.lastSeenAt).getTime(), now)}`;
    status.title = `Último contato: ${new Date(latest.lastSeenAt).toLocaleString("pt-BR")} · receptor ativo na porta ${state.listener.port}`;
    return;
  }
  dot.className = "dot";
  status.textContent = "Aguardando catraca";
  status.title = `Receptor pronto na porta ${state.listener.port}, mas nenhuma catraca se comunicou`;
}

function elapsedLabel(then, now = Date.now()) {
  const minutes = Math.max(1, Math.floor((now - then) / 60_000));
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours} ${hours === 1 ? "hora" : "horas"}`;
}

const consoleLabels = {
  "device-in": "CATRACA → APP",
  "device-out": "APP → CATRACA",
  "api-out": "APP → API",
  "api-in": "API → APP",
  system: "SISTEMA",
  error: "ERRO"
};

function renderConsole(state) {
  const output = $("#console-output");
  if (!output) return;
  const shouldScroll = $("#console-autoscroll").checked;
  output.innerHTML = state.integrationLogs.length
    ? state.integrationLogs.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString("pt-BR", { hour12: false });
      const payload = entry.payload === undefined ? "" : `<pre>${escapeHtml(JSON.stringify(entry.payload, null, 2))}</pre>`;
      return `<div class="console-entry ${entry.category}"><time>${time}</time><span class="channel">${consoleLabels[entry.category]}</span><div><strong>${escapeHtml(entry.title)}</strong>${payload}</div></div>`;
    }).join("")
    : `<div class="console-empty">Aguardando eventos de integração.</div>`;
  if (shouldScroll) output.scrollTop = output.scrollHeight;
}

function renderInstallationGuide(state) {
  $("#guide-port").textContent = state.listener.port;
  $("#guide-idsecure").textContent = state.settings.idSecureBaseUrl;
  $("#guide-idsecure-step").textContent = state.settings.idSecureBaseUrl;
  $("#guide-addresses").textContent = state.networkAddresses.length
    ? state.networkAddresses.map((address) => `${address}:${state.listener.port}`).join(" · ")
    : "Nenhum IPv4 de rede detectado";
  $("#guide-mappings").textContent = `${state.controlIdMappingCount} ${state.controlIdMappingCount === 1 ? "matrícula" : "matrículas"}`;
  $("#firewall-command").textContent = `netsh advfirewall firewall add rule name="Ponte ID - Control iD" dir=in action=allow protocol=TCP localport=${state.listener.port} profile=domain,private remoteip=localsubnet`;
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
  return `<div class="recent-item">${avatar}<div><strong>${escapeHtml(item.studentName)}</strong><small>${parts.time} · ${item.direction === "E" ? "Entrada" : "Saída"}</small></div><span class="status-pill ${item.status}">${item.status === "sent" ? "Enviado" : item.status === "queued" ? "Na fila" : "Enviando"}</span></div>`;
}

function historyRow(item) {
  const parts = timeParts(item.occurredAt);
  return `<tr><td><div class="student-cell"><span class="avatar-shell history-avatar"><span class="recent-avatar">${escapeHtml(studentInitial(item.studentName))}</span>${accessPhotoImage(item, "avatar-photo", `Foto de ${item.studentName}`)}</span><strong>${escapeHtml(item.studentName)}</strong></div></td><td>${escapeHtml(item.matricula)}</td><td>${parts.date} às ${parts.time}</td><td>${item.direction === "E" ? "Entrada" : "Saída"}</td><td><span class="status-pill ${item.status}">${item.status === "sent" ? "Enviado" : "Na fila"}</span></td></tr>`;
}

function accessPhotoImage(item, className, alt) {
  if (!item.photoUrl) return "";
  return `<img class="${className}" data-access-photo-id="${escapeHtml(item.id)}" alt="${escapeHtml(alt)}" decoding="async">`;
}

function studentInitial(name) {
  return String(name || "?").trim().charAt(0).toUpperCase() || "?";
}

function hydrateAccessPhotos() {
  document.querySelectorAll("img[data-access-photo-id]").forEach((image) => {
    const accessId = image.dataset.accessPhotoId;
    if (!accessId || image.dataset.photoLoading === "true") return;
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
  $("#listener-port").value = state.settings.listenerPort;
  $("#direction").value = state.settings.direction;
  $("#turn-left-direction").value = state.settings.turnLeftDirection;
  $("#turn-right-direction").value = state.settings.turnRightDirection;
  $("#auto-start").checked = state.settings.autoStart;
  $("#developer-mode").checked = state.settings.developerMode;
  $("#token-hint").textContent = state.settings.tokenConfigured ? "Token armazenado com proteção do Windows." : "Nenhum token configurado.";
}

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#form-message");
  message.className = "form-message"; message.textContent = "Salvando e verificando conexões...";
  try {
    const state = await window.ponte.saveSettings({
      activeSoftBaseUrl: $("#api-url").value.trim(), activeSoftToken: $("#api-token").value.trim() || undefined,
      idSecureBaseUrl: $("#idsecure-url").value.trim(),
      listenerPort: Number($("#listener-port").value), direction: $("#direction").value,
      turnLeftDirection: $("#turn-left-direction").value, turnRightDirection: $("#turn-right-direction").value,
      autoStart: true,
      developerMode: $("#developer-mode").checked
    });
    $("#api-token").value = ""; render(state); message.textContent = "Configurações salvas.";
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
});

$("#sync-button").addEventListener("click", async () => { $("#sync-button").disabled = true; try { await window.ponte.synchronize(); } finally { $("#sync-button").disabled = false; } });
$("#clear-console").addEventListener("click", () => window.ponte.clearLogs());
$("#prepare-installation").addEventListener("click", () => runInstallationAction(
  () => window.ponte.prepareInstallation(),
  "Preparando auto-início, receptor e Firewall. Aceite a solicitação do Windows, se aparecer."
));
$("#validate-installation").addEventListener("click", () => runInstallationAction(
  () => window.ponte.validateInstallation(),
  "Executando verificações de rede, receptor, ActiveSoft, catraca e matrículas..."
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
