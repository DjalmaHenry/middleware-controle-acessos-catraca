import assert from "node:assert/strict";
import test from "node:test";
import { ControlIdPollingService } from "../main/control-id-polling";
import { Settings } from "../shared/types";

const settings: Settings = {
  configured: true,
  activeSoftBaseUrl: "https://siga01.activesoft.com.br",
  activeSoftToken: "test-token",
  idSecureBaseUrl: "https://192.168.1.2:30443",
  idSecureUsername: "operator",
  idSecurePassword: "panel-password",
  controlIdMode: "polling",
  controlIdUsername: "admin",
  controlIdPassword: "secret",
  controlIdDevices: [{ id: "catraca-1", name: "CATRACA 1", host: "192.168.1.189", port: 80, enabled: true }],
  listenerPort: 8787,
  autoStart: true,
  direction: "E",
  turnLeftDirection: "E",
  turnRightDirection: "S",
  developerMode: true
};

test("consulta direta diagnostica a catraca sem registrar frequência", async () => {
  let eventId = 10;
  let attendanceCalls = 0;
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/login.fcgi")) return Response.json({ session: "session-1" });
    return Response.json({
      access_events: [{ id: eventId, event: "catra", type: eventId === 10 ? "TURN LEFT" : "TURN RIGHT", timestamp: 100 }]
    });
  };
  const contacts: Array<{ observedTurn?: string }> = [];
  const logs: string[] = [];
  const service = new ControlIdPollingService(
    { registerControlIdUser: async () => { attendanceCalls += 1; } },
    {},
    () => settings,
    (_category, title) => logs.push(title),
    (contact) => contacts.push(contact),
    fetchImpl
  );

  await service.pollNow();
  eventId = 11;
  await service.pollNow();

  assert.equal(attendanceCalls, 0);
  assert.equal(requests.filter((url) => url.includes("/login.fcgi")).length, 1);
  assert.ok(requests.every((url) => url.includes("/login.fcgi") || url.includes("/load_objects.fcgi")));
  assert.equal(contacts.at(-1)?.observedTurn, "right");
  assert.ok(logs.some((title) => title.includes("evento físico observado")));
});

test("renova a sessão expirada da catraca", async () => {
  let loginCount = 0;
  let loadCount = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("/login.fcgi")) {
      loginCount += 1;
      return Response.json({ session: `session-${loginCount}` });
    }
    loadCount += 1;
    if (loadCount === 1) return Response.json({ error: "Invalid session" });
    return Response.json({ access_events: [] });
  };
  const service = new ControlIdPollingService({}, {}, () => settings, () => undefined, () => undefined, fetchImpl);
  await service.pollNow();
  assert.equal(loginCount, 2);
});
