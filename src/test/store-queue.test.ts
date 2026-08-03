import assert from "node:assert/strict";
import test from "node:test";
import { discardLegacyQueue } from "../main/store";
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

test("descarta a fila legada sem apagar o histórico", () => {
  const queued = access("queued", "queued");
  const missingFromHistory = access("missing", "queued");
  const sent = access("sent", "sent");

  const migrated = discardLegacyQueue([queued, sent], [queued, missingFromHistory]);

  assert.equal(migrated.length, 3);
  assert.equal(migrated.find((record) => record.id === "queued")?.status, "failed");
  assert.match(migrated.find((record) => record.id === "queued")?.message ?? "", /tentativa única sem fila/);
  assert.equal(migrated.find((record) => record.id === "missing")?.status, "failed");
  assert.equal(migrated.find((record) => record.id === "sent")?.status, "sent");
});
