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
  const logs: Array<{ title: string; payload?: unknown }> = [];
  const service = new AccessService(
    store as unknown as JsonStore,
    activeSoft as unknown as ActiveSoftClient,
    () => undefined,
    (_category, title, payload) => logs.push({ title, payload })
  );

  await Promise.all([
    service.registerControlIdUser(99, "E", "2026-07-31T15:47:30.000Z", "0054", "idsecure:log:175324", {
      idSecurePhotoPath: "image/log/175324.jpg",
      controlIdDeviceName: "CATRACA 2"
    }),
    service.registerControlIdUser(99, "E", "2026-07-31T15:47:30.000Z", "0054", "idsecure:log:175324")
  ]);

  assert.equal(sends, 1);
  assert.equal(store.recent[0].id, "idsecure:log:175324");
  assert.equal(store.recent[0].status, "sent");
  assert.equal(store.recent[0].controlIdUserId, 99);
  assert.equal(store.recent[0].controlIdDeviceName, "CATRACA 2");
  assert.equal(store.recent[0].idSecurePhotoPath, "image/log/175324.jpg");
  assert.ok(logs.some((entry) => entry.title === "Matrícula iDSecure associada ao aluno ActiveSoft"));
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

test("arquiva localmente um acesso sem matrícula sem chamar a ActiveSoft", () => {
  const store = new MemoryAccessStore();
  let sends = 0;
  let changes = 0;
  const service = new AccessService(
    store as unknown as JsonStore,
    { markAttendance: async () => { sends += 1; } } as unknown as ActiveSoftClient,
    () => { changes += 1; },
    () => undefined
  );

  const record = service.recordUnlinkedControlIdUser(
    1001,
    "Aluno sem matrícula",
    "E",
    "2026-08-03T12:00:00.000Z",
    "idsecure:log:900",
    "Matrícula ausente",
    { idSecurePhotoPath: "image/log/900.jpg", controlIdDeviceName: "CATRACA 1" }
  );

  assert.equal(record.status, "failed");
  assert.equal(record.matricula, "Não informada");
  assert.equal(record.controlIdUserId, 1001);
  assert.equal(record.idSecurePhotoPath, "image/log/900.jpg");
  assert.equal(store.recent.length, 1);
  assert.equal(store.queue.length, 0);
  assert.equal(sends, 0);
  assert.equal(changes, 1);
});
