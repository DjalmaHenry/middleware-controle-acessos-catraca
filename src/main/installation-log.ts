import { InstallationCheck } from "../shared/types";

export function buildInstallationLog(checks: InstallationCheck[]): {
  ready: boolean;
  title: string;
  payload: {
    ready: boolean;
    summary: { passed: number; blockingFailures: number; warnings: number };
    pendingChecks: InstallationCheck[];
  };
} {
  const blockingFailures = checks.filter((check) => check.blocking && check.status !== "pass");
  const warnings = checks.filter((check) => check.status === "warning");
  const ready = blockingFailures.length === 0;
  const pendingChecks = ready ? warnings : [...blockingFailures, ...warnings];
  const title = ready
    ? warnings.length
      ? `Instalação validada com ${warnings.length} ${warnings.length === 1 ? "aviso" : "avisos"}`
      : "Instalação validada e pronta"
    : `Validação encontrou ${blockingFailures.length} ${blockingFailures.length === 1 ? "bloqueio" : "bloqueios"} e ${warnings.length} ${warnings.length === 1 ? "aviso" : "avisos"}`;

  return {
    ready,
    title,
    payload: {
      ready,
      summary: {
        passed: checks.filter((check) => check.status === "pass").length,
        blockingFailures: blockingFailures.length,
        warnings: warnings.length
      },
      pendingChecks
    }
  };
}
