import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AccessService } from "./access-service";

interface PendingIdentification { userId: number; time: number; uuid?: string }

export class ControlIdServer {
  private server?: Server;
  private pendingByAccessEvent = new Map<string, PendingIdentification>();
  private pendingByUuid = new Map<string, PendingIdentification>();

  constructor(private readonly accessService: AccessService) {}

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
      if (request.method === "GET" && url.pathname === "/health") return this.json(response, 200, { ok: true });
      if (request.method !== "POST") return this.json(response, 404, { error: "Rota não encontrada" });
      const body = await this.readBody(request);

      if (url.pathname === "/new_user_identified.fcgi") {
        const data = this.parseBody(request, body);
        const userId = Number(data.user_id);
        if (userId > 0 && Number(data.event) !== 3) {
          const pending = { userId, time: Number(data.time) || Math.floor(Date.now() / 1000), uuid: String(data.uuid ?? "") };
          if (pending.uuid) this.pendingByUuid.set(pending.uuid, pending);
        }
        return this.json(response, 200, { result: { event: userId > 0 ? 7 : 3, user_id: userId, user_name: String(data.user_name ?? ""), user_image: false, portal_id: Number(data.portal_id) || 1, actions: [{ action: "catra", parameters: "allow=both" }] } });
      }

      if (url.pathname === "/api/notifications/access_logs") {
        const data = JSON.parse(body || "{}");
        for (const change of data.object_changes ?? []) {
          if (change.object !== "access_logs" || change.type !== "inserted") continue;
          const values = change.values ?? {};
          if (Number(values.user_id) > 0) this.pendingByAccessEvent.set(String(values.id), { userId: Number(values.user_id), time: Number(values.time) });
        }
        return this.json(response, 200, {});
      }

      if (url.pathname === "/api/notifications/catra_event") {
        const data = JSON.parse(body || "{}");
        const eventName = String(data.event?.name ?? "").toUpperCase();
        if (eventName.includes("GIVE") || Number(data.event?.type) === 8) return this.json(response, 200, {});
        const pending = this.pendingByAccessEvent.get(String(data.access_event_id)) ?? this.pendingByUuid.get(String(data.event?.uuid));
        if (pending) {
          await this.accessService.register(pending.userId, undefined, new Date((Number(data.time) || pending.time) * 1000).toISOString());
          this.pendingByAccessEvent.delete(String(data.access_event_id));
          if (pending.uuid) this.pendingByUuid.delete(pending.uuid);
        }
        return this.json(response, 200, {});
      }

      if (url.pathname === "/device_is_alive.fcgi" || url.pathname === "/api/notifications/device_is_alive") return this.json(response, 200, {});
      return this.json(response, 404, { error: "Rota não encontrada" });
    } catch (error) {
      this.json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; if (body.length > 1_000_000) request.destroy(); });
      request.on("end", () => resolve(body));
      request.on("error", reject);
    });
  }

  private parseBody(request: IncomingMessage, body: string): Record<string, string> {
    if (request.headers["content-type"]?.includes("json")) return JSON.parse(body || "{}");
    return Object.fromEntries(new URLSearchParams(body));
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }
}
