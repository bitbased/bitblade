// BitBlade relay (Bun). Same protocol as electron/relay-node.cjs and worker/src/index.ts.
//   ws  /room/<CODE|new>?role=host|client&name=<name>
//   GET /health -> ok ; static ./dist ; /join/<code> -> dist/index.html
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.RELAY_PORT ?? 8787);
const DIST = resolve(import.meta.dir, "..", "dist");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Peer = { id: number; role: "host" | "client"; name: string; code: string };
type Room = { code: string; host: ServerWebSocket<Peer> | null; clients: Map<number, ServerWebSocket<Peer>>; nextId: number };

const rooms = new Map<string, Room>();

function genCode(): string {
  for (;;) {
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

const send = (ws: ServerWebSocket<Peer>, m: unknown) => { try { ws.send(JSON.stringify(m)); } catch {} };

function serveStatic(path: string): Response {
  if (!existsSync(DIST)) return new Response("BitBlade relay (no dist build)", { status: 200 });
  if (path.startsWith("/join/") || path === "/") path = "/index.html";
  const file = normalize(join(DIST, decodeURIComponent(path)));
  if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
  if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
  return new Response(Bun.file(join(DIST, "index.html")));
}

const server = Bun.serve<Peer>({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (m) {
      const role = url.searchParams.get("role") === "host" ? "host" : "client";
      let code = m[1].toUpperCase();
      if (code === "NEW") code = role === "host" ? genCode() : "";
      const name = (url.searchParams.get("name") ?? "").slice(0, 32);
      if (srv.upgrade(req, { data: { id: 0, role, name, code } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    return serveStatic(url.pathname);
  },
  websocket: {
    open(ws) {
      const p = ws.data;
      let room = rooms.get(p.code);
      if (p.role === "host") {
        if (!p.code || room?.host) { send(ws, { t: "error", msg: "room already hosted" }); ws.close(); return; }
        if (!room) { room = { code: p.code, host: null, clients: new Map(), nextId: 1 }; rooms.set(p.code, room); }
        room.host = ws;
        p.id = 0;
      } else {
        if (!room?.host) { send(ws, { t: "error", msg: "no host" }); ws.close(); p.code = ""; return; }
        p.id = room.nextId++;
        room.clients.set(p.id, ws);
        send(room.host, { t: "peer-join", id: p.id, name: p.name });
      }
      send(ws, { t: "welcome", id: p.id, role: p.role, code: p.code });
    },
    message(ws, raw) {
      const p = ws.data;
      const room = rooms.get(p.code);
      if (!room) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (p.role === "client") {
        if (room.host) send(room.host, { t: "from", from: p.id, m: msg });
        return;
      }
      if (room.host !== ws) return;
      if (msg?.t === "to") {
        const data = JSON.stringify(msg.m);
        if (msg.to === "all") for (const c of room.clients.values()) { try { c.send(data); } catch {} }
        else { const c = room.clients.get(Number(msg.to)); if (c) try { c.send(data); } catch {} }
      } else if (msg?.t === "kick") {
        const c = room.clients.get(Number(msg.id));
        if (c) { send(c, { t: "error", msg: "kicked" }); c.close(); }
      }
    },
    close(ws) {
      const p = ws.data;
      const room = rooms.get(p.code);
      if (!room) return;
      if (p.role === "host" && room.host === ws) {
        for (const c of room.clients.values()) { send(c, { t: "host-left" }); c.close(); }
        rooms.delete(p.code);
      } else if (p.role === "client" && room.clients.get(p.id) === ws) {
        room.clients.delete(p.id);
        if (room.host) send(room.host, { t: "peer-leave", id: p.id });
      }
    },
  },
});

console.log(`BitBlade relay on http://localhost:${server.port}  (ws /room/<code>)`);
