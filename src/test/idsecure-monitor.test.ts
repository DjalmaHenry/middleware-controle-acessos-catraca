import assert from "node:assert/strict";
import test from "node:test";
import { IdSecureMonitorService, JsonRequester } from "../main/idsecure-monitor";
import { Direction, Settings } from "../shared/types";

const settings: Settings = {
  configured: true,
  activeSoftBaseUrl: "https://siga01.activesoft.com.br",
  activeSoftToken: "test-token",
  idSecureBaseUrl: "https://192.168.1.2:30443",
  idSecureUsername: "operator",
  idSecurePassword: "panel-password",
  controlIdMode: "polling",
  controlIdUsername: "admin",
  controlIdPassword: "device-password",
  controlIdDevices: [],
  listenerPort: 8787,
  autoStart: true,
  direction: "E",
  turnLeftDirection: "E",
  turnRightDirection: "S",
  developerMode: true
};

class MemoryStore {
  cursor?: number;
  processed = new Set<string>();
  mappings = new Map<string, string>();
  getIdSecureMonitorCursor(): number | undefined { return this.cursor; }
  saveIdSecureMonitorCursor(cursor: number): void { this.cursor = cursor; }
  hasProcessedControlIdAccess(id: string): boolean { return this.processed.has(id); }
  markProcessedControlIdAccess(id: string): void { this.processed.add(id); }
  saveControlIdMapping(userId: number | string, registration: string): void {
    this.mappings.set(String(userId), registration);
  }
}

test("processa o monitor Enterprise por idLog e resolve a matrícula", async () => {
  const store = new MemoryStore();
  let monitorReads = 0;
  const requests: URL[] = [];
  const requester: JsonRequester = async (url) => {
    requests.push(new URL(url));
    if (url.pathname === "/api/login/") return { status: 200, body: { accessToken: "token" } };
    if (url.pathname === "/api/user/list") {
      return { status: 200, body: { data: [{ id: 1001440, idDevice: 1001440, name: "clelio", registration: "0054" }] } };
    }
    monitorReads += 1;
    if (monitorReads === 1) {
      return { status: 200, body: { data: [{ idLog: 175324, eventCode: 7, idUser: 1001440 }] } };
    }
    return {
      status: 200,
      body: {
        data: [
          { idLog: 175325, eventCode: 3, eventName: "Não identificado", idUser: 0, device: "CATRACA 2", time: "/Date(1785512840000-0300)/" },
          { idLog: 175326, eventCode: 7, eventName: "Acesso autorizado", idUser: 1001440, name: "clelio", device: "CATRACA 2", info: "Saída", time: "/Date(1785512850000-0300)/" }
        ]
      }
    };
  };
  const attendance: Array<{ userId: number; direction?: Direction; registration?: string; occurredAt?: string }> = [];
  const logs: Array<{ category: string; title: string }> = [];
  const directions: Direction[] = [];
  const service = new IdSecureMonitorService(
    {
      registerControlIdUser: async (userId, direction, occurredAt, registration) => {
        attendance.push({ userId, direction, occurredAt, registration });
      }
    },
    store,
    () => settings,
    (category, title) => logs.push({ category, title }),
    () => undefined,
    (direction) => directions.push(direction),
    requester
  );

  await service.pollNow();
  assert.equal(store.cursor, 175324);
  assert.equal(attendance.length, 0, "a primeira conexão deve apenas criar a linha de base");
  await service.pollNow();

  assert.deepEqual(attendance, [{
    userId: 1001440,
    direction: "S",
    registration: "0054",
    occurredAt: "2026-07-31T15:47:30.000Z"
  }]);
  assert.equal(store.cursor, 175326);
  assert.equal(store.mappings.get("1001440"), "0054");
  assert.deepEqual(directions, ["S"]);
  assert.ok(logs.some((entry) => entry.title.includes("Não identificado")));
  const userRequest = requests.find((url) => url.pathname === "/api/user/list");
  assert.equal(userRequest?.searchParams.get("filterCol"), "name");
  assert.equal(userRequest?.searchParams.get("search[value]"), "clelio");

  await service.pollNow();
  assert.equal(attendance.length, 1, "um idLog repetido não pode gerar presença duplicada");
});

test("refaz o login quando o Bearer expira", async () => {
  const store = new MemoryStore();
  let loginCount = 0;
  let monitorCount = 0;
  const requester: JsonRequester = async (url) => {
    if (url.pathname === "/api/login/") {
      loginCount += 1;
      return { status: 200, body: { accessToken: `token-${loginCount}` } };
    }
    monitorCount += 1;
    if (monitorCount === 1) return { status: 401, body: { error: "Token expirado" } };
    return { status: 200, body: { data: [] } };
  };
  const service = new IdSecureMonitorService(
    { registerControlIdUser: async () => undefined },
    store,
    () => settings,
    () => undefined,
    () => undefined,
    () => undefined,
    requester
  );
  await service.pollNow();
  assert.equal(loginCount, 2);
  assert.equal(store.cursor, 0);
});

test("um usuário sem matrícula não bloqueia os acessos seguintes", async () => {
  const store = new MemoryStore();
  store.cursor = 200;
  const requester: JsonRequester = async (url) => {
    if (url.pathname === "/api/login/") return { status: 200, body: { accessToken: "token" } };
    if (url.pathname === "/api/user/list") {
      const requested = url.searchParams.get("search[value]");
      return requested === "sem-matricula" || requested === "1"
        ? { status: 200, body: { data: [{ idDevice: 1, name: "sem-matricula", registration: "" }] } }
        : { status: 200, body: { data: [{ idDevice: 2, name: "aluno", registration: "0099" }] } };
    }
    return { status: 200, body: { data: [
      { idLog: 201, eventCode: 7, idUser: 1, name: "sem-matricula", info: "Entrada" },
      { idLog: 202, eventCode: 7, idUser: 2, name: "aluno", info: "Entrada" }
    ] } };
  };
  const registrations: string[] = [];
  const service = new IdSecureMonitorService(
    { registerControlIdUser: async (_userId, _direction, _occurredAt, registration) => { registrations.push(String(registration)); } },
    store,
    () => settings,
    () => undefined,
    () => undefined,
    () => undefined,
    requester
  );

  await service.pollNow();
  await service.pollNow();
  assert.equal(store.cursor, 200);
  await service.pollNow();
  assert.equal(store.cursor, 202);
  assert.deepEqual(registrations, ["0099"]);
});
