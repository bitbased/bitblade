// BitBlade Cloudflare Worker: serves the web build (assets) and relays rooms via a Durable Object.
// Same protocol as server/relay-bun.ts and electron/relay-node.cjs.

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genCode(): string {
  let c = "";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) c += CODE_CHARS[b % CODE_CHARS.length];
  return c;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const role = url.searchParams.get("role") === "host" ? "host" : "client";
      let code = m[1].toUpperCase();
      if (code === "NEW") {
        if (role !== "host") return new Response("bad request", { status: 400 });
        code = genCode();
      }
      const fwd = new Request(req.url, req);
      fwd.headers.set("X-Room-Code", code);
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(fwd);
    }
    return env.ASSETS.fetch(req);
  },
};

type Peer = { id: number; role: "host" | "client"; name: string; code: string };

export class Room {
  constructor(private state: DurableObjectState, private env: Env) {}

  private host(): WebSocket | undefined {
    return this.state.getWebSockets("host")[0];
  }

  private client(id: number): WebSocket | undefined {
    return this.state.getWebSockets(`c:${id}`)[0];
  }

  private send(ws: WebSocket, m: unknown) {
    try { ws.send(JSON.stringify(m)); } catch {}
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const role = url.searchParams.get("role") === "host" ? "host" : "client";
    const code = req.headers.get("X-Room-Code") ?? "";
    const name = (url.searchParams.get("name") ?? "").slice(0, 32);
    const pair = new WebSocketPair();
    const [clientSide, ws] = [pair[0], pair[1]];

    if (role === "host") {
      if (this.host()) {
        ws.accept();
        this.send(ws, { t: "error", msg: "room already hosted" });
        ws.close(1000, "room already hosted");
        return new Response(null, { status: 101, webSocket: clientSide });
      }
      const peer: Peer = { id: 0, role, name, code };
      this.state.acceptWebSocket(ws, ["host"]);
      ws.serializeAttachment(peer);
      this.send(ws, { t: "welcome", id: 0, role, code });
    } else {
      const host = this.host();
      if (!host) {
        ws.accept();
        this.send(ws, { t: "error", msg: "no host" });
        ws.close(1000, "no host");
        return new Response(null, { status: 101, webSocket: clientSide });
      }
      const id = ((await this.state.storage.get<number>("nextId")) ?? 1);
      await this.state.storage.put("nextId", id + 1);
      const peer: Peer = { id, role, name, code };
      this.state.acceptWebSocket(ws, [`c:${id}`, "client"]);
      ws.serializeAttachment(peer);
      this.send(ws, { t: "welcome", id, role, code });
      this.send(host, { t: "peer-join", id, name });
    }
    return new Response(null, { status: 101, webSocket: clientSide });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const peer = ws.deserializeAttachment() as Peer;
    let msg: any;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (peer.role === "client") {
      const host = this.host();
      if (host) this.send(host, { t: "from", from: peer.id, m: msg });
      return;
    }
    if (msg?.t === "to") {
      const data = JSON.stringify(msg.m);
      const targets = msg.to === "all" ? this.state.getWebSockets("client") : [this.client(Number(msg.to))];
      for (const c of targets) if (c) try { c.send(data); } catch {}
    } else if (msg?.t === "kick") {
      const c = this.client(Number(msg.id));
      if (c) { this.send(c, { t: "error", msg: "kicked" }); c.close(1000, "kicked"); }
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.onGone(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.onGone(ws);
  }

  private async onGone(ws: WebSocket) {
    const peer = ws.deserializeAttachment() as Peer | null;
    if (!peer) return;
    if (peer.role === "host") {
      for (const c of this.state.getWebSockets("client")) {
        this.send(c, { t: "host-left" });
        try { c.close(1000, "host left"); } catch {}
      }
      await this.state.storage.deleteAll();
    } else {
      const host = this.host();
      if (host) this.send(host, { t: "peer-leave", id: peer.id });
    }
    try { ws.close(1000, "bye"); } catch {}
  }
}
