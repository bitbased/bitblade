import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
    // public dev tunnel (cloudflared → localhost:5173)
    allowedHosts: ['bitblade-dev.bitbased.net', 'localhost', '.trycloudflare.com'],
    // multiplayer relay rooms: proxied to `bun run relay` (port 8787) so the dev page and tunnel share one origin
    proxy: { '/room': { target: 'ws://localhost:8787', ws: true }, '/health': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
