// Starts the Vite dev server, then launches Electron pointed at it.
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const electronBin: string = require("electron");

const server = await createServer({ root, server: { port: 5173, strictPort: false } });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";
console.log(`vite: ${url}`);

const child = spawn(electronBin, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_URL: url },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
