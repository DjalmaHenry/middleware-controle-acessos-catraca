import assert from "node:assert/strict";
import test from "node:test";
import { ActiveSoftClient } from "../main/active-soft";
import { Settings } from "../shared/types";

const settings: Settings = {
  configured: true,
  activeSoftBaseUrl: "https://siga01.activesoft.com.br",
  activeSoftToken: "test-token",
  idSecureBaseUrl: "https://192.168.1.2:30443",
  idSecureUsername: "operator",
  idSecurePassword: "panel-password",
  controlIdMode: "polling",
  controlIdUsername: "admin",
  controlIdPassword: "test-password",
  controlIdDevices: [{ id: "test", name: "Catraca", host: "192.168.1.189", port: 80, enabled: true }],
  listenerPort: 8787,
  autoStart: true,
  direction: "E",
  turnLeftDirection: "E",
  turnRightDirection: "S",
  developerMode: true
};

test("informa claramente quando o token ActiveSoft expirou", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ detail: "As credenciais de autenticação não foram fornecidas." }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="api",error="invalid_token",error_description="The access token has expired."'
      }
    }
  );
  try {
    const client = new ActiveSoftClient(() => settings, () => undefined);
    await assert.rejects(
      () => client.testConnection(),
      /O token de acesso expirou/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("força HTTPS na paginação e preserva os campos de aluno", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (requestedUrls.length === 1) {
      return Response.json({
        results: [{ id: 10, matricula: "0010", nome: "Aluno A", url_foto: "https://foto/10.jpg" }],
        next: "http://siga01.activesoft.com.br/api/v0/lista_alunos/?limit=200&offset=200"
      });
    }
    return Response.json({
      results: [{ id: 11, matricula: "0011", nome: "Aluno B" }],
      next: null
    });
  };
  try {
    const client = new ActiveSoftClient(() => settings, () => undefined);
    const students = await client.listStudents();
    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[1], /^https:\/\/siga01\.activesoft\.com\.br/);
    assert.deepEqual(students.map(({ id, matricula }) => ({ id, matricula })), [
      { id: 10, matricula: "0010" },
      { id: 11, matricula: "0011" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("não registra no Console as listagens bem-sucedidas de alunos", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ results: [], next: null });
  const logs: Array<{ category: string; title: string }> = [];
  try {
    const client = new ActiveSoftClient(
      () => settings,
      (category, title) => logs.push({ category, title })
    );
    await client.listStudents();
    assert.deepEqual(logs, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("envia a frequência com matrícula textual e autenticação Bearer", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), init };
    return Response.json({ ok: true }, { status: 201 });
  };
  try {
    const client = new ActiveSoftClient(() => settings, () => undefined);
    await client.markAttendance("0011226", "E", "2026-07-30T12:00:00.000Z");
    assert.match(captured?.url ?? "", /\/api\/v0\/marcar_frequencia_aluno\/$/);
    assert.equal(captured?.init?.method, "POST");
    assert.equal((captured?.init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
      data_hora: "2026-07-30T12:00:00.000Z",
      tipo_entrada_saida: "E",
      matricula: "0011226",
      comentario: "Catraca Control iD"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
