// BitBlade admin: one global Durable Object that holds the switches (online on / whitelist only / off, quick match on /
// off, a message for players), IP bans and the whitelist — and the usage numbers: per-hour totals, per-IP counts for
// spotting abuse, and the rooms open right now. The worker checks every new connection against a cached copy of the
// switches (so a ban or OFF takes effect within ~10s everywhere); rooms report their traffic about once a minute and
// when connections close (never per message), so watching costs almost nothing.
//
//   /admin             the admin page (password: the ADMIN_TOKEN secret; a signed cookie after that)
//   /admin/api/*       its JSON API (same cookie)
import type { Env } from "./index";
import { ipMatches, networkRule } from "./ip";

/** who: an IP, an IP prefix (ends in . or :), or a browser id ("id:" + the id the game keeps per browser) · until 0 = for good */
export interface Ban { ip: string; until: number; reason: string; at: number }
export interface AdminConfig {
  /** on: everyone · whitelist: only whitelisted IPs · off: nobody (whitelisted IPs still get in — that's you testing) */
  online: "on" | "whitelist" | "off";
  queue: boolean;
  /** shown to players who are turned away */
  message: string;
  whitelist: string[];
  bans: Ban[];
  /** relay flood limit: messages per second per connection before it's cut off */
  floodPerSec: number;
  /**
   * WebRTC (players connect directly; this server only introduces them, using Google's public STUN — no TURN relay):
   * off · on (direct where it connects, the WebSocket relay where it doesn't) · required (direct only: a player who
   * can't connect directly to their party leader can't stay). `rtcMobile` is the same for phones / mobile data (some
   * phones' radios have choked on WebRTC), applied instead of `rtc` there.
   */
  rtc: RtcPolicy;
  rtcMobile: RtcPolicy;
}
export type RtcPolicy = "off" | "on" | "required";
const RTC = ["off", "on", "required"];
const DEFAULT_CONFIG: AdminConfig = { online: "on", queue: true, message: "", whitelist: [], bans: [], floodPerSec: 240, rtc: "off", rtcMobile: "off" };

/** what a room reports (every ~minute while busy, and when a connection closes) */
export interface UsageReport {
  code: string;
  /** totals since the last report */
  msgs: number; bytes: number; activeSecs: number;
  /** connections that closed since the last report: who and how much */
  closed?: { ip: string; role: string; msgs: number; bytes: number; secs: number }[];
  /** connections opened since the last report */
  opened?: { ip: string; role: string; dev?: string }[];
  floods?: { ip: string }[];
  /** the room now: players connected, the host's ip, open since — or gone */
  live?: { players: number; hostIp: string; since: number; name: string } | null;
}

const HOUR = 3600_000, DAY = 24 * HOUR;
const hourKey = (t: number) => `h:${new Date(t).toISOString().slice(0, 13)}`;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
type Bucket = { conns: number; hosts: number; joins: number; msgs: number; bytes: number; activeSecs: number; connSecs: number; queue: number; matches: number; denied: number; floods: number; peakRooms: number };
const emptyBucket = (): Bucket => ({ conns: 0, hosts: 0, joins: 0, msgs: 0, bytes: 0, activeSecs: 0, connSecs: 0, queue: 0, matches: 0, denied: 0, floods: 0, peakRooms: 0 });
type IpDay = { conns: number; hosts: number; msgs: number; bytes: number; floods: number; denied: number; last: number; devs?: string[] };

/** rooms check in at least every 5 minutes (index.ts HEARTBEAT): one not heard from in 12 has closed */
const LIVE_TTL = 12 * 60_000;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export class Admin {
  private cfg: AdminConfig | null = null;
  /** open rooms (by code — the code never leaves this object: the admin page gets an anonymous ref per room), saved so
   *  the list survives this object being unloaded while idle */
  private live = new Map<string, { players: number; hostIp: string; since: number; name: string; seen: number }>();
  private liveLoaded = false;
  /** refs are a hash of the code with this per-instance salt: they can't be turned back into a join code */
  private salt = crypto.randomUUID();
  private async loadLive() {
    if (this.liveLoaded) return;
    this.liveLoaded = true;
    const saved = await this.state.storage.get<[string, { players: number; hostIp: string; since: number; name: string; seen: number }][]>("live");
    for (const [k, v] of saved ?? []) if (!this.live.has(k)) this.live.set(k, v);
  }
  private saveLive() { return this.state.storage.put("live", [...this.live]); }
  private async refOf(code: string) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.salt + code));
    return [...new Uint8Array(d).slice(0, 6)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  /** this hour's bucket and today's per-IP counts, flushed to storage at most every few seconds */
  private bucket: { key: string; b: Bucket } | null = null;
  private ips: { day: string; m: Map<string, IpDay> } | null = null;
  private dirtyAt = 0;
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private state: DurableObjectState, private env: Env) {}

  /**
   * The switches, bans and whitelist. KV is where they live for good (portable: any worker or app can bind it, and
   * they can be read / fixed from the dashboard or `wrangler kv` even if this page is down); this object keeps them in
   * memory, so KV is read only when it wakes up — every connection's check is answered from here (and each worker
   * instance caches the answer ~10s on top). Usage stays in this object's own storage: it survives every deploy, and
   * is only lost if the worker or this class is deleted — fine for numbers like these.
   */
  private async config(): Promise<AdminConfig> {
    if (!this.cfg) {
      const fromKv = this.env.ADMIN_KV ? await this.env.ADMIN_KV.get<AdminConfig>("config", "json").catch(() => null) : null;
      this.cfg = { ...DEFAULT_CONFIG, ...(fromKv ?? (await this.state.storage.get<AdminConfig>("config")) ?? {}) };
    }
    const now = Date.now();
    if (this.cfg.bans.some((b) => b.until && b.until < now)) { this.cfg.bans = this.cfg.bans.filter((b) => !b.until || b.until >= now); await this.saveConfig(this.cfg); }
    return this.cfg;
  }
  private async saveConfig(c: AdminConfig) {
    this.cfg = c;
    await this.env.ADMIN_KV?.put("config", JSON.stringify(c));
    await this.state.storage.put("config", c); // (a copy here too)
  }

  private async hour(now: number) {
    const key = hourKey(now);
    if (this.bucket?.key !== key) {
      if (this.bucket) await this.state.storage.put(this.bucket.key, this.bucket.b);
      this.bucket = { key, b: { ...emptyBucket(), ...((await this.state.storage.get<Bucket>(key)) ?? {}) } };
    }
    return this.bucket.b;
  }
  private async ipRow(ip: string, now: number) {
    const day = dayKey(now);
    if (this.ips?.day !== day) {
      if (this.ips) await this.saveIps();
      const m = new Map<string, IpDay>(Object.entries((await this.state.storage.get<Record<string, IpDay>>(`ip:${day}`)) ?? {}));
      this.ips = { day, m };
    }
    let r = this.ips.m.get(ip);
    if (!r) { r = { conns: 0, hosts: 0, msgs: 0, bytes: 0, floods: 0, denied: 0, last: now }; this.ips.m.set(ip, r); }
    r.last = now;
    return r;
  }
  private async saveIps() {
    if (!this.ips) return;
    // (keep the 2000 busiest addresses a day — enough to see who's hammering it)
    const top = [...this.ips.m.entries()].sort((a, b) => b[1].msgs + b[1].conns * 100 - (a[1].msgs + a[1].conns * 100)).slice(0, 2000);
    await this.state.storage.put(`ip:${this.ips.day}`, Object.fromEntries(top));
  }
  private async flushSoon(now: number) {
    if (now - this.dirtyAt < 5000) return;
    this.dirtyAt = now;
    if (this.bucket) await this.state.storage.put(this.bucket.key, this.bucket.b);
    await this.saveIps();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};
    await this.loadLive();
    switch (url.pathname) {
      // ---- from the worker / rooms / queue
      case "/config": return json(await this.config());
      case "/denied": { const b = await this.hour(now); b.denied++; (await this.ipRow(String(body.ip ?? "?"), now)).denied++; await this.flushSoon(now); return json({ ok: true }); }
      case "/queue": { const b = await this.hour(now); if (body.matched) b.matches++; else b.queue++; await this.flushSoon(now); return json({ ok: true }); }
      case "/report": { await this.report(body as UsageReport, now); return json({ ok: true }); }
      // ---- admin page
      case "/login-check": {
        const f = this.fails.get(String(body.ip));
        if (f && f.until > now && f.n >= 5) return json({ ok: false, wait: Math.ceil((f.until - now) / 1000) });
        return json({ ok: true });
      }
      case "/login-fail": {
        const ip = String(body.ip), f = this.fails.get(ip);
        this.fails.set(ip, f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + 15 * 60_000 });
        return json({ ok: true });
      }
      case "/overview": return json(await this.overview(now));
      case "/export": return json({ exported: new Date(now).toISOString(), config: await this.config() });
      case "/set": {
        const c = await this.config();
        if (body.online === "on" || body.online === "whitelist" || body.online === "off") c.online = body.online;
        if (typeof body.queue === "boolean") c.queue = body.queue;
        if (typeof body.message === "string") c.message = body.message.slice(0, 200);
        if (Array.isArray(body.whitelist)) c.whitelist = [...new Set(body.whitelist.map((x: unknown) => String(x).trim()).filter(Boolean))].slice(0, 200) as string[];
        if (typeof body.floodPerSec === "number" && body.floodPerSec >= 30) c.floodPerSec = Math.min(5000, Math.floor(body.floodPerSec));
        if (RTC.includes(body.rtc)) c.rtc = body.rtc;
        if (RTC.includes(body.rtcMobile)) c.rtcMobile = body.rtcMobile;
        await this.saveConfig(c);
        return json(c);
      }
      case "/ban": {
        const c = await this.config();
        const ip = String(body.ip ?? "").trim();
        if (!ip) return json({ error: "ip?" }, 400);
        const hours = Number(body.hours) || 0;
        c.bans = [...c.bans.filter((b) => b.ip !== ip), { ip, until: hours > 0 ? now + hours * HOUR : 0, reason: String(body.reason ?? "").slice(0, 120), at: now }];
        await this.saveConfig(c);
        // (and out of every room they're in right now)
        if (body.kick !== false) await Promise.all([...this.live.keys()].map((code) => this.roomCmd(code, { a: "kick", who: ip })));
        return json(c);
      }
      case "/unban": {
        const c = await this.config();
        c.bans = c.bans.filter((b) => b.ip !== String(body.ip));
        await this.saveConfig(c);
        return json(c);
      }
      case "/close-room": {
        // (the page names a room by its ref, never its code)
        let code = "";
        for (const k of this.live.keys()) if ((await this.refOf(k)) === String(body.ref)) code = k;
        if (!code) return json({ error: "That room isn't open any more (the list was out of date)" }, 404);
        await this.roomCmd(code, { a: "close", why: String(body.why ?? "Closed by the admin") });
        this.live.delete(code);
        await this.saveLive();
        return json({ ok: true });
      }
      case "/close-all": {
        const codes = [...this.live.keys()];
        await Promise.all(codes.map((code) => this.roomCmd(code, { a: "close", why: String(body.why ?? "Online play is paused") })));
        this.live.clear();
        await this.saveLive();
        return json({ closed: codes.length });
      }
    }
    return json({ error: "not found" }, 404);
  }

  private roomCmd(code: string, cmd: unknown) {
    if (!/^[A-Z0-9]{4,10}$/.test(code)) return Promise.resolve();
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(code)).fetch(new Request("https://internal/admin", { method: "POST", body: JSON.stringify(cmd) })).catch(() => undefined);
  }

  private async report(r: UsageReport, now: number) {
    const b = await this.hour(now);
    b.msgs += r.msgs || 0; b.bytes += r.bytes || 0; b.activeSecs += r.activeSecs || 0;
    for (const o of r.opened ?? []) {
      b.conns++; if (o.role === "host") b.hosts++; else b.joins++;
      const ip = await this.ipRow(o.ip, now); ip.conns++; if (o.role === "host") ip.hosts++;
      if (o.dev && !(ip.devs ??= []).includes(o.dev) && ip.devs.length < 6) ip.devs.push(o.dev);
    }
    for (const c of r.closed ?? []) {
      b.connSecs += c.secs || 0;
      const ip = await this.ipRow(c.ip, now); ip.msgs += c.msgs || 0; ip.bytes += c.bytes || 0;
    }
    for (const f of r.floods ?? []) { b.floods++; (await this.ipRow(f.ip, now)).floods++; }
    const had = this.live.get(r.code);
    if (r.live === null) this.live.delete(r.code);
    else if (r.live) this.live.set(r.code, { ...r.live, seen: now });
    // (a room that's missed two heartbeats is gone — it closed without saying so)
    for (const [k, v] of this.live) if (now - v.seen > LIVE_TTL) this.live.delete(k);
    // (saved when the list changes, and with each heartbeat — not on every traffic report)
    if (!had || r.live === null || !r.live || had.players !== r.live.players || now - had.seen > 60_000) await this.saveLive();
    b.peakRooms = Math.max(b.peakRooms, this.live.size);
    await this.flushSoon(now);
  }

  private async overview(now: number) {
    if (this.bucket) await this.state.storage.put(this.bucket.key, this.bucket.b);
    await this.saveIps();
    // the last 72 hours, hour by hour; this month's totals for the cost estimate
    const hours: { h: string; b: Bucket }[] = [];
    for (let t = now - 71 * HOUR; t <= now; t += HOUR) {
      const k = hourKey(t);
      hours.push({ h: k.slice(2), b: { ...emptyBucket(), ...((await this.state.storage.get<Bucket>(k)) ?? {}) } });
    }
    const month = new Date(now).toISOString().slice(0, 7);
    const all = await this.state.storage.list<Bucket>({ prefix: `h:${month}` });
    const mt = emptyBucket();
    for (const v of all.values()) for (const k of Object.keys(mt) as (keyof Bucket)[]) mt[k] = k === "peakRooms" ? Math.max(mt[k], v[k] ?? 0) : mt[k] + (v[k] ?? 0);
    // prune: hours older than 90 days, per-IP days older than 14
    if (Math.random() < 0.1) {
      for (const k of (await this.state.storage.list({ prefix: "h:" })).keys()) if (k < hourKey(now - 90 * DAY)) await this.state.storage.delete(k);
      for (const k of (await this.state.storage.list({ prefix: "ip:" })).keys()) if (k < `ip:${dayKey(now - 14 * DAY)}`) await this.state.storage.delete(k);
    }
    const today = this.ips?.day === dayKey(now) ? this.ips.m : new Map<string, IpDay>();
    const cfg = await this.config();
    const banned = new Set(cfg.bans.map((b) => b.ip));
    const topIps = [...today.entries()].map(([ip, v]) => ({ ip, ...v, banned: banned.has(ip), flag: flagIp(v) }))
      .sort((a, b) => (b.flag ? 1 : 0) - (a.flag ? 1 : 0) || b.msgs - a.msgs || b.conns - a.conns).slice(0, 50);
    const live = await Promise.all([...this.live.entries()].filter(([, v]) => now - v.seen < LIVE_TTL).sort((a, b) => b[1].players - a[1].players)
      .map(async ([code, v]) => ({ ref: await this.refOf(code), name: v.name, players: v.players, hostIp: v.hostIp, since: v.since })));
    return { now, config: cfg, live, hours, month: { month, ...mt }, cost: costEstimate(mt, now), topIps };
  }
}

/** looks like abuse: many rooms, floods, a lot of turned-away attempts, or way more traffic than one player makes */
function flagIp(v: IpDay): string {
  if (v.floods) return `${v.floods} flood cut-off${v.floods > 1 ? "s" : ""}`;
  if (v.hosts > 60) return `${v.hosts} rooms opened today`;
  if (v.conns > 400) return `${v.conns} connections today`;
  if (v.denied > 30) return `${v.denied} turned away`;
  if (v.bytes > 2e9) return `${(v.bytes / 1e9).toFixed(1)} GB relayed`;
  return "";
}

/**
 * This month's Cloudflare bill, estimated from what the rooms counted (Workers Paid plan list prices). Real numbers:
 * the Cloudflare dashboard → Billing. Room objects are billed for the time they're busy relaying (they don't sleep
 * mid-match), each incoming WebSocket message counts as 1/20 of a request.
 */
export function costEstimate(m: Bucket, now: number) {
  const doRequests = m.conns + m.msgs / 20 + m.queue * 3;
  const gbSecs = m.activeSecs * 0.128; // (128 MB per object)
  const workerRequests = m.conns + m.queue + m.denied;
  const over = (v: number, free: number, perM: number) => Math.max(0, v - free) / 1e6 * perM;
  const parts = {
    base: 5,
    doRequests: over(doRequests, 1e6, 0.15),
    doDuration: over(gbSecs, 400_000, 12.5),
    workerRequests: over(workerRequests, 10e6, 0.3),
  };
  const d = new Date(now), daysIn = new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getDate(), dayFrac = (d.getUTCDate() - 1 + d.getUTCHours() / 24) / daysIn;
  const total = parts.base + parts.doRequests + parts.doDuration + parts.workerRequests;
  // (a straight-line projection of the usage part to the end of the month)
  const projected = parts.base + (total - parts.base) / Math.max(0.03, dayFrac);
  return { doRequests, gbSecs, workerRequests, parts, total, projected, dayFrac };
}

// ------------------------------------------------------------------ the worker side

let cache: { at: number; cfg: AdminConfig } | null = null;
export const adminStub = (env: Env) => env.ADMIN.get(env.ADMIN.idFromName("global"));

/** the switches, cached ~10s per worker instance (a ban or OFF reaches every instance within that) */
export async function adminConfig(env: Env): Promise<AdminConfig> {
  const now = Date.now();
  if (cache && now - cache.at < 10_000) return cache.cfg;
  try {
    const r = await adminStub(env).fetch(new Request("https://admin/config"));
    cache = { at: now, cfg: (await r.json()) as AdminConfig };
  } catch { if (!cache) return DEFAULT_CONFIG; }
  return cache!.cfg;
}

export { ipMatches };

export const UNAVAILABLE = "Online play is temporarily unavailable";
function banned(c: AdminConfig, ip: string, dev: string) {
  return c.bans.some((b) => b.ip.startsWith("id:") ? !!dev && b.ip === `id:${dev}` : ipMatches(ip, b.ip));
}

/**
 * May this player use online play now? null = yes, else why not (shown to them). A ban reads exactly like a pause
 * without its message — "temporarily unavailable" — so nobody learns they've been banned (or for how long).
 */
export async function gate(env: Env, ip: string, dev: string, what: "room" | "queue"): Promise<string | null> {
  const c = await adminConfig(env);
  // (a browser id is the game's secret per-browser id — it only ever goes to this server, never to other players)
  const white = c.whitelist.some((w) => w.startsWith("id:") ? !!dev && w === `id:${dev}` : ipMatches(ip, w));
  if (white) return null;
  if (banned(c, ip, dev)) return UNAVAILABLE;
  const msg = c.message ? ` — ${c.message}` : "";
  if (c.online === "off" || c.online === "whitelist") return `${UNAVAILABLE}${msg}`;
  if (what === "queue" && !c.queue) return `Quick match is temporarily unavailable${msg}`;
  return null;
}

/** GET /api/status: what the main menu shows (online available or not, and the queue) */
export async function status(env: Env, ip: string, dev: string) {
  const room = await gate(env, ip, dev, "room");
  const queue = room ?? (await gate(env, ip, dev, "queue"));
  const c = await adminConfig(env);
  return { online: !room, queue: !queue, message: room ?? queue ?? "", rtc: c.rtc ?? "off", rtcMobile: c.rtcMobile ?? "off" };
}

// ------------------------------------------------------------------ the admin page + its API

const enc = new TextEncoder();
async function hmac(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const SESSION = 12 * HOUR;
async function signed(env: Env, req: Request) {
  const m = (req.headers.get("Cookie") ?? "").match(/(?:^|;\s*)bb_admin=([0-9]+)\.([0-9a-f]{64})/);
  if (!m || !env.ADMIN_TOKEN) return false;
  if (Number(m[1]) < Date.now()) return false;
  return same(m[2], await hmac(env.ADMIN_TOKEN, `admin:${m[1]}`));
}

export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  // Security: everything here hangs on the ADMIN_TOKEN secret — it's never in the code or the repo (no default), so
  // reading the source gives nobody a way in. A short one is refused outright; sessions are HMAC-signed with it (rotate
  // the secret to sign everyone out); wrong guesses are limited per IP; state changes need POST from this origin.
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 20) return new Response("Admin is off: set a long ADMIN_TOKEN secret (20+ characters) — bun x wrangler secret put ADMIN_TOKEN", { status: 503 });
  const stub = adminStub(env);
  const call = (path: string, body?: unknown) => stub.fetch(new Request(`https://admin${path}`, { method: "POST", body: JSON.stringify(body ?? {}) }));
  if (url.pathname === "/admin/login" && req.method === "POST") {
    const chk = (await (await call("/login-check", { ip })).json()) as { ok: boolean; wait?: number };
    if (!chk.ok) return json({ error: `Too many tries — wait ${chk.wait}s` }, 429);
    const b = (await req.json().catch(() => ({}))) as { token?: string };
    if (!same(String(b.token ?? ""), env.ADMIN_TOKEN)) { await call("/login-fail", { ip }); return json({ error: "Wrong password" }, 401); }
    const exp = Date.now() + SESSION;
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": `bb_admin=${exp}.${await hmac(env.ADMIN_TOKEN, `admin:${exp}`)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION / 1000}` } });
  }
  if (url.pathname === "/admin/logout") return new Response(null, { status: 302, headers: { Location: "/admin", "Set-Cookie": "bb_admin=; Path=/admin; Max-Age=0" } });
  const ok = await signed(env, req);
  if (url.pathname === "/admin" || url.pathname === "/admin/") return new Response(ADMIN_PAGE.replace("__AUTHED__", ok ? "true" : "false").replaceAll("__MYIP__", ip.replace(/[^0-9a-fA-F.:]/g, "")).replaceAll("__MYNET__", networkRule(ip).replace(/[^0-9a-fA-F.:/]/g, "")), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });
  if (!ok) return json({ error: "not signed in" }, 401);
  const api = url.pathname.match(/^\/admin\/api\/([a-z-]+)$/);
  if (!api) return json({ error: "not found" }, 404);
  // (state changes only by POST from this page: SameSite=Strict cookie + a same-origin check)
  // (compared by host: behind the dev server's proxy the worker sees http:// while the browser is on https://)
  const origin = req.headers.get("Origin");
  const hosts = [url.host, req.headers.get("Host"), req.headers.get("X-Forwarded-Host")].filter(Boolean);
  if (req.method === "POST" && origin && (() => { try { return !hosts.includes(new URL(origin).host); } catch { return true; } })()) return json({ error: "bad origin" }, 403);
  const action = api[1];
  if (action === "overview") return stub.fetch(new Request("https://admin/overview"));
  if (action === "export") { const r = await stub.fetch(new Request("https://admin/export")); return new Response(r.body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename=bitblade-admin-${new Date().toISOString().slice(0, 10)}.json` } }); }
  if (req.method !== "POST" || !["set", "ban", "unban", "close-room", "close-all"].includes(action)) return json({ error: "bad request" }, 400);
  const r = await stub.fetch(new Request(`https://admin/${action}`, { method: "POST", body: await req.text() }));
  cache = null; // (this instance sees the change at once)
  return r;
}

const ADMIN_PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>BitBlade Admin</title>
<style>
:root { --bg: #0b0e17; --panel: #131828; --line: #2a3350; --text: #e6ecff; --muted: #8b95b5; --accent: #3cf2ff; --gold: #ffd23a; --red: #ff4d6d; --green: #4dffa6; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 2; }
header h1 { font-size: 18px; margin: 0; letter-spacing: 0.08em; color: var(--accent); }
header .sp { flex: 1; }
/* one column on phones; on wider screens the controls on the left, what's happening on the right */
main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; padding: 14px 18px 40px; align-items: start; max-width: 1500px; margin: 0 auto; }
@media (min-width: 1000px) { main { grid-template-columns: minmax(380px, 1fr) minmax(0, 1.6fr); } #play { grid-row: span 2; } }
section { background: var(--panel); border: 1px solid var(--line); padding: 14px 16px; min-width: 0; }
section.wide { grid-column: 1 / -1; }
h3 { font-size: 12px; letter-spacing: 0.1em; color: var(--muted); margin: 18px 0 6px; text-transform: uppercase; font-weight: 600; border-top: 1px solid var(--line); padding-top: 14px; }
/* settings: a label, then its control */
.field { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 12px; align-items: center; margin: 9px 0; }
.field > label:first-child { color: var(--muted); }
.field input:not([type=checkbox]), .field select { width: 100%; }
.field .inline { display: flex; gap: 8px; align-items: center; }
.field .inline input { width: 90px; }
@media (max-width: 560px) { .field { grid-template-columns: minmax(0, 1fr); gap: 4px; } }
code { word-break: break-all; }
h2 { font-size: 12px; letter-spacing: 0.14em; color: var(--muted); margin: 0 0 10px; text-transform: uppercase; }
.big { font-size: 28px; font-weight: 700; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
.stat { display: inline-flex; flex-direction: column; min-width: 92px; margin-right: 14px; }
.stat span { color: var(--muted); font-size: 12px; }
button, select, input, textarea { font: inherit; color: var(--text); background: #0b0f1c; border: 1px solid var(--line); padding: 6px 10px; }
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.on { background: var(--accent); color: #001; border-color: var(--accent); }
button.danger { border-color: var(--red); color: var(--red); }
button.danger.on { background: var(--red); color: #fff; }
textarea { width: 100%; min-height: 70px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; vertical-align: middle; }
td.ip { white-space: normal; word-break: break-all; min-width: 120px; }
td.wrap { white-space: normal; overflow-wrap: anywhere; min-width: 120px; }
td.num, th.num { text-align: right; }
td.act { text-align: right; }
/* phones: each table row becomes a card (label: value), so nothing scrolls sideways */
@media (max-width: 700px) {
  table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; width: 100%; }
  table.cards tr.head { display: none; }
  table.cards tr { border: 1px solid var(--line); margin: 8px 0; padding: 4px 0; }
  table.cards td { border: 0; display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 8px; padding: 3px 10px; white-space: normal; overflow-wrap: anywhere; text-align: left; }
  table.cards td > span { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
  table.cards td::before { content: attr(data-l); color: var(--muted); font-size: 12px; }
  table.cards td.act { display: block; }
  table.cards td.act::before { content: none; }
}
th { color: var(--muted); font-weight: 500; }
td.flag { color: var(--gold); }
.muted { color: var(--muted); }
.bad { color: var(--red); }
.good { color: var(--green); }
.chart { display: flex; align-items: flex-end; gap: 1px; height: 90px; border-bottom: 1px solid var(--line); }
.chart i { flex: 1; background: var(--accent); min-height: 1px; opacity: 0.85; }
.chart i:hover { opacity: 1; background: var(--gold); }
.scroll { overflow-x: auto; }
#login { max-width: 360px; margin: 12vh auto; background: var(--panel); border: 1px solid var(--line); padding: 22px; }
#login input { width: 100%; margin: 10px 0; }
</style></head><body>
<div id="login" hidden><h1 style="color:var(--accent);margin:0 0 6px">BitBlade Admin</h1><div class="muted">Password (the ADMIN_TOKEN secret)</div>
<form id="lf"><input id="pw" type="password" autocomplete="current-password" autofocus><button class="on" style="width:100%">Sign in</button></form><div id="lerr" class="bad"></div></div>
<div id="app" hidden>
<header><h1>BITBLADE ADMIN</h1><span id="status" class="muted"></span><span class="sp"></span><span class="muted">you: __MYIP__</span><button id="refresh">Refresh</button><a href="/admin/api/export"><button title="Download the switches, bans and whitelist (a backup)">Export</button></a><a href="/admin/logout"><button>Sign out</button></a></header>
<main>
<section id="play"><h2>Online play</h2>
  <div class="row" id="modes"></div>
  <div class="field"><label for="queue">Quick match</label><label><input type="checkbox" id="queue"> on</label></div>
  <div class="field"><label for="msg">Message when turned away</label><input id="msg" maxlength="200" placeholder="e.g. Back in 10 minutes — updating!"></div>
  <div class="field" title="Players connect directly to their party leader (the server only introduces them; Google's public STUN, no TURN relay). ON: direct where it connects, the server relay where it doesn't. REQUIRED: direct only — anyone who can't connect directly can't stay."><label for="rtc">WebRTC (direct)</label><select id="rtc"><option value="off">Off</option><option value="on">On — relay as fallback</option><option value="required">Required</option></select></div>
  <div class="field"><label for="rtcm">WebRTC on phones</label><select id="rtcm"><option value="off">Off</option><option value="on">On — relay as fallback</option><option value="required">Required</option></select></div>
  <div class="field"><label for="flood">Flood limit</label><span class="inline"><input id="flood" type="number" min="30" max="5000"><span class="muted">msgs/sec per connection</span></span></div>
  <div class="row"><button id="save" class="on">Save</button><button id="closeall" class="danger">Close all rooms now</button></div>
  <h3>Whitelist</h3>
  <div class="muted">WHITELIST only: just these can play (you testing). OFF: nobody — except these. One per line: an IP (v4 or v6, any notation), a range like 203.0.113.0/24 or 2001:db8:1:2::/64, a prefix ending in . or :, or a browser as id:…</div>
  <div class="row"><span class="muted">This browser:</span><code id="mydev"></code></div>
  <div class="row"><button id="addme">Whitelist this browser</button><button id="addip" title="Adds __MYNET__ — on IPv6 that's your whole home network (the part of the address that doesn't rotate)">Whitelist my network</button></div>
  <textarea id="white" placeholder="203.0.113.7"></textarea>
</section>
<section><h2>Right now</h2><div id="now"></div><div class="scroll"><table id="rooms" class="cards"></table></div><div class="muted" style="margin-top:8px">Party codes aren't shown here: they're how people join a party, and they're private to it.</div></section>
<section><h2>This month (estimate)</h2><div id="cost"></div></section>
<section class="wide"><h2>Last 72 hours</h2><div class="row"><select id="metric"></select><span id="mtot" class="muted"></span></div><div class="chart" id="chart"></div><div class="row muted" style="justify-content:space-between"><span id="c0"></span><span>now</span></div></section>
<section class="wide"><h2>Addresses today</h2><div class="muted">Busiest first — flagged ones look like abuse. Ban for a while or for good; banning also drops them from rooms they're in. Banned players just see "temporarily unavailable" — the same as a pause.</div><div class="scroll"><table id="ips" class="cards"></table></div></section>
<section class="wide"><h2>Bans</h2><div class="row"><input id="banip" placeholder="IP, range (…/24, …::/64), prefix, or id:browser" style="flex:1"><select id="banh"><option value="1">1 hour</option><option value="24" selected>1 day</option><option value="168">1 week</option><option value="0">for good</option></select></div><div class="row"><input id="banwhy" placeholder="reason (for you)" style="flex:1"><button id="ban" class="danger">Ban</button></div><div class="scroll"><table id="bans" class="cards"></table></div></section>
</main></div>
<script>
const AUTHED = __AUTHED__;
const $ = (id) => document.getElementById(id);
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'G' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const bytes = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' kB';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
async function api(path, body) {
  const r = await fetch('/admin/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (r.status === 401) { location.reload(); return null; }
  return r.json();
}
if (!AUTHED) {
  $('login').hidden = false;
  $('lf').onsubmit = async (e) => { e.preventDefault(); const r = await fetch('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: $('pw').value }) }); const j = await r.json(); if (j.ok) location.reload(); else $('lerr').textContent = j.error; };
} else {
  $('app').hidden = false;
  let data = null;
  const METRICS = { conns: 'Connections', hosts: 'Rooms opened', joins: 'Joins', msgs: 'Messages relayed', bytes: 'Bytes relayed', activeSecs: 'Room busy-seconds', queue: 'Quick match searches', matches: 'Matches made', peakRooms: 'Peak rooms', denied: 'Turned away', floods: 'Flood cut-offs' };
  for (const [k, v] of Object.entries(METRICS)) $('metric').append(new Option(v, k));
  $('metric').onchange = () => chart();
  function chart() {
    const k = $('metric').value, hs = data.hours, max = Math.max(1, ...hs.map((h) => h.b[k]));
    $('chart').innerHTML = hs.map((h) => '<i style="height:' + (100 * h.b[k] / max) + '%" title="' + h.h + ':00 — ' + (k === 'bytes' ? bytes(h.b[k]) : fmt(h.b[k])) + '"></i>').join('');
    $('c0').textContent = hs[0].h + ':00';
    const tot = hs.reduce((a, h) => k === 'peakRooms' ? Math.max(a, h.b[k]) : a + h.b[k], 0);
    $('mtot').textContent = (k === 'peakRooms' ? 'max ' : 'total ') + (k === 'bytes' ? bytes(tot) : fmt(tot));
  }
  function render() {
    const c = data.config;
    $('status').innerHTML = c.online === 'on' ? '<span class="good">● ONLINE</span>' : c.online === 'whitelist' ? '<span style="color:var(--gold)">● WHITELIST ONLY</span>' : '<span class="bad">● OFF</span>';
    $('modes').innerHTML = '';
    for (const [k, label] of [['on', 'ON — everyone'], ['whitelist', 'WHITELIST only'], ['off', 'OFF']]) {
      const b = document.createElement('button'); b.textContent = label; b.className = (c.online === k ? 'on ' : '') + (k === 'off' ? 'danger' : '');
      b.onclick = async () => { data.config = await api('set', { online: k }); render(); }; $('modes').append(b);
    }
    $('queue').checked = c.queue; if (document.activeElement !== $('msg')) $('msg').value = c.message; $('flood').value = c.floodPerSec; $('rtc').value = c.rtc || 'off'; $('rtcm').value = c.rtcMobile || 'off';
    if (document.activeElement !== $('white')) $('white').value = c.whitelist.join('\\n');
    const players = data.live.reduce((a, r) => a + r.players, 0);
    $('now').innerHTML = '<div class="row"><span class="stat"><b class="big">' + data.live.length + '</b><span>rooms open</span></span><span class="stat"><b class="big">' + players + '</b><span>players connected</span></span></div>';
    $('rooms').innerHTML = data.live.length ? th([['Party'], ['Players', 'num'], ['Leader IP'], ['Open'], ['']]) + data.live.map((r) => tr([['Party', r.name ? esc(r.name) : '<span class="muted">(no name)</span>', 'wrap'], ['Players', r.players, 'num'], ['Leader IP', esc(r.hostIp), 'ip'], ['Open', ago(r.since)], ['', '<button data-close="' + esc(r.ref) + '" data-name="' + esc(r.name || 'this party') + '">Close</button>', 'act']])).join('') : '<tr><td class="muted">No rooms open.</td></tr>';
    const m = data.month, e = data.cost;
    $('cost').innerHTML = '<div class="row"><span class="stat"><b class="big">$' + e.total.toFixed(2) + '</b><span>so far</span></span><span class="stat"><b class="big">$' + e.projected.toFixed(2) + '</b><span>month projected</span></span></div>'
      + '<table><tr><td>Workers Paid plan</td><td>$' + e.parts.base.toFixed(2) + '</td></tr>'
      + '<tr><td>Room requests ' + fmt(e.doRequests) + ' (1M included)</td><td>$' + e.parts.doRequests.toFixed(2) + '</td></tr>'
      + '<tr><td>Room busy time ' + fmt(e.gbSecs) + ' GB·s (400k included)</td><td>$' + e.parts.doDuration.toFixed(2) + '</td></tr>'
      + '<tr><td>Worker requests ' + fmt(e.workerRequests) + ' (10M included)</td><td>$' + e.parts.workerRequests.toFixed(2) + '</td></tr></table>'
      + '<div class="muted" style="margin-top:8px">' + m.month + ': ' + fmt(m.conns) + ' connections · ' + fmt(m.hosts) + ' rooms · ' + fmt(m.matches) + ' quick matches · ' + bytes(m.bytes) + ' relayed. Estimated from the rooms\\' own counts at list prices — the real bill is in the Cloudflare dashboard → Billing.</div>';
    $('ips').innerHTML = th([['IP'], ['Browsers'], ['Flag'], ['Conns', 'num'], ['Rooms', 'num'], ['Msgs', 'num'], ['Data', 'num'], ['Turned away', 'num'], ['Last'], ['']]) + (data.topIps.length ? data.topIps.map((r) => tr([
      ['IP', esc(r.ip), 'ip'], ['Browsers', (r.devs || []).map((d) => '<button title="Ban this browser (not the whole address)" data-bandev="' + esc(d) + '">' + esc(d.slice(0, 6)) + '</button>').join(' ')], ['Flag', esc(r.flag), 'flag'],
      ['Conns', r.conns, 'num'], ['Rooms', r.hosts, 'num'], ['Msgs', fmt(r.msgs), 'num'], ['Data', bytes(r.bytes), 'num'], ['Turned away', r.denied, 'num'], ['Last', ago(r.last)],
      ['', r.banned ? '<span class="bad">banned</span>' : '<button class="danger" data-ban="' + esc(r.ip) + '">Ban 1 day</button>', 'act']])).join('') : '<tr><td class="muted" colspan="10">Nobody yet today.</td></tr>');
    $('bans').innerHTML = c.bans.length ? th([['Who'], ['Until'], ['Reason'], ['']]) + c.bans.map((b) => tr([['Who', esc(b.ip), 'ip'], ['Until', b.until ? new Date(b.until).toLocaleString() : 'for good'], ['Reason', esc(b.reason), 'wrap'], ['', '<button data-unban="' + esc(b.ip) + '">Unban</button>', 'act']])).join('') : '<tr><td class="muted">No bans.</td></tr>';
    chart();
  }
  // a table row whose cells carry their column name (shown as the label when the table becomes cards on a phone)
  const tr = (cells) => '<tr>' + cells.map(([l, v, cls]) => '<td data-l="' + l + '"' + (cls ? ' class="' + cls + '"' : '') + '><span>' + v + '</span></td>').join('') + '</tr>';
  const th = (heads) => '<tr class="head">' + heads.map((h) => '<th' + (h[1] ? ' class="' + h[1] + '"' : '') + '>' + h[0] + '</th>').join('') + '</tr>';
  async function load() { const d = await api('overview'); if (d) { data = d; render(); } }
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.close && confirm('Close ' + t.dataset.name + '? Everyone in it is disconnected.')) { const r = await api('close-room', { ref: t.dataset.close }); if (r && r.error) alert(r.error); load(); }
    if (t.dataset.ban && confirm('Ban ' + t.dataset.ban + ' for a day?')) { await api('ban', { ip: t.dataset.ban, hours: 24, reason: 'from the address list' }); load(); }
    if (t.dataset.bandev && confirm('Ban browser ' + t.dataset.bandev + ' for a day? (Clearing site data gets around this — an IP ban is harder to dodge.)')) { await api('ban', { ip: 'id:' + t.dataset.bandev, hours: 24, reason: 'browser, from the address list' }); load(); }
    if (t.dataset.unban) { await api('unban', { ip: t.dataset.unban }); load(); }
  });
  $('save').onclick = async () => { data.config = await api('set', { queue: $('queue').checked, message: $('msg').value, floodPerSec: Number($('flood').value), rtc: $('rtc').value, rtcMobile: $('rtcm').value, whitelist: $('white').value.split('\\n') }); render(); };
  $('closeall').onclick = async () => { if (!confirm('Close EVERY open room now? Everyone online is disconnected.')) return; const r = await api('close-all', { why: $('msg').value || 'Online play is paused' }); alert('Closed ' + r.closed + ' rooms'); load(); };
  $('ban').onclick = async () => { const ip = $('banip').value.trim(); if (!ip) return; data.config = await api('ban', { ip, hours: Number($('banh').value), reason: $('banwhy').value }); $('banip').value = ''; $('banwhy').value = ''; load(); };
  let myDev = ''; try { myDev = localStorage.getItem('bitblade.deviceId') || ''; } catch {}
  $('mydev').textContent = myDev ? 'id:' + myDev : '(play once in this browser first)';
  const addWhite = (v) => { if (!v) return; const l = $('white').value.split('\\n').map((x) => x.trim()).filter(Boolean); if (!l.includes(v)) l.push(v); $('white').value = l.join('\\n'); $('save').click(); };
  $('addme').onclick = () => addWhite(myDev && 'id:' + myDev);
  $('addip').onclick = () => addWhite('__MYNET__');
  $('refresh').onclick = load;
  load(); setInterval(load, 15000);
}
</script></body></html>`;
