// Transport abstraction. The game only talks to HostTransport / ClientTransport, so a Steam
// Networking Sockets / Steam Lobby implementation (steamworks.js in Electron) can be added later
// next to the WebSocket relay without touching game code.
import { RelayClient, makeInviteUrl, parseJoinInput } from './relay';
import { getPlatform } from './platform';

export type TransportKind = 'relay-local' | 'relay-tunnel' | 'relay-cloud' | 'steam';

export interface HostTransport {
  kind: TransportKind;
  code: string;
  invites: string[]; // human-shareable URLs / codes
  onJoin(cb: (peer: number, name: string) => void): void;
  onLeave(cb: (peer: number) => void): void;
  onMessage(cb: (peer: number, msg: any) => void): void;
  send(peer: number | 'all', msg: unknown): void;
  kick(peer: number): void;
  /** publish / unpublish this room in the public directory (only relays that keep one) */
  meta(m: RoomListing): void;
  /** true when this room can appear in the public room list */
  listable: boolean;
  close(): void;
}

/** what a public room shows in the browser */
export interface RoomListing {
  public: boolean; name: string; host: string; mode: string; modeName: string; arena: string;
  players: number; max: number; inMatch: boolean; persistent: boolean;
  /** anyone in the room can change mode / arena and start */
  openControl?: boolean;
  /** a password is needed to join */
  locked?: boolean;
}

/** a public room as returned by the directory */
export interface PublicRoom extends RoomListing { code: string; clients: number; updated: number }

export interface HostOpts { code?: string; key?: string }

export interface ClientTransport {
  kind: TransportKind;
  id: number;
  code: string;
  onMessage(cb: (msg: any) => void): void;
  onClose(cb: (reason: string) => void): void;
  send(msg: unknown): void;
  close(): void;
}

function wrapHost(rc: RelayClient, kind: TransportKind, invites: string[], listable: boolean, cleanup?: () => void): HostTransport {
  return {
    kind, code: rc.code, invites, listable,
    meta: (m) => rc.meta(m),
    onJoin: (cb) => { rc.on('peer-join', (e) => cb(e.id, e.name)); },
    onLeave: (cb) => { rc.on('peer-leave', (e) => cb(e.id)); },
    onMessage: (cb) => { rc.on('from', (e) => cb(e.from, e.m)); },
    send: (peer, msg) => rc.sendTo(peer, msg),
    kick: (peer) => rc.kick(peer),
    close: () => { rc.close(); cleanup?.(); },
  };
}

/** Host on this machine (Electron) — LAN direct, optionally exposed through a Cloudflare quick tunnel. */
export async function hostLocal(name: string, tunnel: boolean, opts: HostOpts = {}): Promise<HostTransport> {
  const p = getPlatform();
  if (!p) {
    // browser: same-origin relay (vite dev proxies /room to `bun run relay`; the Worker serves it in production)
    const http = location.protocol.startsWith('http') ? location.origin : 'http://localhost:8787';
    const rc = await RelayClient.host(http.replace(/^http/, 'ws'), name, opts);
    return wrapHost(rc, 'relay-local', [rc.code, makeInviteUrl(http, rc.code)], true);
  }
  const info = await p.startHost();
  const rc = await RelayClient.host(`ws://127.0.0.1:${info.port}`, name, opts);
  const invites = [rc.code, ...info.lanUrls.map((u) => makeInviteUrl(u, rc.code))];
  let kind: TransportKind = 'relay-local';
  if (tunnel) {
    const t = await p.startTunnel();
    if ('error' in t) {
      rc.close();
      throw new Error(t.error);
    }
    invites.unshift(makeInviteUrl(t.url, rc.code));
    kind = 'relay-tunnel';
  }
  return wrapHost(rc, kind, invites, false, () => { p.stopTunnel(); p.stopHost(); });
}

export function cloudRelayUrl(): string {
  try {
    const s = localStorage.getItem('bitblade.cloudRelay');
    if (s) return s;
  } catch { /* ignore */ }
  const env = import.meta.env.VITE_CLOUD_RELAY as string | undefined;
  if (env) return env;
  // served over http(s) (dev server, dev tunnel, the Worker): the page's own origin has a relay
  return typeof location !== 'undefined' && location.protocol.startsWith('http') ? location.origin : '';
}

/** Host through the Cloudflare Worker (Durable Object relay). */
export async function hostCloud(name: string, opts: HostOpts = {}): Promise<HostTransport> {
  const base = cloudRelayUrl();
  if (!base) throw new Error('No cloud relay configured (Settings → Cloud relay URL)');
  const ws = base.replace(/^http/, 'ws');
  const rc = await RelayClient.host(ws, name, opts);
  const http = base.replace(/^ws/, 'http');
  return wrapHost(rc, 'relay-cloud', [rc.code, makeInviteUrl(http, rc.code)], true);
}

/** the public room directory (from the cloud relay, or the page's own relay in dev) */
export async function fetchPublicRooms(): Promise<PublicRoom[]> {
  const base = cloudRelayUrl().replace(/^ws/, 'http').replace(/\/+$/, '');
  if (!base) throw new Error('No cloud relay configured');
  const r = await fetch(`${base}/api/rooms`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Room list unavailable (${r.status})`);
  const j = (await r.json()) as { rooms: PublicRoom[] };
  return j.rooms ?? [];
}

/** invite input for a listed room (works from Electron too, where a bare code has no origin) */
export function publicJoinInput(code: string) {
  return `${cloudRelayUrl().replace(/^ws/, 'http').replace(/\/+$/, '')}/join/${code}`;
}

/** Join by bare code, invite URL or host:port/CODE. */
export async function joinAny(input: string, name: string): Promise<ClientTransport> {
  let { wsBase, code } = parseJoinInput(input);
  // bare code in Electron (file://): fall back to the cloud relay
  if (/^[A-Z0-9]{4,10}$/i.test(input.trim()) && location.protocol === 'file:' && cloudRelayUrl()) wsBase = cloudRelayUrl().replace(/^http/, 'ws');
  const rc = await RelayClient.join(wsBase, code, name);
  return {
    kind: 'relay-cloud', id: rc.id, code,
    onMessage: (cb) => { rc.on('msg', cb); },
    onClose: (cb) => { rc.on('host-left', () => cb('Host left')); rc.on('close', (e) => cb(e.reason || 'Disconnected')); },
    send: (m) => rc.sendToHost(m),
    close: () => rc.close(),
  };
}
