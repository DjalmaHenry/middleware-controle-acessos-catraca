import { IntegrationLogger } from "./integration-logger";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const SUCCESS_CACHE_MS = 6 * 60 * 60 * 1000;
const FAILURE_CACHE_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 60;

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

export class PhotoService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly log: IntegrationLogger,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async resolve(photoUrl?: string): Promise<string | null> {
    if (!photoUrl) return null;
    const cached = this.cache.get(photoUrl);
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.delete(photoUrl);
      this.cache.set(photoUrl, cached);
      return cached.value;
    }
    if (cached) this.cache.delete(photoUrl);

    const pending = this.inFlight.get(photoUrl);
    if (pending) return pending;

    const request = this.download(photoUrl)
      .catch((error) => {
        this.log("error", "Não foi possível preparar a foto do aluno", {
          host: safeHostname(photoUrl),
          message: error instanceof Error ? error.message : String(error)
        });
        return null;
      })
      .then((value) => {
        this.cache.set(photoUrl, {
          value,
          expiresAt: Date.now() + (value ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS)
        });
        this.trimCache();
        return value;
      })
      .finally(() => this.inFlight.delete(photoUrl));

    this.inFlight.set(photoUrl, request);
    return request;
  }

  private async download(photoUrl: string): Promise<string> {
    const target = new URL(photoUrl);
    if (target.protocol !== "https:") throw new Error("A foto não usa uma conexão HTTPS.");

    const response = await this.fetcher(target, {
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Servidor da foto respondeu ${response.status}.`);
    if (response.url && new URL(response.url).protocol !== "https:") {
      throw new Error("A foto foi redirecionada para uma conexão não segura.");
    }

    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_PHOTO_BYTES) {
      throw new Error("A foto ultrapassa o limite de 8 MB.");
    }

    const bytes = await readLimited(response, MAX_PHOTO_BYTES);
    const mime = detectImageMime(bytes);
    if (!mime) throw new Error("O conteúdo recebido não é uma imagem compatível.");
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  private trimCache(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) return;
      this.cache.delete(oldest);
    }
  }
}

export function detectImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 12).toString("ascii").startsWith("ftypavi")) return "image/avif";
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("A foto ultrapassa o limite de 8 MB.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return "endereço inválido"; }
}
