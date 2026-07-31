import { randomUUID } from "node:crypto";
import { ActiveSoftClient } from "./active-soft";
import { JsonStore } from "./store";
import { AccessRecord, Direction, Student } from "../shared/types";
import { IntegrationLogger } from "./integration-logger";

export class AccessService {
  private processing = false;
  constructor(
    private readonly store: JsonStore,
    private readonly activeSoft: ActiveSoftClient,
    private readonly onChange: () => void,
    private readonly log: IntegrationLogger
  ) {}

  async register(studentId: number, direction?: Direction, occurredAt = new Date().toISOString()): Promise<AccessRecord> {
    const student = this.store.getStudents().find((item) => item.id === studentId);
    if (!student) throw new Error(`Aluno ${studentId} não encontrado na sincronização local.`);
    const record: AccessRecord = {
      id: randomUUID(), studentId, studentName: student.nome, matricula: student.matricula,
      photoUrl: student.urlFoto, direction: direction ?? this.store.getSettings().direction,
      occurredAt, status: "sending"
    };
    this.store.addAccess(record);
    this.onChange();
    return this.send(record);
  }

  async registerControlIdUser(
    userId: number,
    direction?: Direction,
    occurredAt = new Date().toISOString(),
    registration?: string
  ): Promise<AccessRecord> {
    const mappedRegistration = registration || this.store.getControlIdRegistration(userId);
    const students = this.store.getStudents();
    const student = mappedRegistration
      ? students.find((item) => normalizeRegistration(item.matricula) === normalizeRegistration(mappedRegistration))
      : students.find((item) => item.id === userId);
    if (!student) {
      const message = mappedRegistration
        ? `Matrícula ${mappedRegistration} do usuário Control iD ${userId} não encontrada na ActiveSoft.`
        : `Usuário Control iD ${userId} sem matrícula associada. Cadastre a matrícula no campo registration do iDSecure.`;
      this.log("error", "Não foi possível associar o acesso a um aluno", { user_id: userId, registration: mappedRegistration, message });
      throw new Error(message);
    }
    return this.register(student.id, direction, occurredAt);
  }

  async retryQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      for (const record of this.store.getQueue().reverse()) await this.send(record);
    } finally {
      this.processing = false;
    }
  }

  seedDemoStudents(): Student[] {
    const students: Student[] = [
      { id: 101, matricula: "202600101", nome: "Marina Oliveira", turma: "7º Ano A", urlFoto: "https://i.pravatar.cc/600?img=47" },
      { id: 102, matricula: "202600102", nome: "Lucas Almeida", turma: "8º Ano B", urlFoto: "https://i.pravatar.cc/600?img=12" },
      { id: 103, matricula: "202600103", nome: "Beatriz Santos", turma: "6º Ano A", urlFoto: "https://i.pravatar.cc/600?img=32" }
    ];
    this.store.saveStudents(students);
    this.onChange();
    return students;
  }

  private async send(record: AccessRecord): Promise<AccessRecord> {
    try {
      if (this.store.getSettings().demoMode) {
        this.log("api-out", "SIMULAÇÃO POST ActiveSoft /api/v0/marcar_frequencia_aluno/", {
          data_hora: record.occurredAt,
          tipo_entrada_saida: record.direction,
          matricula: record.matricula,
          comentario: "Catraca Control iD"
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
        this.log("api-in", "SIMULAÇÃO 201 ActiveSoft - frequência registrada", { ok: true });
      } else await this.activeSoft.markAttendance(record.matricula, record.direction, record.occurredAt);
      const sent = { ...record, status: "sent" as const, message: undefined };
      this.store.dequeue(record.id);
      this.store.addAccess(sent);
      this.onChange();
      return sent;
    } catch (error) {
      const queued = { ...record, status: "queued" as const, message: error instanceof Error ? error.message : String(error) };
      this.store.enqueue(queued);
      this.store.addAccess(queued);
      this.onChange();
      return queued;
    }
  }
}

function normalizeRegistration(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, "");
}
