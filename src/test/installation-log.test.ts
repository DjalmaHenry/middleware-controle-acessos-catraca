import assert from "node:assert/strict";
import test from "node:test";
import { buildInstallationLog } from "../main/installation-log";
import { InstallationCheck } from "../shared/types";

test("log de validação omite verificações aprovadas quando há pendências", () => {
  const checks: InstallationCheck[] = [
    { id: "listener", title: "Receptor", status: "pass", blocking: true, detail: "Ativo." },
    { id: "activesoft", title: "ActiveSoft", status: "fail", blocking: true, detail: "Sem token." },
    { id: "device", title: "Catraca", status: "fail", blocking: true, detail: "Sem contato." },
    { id: "dhcp", title: "IP", status: "warning", blocking: false, detail: "Usa DHCP." },
    { id: "mapping", title: "Matrícula", status: "warning", blocking: false, detail: "Não observada." }
  ];

  const result = buildInstallationLog(checks);

  assert.equal(result.ready, false);
  assert.equal(result.title, "Validação encontrou 2 bloqueios e 2 avisos");
  assert.deepEqual(result.payload.summary, { passed: 1, blockingFailures: 2, warnings: 2 });
  assert.deepEqual(result.payload.pendingChecks.map((check) => check.id), [
    "activesoft",
    "device",
    "dhcp",
    "mapping"
  ]);
});

test("avisos não transformam uma instalação pronta em erro", () => {
  const result = buildInstallationLog([
    { id: "listener", title: "Receptor", status: "pass", blocking: true, detail: "Ativo." },
    { id: "dhcp", title: "IP", status: "warning", blocking: false, detail: "Usa DHCP." }
  ]);

  assert.equal(result.ready, true);
  assert.equal(result.title, "Instalação validada com 1 aviso");
  assert.deepEqual(result.payload.pendingChecks.map((check) => check.id), ["dhcp"]);
});
