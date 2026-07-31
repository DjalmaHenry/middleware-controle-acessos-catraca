import assert from "node:assert/strict";
import test from "node:test";
import { buildStudentCacheCheck } from "../main/student-cache-check";
import { Student } from "../shared/types";

const students: Student[] = [
  { id: 101, matricula: "202600101", nome: "Aluno Teste", urlFoto: "https://example.com/foto.jpg" }
];

test("não aprova alunos de demonstração como cadastro ActiveSoft", () => {
  const check = buildStudentCacheCheck(students, {
    source: "demo",
    syncedAt: "2026-07-31T00:00:00.000Z"
  });

  assert.equal(check.status, "fail");
  assert.equal(check.blocking, true);
  assert.match(check.detail, /demonstração/);
});

test("não aprova cache legado sem origem comprovada", () => {
  const check = buildStudentCacheCheck(students, undefined);

  assert.equal(check.status, "fail");
  assert.match(check.detail, /origem não pode ser comprovada/);
});

test("aprova somente cache sincronizado da ActiveSoft", () => {
  const check = buildStudentCacheCheck(students, {
    source: "activesoft",
    syncedAt: "2026-07-31T00:00:00.000Z"
  });

  assert.equal(check.status, "pass");
  assert.match(check.detail, /sincronizados da ActiveSoft/);
});
