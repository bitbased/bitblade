// Browser client for the BitBlade relay (server/relay-bun.ts, electron/relay-node.cjs, worker/).
// Hosts connect to /room/new and get a code; clients join /room/<code>.

export type RelayRole = "host" | "client";

export type RelayEvents = {
  welcome: { t: "welcome"; id: number; role: RelayRole; code: string };
  "peer-join": { t: "peer-join"; id: number; name: string };
  "peer-leave": { t: "peer-leave"; id: number };
  from: { t: "from"; from: number; m: any };
  "host-left": { t: "host-left" };
  error: { t: "error"; msg: string };
  close: { code: number; reason: string };
  msg: any;
};

type Listener<K extends keyof RelayEvents> = (e: RelayEvents[K]) => void;

const RELAY_TYPES = new Set(["welcome", "peer-join", "peer-leave", "from", "host-left", "error"]);

export class RelayClient {
  id = -1;
  code = "";
  role: RelayRole;
  readonly wsBase: string;
  private ws: WebSocket;
  private listeners = new Map<string, Set<(e: any) => void>>();

  private constructor(wsBase: string, path: string, role: RelayRole) {
    this.wsBase = wsBase.replace(/\/+$/, "");
    this.role = role;
    this.ws = new WebSocket(this.wsBase + path);
    this.ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      // Host receives only relay envelopes; clients receive relay envelopes and raw host messages.
      if (m && typeof m.t === "string" && RELAY_TYPES.has(m.t) && (this.role === "host" || m.t !== "from")) {
        if (m.t === "welcome") { this.id = m.id; this.code = m.code; }
        this.emit(m.t, m);
      } else {
        this.emit("msg", m);
      }
    };
    this.ws.onclose = (ev) => this.emit("close", { code: ev.code, reason: ev.reason });
  }

  private ready(): Promise<RelayClient> {
    return new Promise((resolve, reject) => {
      const offW = this.on("welcome", () => { cleanup(); resolve(this); });
      const offE = this.on("error", (e) => { cleanup(); reject(new Error(e.msg)); });
      const offC = this.on("close", () => { cleanup(); reject(new Error("connection closed")); });
      const cleanup = () => { offW(); offE(); offC(); };
    });
  }

  static host(wsBase: string, name = "host"): Promise<RelayClient> {
    const c = new RelayClient(wsBase, `/room/new?role=host&name=${encodeURIComponent(name)}`, "host");
    return c.ready();
  }

  static join(wsBase: string, code: string, name: string): Promise<RelayClient> {
    const c = new RelayClient(wsBase, `/room/${encodeURIComponent(code.toUpperCase())}?role=client&name=${encodeURIComponent(name)}`, "client");
    return c.ready();
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  on<K extends keyof RelayEvents>(type: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  private emit(type: string, e: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(e);
  }

  private raw(m: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Client → host. Arrives at host as {t:"from", from:<myId>, m}. */
  sendToHost(m: unknown) {
    this.raw(m);
  }

  /** Host → one client or all clients. Arrives at client(s) as a 'msg' event with `m`. */
  sendTo(to: number | "all", m: unknown) {
    this.raw({ t: "to", to, m });
  }

  kick(id: number) {
    this.raw({ t: "kick", id });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

const CODE_RE = /^[A-Za-z0-9]{5}$/;

function defaultWsBase(): string {
  const env = (import.meta as any).env?.VITE_CLOUD_RELAY as string | undefined;
  if (env) return env.replace(/^http/, "ws").replace(/\/+$/, "");
  if (typeof location !== "undefined" && /^https?:$/.test(location.protocol)) {
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  }
  return "ws://localhost:8787";
}

/**
 * Accepts: bare code "ABCDE"; full invite URL (https://x.trycloudflare.com/join/ABCDE,
 * http://192.168.1.5:47800/join/ABCDE); or "host:port/CODE".
 */
export function parseJoinInput(input: string): { wsBase: string; code: string } {
  const s = input.trim();
  if (CODE_RE.test(s)) return { wsBase: defaultWsBase(), code: s.toUpperCase() };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    throw new Error("Invalid invite code or URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const code = parts[parts.length - 1] ?? "";
  if (!CODE_RE.test(code)) throw new Error("No room code found in invite");
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  return { wsBase: `${secure ? "wss" : "ws"}://${url.host}`, code: code.toUpperCase() };
}

export function makeInviteUrl(httpBase: string, code: string): string {
  return `${httpBase.replace(/\/+$/, "")}/join/${code}`;
}

/** Convert an http(s) base to ws(s). */
export function toWsBase(httpBase: string): string {
  return httpBase.replace(/^http/, "ws").replace(/\/+$/, "");
}
