import assert from "node:assert/strict";
import test from "node:test";
import { ControlIdServer } from "../main/control-id-server";

test("registra somente depois da confirmação de giro", async () => {
  const registered: number[] = [];
  const service = { register: async (studentId: number) => { registered.push(studentId); return {} as never; } };
  const server = new ControlIdServer(service as never);
  const port = await server.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/access_logs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_changes: [{ object: "access_logs", type: "inserted", values: { id: 55, user_id: 101, time: 1700000000 } }] })
    });
    assert.deepEqual(registered, []);
    await fetch(`http://127.0.0.1:${port}/api/notifications/catra_event`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { type: 7, name: "TURN LEFT", time: 1700000001 }, access_event_id: 55 })
    });
    assert.deepEqual(registered, [101]);
  } finally { await server.stop(); }
});

test("ignora desistência da catraca", async () => {
  const registered: number[] = [];
  const service = { register: async (studentId: number) => { registered.push(studentId); return {} as never; } };
  const server = new ControlIdServer(service as never);
  const port = await server.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notifications/access_logs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_changes: [{ object: "access_logs", type: "inserted", values: { id: 56, user_id: 102, time: 1700000000 } }] })
    });
    await fetch(`http://127.0.0.1:${port}/api/notifications/catra_event`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: { type: 8, name: "GIVE UP", time: 1700000001 }, access_event_id: 56 })
    });
    assert.deepEqual(registered, []);
  } finally { await server.stop(); }
});
