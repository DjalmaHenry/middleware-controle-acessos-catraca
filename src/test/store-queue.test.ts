import assert from "node:assert/strict";
import test from "node:test";
import { clearPendingWorkState, PendingWorkState } from "../main/store";
import { AccessRecord } from "../shared/types";

function access(id: string, status: AccessRecord["status"]): AccessRecord {
  return {
    id,
    studentId: 1,
    studentName: "Aluno Teste",
    matricula: "0054",
    direction: "E",
    occurredAt: "2026-08-03T15:00:00.000Z",
    status
  };
}

test("zera todas as pendências sem apagar o histórico", () => {
  const queued = access("queued", "queued");
  const sent = access("sent", "sent");
  const state: PendingWorkState = {
    recentAccesses: [queued, sent],
    queue: [queued],
    pendingControlIdAccesses: { "10": { userId: 7, time: 1 } },
    pendingIdSecureAccesses: { "20": { idLog: 20, userId: 7, attempts: 2 } },
    pendingPhysicalTurns: {
      turn: { key: "turn", device: "CATRACA 1", eventId: 30, event: "TURN_LEFT", receivedAt: "2026-08-03T15:00:00.000Z" }
    }
  };

  const removed = clearPendingWorkState(state, "Removido manualmente da fila de envio.");

  assert.deepEqual(removed, { activeSoft: 1, idSecure: 1, controlId: 1, physicalTurns: 1 });
  assert.equal(state.queue.length, 0);
  assert.equal(Object.keys(state.pendingControlIdAccesses).length, 0);
  assert.equal(Object.keys(state.pendingIdSecureAccesses).length, 0);
  assert.equal(Object.keys(state.pendingPhysicalTurns).length, 0);
  assert.equal(state.recentAccesses.find((record) => record.id === "queued")?.status, "failed");
  assert.equal(state.recentAccesses.find((record) => record.id === "queued")?.message, "Removido manualmente da fila de envio.");
  assert.equal(state.recentAccesses.find((record) => record.id === "sent")?.status, "sent");
});
