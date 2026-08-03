import assert from "node:assert/strict";
import test from "node:test";
import { BinaryRequester, IdSecureMonitorService, IdSecureRequestTimeoutError, JsonRequester } from "../main/idsecure-monitor";
import { Direction, PendingIdSecureAccess, PendingPhysicalTurn, Settings } from "../shared/types";

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
  pending = new Map<number, PendingIdSecureAccess>();
  physical = new Map<string, PendingPhysicalTurn>();
  getIdSecureMonitorCursor(): number | undefined { return this.cursor; }
  saveIdSecureMonitorCursor(cursor: number): void { this.cursor = cursor; }
  getPendingIdSecureAccesses(): PendingIdSecureAccess[] { return [...this.pending.values()].map((item) => ({ ...item })); }
  savePendingIdSecureAccess(access: PendingIdSecureAccess): void {
    this.pending.set(access.idLog, { ...this.pending.get(access.idLog), ...access });
  }
  removePendingIdSecureAccess(idLog: number): void { this.pending.delete(idLog); }
  getPendingPhysicalTurns(): PendingPhysicalTurn[] { return [...this.physical.values()].map((item) => ({ ...item })); }
  removePendingPhysicalTurn(key: string): void { this.physical.delete(key); }
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
          { idLog: 175326, eventCode: 7, eventName: "Acesso autorizado", idUser: 1001440, name: "clelio", device: "CATRACA 2", info: "Saída", time: "/Date(1785512850000-0300)/", ipCamera: "image/log/175326.jpg" }
        ]
      }
    };
  };
  const attendance: Array<{ userId: number; direction?: Direction; registration?: string; occurredAt?: string; sourceId?: string; photoPath?: string }> = [];
  const logs: Array<{ category: string; title: string }> = [];
  const directions: Direction[] = [];
  const service = new IdSecureMonitorService(
    {
      registerControlIdUser: async (userId, direction, occurredAt, registration, sourceId, photoContext) => {
        attendance.push({ userId, direction, occurredAt, registration, sourceId, photoPath: photoContext?.idSecurePhotoPath });
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

  assert.equal(attendance.length, 0, "o acesso autorizado deve aguardar o giro físico");
  assert.equal(await service.handlePhysicalTurn("CATRACA 2", "TURN_RIGHT"), true);
  assert.deepEqual(attendance, [{
    userId: 1001440,
    direction: "S",
    registration: "0054",
    occurredAt: "2026-07-31T15:47:30.000Z",
    sourceId: "idsecure:log:175326",
    photoPath: "image/log/175326.jpg"
  }]);
  assert.equal(store.cursor, 175326);
  assert.equal(store.mappings.get("1001440"), "0054");
  assert.deepEqual(directions, ["S"]);
  assert.ok(logs.some((entry) => entry.title.includes("Não identificado")));
  assert.ok(logs.some((entry) => entry.title === "Ponte ID → iDSecure /api/user/list"));
  assert.ok(logs.some((entry) => entry.title === "iDSecure → Ponte ID /api/user/list"));
  const userRequest = requests.find((url) => url.pathname === "/api/user/list");
  assert.equal(userRequest?.searchParams.get("filterCol"), "name");
  assert.equal(userRequest?.searchParams.get("search[value]"), "clelio");

  await service.pollNow();
  assert.equal(attendance.length, 1, "um idLog repetido não pode gerar presença duplicada");
});

test("obtém a foto capturada pelo iDSecure usando o Bearer do painel", async () => {
  const store = new MemoryStore();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  let receivedUrl = "";
  let receivedAuthorization = "";
  const requester: JsonRequester = async () => ({ status: 200, body: { accessToken: "token-foto" } });
  const binaryRequester: BinaryRequester = async (url, headers) => {
    receivedUrl = url.toString();
    receivedAuthorization = headers.Authorization;
    return { status: 200, body: jpeg };
  };
  const service = new IdSecureMonitorService(
    { registerControlIdUser: async () => undefined },
    store,
    () => settings,
    () => undefined,
    () => undefined,
    () => undefined,
    requester,
    binaryRequester
  );

  const result = await service.resolveAccessPhoto("image/log/175324.jpg");

  assert.equal(receivedUrl, "https://192.168.1.2:30443/image/log/175324.jpg");
  assert.equal(receivedAuthorization, "Bearer token-foto");
  assert.equal(result, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
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

test("considera o timeout silencioso do long polling saudável após confirmar o login", async () => {
  const store = new MemoryStore();
  store.cursor = 400;
  let loginCount = 0;
  const statuses: string[] = [];
  const errors: string[] = [];
  const requester: JsonRequester = async (url) => {
    if (url.pathname === "/api/login/") {
      loginCount += 1;
      return { status: 200, body: { accessToken: `token-${loginCount}` } };
    }
    throw new IdSecureRequestTimeoutError("monitor sem novos eventos");
  };
  const service = new IdSecureMonitorService(
    { registerControlIdUser: async () => undefined },
    store,
    () => settings,
    (category, title) => { if (category === "error") errors.push(title); },
    (status) => statuses.push(status.status),
    () => undefined,
    requester
  );

  await service.pollNow();
  assert.equal(loginCount, 2, "deve confirmar que o painel continua alcançável e autenticando");
  assert.equal(statuses.at(-1), "online");
  assert.deepEqual(errors, []);
  assert.equal(store.cursor, 400);
});

test("envia o acesso pendente liberado somente após o giro da mesma catraca", async () => {
  const store = new MemoryStore();
  store.cursor = 500;
  const requester: JsonRequester = async (url) => {
    if (url.pathname === "/api/login/") return { status: 200, body: { accessToken: "token" } };
    if (url.pathname === "/api/user/list") {
      return { status: 200, body: { data: [{ idDevice: 1001440, name: "clelio", registration: "0054" }] } };
    }
    return { status: 200, body: { data: [{
      idLog: 501,
      eventCode: 8,
      eventName: "Acesso pendente",
      idUser: 1001440,
      name: "clelio",
      device: "CATRACA 2",
      info: "Liberado",
      time: "/Date(1785516279000-0300)/"
    }] } };
  };
  const attendance: Array<{ direction?: Direction; sourceId?: string }> = [];
  const service = new IdSecureMonitorService(
    {
      registerControlIdUser: async (_userId, direction, _occurredAt, _registration, sourceId) => {
        attendance.push({ direction, sourceId });
      }
    },
    store,
    () => settings,
    () => undefined,
    () => undefined,
    () => undefined,
    requester
  );

  await service.pollNow();
  assert.equal(attendance.length, 0);
  assert.equal(store.pending.get(501)?.awaitingTurn, true);
  assert.equal(await service.handlePhysicalTurn("CATRACA 1", "TURN_LEFT"), false);
  assert.equal(await service.handlePhysicalTurn("CATRACA 2", "TURN_LEFT", "controlid:turn:catraca-2:18587"), true);
  assert.deepEqual(attendance, [{ direction: "E", sourceId: "idsecure:log:501" }]);
  assert.equal(store.pending.size, 0);
  assert.equal(store.processed.has("controlid:turn:catraca-2:18587"), true);
});

test("correlaciona um giro persistido que chegou antes do monitor central", async () => {
  const store = new MemoryStore();
  store.cursor = 600;
  store.physical.set("catraca-2:77", {
    key: "catraca-2:77",
    device: "CATRACA 2",
    eventId: 77,
    event: "TURN_RIGHT",
    receivedAt: new Date().toISOString()
  });
  const requester: JsonRequester = async (url) => {
    if (url.pathname === "/api/login/") return { status: 200, body: { accessToken: "token" } };
    if (url.pathname === "/api/user/list") {
      return { status: 200, body: { data: [{ idDevice: 9, name: "aluna", registration: "0099" }] } };
    }
    return { status: 200, body: { data: [{
      idLog: 601, eventCode: 8, idUser: 9, name: "aluna", device: "CATRACA 2", info: "Liberado"
    }] } };
  };
  const directions: Direction[] = [];
  const service = new IdSecureMonitorService(
    { registerControlIdUser: async (_id, direction) => { directions.push(direction ?? "E"); } },
    store,
    () => settings,
    () => undefined,
    () => undefined,
    () => undefined,
    requester
  );

  await service.pollNow();
  assert.deepEqual(directions, ["S"]);
  assert.equal(store.physical.size, 0);
  assert.equal(store.pending.size, 0);
  assert.equal(store.processed.has("controlid:turn:catraca-2:77"), true);
});

test("GIVE UP remove o acesso liberado sem registrar presença", async () => {
  const store = new MemoryStore();
  store.cursor = 700;
  store.pending.set(700, {
    idLog: 700,
    userId: 15,
    device: "CATRACA 1",
    info: "Liberado",
    receivedAt: new Date().toISOString(),
    awaitingTurn: true,
    attempts: 0
  });
  let attendance = 0;
  const service = new IdSecureMonitorService(
    { registerControlIdUser: async () => { attendance += 1; } },
    store,
    () => settings,
    () => undefined
  );

  assert.equal(await service.handlePhysicalTurn("CATRACA 1", "GIVE_UP"), true);
  assert.equal(attendance, 0);
  assert.equal(store.pending.size, 0);
  assert.equal(store.processed.has("idsecure:log:700"), true);
});

test("um usuário sem matrícula permanece salvo e não bloqueia os acessos seguintes", async () => {
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
  assert.equal(store.cursor, 202);
  assert.equal(await service.handlePhysicalTurn("CATRACA", "TURN_LEFT"), false);
  assert.equal(await service.handlePhysicalTurn("", "TURN_LEFT"), true);
  assert.equal(await service.handlePhysicalTurn("", "TURN_LEFT"), true);
  assert.deepEqual(registrations, ["0099"]);
  assert.equal(store.pending.has(201), true);
  assert.equal(store.pending.has(202), false);

  await service.pollNow();
  await service.pollNow();
  assert.equal(store.pending.has(201), true, "um evento inválido não pode ser descartado após novas tentativas");
  assert.deepEqual(registrations, ["0099"], "o evento seguinte não pode ser enviado novamente");
});

test("retoma após reinício um acesso persistido antes do envio", async () => {
  const store = new MemoryStore();
  store.cursor = 300;
  store.pending.set(300, {
    idLog: 300,
    userId: 42,
    name: "aluna",
    device: "CATRACA 1",
    info: "Entrada",
    time: "/Date(1785512850000-0300)/",
    attempts: 4,
    lastError: "ActiveSoft temporariamente indisponível"
  });
  const requester: JsonRequester = async (url) => {
    if (url.pathname === "/api/login/") return { status: 200, body: { accessToken: "token" } };
    if (url.pathname === "/api/user/list") {
      return { status: 200, body: { data: [{ idDevice: 42, name: "aluna", registration: "0012" }] } };
    }
    return { status: 200, body: { data: [] } };
  };
  const sourceIds: string[] = [];
  const service = new IdSecureMonitorService(
    {
      registerControlIdUser: async (_userId, _direction, _occurredAt, _registration, sourceId) => {
        sourceIds.push(String(sourceId));
      }
    },
    store,
    () => settings,
    () => undefined,
    () => undefined,
    () => undefined,
    requester
  );

  await service.pollNow();
  assert.deepEqual(sourceIds, ["idsecure:log:300"]);
  assert.equal(store.pending.size, 0);
  assert.equal(store.processed.has("idsecure:log:300"), true);
});
