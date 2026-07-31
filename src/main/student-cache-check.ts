import { InstallationCheck, Student, StudentSyncState } from "../shared/types";

export function buildStudentCacheCheck(
  students: Student[],
  sync: StudentSyncState | undefined
): InstallationCheck {
  const photoCount = students.filter((student) => student.urlFoto).length;

  if (sync?.source === "activesoft" && students.length > 0) {
    return {
      id: "students",
      title: "Cadastro local de alunos",
      status: "pass",
      blocking: true,
      detail: `${students.length} alunos sincronizados da ActiveSoft em ${new Date(sync.syncedAt).toLocaleString("pt-BR")}; ${photoCount} possuem foto.`
    };
  }

  if (sync?.source === "demo") {
    return {
      id: "students",
      title: "Cadastro local de alunos",
      status: "fail",
      blocking: true,
      detail: `${students.length} alunos de demonstração estão no cache; eles não comprovam uma sincronização com a ActiveSoft.`,
      resolution: "Desative o modo demonstração, configure o token ActiveSoft e clique em Sincronizar."
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
