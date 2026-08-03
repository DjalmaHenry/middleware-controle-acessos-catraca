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

class MemoryPollingStore {
  cursors = new Map<string, number>();
  physical = new Map<string, unknown>();
  processed = new Set<string>();
  getControlIdPollingCursor(key: string): number | undefined { return this.cursors.get(key); }
  saveControlIdPollingCursor(key: string, cursor: number): void { this.cursors.set(key, cursor); }
  savePendingPhysicalTurn(turn: { key: string }): void { this.physical.set(turn.key, turn); }
  removePendingPhysicalTurn(key: string): void { this.physical.delete(key); }
  hasProcessedControlIdAccess(sourceId: string): boolean { return this.processed.has(sourceId); }
}

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
  const physicalEvents: string[] = [];
  const store = new MemoryPollingStore();
  const service = new ControlIdPollingService(
    { registerControlIdUser: async () => { attendanceCalls += 1; } },
    store,
    () => settings,
    (_category, title) => logs.push(title),
    (contact) => contacts.push(contact),
    async (_device, event) => { physicalEvents.push(event); return true; },
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
  assert.deepEqual(physicalEvents, ["TURN_RIGHT"]);
  assert.equal(store.physical.size, 0);
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
  const service = new ControlIdPollingService(
    {},
    new MemoryPollingStore(),
    () => settings,
    () => undefined,
    () => undefined,
    async () => false,
    fetchImpl
  );
  await service.pollNow();
  assert.equal(loginCount, 2);
});

test("obtém a foto cadastrada diretamente na catraca", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/login.fcgi")) return Response.json({ session: "photo-session" });
    if (url.includes("/user_get_image.fcgi")) return new Response(jpeg, {
      status: 200,
      headers: { "content-type": "image/jpeg" }
    });
    return Response.json({ access_events: [] });
  };
  const service = new ControlIdPollingService(
    {},
    new MemoryPollingStore(),
    () => settings,
    () => undefined,
    () => undefined,
    async () => false,
    fetchImpl
  );

  const result = await service.resolveUserPhoto(1001440, "CATRACA 1");

  assert.match(requests.at(-1) ?? "", /\/user_get_image\.fcgi\?/);
  assert.match(requests.at(-1) ?? "", /user_id=1001440/);
  assert.equal(result, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
});

test("não avança o cursor quando a correlação falha e retoma todos os giros", async () => {
  const store = new MemoryPollingStore();
  store.cursors.set("192.168.1.189:80", 10);
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).includes("/login.fcgi")) return Response.json({ session: "session" });
    return Response.json({ access_events: [
      { id: 12, event: "catra", type: "TURN RIGHT", timestamp: 102 },
      { id: 11, event: "catra", type: "TURN LEFT", timestamp: 101 }
    ] });
  };
  const received: string[] = [];
  let failOnce = true;
  const service = new ControlIdPollingService(
    {},
    store,
    () => settings,
    () => undefined,
    () => undefined,
    async (_device, event) => {
      received.push(event);
      if (failOnce) {
        failOnce = false;
        throw new Error("falha simulada");
      }
      return true;
    },
    fetchImpl
  );

  await service.pollNow();
  assert.equal(store.cursors.get("192.168.1.189:80"), 10);
  await service.pollNow();
  assert.equal(store.cursors.get("192.168.1.189:80"), 12);
  assert.deepEqual(received, ["TURN_LEFT", "TURN_LEFT", "TURN_RIGHT"]);
});
