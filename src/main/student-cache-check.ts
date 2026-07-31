import { InstallationCheck, Student, StudentSyncState } from "../shared/types";

export function normalizeStudentSync(value: unknown): StudentSyncState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<StudentSyncState> & { source?: unknown };
  if ("source" in candidate && candidate.source !== "activesoft") return undefined;
  return typeof candidate.syncedAt === "string" && !Number.isNaN(Date.parse(candidate.syncedAt))
    ? { syncedAt: candidate.syncedAt }
    : undefined;
}

export function buildStudentCacheCheck(
  students: Student[],
  sync: StudentSyncState | undefined
): InstallationCheck {
  const photoCount = students.filter((student) => student.urlFoto).length;

  if (sync && students.length > 0) {
    return {
      id: "students",
      title: "Cadastro local de alunos",
      status: "pass",
      blocking: true,
      detail: `${students.length} alunos sincronizados da ActiveSoft em ${new Date(sync.syncedAt).toLocaleString("pt-BR")}; ${photoCount} possuem foto.`
    };
  }

  if (students.length > 0) {
    return {
      id: "students",
      title: "Cadastro local de alunos",
      status: "fail",
      blocking: true,
      detail: `${students.length} alunos estão em um cache de versão anterior cuja origem não pode ser comprovada.`,
      resolution: "Configure o token ActiveSoft e execute uma nova sincronização para validar a origem dos alunos."
    };
  }

  return {
    id: "students",
    title: "Cadastro local de alunos",
    status: "fail",
    blocking: true,
    detail: "Nenhum aluno sincronizado da ActiveSoft está disponível no cache local.",
    resolution: "Corrija a conexão ActiveSoft e clique em Sincronizar."
  };
}
