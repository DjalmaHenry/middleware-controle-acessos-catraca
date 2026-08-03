import { randomUUID } from "node:crypto";
import { ActiveSoftClient } from "./active-soft";
import { JsonStore } from "./store";
import { AccessRecord, Direction } from "../shared/types";
import { IntegrationLogger } from "./integration-logger";

interface AccessPhotoContext {
  idSecurePhotoPath?: string;
  controlIdUserId?: number;
  controlIdDeviceName?: string;
}

export class AccessService {
  private readonly inFlight = new Map<string, Promise<AccessRecord>>();
  constructor(
    private readonly store: JsonStore,
    private readonly activeSoft: ActiveSoftClient,
    private readonly onChange: () => void,
    private readonly log: IntegrationLogger
  ) {}

  async register(
    studentId: number,
    direction?: Direction,
    occurredAt = new Date().toISOString(),
    recordId: string = randomUUID(),
    photoContext: AccessPhotoContext = {}
  ): Promise<AccessRecord> {
    if (!this.store.getStudentSync()) {
      throw new Error("Não existe uma sincronização real de alunos da ActiveSoft disponível. Configure o token e sincronize antes de processar acessos.");
    }
    const student = this.store.getStudents().find((item) => item.id === studentId);
    if (!student) throw new Error(`Aluno ${studentId} não encontrado na sincronização local.`);
    const existing = this.store.getRecentAccesses().find((item) => item.id === recordId)
      ?? this.store.getQueue().find((item) => item.id === recordId);
    if (existing) return existing;
    const record: AccessRecord = {
      id: recordId, studentId, studentName: student.nome, matricula: student.matricula,
      photoUrl: student.urlFoto,
      ...photoContext,
      direction: direction ?? this.store.getSettings().direction,
      occurredAt, status: "sending"
    };
    this.store.addAccess(record);
    this.onChange();
    return this.sendOnce(record);
  }

  async registerControlIdUser(
    userId: number,
    direction?: Direction,
    occurredAt = new Date().toISOString(),
    registration?: string,
    sourceId?: string,
    photoContext: AccessPhotoContext = {}
  ): Promise<AccessRecord> {
    const mappedRegistration = registration || this.store.getControlIdRegistration(userId);
    const students = this.store.getStudents();
    const student = mappedRegistration
      ? findStudentByRegistration(students, mappedRegistration)
      : undefined;
    if (!student) {
      const message = mappedRegistration
        ? `Matrícula ${mappedRegistration} do usuário Control iD ${userId} não encontrada na ActiveSoft.`
        : `Usuário Control iD ${userId} sem matrícula associada. Cadastre a matrícula no campo registration do iDSecure.`;
      this.log("error", "Não foi possível associar o acesso a um aluno", { user_id: userId, registration: mappedRegistration, message });
      throw new Error(message);
    }
    this.log("system", "Matrícula iDSecure associada ao aluno ActiveSoft", {
      userId,
      registration: mappedRegistration,
      studentId: student.id,
      studentName: student.nome
    });
    return this.register(student.id, direction, occurredAt, sourceId, {
      controlIdUserId: userId,
      ...photoContext
    });
  }

  recordUnlinkedControlIdUser(
    userId: number,
    studentName: string | undefined,
    direction: Direction,
    occurredAt: string,
    sourceId: string,
    message: string,
    photoContext: AccessPhotoContext = {},
    registration?: string
  ): AccessRecord {
    const existing = this.store.getRecentAccesses().find((item) => item.id === sourceId);
    if (existing) return existing;
    const record: AccessRecord = {
      id: sourceId,
      studentId: 0,
      studentName: studentName?.trim() || `Usuário Control iD ${userId}`,
      matricula: registration?.trim() || "Não informada",
      controlIdUserId: userId,
      ...photoContext,
      direction,
      occurredAt,
      status: "failed",
      message
    };
    this.store.addAccess(record);
    this.onChange();
    return record;
  }

  private sendOnce(record: AccessRecord): Promise<AccessRecord> {
    const existing = this.inFlight.get(record.id);
    if (existing) return existing;
    const request = this.send(record).finally(() => this.inFlight.delete(record.id));
    this.inFlight.set(record.id, request);
    return request;
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
      const failed = { ...record, status: "failed" as const, message: error instanceof Error ? error.message : String(error) };
      this.store.dequeue(record.id);
      this.store.addAccess(failed);
      this.onChange();
      return failed;
    }
  }
}

function normalizeRegistration(value: string): string {
  return value.trim().replace(/^0+(?=\d)/, "");
}

export function findStudentByRegistration<T extends { matricula: string }>(students: T[], registration: string): T | undefined {
  const exact = registration.trim();
  return students.find((student) => student.matricula.trim() === exact)
    ?? students.find((student) => normalizeRegistration(student.matricula) === normalizeRegistration(exact));
}
