// BitBlade Electron main process.
const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn, execFileSync } = require("node:child_process");
const { startRelay } = require("./relay-node.cjs");

const DIST = path.join(__dirname, "..", "dist");
const HOST_PORT = 47800;

let win = null;
let relay = null;
let tunnel = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: "#05060a",
    autoHideMenuBar: true,
    title: "BitBlade",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.type === "keyDown" && input.key === "F12") { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL);
  else win.loadFile(path.join(DIST, "index.html"));
  win.on("closed", () => { win = null; });
}

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) out.push(`http://${ni.address}:${port}`);
  }
  return out;
}

async function startHost() {
  if (relay) return { port: relay.port, lanUrls: lanUrls(relay.port) };
  let lastErr;
  for (let p = HOST_PORT; p < HOST_PORT + 20; p++) {
    try { relay = await startRelay(p, DIST); return { port: relay.port, lanUrls: lanUrls(relay.port) }; }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function stopHost() {
  stopTunnel();
  if (relay) { const r = relay; relay = null; await r.close(); }
}

function findCloudflared() {
  const candidates = [
    "C:/Program Files (x86)/cloudflared/cloudflared.exe",
    "C:/Program Files/cloudflared/cloudflared.exe",
    path.join(os.homedir(), "AppData/Local/Microsoft/WinGet/Links/cloudflared.exe"),
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ];
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(cmd, ["cloudflared"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch {}
  return candidates.find((c) => fs.existsSync(c)) || null;
}

async function startTunnel() {
  if (tunnel && tunnel.url) return { url: tunnel.url };
  const { port } = await startHost();
  const bin = findCloudflared();
  if (!bin) return { error: "cloudflared not installed — winget install Cloudflare.cloudflared" };
  return new Promise((resolve) => {
    const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { windowsHide: true });
    tunnel = { child, url: null };
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && tunnel) { tunnel.url = m[0]; finish({ url: m[0] }); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { tunnel = null; finish({ error: String(e.message || e) }); });
    child.on("exit", () => { if (tunnel && tunnel.child === child) tunnel = null; finish({ error: "cloudflared exited" }); });
    setTimeout(() => finish({ error: "timed out waiting for tunnel URL" }), 30000);
  });
}

function stopTunnel() {
  if (tunnel) { try { tunnel.child.kill(); } catch {} tunnel = null; }
}

ipcMain.handle("bb:startHost", () => startHost());
ipcMain.handle("bb:stopHost", () => stopHost());
ipcMain.handle("bb:startTunnel", () => startTunnel());
ipcMain.handle("bb:stopTunnel", () => stopTunnel());
ipcMain.handle("bb:quit", () => app.quit());
ipcMain.handle("bb:toggleFullscreen", () => { if (win) win.setFullScreen(!win.isFullScreen()); });

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { stopTunnel(); if (relay) relay.close(); });
