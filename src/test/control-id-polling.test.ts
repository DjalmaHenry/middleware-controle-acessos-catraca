import assert from "node:assert/strict";
import test from "node:test";
import { ControlIdPollingService } from "../main/control-id-polling";
import { Settings } from "../shared/types";

const settings: Settings = {
  configured: true,
  activeSoftBaseUrl: "https://siga01.activesoft.com.br",
  activeSoftToken: "test-token",
  idSecureBaseUrl: "https://192.168.1.2:30443",
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
  processed = new Set<string>();
  mappings = new Map<string, string>();
  getControlIdPollingCursor(key: string): number | undefined { return this.cursors.get(key); }
  saveControlIdPollingCursor(key: string, cursor: number): void { this.cursors.set(key, cursor); }
  hasProcessedControlIdAccess(id: string): boolean { return this.processed.has(id); }
  markProcessedControlIdAccess(id: string): void { this.processed.add(id); }
  saveControlIdMapping(userId: string | number, registration: string): void {
    this.mappings.set(String(userId), registration);
  }
}

test("inicia no último log e registra somente uma passagem física nova", async () => {
  const store = new MemoryPollingStore();
  const attendance: Array<{ userId: number; direction?: string; registration?: string }> = [];
  const now = Math.floor(Date.now() / 1000);
  let accessLogReads = 0;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.includes("/login.fcgi")) return Response.json({ session: "session-1" });
    if (body.object === "access_logs") {
      accessLogReads += 1;
      return Response.json({
        access_logs: accessLogReads === 1
          ? [{ id: 10 }]
          : [{ id: 11, time: now - 20, event: 7, device_id: 1, user_id: 99 }]
      });
    }
    if (body.object === "access_events") {
      return Response.json({ access_events: [{ id: 70, event: "catra", type: "TURN_LEFT", device_id: 1, timestamp: now - 19 }] });
    }
    if (body.object === "users") {
      return Response.json({ users: [{ id: 99, registration: "001234", name: "Aluno Teste" }] });
    }
    return Response.json({}, { status: 404 });
  };
  const contacts: string[] = [];
  const service = new ControlIdPollingService(
    {
      registerControlIdUser: async (userId, direction, _occurredAt, registration) => {
        attendance.push({ userId, direction, registration });
      }
    },
    store,
    () => settings,
    () => undefined,
    (contact) => contacts.push(contact.path),
    fetchImpl
  );

  await service.pollNow();
  assert.equal(attendance.length, 0, "o histórico anterior à instalação não deve ser reenviado");
  assert.equal(store.getControlIdPollingCursor("192.168.1.189:80"), 10);

  await service.pollNow();
  assert.deepEqual(attendance, [{ userId: 99, direction: "E", registration: "001234" }]);
  assert.equal(store.getControlIdPollingCursor("192.168.1.189:80"), 11);
  assert.equal(store.mappings.get("99"), "001234");
  assert.ok(contacts.some((path) => path.includes("giro confirmado")));
  assert.equal(requests.filter((request) => request.url.includes("/login.fcgi")).length, 1, "a sessão deve ser reutilizada");

  await service.pollNow();
  assert.equal(attendance.length, 1, "o cursor persistido deve impedir duplicidade");
});

test("ignora desistência registrada pela iDBlock Next", async () => {
  const store = new MemoryPollingStore();
  store.saveControlIdPollingCursor("192.168.1.189:80", 20);
  const now = Math.floor(Date.now() / 1000);
  let registrations = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (String(input).includes("/login.fcgi")) return Response.json({ session: "session-2" });
    if (body.object === "access_logs") {
      return Response.json({ access_logs: [{ id: 21, time: now - 20, event: 13, device_id: 1, user_id: 99 }] });
    }
    return Response.json({}, { status: 404 });
  };
  const service = new ControlIdPollingService(
    { registerControlIdUser: async () => { registrations += 1; } },
    store,
    () => settings,
    () => undefined,
    () => undefined,
    fetchImpl
  );

  await service.pollNow();
  assert.equal(registrations, 0);
  assert.equal(store.getControlIdPollingCursor("192.168.1.189:80"), 21);
});
