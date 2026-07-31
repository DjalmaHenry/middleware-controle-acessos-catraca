export interface ListenerHealthResult {
  ok: boolean;
  detail?: string;
}

export async function probePonteListener(port: number, timeoutMs = 1_500): Promise<ListenerHealthResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json() as { ok?: boolean; service?: string };
    if (response.ok && payload.ok === true && payload.service === "ponte-id") return { ok: true };
    return { ok: false, detail: "A porta respondeu, mas não pertence ao receptor Ponte ID." };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
