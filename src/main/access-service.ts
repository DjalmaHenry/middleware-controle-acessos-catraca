import { randomUUID } from "node:crypto";
import { ActiveSoftClient } from "./active-soft";
import { JsonStore } from "./store";
import { AccessRecord, Direction } from "../shared/types";
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
    if (!this.store.getStudentSync()) {
      throw new Error("Não existe uma sincronização real de alunos da ActiveSoft disponível. Configure o token e sincronize antes de processar acessos.");
    }
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

  private async send(record: AccessRecord): Promise<AccessRecord> {
    try {
      await this.activeSoft.markAttendance(record.matricula, record.direction, record.occurredAt);
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
