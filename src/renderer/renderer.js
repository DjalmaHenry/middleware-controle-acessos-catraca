const $ = (selector) => document.querySelector(selector);
let appState;

const titles = {
  dashboard: ["Monitor de acesso", "Acompanhe as entradas em tempo real"],
  history: ["Histórico", "Passagens processadas por este computador"],
  settings: ["Configurações", "Conexões e funcionamento do aplicativo"]
};
let initialViewSelected = false;

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.view;
  document.querySelectorAll(".nav-item,.view").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  $(`#${view}`).classList.add("active");
  $("#page-title").textContent = titles[view][0];
  $("#page-subtitle").textContent = titles[view][1];
  $("#sync-button").style.display = view === "settings" ? "none" : "block";
}));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function timeParts(iso) {
  const date = new Date(iso);
  return { time: date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), date: date.toLocaleDateString("pt-BR") };
}

function render(state) {
  appState = state;
  if (!initialViewSelected && !state.settings.configured) {
    initialViewSelected = true;
    document.querySelector('.nav-item[data-view="settings"]').click();
  }
  const listenerDot = $("#listener-dot");
  listenerDot.className = `dot ${state.listener.running ? "ok" : "bad"}`;
  $("#listener-status").textContent = state.listener.running ? `Ativo na porta ${state.listener.port}` : "Receptor parado";
  const activeDot = $("#active-dot");
  activeDot.className = `dot ${state.settings.demoMode ? "warn" : state.activeSoft.status === "online" ? "ok" : state.activeSoft.status === "offline" ? "bad" : ""}`;
  $("#active-status").textContent = state.settings.demoMode ? "Modo demonstração" : state.activeSoft.status === "online" ? "Conectada" : state.activeSoft.status === "offline" ? "Sem conexão" : "Aguardando teste";
  $("#queue-status").textContent = `${state.pendingCount} ${state.pendingCount === 1 ? "pendência" : "pendências"}`;
  $("#student-count").textContent = `${state.students.length} sincronizados`;
  $("#demo-panel").style.display = state.settings.demoMode ? "flex" : "none";

  const options = state.students.map((student) => `<option value="${student.id}">${escapeHtml(student.nome)}</option>`).join("");
  if ($("#demo-student").innerHTML !== options) $("#demo-student").innerHTML = options;
  const latest = state.recentAccesses[0];
  if (latest) {
    const parts = timeParts(latest.occurredAt);
    $("#last-access").innerHTML = `<div class="access-hero"><img class="access-photo" src="${escapeHtml(latest.photoUrl || "")}" alt="Foto de ${escapeHtml(latest.studentName)}"><div class="access-overlay"><span class="eyebrow">Último acesso</span><h2>${escapeHtml(latest.studentName)}</h2><p>${escapeHtml(latest.matricula)} · ${latest.direction === "E" ? "Entrada" : "Saída"}</p><div class="access-time"><strong>${parts.time}</strong><small>${parts.date}</small></div></div></div>`;
  }
  $("#recent-list").innerHTML = state.recentAccesses.length ? state.recentAccesses.slice(0, 7).map(recentRow).join("") : `<div class="empty-state" style="padding:55px 20px"><p>Nenhuma passagem registrada.</p></div>`;
  $("#history-body").innerHTML = state.recentAccesses.map(historyRow).join("");
  fillSettings(state);
}

function recentRow(item) {
  const parts = timeParts(item.occurredAt);
  const avatar = item.photoUrl ? `<img src="${escapeHtml(item.photoUrl)}" alt="">` : `<span class="recent-avatar">${escapeHtml(item.studentName[0])}</span>`;
  return `<div class="recent-item">${avatar}<div><strong>${escapeHtml(item.studentName)}</strong><small>${parts.time} · ${item.direction === "E" ? "Entrada" : "Saída"}</small></div><span class="status-pill ${item.status}">${item.status === "sent" ? "Enviado" : item.status === "queued" ? "Na fila" : "Enviando"}</span></div>`;
}

function historyRow(item) {
  const parts = timeParts(item.occurredAt);
  return `<tr><td><div class="student-cell">${item.photoUrl ? `<img src="${escapeHtml(item.photoUrl)}" alt="">` : ""}<strong>${escapeHtml(item.studentName)}</strong></div></td><td>${escapeHtml(item.matricula)}</td><td>${parts.date} às ${parts.time}</td><td>${item.direction === "E" ? "Entrada" : "Saída"}</td><td><span class="status-pill ${item.status}">${item.status === "sent" ? "Enviado" : "Na fila"}</span></td></tr>`;
}

function fillSettings(state) {
  if (document.activeElement?.closest("#settings-form")) return;
  $("#api-url").value = state.settings.activeSoftBaseUrl;
  $("#listener-port").value = state.settings.listenerPort;
  $("#direction").value = state.settings.direction;
  $("#auto-start").checked = state.settings.autoStart;
  $("#demo-mode").checked = state.settings.demoMode;
  $("#token-hint").textContent = state.settings.tokenConfigured ? "Token armazenado com proteção do Windows." : "Nenhum token configurado.";
}

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#form-message");
  message.className = "form-message"; message.textContent = "Salvando e verificando conexões...";
  try {
    const state = await window.ponte.saveSettings({
      activeSoftBaseUrl: $("#api-url").value.trim(), activeSoftToken: $("#api-token").value.trim() || undefined,
      listenerPort: Number($("#listener-port").value), direction: $("#direction").value,
      autoStart: $("#auto-start").checked, demoMode: $("#demo-mode").checked
    });
    $("#api-token").value = ""; render(state); message.textContent = "Configurações salvas.";
  } catch (error) { message.className = "form-message error"; message.textContent = error.message; }
});

$("#sync-button").addEventListener("click", async () => { $("#sync-button").disabled = true; try { await window.ponte.synchronize(); } finally { $("#sync-button").disabled = false; } });
$("#demo-button").addEventListener("click", async () => { const id = Number($("#demo-student").value); if (id) await window.ponte.simulateAccess(id); });

window.ponte.onStateChanged(render);
window.ponte.getState().then(render);
