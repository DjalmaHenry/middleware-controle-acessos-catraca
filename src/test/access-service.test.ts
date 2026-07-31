import assert from "node:assert/strict";
import test from "node:test";
import { AccessService } from "../main/access-service";
import { ActiveSoftClient } from "../main/active-soft";
import { JsonStore } from "../main/store";
import { AccessRecord, Settings, Student } from "../shared/types";

class MemoryAccessStore {
  recent: AccessRecord[] = [];
  queue: AccessRecord[] = [];
  students: Student[] = [{ id: 10, matricula: "0054", nome: "Aluno" }];
  getStudentSync(): { syncedAt: string } { return { syncedAt: new Date().toISOString() }; }
  getStudents(): Student[] { return [...this.students]; }
  getRecentAccesses(): AccessRecord[] { return [...this.recent]; }
  getQueue(): AccessRecord[] { return [...this.queue]; }
  getSettings(): Pick<Settings, "direction"> { return { direction: "E" }; }
  getControlIdRegistration(): string | undefined { return undefined; }
  addAccess(record: AccessRecord): void {
    this.recent = [record, ...this.recent.filter((item) => item.id !== record.id)];
  }
  enqueue(record: AccessRecord): void {
    this.queue = [record, ...this.queue.filter((item) => item.id !== record.id)];
  }
  dequeue(id: string): void { this.queue = this.queue.filter((item) => item.id !== id); }
}

test("deduplica chamadas simultâneas pelo idLog do iDSecure", async () => {
  const store = new MemoryAccessStore();
  let sends = 0;
  const activeSoft = {
    markAttendance: async () => {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const service = new AccessService(
    store as unknown as JsonStore,
    activeSoft as unknown as ActiveSoftClient,
    () => undefined,
    () => undefined
  );

  await Promise.all([
    service.registerControlIdUser(99, "E", "2026-07-31T15:47:30.000Z", "0054", "idsecure:log:175324"),
    service.registerControlIdUser(99, "E", "2026-07-31T15:47:30.000Z", "0054", "idsecure:log:175324")
  ]);

  assert.equal(sends, 1);
  assert.equal(store.recent[0].id, "idsecure:log:175324");
  assert.equal(store.recent[0].status, "sent");
});

test("mantém na fila após falha e não reenvia depois de concluído", async () => {
  const store = new MemoryAccessStore();
  let sends = 0;
  const activeSoft = {
    markAttendance: async () => {
      sends += 1;
      if (sends === 1) throw new Error("indisponível");
    }
  };
  const service = new AccessService(
    store as unknown as JsonStore,
    activeSoft as unknown as ActiveSoftClient,
    () => undefined,
    () => undefined
  );

  const first = await service.registerControlIdUser(99, "E", undefined, "0054", "idsecure:log:175325");
  assert.equal(first.status, "queued");
  assert.equal(store.queue.length, 1);

  const second = await service.registerControlIdUser(99, "E", undefined, "0054", "idsecure:log:175325");
  assert.equal(second.status, "sent");
  assert.equal(store.queue.length, 0);

  const third = await service.registerControlIdUser(99, "E", undefined, "0054", "idsecure:log:175325");
  assert.equal(third.status, "sent");
  assert.equal(sends, 2);
});
