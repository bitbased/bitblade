import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
    // public dev tunnel (cloudflared → localhost:5173)
    allowedHosts: ['bitblade-dev.bitbased.net', 'localhost', '.trycloudflare.com'],
    // multiplayer relay rooms: proxied to `bun run relay` (port 8787) so the dev page and tunnel share one origin
    // (online traffic goes to a local copy of the real Cloudflare worker — `wrangler dev` on 8790, so dev has the admin
    // page, bans and switches just like production; DEV_BACKEND=8787 uses the small Bun relay instead)
    proxy: (() => {
      const port = process.env.DEV_BACKEND ?? '8790';
      const http = { target: `http://localhost:${port}`, xfwd: true }, ws = { target: `ws://localhost:${port}`, ws: true, xfwd: true };
      // (xfwd: the worker sees the address the browser used — the admin page's same-site check needs it)
      return { '/room': ws, '/mm': ws, '/health': http, '/api': http, '/admin': http };
    })(),
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
