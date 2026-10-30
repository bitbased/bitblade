// BitBlade Cloudflare Worker: serves the web build (assets), relays rooms via a Durable Object, and keeps a
// public room directory. Same protocol as server/relay-bun.ts and electron/relay-node.cjs.
//   ws  /room/<CODE|new>?role=host|client&name=<name>[&key=<owner key>]
//   GET /api/rooms -> public room list (JSON)
//   ws  /mm?name=<name> -> the QUICK MATCH queue (one global instance; server/matchmaker.ts)

import { Matchmaker } from "../../server/matchmaker";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  DIR: DurableObjectNamespace;
  QUEUE: DurableObjectNamespace;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z0-9]{4,10}$/;
const LISTING_TTL = 75_000; // hosts heartbeat every ~25s
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET", "Cache-Control": "no-store" };

function genCode(): string {
  let c = "";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) c += CODE_CHARS[b % CODE_CHARS.length];
  return c;
}

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const dir = (env: Env) => env.DIR.get(env.DIR.idFromName("global"));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    // invite links: /join/<CODE> → /?join=<CODE> (the build loads ./assets relative to the page, so the page itself
    // has to be served from the root — at /join/<CODE> its scripts resolved to /join/assets/… and the page was blank)
    const join = url.pathname.match(/^\/join\/([A-Za-z0-9]{4,10})\/?$/);
    if (join) return Response.redirect(`${url.origin}/?join=${join[1].toUpperCase()}`, 302);
    if (url.pathname === "/mm") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      return env.QUEUE.get(env.QUEUE.idFromName("global")).fetch(req);
    }
    if (url.pathname === "/api/rooms") {
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      const r = await dir(env).fetch(new Request("https://dir/list"));
      return new Response(await r.text(), { headers: { "Content-Type": "application/json", ...CORS } });
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const role = url.searchParams.get("role") === "host" ? "host" : "client";
      let code = m[1].toUpperCase();
      if (code === "NEW") {
        if (role !== "host") return new Response("bad request", { status: 400 });
        code = genCode();
      } else if (!CODE_RE.test(code)) return new Response("bad room code", { status: 400 });
      const fwd = new Request(req.url, req);
      fwd.headers.set("X-Room-Code", code);
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(fwd);
    }
    return env.ASSETS.fetch(req);
  },
};

type Peer = { id: number; role: "host" | "client"; name: string; code: string };

export class Room {
  private lastMeta = 0;
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

  private reject(ws: WebSocket, clientSide: WebSocket, msg: string) {
    ws.accept();
    this.send(ws, { t: "error", msg });
    ws.close(1000, msg);
    return new Response(null, { status: 101, webSocket: clientSide });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const role = url.searchParams.get("role") === "host" ? "host" : "client";
    const code = req.headers.get("X-Room-Code") ?? "";
    const name = (url.searchParams.get("name") ?? "").slice(0, 32);
    const pair = new WebSocketPair();
    const [clientSide, ws] = [pair[0], pair[1]];

    if (role === "host") {
      if (this.host()) return this.reject(ws, clientSide, "room already hosted");
      // persistent rooms: the first host to present a key owns the code from then on
      const key = url.searchParams.get("key") ?? "";
      const owner = await this.state.storage.get<string>("owner");
      if (owner && (!key || (await sha(key)) !== owner)) return this.reject(ws, clientSide, "that room code belongs to someone else");
      if (!owner && key) await this.state.storage.put("owner", await sha(key));
      const peer: Peer = { id: 0, role, name, code };
      this.state.acceptWebSocket(ws, ["host"]);
      ws.serializeAttachment(peer);
      this.send(ws, { t: "welcome", id: 0, role, code });
    } else {
      const host = this.host();
      if (!host) return this.reject(ws, clientSide, "no host");
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
    } else if (msg?.t === "meta") {
      // room listing for the public directory (rate-limited; private rooms are removed)
      const now = Date.now();
      if (now - this.lastMeta < 1000) return;
      this.lastMeta = now;
      const body = JSON.stringify({ ...msg.m, code: peer.code, clients: this.state.getWebSockets("client").length });
      await dir(this.env).fetch(new Request(msg.m?.public ? "https://dir/upsert" : "https://dir/remove", { method: "POST", body }));
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
      await this.state.storage.delete("nextId"); // keep "owner" so persistent codes stay claimed
      await dir(this.env).fetch(new Request("https://dir/remove", { method: "POST", body: JSON.stringify({ code: peer.code }) }));
    } else {
      const host = this.host();
      if (host) this.send(host, { t: "peer-leave", id: peer.id });
    }
    try { ws.close(1000, "bye"); } catch {}
  }
}

const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const num = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

/** The public room directory (one global instance). Entries expire unless the host keeps heartbeating. */
export class Directory {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/list") {
      const now = Date.now();
      const all = await this.state.storage.list<any>({ prefix: "r:" });
      const rooms: any[] = [];
      for (const [k, v] of all) {
        if (now - v.updated > LISTING_TTL) await this.state.storage.delete(k);
        else rooms.push(v);
      }
      rooms.sort((a, b) => Number(a.inMatch) - Number(b.inMatch) || b.players - a.players || b.updated - a.updated);
      return new Response(JSON.stringify({ rooms: rooms.slice(0, 100), now }));
    }
    const b = (await req.json().catch(() => null)) as any;
    const code = clip(b?.code, 10).toUpperCase();
    if (!CODE_RE.test(code)) return new Response("bad", { status: 400 });
    if (url.pathname === "/remove") { await this.state.storage.delete("r:" + code); return new Response("ok"); }
    if (url.pathname === "/upsert") {
      await this.state.storage.put("r:" + code, {
        code, name: clip(b.name, 32), host: clip(b.host, 16), mode: clip(b.mode, 12), modeName: clip(b.modeName, 24), arena: clip(b.arena, 32),
        players: num(b.players, 16), max: num(b.max, 16), clients: num(b.clients, 64), inMatch: !!b.inMatch, persistent: !!b.persistent, openControl: !!b.openControl, updated: Date.now(),
      });
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }
}

/**
 * The QUICK MATCH queue (one global instance). It holds its sockets in memory while anyone's queued, ticks every
 * second, and hands out room codes no room is using right now (the Room objects check codes when the host connects).
 */
export class Queue {
  private socks = new Map<number, WebSocket>();
  private next = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private mm = new Matchmaker((id, m) => { const ws = this.socks.get(id); if (ws) try { ws.send(JSON.stringify(m)); } catch {} }, genCode);
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const [clientSide, ws] = [pair[0], pair[1]];
    ws.accept();
    const id = this.next++;
    const name = (url.searchParams.get("name") ?? "").slice(0, 16);
    this.socks.set(id, ws);
    ws.addEventListener("message", (e) => {
      let m: any;
      try { m = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)); } catch { return; }
      this.mm.message(id, { ...m, name: m?.name ?? name });
      this.ensureTimer();
    });
    const gone = () => { this.socks.delete(id); this.mm.remove(id); };
    ws.addEventListener("close", gone);
    ws.addEventListener("error", gone);
    return new Response(null, { status: 101, webSocket: clientSide });
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.mm.tickets.size) { clearInterval(this.timer!); this.timer = null; return; }
      this.mm.tick();
    }, 1000);
  }
}
