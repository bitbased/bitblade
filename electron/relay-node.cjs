// BitBlade relay (Node + ws) for hosting from the Electron app.
// Same protocol as server/relay-bun.ts and worker/src/index.ts.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
};

function startRelay(port, distDir) {
  const rooms = new Map();
  const genCode = () => {
    for (;;) {
      let c = "";
      for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
  };
  const send = (ws, m) => { try { ws.send(JSON.stringify(m)); } catch {} };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") { res.end("ok"); return; }
    if (!distDir || !fs.existsSync(distDir)) { res.end("BitBlade relay"); return; }
    let p = url.pathname;
    if (p === "/" || p.startsWith("/join/")) p = "/index.html";
    let file = path.normalize(path.join(distDir, decodeURIComponent(p)));
    if (!file.startsWith(path.normalize(distDir))) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(distDir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (!m) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const role = url.searchParams.get("role") === "host" ? "host" : "client";
      let code = m[1].toUpperCase();
      if (code === "NEW") code = role === "host" ? genCode() : "";
      const peer = { id: 0, role, code, name: (url.searchParams.get("name") || "").slice(0, 32) };
      let room = rooms.get(code);

      if (role === "host") {
        if (!code || (room && room.host)) { send(ws, { t: "error", msg: "room already hosted" }); ws.close(); return; }
        if (!room) { room = { host: null, clients: new Map(), nextId: 1 }; rooms.set(code, room); }
        room.host = ws;
      } else {
        if (!room || !room.host) { send(ws, { t: "error", msg: "no host" }); ws.close(); return; }
        peer.id = room.nextId++;
        room.clients.set(peer.id, ws);
        send(room.host, { t: "peer-join", id: peer.id, name: peer.name });
      }
      send(ws, { t: "welcome", id: peer.id, role, code });

      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (role === "client") { if (room.host) send(room.host, { t: "from", from: peer.id, m: msg }); return; }
        if (room.host !== ws) return;
        if (msg && msg.t === "to") {
          const data = JSON.stringify(msg.m);
          if (msg.to === "all") { for (const c of room.clients.values()) { try { c.send(data); } catch {} } }
          else { const c = room.clients.get(Number(msg.to)); if (c) try { c.send(data); } catch {} }
        } else if (msg && msg.t === "kick") {
          const c = room.clients.get(Number(msg.id));
          if (c) { send(c, { t: "error", msg: "kicked" }); c.close(); }
        }
      });

      ws.on("close", () => {
        if (role === "host" && room.host === ws) {
          for (const c of room.clients.values()) { send(c, { t: "host-left" }); c.close(); }
          rooms.delete(code);
        } else if (role === "client" && room.clients.get(peer.id) === ws) {
          room.clients.delete(peer.id);
          if (room.host) send(room.host, { t: "peer-leave", id: peer.id });
        }
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startRelay };
