import assert from "node:assert/strict";
import test from "node:test";
import { ControlIdServer } from "../main/control-id-server";

test("registra somente depois da confirmação de giro", async () => {
  const registered: Array<{ studentId: number; direction: string }> = [];
  const service = {
    registerControlIdUser: async (studentId: number, direction: string) => {
      registered.push({ studentId, direction });
      return {} as never;
    }
  };
  const pending = new Map<string, { userId: number; time: number }>();
  const store = {
    saveControlIdMapping: () => undefined,
    getControlIdRegistration: () => undefined,
    savePendingControlIdAccess: (id: string, value: { userId: number; time: number }) => pending.set(id, value),
    getPendingControlIdAccess: (id: string) => pending.get(id),
    removePendingControlIdAccess: (id: string) => pending.delete(id)
  };
  const settings = () => ({ turnLeftDirection: "E", turnRightDirection: "S", direction: "E" });
  const server = new ControlIdServer(service as never, store as never, settings as never, () => undefined);
  const port = await server.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/dao`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_changes: [{ object: "access_logs", type: "inserted", values: { id: 55, user_id: 101, time: 1700000000 } }] })
    });
    assert.deepEqual(registered, []);
    await fetch(`http://127.0.0.1:${port}/api/notifications/catra_event`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { type: 7, name: "TURN LEFT", time: 1700000001 }, access_event_id: 55 })
    });
    assert.deepEqual(registered, [{ studentId: 101, direction: "E" }]);
  } finally { await server.stop(); }
});

test("aprende a matrícula recebida no objeto users", async () => {
  const mappings: Array<{ userId: number; registration: string }> = [];
  const service = { registerControlIdUser: async () => ({} as never) };
  const store = {
    saveControlIdMapping: (userId: number, registration: string) => mappings.push({ userId, registration }),
    getControlIdRegistration: () => undefined,
    savePendingControlIdAccess: () => undefined,
    getPendingControlIdAccess: () => undefined,
    removePendingControlIdAccess: () => undefined
  };
  const settings = () => ({ turnLeftDirection: "E", turnRightDirection: "S", direction: "E" });
  const server = new ControlIdServer(service as never, store as never, settings as never, () => undefined);
  const port = await server.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/dao`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_changes: [{
          object: "users",
          type: "inserted",
          values: { id: 101, registration: "0011226", name: "Aluno Teste" }
        }]
      })
    });
    assert.deepEqual(mappings, [{ userId: 101, registration: "0011226" }]);
  } finally { await server.stop(); }
});

test("ignora desistência da catraca", async () => {
  const registered: number[] = [];
  const service = { registerControlIdUser: async (studentId: number) => { registered.push(studentId); return {} as never; } };
  const pending = new Map<string, { userId: number; time: number }>();
  const store = {
    saveControlIdMapping: () => undefined,
    getControlIdRegistration: () => undefined,
    savePendingControlIdAccess: (id: string, value: { userId: number; time: number }) => pending.set(id, value),
    getPendingControlIdAccess: (id: string) => pending.get(id),
    removePendingControlIdAccess: (id: string) => pending.delete(id)
  };
  const settings = () => ({ turnLeftDirection: "E", turnRightDirection: "S", direction: "E" });
  const server = new ControlIdServer(service as never, store as never, settings as never, () => undefined);
  const port = await server.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/access_logs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_changes: [{ object: "access_logs", type: "inserted", values: { id: 56, user_id: 102, time: 1700000000 } }] })
    });
    await fetch(`http://127.0.0.1:${port}/api/notifications/catra_event`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { type: 13, name: "GIVE UP", time: 1700000001 }, access_event_id: 56 })
    });
    assert.deepEqual(registered, []);
  } finally { await server.stop(); }
});

test("sinaliza conexão somente após notificação real da Control iD", async () => {
  const contacts: Array<{ key: string; path: string; deviceId?: string }> = [];
  const service = { registerControlIdUser: async () => ({} as never) };
  const store = {
    saveControlIdMapping: () => undefined,
    getControlIdRegistration: () => undefined,
    savePendingControlIdAccess: () => undefined,
    getPendingControlIdAccess: () => undefined,
    removePendingControlIdAccess: () => undefined
  };
  const settings = () => ({ turnLeftDirection: "E", turnRightDirection: "S", direction: "E" });
  const server = new ControlIdServer(
    service as never,
    store as never,
    settings as never,
    () => undefined,
    (contact) => contacts.push(contact)
  );
  const port = await server.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    await fetch(`http://127.0.0.1:${port}/rota-desconhecida`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(contacts.length, 0);

    await fetch(`http://127.0.0.1:${port}/api/notifications/device_is_alive?device_id=77`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].key, "device:77");
    assert.equal(contacts[0].deviceId, "77");
    assert.equal(contacts[0].path, "/api/notifications/device_is_alive");
  } finally { await server.stop(); }
});
