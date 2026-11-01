// BitBlade Cloudflare Worker: serves the web build (assets), relays rooms via a Durable Object, and keeps a
// public room directory. Same protocol as server/relay-bun.ts and electron/relay-node.cjs.
//   ws  /room/<CODE|new>?role=host|client&name=<name>[&key=<owner key>]
//   GET /api/rooms -> public room list (JSON)
//   ws  /mm?name=<name> -> the QUICK MATCH queue (one global instance; server/matchmaker.ts)

import { Matchmaker } from "../../server/matchmaker";
import { adminConfig, adminStub, gate, handleAdmin, status, type UsageReport } from "./admin";
export { Admin } from "./admin";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  DIR: DurableObjectNamespace;
  QUEUE: DurableObjectNamespace;
  ADMIN: DurableObjectNamespace;
  /** where the admin switches / bans / whitelist live for good (the Admin object caches them) */
  ADMIN_KV?: KVNamespace;
  /** the admin page password (wrangler secret put ADMIN_TOKEN; .dev.vars locally) — unset: admin is off */
  ADMIN_TOKEN?: string;
}

interface Ctx { waitUntil(p: Promise<unknown>): void }

/** a WebSocket that just says why not, then closes (the client shows the message) */
function refuse(msg: string): Response {
  const pair = new WebSocketPair();
  const [clientSide, ws] = [pair[0], pair[1]];
  ws.accept();
  try { ws.send(JSON.stringify({ t: "error", msg })); } catch {}
  ws.close(1000, msg.slice(0, 120));
  return new Response(null, { status: 101, webSocket: clientSide });
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z0-9]{4,10}$/;
const LISTING_TTL = 75_000; // hosts heartbeat every ~25s
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET", "Cache-Control": "no-store" };

function genCode(n = 5): string {
  let c = "";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (const b of bytes) c += CODE_CHARS[b % CODE_CHARS.length];
  return c;
}

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const dir = (env: Env) => env.DIR.get(env.DIR.idFromName("global"));

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(req, env);
    const ip = req.headers.get("CF-Connecting-IP") ?? "local";
    const dev = (url.searchParams.get("dev") ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 40); // (the game's per-browser id)
    // (the admin switches: bans, online off / whitelist only, quick match off)
    const turnAway = async (what: "room" | "queue") => {
      const why = await gate(env, ip, dev, what);
      if (why) ctx.waitUntil(adminStub(env).fetch(new Request("https://admin/denied", { method: "POST", body: JSON.stringify({ ip }) })).catch(() => undefined));
      return why;
    };
    // invite links: /join/<CODE> → /?join=<CODE> (the build loads ./assets relative to the page, so the page itself
    // has to be served from the root — at /join/<CODE> its scripts resolved to /join/assets/… and the page was blank)
    const join = url.pathname.match(/^\/join\/([A-Za-z0-9]{4,10})\/?$/);
    if (join) return Response.redirect(`${url.origin}/?join=${join[1].toUpperCase()}`, 302);
    if (url.pathname === "/mm") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const why = await turnAway("queue");
      if (why) return refuse(why);
      return env.QUEUE.get(env.QUEUE.idFromName("global")).fetch(req);
    }
    if (url.pathname === "/api/status") {
      // (the main menu: is online play available for me right now?)
      return new Response(JSON.stringify(await status(env, ip, dev)), { headers: { "Content-Type": "application/json", ...CORS } });
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
      const why = await turnAway("room");
      if (why) return refuse(why);
      let code = m[1].toUpperCase();
      if (code === "NEW") {
        if (role !== "host") return new Response("bad request", { status: 400 });
        // a code nobody's using: ask the room object behind each candidate (a live room or a kept code says no)
        code = "";
        for (let i = 0; i < 8 && !code; i++) {
          const c = genCode(i < 4 ? 5 : 6);
          const r = await env.ROOMS.get(env.ROOMS.idFromName(c)).fetch(new Request("https://internal/free"));
          if ((await r.text()) === "free") code = c;
        }
        if (!code) return refuse("Couldn't find a free party code — try again");
      } else if (!CODE_RE.test(code)) return new Response("bad room code", { status: 400 });
      const fwd = new Request(req.url, req);
      fwd.headers.set("X-Room-Code", code);
      fwd.headers.set("X-Client-IP", ip); // (set here, never taken from the client)
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(fwd);
    }
    return env.ASSETS.fetch(req);
  },
};

type Peer = { id: number; role: "host" | "client"; name: string; code: string; ip: string; dev: string; since: number };

/** a kept code nobody has opened for this long is free again */
const KEEP_FOR = 180 * 24 * 3600_000;

export class Room {
  private lastMeta = 0;
  /** traffic since the last report to the admin object (reports go about once a minute, and on joins / leaves) */
  private usage = { msgs: 0, bytes: 0, activeMs: 0, lastMsg: 0, lastReport: 0 };
  private perPeer = new Map<number, { msgs: number; bytes: number; sec: number; inSec: number }>();
  private opened: { ip: string; role: string; dev: string }[] = [];
  private closed: NonNullable<UsageReport["closed"]> = [];
  private floods: { ip: string }[] = [];
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

  /** the owner of a kept code (forgotten once it's gone unused for KEEP_FOR) */
  private async owner(): Promise<string | undefined> {
    const owner = await this.state.storage.get<string>("owner");
    if (!owner) return undefined;
    const seen = (await this.state.storage.get<number>("ownerSeen")) ?? 0;
    if (seen && Date.now() - seen > KEEP_FOR) { await this.state.storage.delete("owner"); await this.state.storage.delete("ownerSeen"); return undefined; }
    return owner;
  }

  /** tell the admin object what's happened since last time (never blocks the relay) */
  private report(force = false, gone = false) {
    const now = Date.now(), u = this.usage;
    if (!force && now - u.lastReport < 60_000) return;
    u.lastReport = now;
    const host = this.host();
    const hp = host ? (host.deserializeAttachment() as Peer | null) : null;
    const code = hp?.code ?? this.code;
    if (!code) return;
    const r: UsageReport = {
      code, msgs: u.msgs, bytes: u.bytes, activeSecs: Math.round(u.activeMs / 1000),
      opened: this.opened.splice(0), closed: this.closed.splice(0), floods: this.floods.splice(0),
      live: gone || !hp ? null : { players: 1 + this.state.getWebSockets("client").length, hostIp: hp.ip, since: hp.since, name: hp.name },
    };
    u.msgs = 0; u.bytes = 0; u.activeMs = 0;
    void adminStub(this.env).fetch(new Request("https://admin/report", { method: "POST", body: JSON.stringify(r) })).catch(() => undefined);
  }
  private code = "";

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // (internal calls — the worker only ever forwards /room/<code> here, so these paths can't come from outside)
    if (url.pathname === "/free") return new Response(this.host() || (await this.owner()) ? "taken" : "free");
    if (url.pathname === "/admin") {
      const cmd = (await req.json().catch(() => ({}))) as { a?: string; who?: string; why?: string };
      const host = this.host();
      const all = [...this.state.getWebSockets("client"), ...(host ? [host] : [])];
      for (const ws of all) {
        const p = ws.deserializeAttachment() as Peer | null;
        const hit = cmd.a === "close" || (cmd.a === "kick" && !!p && (p.ip === cmd.who || (!!p.dev && `id:${p.dev}` === cmd.who) || (!!cmd.who?.match(/[.:]$/) && p.ip.startsWith(cmd.who!))));
        if (hit) { this.send(ws, { t: "error", msg: cmd.why ?? "Online play is temporarily unavailable" }); try { ws.close(1000, "removed"); } catch {} }
      }
      return new Response("ok");
    }
    const role = url.searchParams.get("role") === "host" ? "host" : "client";
    const code = req.headers.get("X-Room-Code") ?? "";
    const ip = req.headers.get("X-Client-IP") ?? "?";
    const dev = (url.searchParams.get("dev") ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
    const name = (url.searchParams.get("name") ?? "").slice(0, 32);
    const pair = new WebSocketPair();
    const [clientSide, ws] = [pair[0], pair[1]];
    this.code = code;

    if (role === "host") {
      if (this.host()) return this.reject(ws, clientSide, "room already hosted");
      // kept codes: the first host to present a key owns the code from then on (until it goes unused for KEEP_FOR)
      const key = url.searchParams.get("key") ?? "";
      const owner = await this.owner();
      if (owner && (!key || (await sha(key)) !== owner)) return this.reject(ws, clientSide, "that room code belongs to someone else");
      if (!owner && key) await this.state.storage.put("owner", await sha(key));
      if (key) await this.state.storage.put("ownerSeen", Date.now());
      const peer: Peer = { id: 0, role, name, code, ip, dev, since: Date.now() };
      this.state.acceptWebSocket(ws, ["host"]);
      ws.serializeAttachment(peer);
      this.send(ws, { t: "welcome", id: 0, role, code });
    } else {
      const host = this.host();
      if (!host) return this.reject(ws, clientSide, "no host");
      const id = ((await this.state.storage.get<number>("nextId")) ?? 1);
      await this.state.storage.put("nextId", id + 1);
      const peer: Peer = { id, role, name, code, ip, dev, since: Date.now() };
      this.state.acceptWebSocket(ws, [`c:${id}`, "client"]);
      ws.serializeAttachment(peer);
      this.send(ws, { t: "welcome", id, role, code });
      this.send(host, { t: "peer-join", id, name });
    }
    this.opened.push({ ip, role, dev });
    this.report(true);
    return new Response(null, { status: 101, webSocket: clientSide });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const peer = ws.deserializeAttachment() as Peer;
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    // usage: totals, busy time (gaps under 10s count as busy), and per-connection counts with a flood cut-off
    const now = Date.now(), u = this.usage;
    u.msgs++; u.bytes += size;
    if (u.lastMsg && now - u.lastMsg < 10_000) u.activeMs += now - u.lastMsg;
    u.lastMsg = now;
    let pp = this.perPeer.get(peer.id);
    if (!pp) { pp = { msgs: 0, bytes: 0, sec: 0, inSec: 0 }; this.perPeer.set(peer.id, pp); }
    pp.msgs++; pp.bytes += size;
    const sec = Math.floor(now / 1000);
    if (pp.sec !== sec && pp.inSec >= 0) { pp.sec = sec; pp.inSec = 0; }
    if (pp.inSec < 0) return; // (already cut off: the rest of its burst is dropped)
    if (++pp.inSec > (await adminConfig(this.env)).floodPerSec) {
      pp.inSec = -1e9;
      this.floods.push({ ip: peer.ip });
      this.send(ws, { t: "error", msg: "Too much traffic — disconnected" });
      try { ws.close(1008, "flood"); } catch {}
      this.report(true);
      return;
    }
    this.report();
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
    const pp = this.perPeer.get(peer.id);
    this.perPeer.delete(peer.id);
    this.closed.push({ ip: peer.ip ?? "?", role: peer.role, msgs: pp?.msgs ?? 0, bytes: pp?.bytes ?? 0, secs: Math.round((Date.now() - (peer.since ?? Date.now())) / 1000) });
    if (peer.role === "host") {
      for (const c of this.state.getWebSockets("client")) {
        this.send(c, { t: "host-left" });
        try { c.close(1000, "host left"); } catch {}
      }
      this.report(true, true);
      await this.state.storage.delete("nextId"); // keep "owner" so kept codes stay claimed
      await dir(this.env).fetch(new Request("https://dir/remove", { method: "POST", body: JSON.stringify({ code: peer.code }) }));
    } else {
      const host = this.host();
      if (host) this.send(host, { t: "peer-leave", id: peer.id });
      this.report(true);
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
        players: num(b.players, 16), max: num(b.max, 16), clients: num(b.clients, 64), inMatch: !!b.inMatch, persistent: !!b.persistent, openControl: !!b.openControl, locked: !!b.locked, updated: Date.now(),
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
  private mm = new Matchmaker((id, m: any) => {
    const ws = this.socks.get(id);
    if (ws) try { ws.send(JSON.stringify(m)); } catch {}
    if (m?.t === "match" && m.role === "host") this.count({ matched: true });
  }, () => genCode(6));
  private searched = new Set<number>();
  private count(b: unknown) { void adminStub(this.env).fetch(new Request("https://admin/queue", { method: "POST", body: JSON.stringify(b) })).catch(() => undefined); }
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
      if (m?.t === "queue" && !this.searched.has(id)) { this.searched.add(id); this.count({}); }
      this.ensureTimer();
    });
    const gone = () => { this.socks.delete(id); this.mm.remove(id); this.searched.delete(id); };
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
