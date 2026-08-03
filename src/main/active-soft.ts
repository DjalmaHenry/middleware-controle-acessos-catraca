import { Direction, Settings, Student } from "../shared/types";
import { IntegrationLogger } from "./integration-logger";

interface Paginated<T> { results?: T[]; next?: string | null }
interface RawStudent {
  id: number;
  matricula: string | number;
  nome: string;
  url_foto?: string;
  nome_turma?: string;
}

export class ActiveSoftClient {
  constructor(
    private readonly getSettings: () => Settings,
    private readonly log: IntegrationLogger
  ) {}

  async listStudents(): Promise<Student[]> {
    const all: Student[] = [];
    let next: string | null = this.url("/api/v0/lista_alunos/?limit=200");
    while (next) {
      const payload: Paginated<RawStudent> | RawStudent[] = await this.request<Paginated<RawStudent> | RawStudent[]>(next);
      const rows: RawStudent[] = Array.isArray(payload) ? payload : payload.results ?? [];
      all.push(...rows.map((student: RawStudent) => ({
        id: Number(student.id),
        matricula: String(student.matricula),
        nome: student.nome,
        urlFoto: student.url_foto,
        turma: student.nome_turma
      })));
      next = Array.isArray(payload) ? null : this.securePaginationUrl(payload.next);
    }
    return all;
  }

  async markAttendance(matricula: string, direction: Direction, occurredAt: string): Promise<void> {
    await this.request(this.url("/api/v0/marcar_frequencia_aluno/"), {
      method: "POST",
      body: JSON.stringify({
        data_hora: toActiveSoftLocalDateTime(occurredAt),
        tipo_entrada_saida: direction,
        matricula,
        comentario: "Catraca Control iD"
      })
    });
  }

  async testConnection(): Promise<void> {
    await this.request(this.url("/api/v0/lista_alunos/?limit=1"));
  }

  async testAttendancePermission(): Promise<void> {
    await this.request(this.url("/api/v0/marcar_frequencia_aluno/"), { method: "OPTIONS" });
  }

  private url(route: string): string {
    return `${this.getSettings().activeSoftBaseUrl.replace(/\/$/, "")}${route}`;
  }

  private securePaginationUrl(next?: string | null): string | null {
    if (!next) return null;
    const target = new URL(next, this.getSettings().activeSoftBaseUrl);
    const configured = new URL(this.getSettings().activeSoftBaseUrl);
    if (target.hostname !== configured.hostname) {
      throw new Error(`Paginação ActiveSoft apontou para host inesperado: ${target.hostname}`);
    }
    target.protocol = "https:";
    return target.toString();
  }

  private async request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const settings = this.getSettings();
    if (!settings.activeSoftToken) throw new Error("Token da ActiveSoft não configurado.");
    const method = init.method ?? "GET";
    const safeUrl = url.replace(settings.activeSoftBaseUrl, "");
    const requestBody = parseJsonOrText(typeof init.body === "string" ? init.body : undefined);
    const quietStudentListing = method === "GET" && isStudentListingUrl(url);
    if (!quietStudentListing) this.log("api-out", `${method} ActiveSoft ${safeUrl}`, requestBody);
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${settings.activeSoftToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init.headers
        }
      });
      const responseText = response.status === 204 ? "" : await response.text();
      const responseBody = parseJsonOrText(responseText);
      const bearerError = parseBearerChallenge(response.headers.get("www-authenticate"));
      if (!response.ok || !quietStudentListing) {
        this.log(response.ok ? "api-in" : "error", `${response.status} ActiveSoft ${method} ${safeUrl}`, {
          body: responseBody,
          authentication: bearerError
        });
      }
      if (!response.ok) {
        const detail = bearerError?.description || responseText.slice(0, 300) || response.statusText;
        throw new Error(`ActiveSoft respondeu ${response.status}: ${translateAuthenticationError(detail)}`);
      }
      if (response.status === 204 || !responseText) return undefined as T;
      return responseBody as T;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("ActiveSoft respondeu"))) {
        this.log("error", `Falha de comunicação com ActiveSoft ${method} ${safeUrl}`, {
          message: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
  }
}

function isStudentListingUrl(value: string): boolean {
  try {
    return new URL(value).pathname === "/api/v0/lista_alunos/";
  } catch {
    return false;
  }
}

function parseJsonOrText(value?: string): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

function toActiveSoftLocalDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Data de acesso inválida: ${value}`);
  const pad = (part: number, length = 2) => String(part).padStart(length, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  ].join("T");
}

function parseBearerChallenge(header: string | null): { error?: string; description?: string } | undefined {
  if (!header) return undefined;
  const error = header.match(/(?:^|,)error="([^"]+)"/i)?.[1];
  const description = header.match(/error_description="([^"]+)"/i)?.[1];
  return error || description ? { error, description } : undefined;
}

function translateAuthenticationError(detail: string): string {
  if (/token has expired|expired token|token expirado/i.test(detail)) {
    return "O token de acesso expirou. Gere um novo token na ActiveSoft e atualize as Configurações.";
  }
  if (/invalid[_ ]token|token is invalid/i.test(detail)) {
    return "O token de acesso é inválido. Confira ou gere uma nova credencial na ActiveSoft.";
  }
  return detail;
}
