import { Direction, Settings, Student } from "../shared/types";

interface Paginated<T> { results?: T[]; next?: string | null }
interface RawStudent {
  id: number;
  matricula: string | number;
  nome: string;
  url_foto?: string;
  nome_turma?: string;
}

export class ActiveSoftClient {
  constructor(private readonly getSettings: () => Settings) {}

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
      next = Array.isArray(payload) ? null : payload.next ?? null;
    }
    return all;
  }

  async markAttendance(matricula: string, direction: Direction, occurredAt: string): Promise<void> {
    await this.request(this.url("/api/v0/marcar_frequencia_aluno/"), {
      method: "POST",
      body: JSON.stringify({
        data_hora: occurredAt,
        tipo_entrada_saida: direction,
        matricula,
        comentario: "Catraca Control iD"
      })
    });
  }

  async testConnection(): Promise<void> {
    await this.request(this.url("/api/v0/lista_unidades/?limit=1"));
  }

  private url(route: string): string {
    return `${this.getSettings().activeSoftBaseUrl.replace(/\/$/, "")}${route}`;
  }

  private async request<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const settings = this.getSettings();
    if (!settings.activeSoftToken) throw new Error("Token da ActiveSoft não configurado.");
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
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`ActiveSoft respondeu ${response.status}: ${body || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}
