import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AccessService } from "./access-service";
import { ControlIdDeviceContact, Direction, Settings } from "../shared/types";
import { IntegrationLogger } from "./integration-logger";
import { JsonStore } from "./store";

interface PendingIdentification { userId: number; time: number; registration?: string }

export class ControlIdServer {
  private server?: Server;

  constructor(
    private readonly accessService: AccessService,
    private readonly store: JsonStore,
    private readonly getSettings: () => Settings,
    private readonly log: IntegrationLogger,
    private readonly onDeviceContact: (contact: ControlIdDeviceContact) => void = () => undefined
  ) {}

  async start(port: number): Promise<number> {
    await this.stop();
    this.server = createServer((request, response) => void this.route(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "0.0.0.0", () => resolve());
    });
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, service: "ponte-id" }));
        return;
      }
      if (request.method !== "POST") return this.json(response, 404, { error: "Rota não encontrada" });
      const body = await this.readBody(request);
      const parsedBody = this.parseBody(request, body);
      if (isControlIdPath(url.pathname)) {
        const deviceId = stringValue(url.searchParams.get("device_id"))
          || stringValue(parsedBody.device_id)
          || stringValue((parsedBody.device as Record<string, unknown> | undefined)?.id);
        const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
        const observedTurn = url.pathname === "/api/notifications/catra_event"
          ? turnFromEventName(String((parsedBody.event as Record<string, unknown> | undefined)?.name ?? ""))
          : undefined;
        this.onDeviceContact({
          key: deviceId ? `device:${deviceId}` : `address:${remoteAddress ?? "unknown"}`,
          lastSeenAt: new Date().toISOString(),
          path: url.pathname,
          remoteAddress,
          deviceId,
          observedTurn
        });
      }
      this.log("device-in", `${request.method} Control iD ${url.pathname}`, {
        query: Object.fromEntries(url.searchParams),
        body: parsedBody
      });

      if (url.pathname === "/new_user_identified.fcgi") {
        const data = parsedBody;
        const userId = Number(data.user_id);
        this.log("error", "Tentativa de usar o middleware como servidor de autorização online", {
          user_id: userId,
          orientação: "Mantenha online_client apontando para o iDSecure Enterprise. O Ponte ID utiliza somente o Monitor."
        });
        return this.json(response, 200, {
          result: {
            event: 14,
            user_id: userId,
            user_name: String(data.user_name ?? ""),
            user_image: false,
            portal_id: Number(data.portal_id) || 1,
            actions: [],
            message: "Servidor de autorização deve permanecer no iDSecure."
          }
        });
      }

      if (url.pathname === "/api/notifications/dao" || url.pathname === "/api/notifications/access_logs") {
        const data = parsedBody as Record<string, any>;
        for (const change of data.object_changes ?? []) {
          const values = change.values ?? {};
          if (change.object === "users" && change.type !== "deleted" && Number(values.id) > 0 && values.registration) {
            this.store.saveControlIdMapping(Number(values.id), String(values.registration));
          }
          if (change.object !== "access_logs" || change.type !== "inserted") continue;
          if (Number(values.user_id) > 0) {
            const registration = stringValue(values.registration) || this.store.getControlIdRegistration(values.user_id);
            this.store.savePendingControlIdAccess(String(values.id), {
              userId: Number(values.user_id),
              time: Number(values.time),
              registration
            });
          }
        }
        return this.json(response, 200, {});
      }

      if (url.pathname === "/api/notifications/catra_event") {
        const data = parsedBody as Record<string, any>;
        const eventName = String(data.event?.name ?? "").toUpperCase();
        if (eventName.includes("GIVE") || eventName.includes("DESIST") || Number(data.event?.type) === 13) {
          this.log("system", "Giro cancelado: desistência ignorada", data);
          return this.json(response, 200, {});
        }
        const accessEventId = String(data.access_event_id);
        const pending: PendingIdentification | undefined = this.store.getPendingControlIdAccess(accessEventId);
        if (pending) {
          await this.accessService.registerControlIdUser(
            pending.userId,
            this.directionForTurn(eventName),
            new Date((Number(data.time) || pending.time) * 1000).toISOString(),
            pending.registration
          );
          this.store.removePendingControlIdAccess(accessEventId);
        } else {
          this.log("error", "Confirmação de giro sem identificação correlacionada", data);
        }
        return this.json(response, 200, {});
      }

      if (
        url.pathname === "/device_is_alive.fcgi" ||
        url.pathname === "/api/notifications/device_is_alive" ||
        url.pathname === "/api/notifications/access_photo"
      ) return this.json(response, 200, {});
      if (url.pathname.startsWith("/api/notifications/")) {
        this.log("system", `Notificação Control iD reconhecida sem ação: ${url.pathname}`, parsedBody);
        return this.json(response, 200, {});
      }
      return this.json(response, 404, { error: "Rota não encontrada" });
    } catch (error) {
      this.log("error", `Erro ao processar evento Control iD ${request.url ?? ""}`, {
        message: error instanceof Error ? error.message : String(error)
      });
      this.json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; if (body.length > 8_000_000) request.destroy(); });
      request.on("end", () => resolve(body));
      request.on("error", reject);
    });
  }

  private parseBody(request: IncomingMessage, body: string): Record<string, any> {
    if (request.headers["content-type"]?.includes("json")) return JSON.parse(body || "{}");
    return Object.fromEntries(new URLSearchParams(body));
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    this.log("device-out", `${status} resposta para Control iD`, payload);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  private directionForTurn(eventName: string): Direction {
    const settings = this.getSettings();
    if (eventName.includes("LEFT") || eventName.includes("ESQUER")) return settings.turnLeftDirection;
    if (eventName.includes("RIGHT") || eventName.includes("DIREIT")) return settings.turnRightDirection;
    return settings.direction;
  }
}

function stringValue(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function isControlIdPath(pathname: string): boolean {
  return pathname === "/new_user_identified.fcgi"
    || pathname === "/device_is_alive.fcgi"
    || pathname === "/api/notifications/access_logs"
    || pathname.startsWith("/api/notifications/");
}

function normalizeRemoteAddress(value?: string): string | undefined {
  if (!value) return undefined;
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function turnFromEventName(eventName: string): "left" | "right" | undefined {
  const normalized = eventName.toUpperCase();
  if (normalized.includes("LEFT") || normalized.includes("ESQUER")) return "left";
  if (normalized.includes("RIGHT") || normalized.includes("DIREIT")) return "right";
  return undefined;
}
