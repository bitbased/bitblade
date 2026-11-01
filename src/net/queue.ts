// QUICK MATCH queue client (server: server/matchmaker.ts, on the relay at /mm). One connection while you're
// queued — solo from the Online screen, or your whole room from the lobby — and it survives switching screens.
import { cloudRelayUrl } from './transport';
import { party } from './party';
import { onlineState } from './onlineStatus';

export interface QueueStatus { wait: number; queued: number; modes: Record<string, number> }
export interface QueueMatch { role: 'host' | 'join'; mode: string; code: string; expect: number; host: string; names: string[] }
export interface QueueTicket { modes: string[]; size: number; room?: string; name: string }

class QueueClient {
  private ws: WebSocket | null = null;
  ticket: QueueTicket | null = null;
  status: QueueStatus | null = null;
  error = '';
  since = 0;
  /** whoever's on screen redraws on these */
  listeners = new Set<() => void>();
  /** set once by main.ts: what a match does (host it / join it / bring the room along) */
  onMatch: ((m: QueueMatch) => void) | null = null;

  get active() { return !!this.ticket; }
  private notify() { for (const f of this.listeners) f(); }

  /** queue (or update what you're queued for: modes, group size, room) */
  start(t: QueueTicket) {
    const fresh = !this.ticket;
    this.ticket = t;
    this.error = '';
    if (fresh) { this.since = performance.now(); this.status = null; }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify({ t: 'queue', ...t })); this.notify(); return; }
    if (this.ws) { this.notify(); return; } // (connecting: the ticket goes when it opens)
    const base = cloudRelayUrl().replace(/^http/, 'ws').replace(/\/+$/, '');
    if (!base) { this.ticket = null; this.error = 'No online relay configured'; this.notify(); return; }
    const ws = new WebSocket(`${base}/mm?name=${encodeURIComponent(t.name)}&dev=${encodeURIComponent(party.deviceId)}`);
    this.ws = ws;
    ws.onopen = () => { if (this.ticket) ws.send(JSON.stringify({ t: 'queue', ...this.ticket })); };
    ws.onmessage = (e) => {
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m?.t === 'error') { this.ticket = null; this.status = null; this.error = String(m.msg ?? 'Quick match is unavailable'); onlineState.turnedAway(this.error); this.close(); this.notify(); return; }
      if (m?.t === 'status') { this.status = m; this.notify(); }
      else if (m?.t === 'match') {
        this.ticket = null; this.status = null;
        this.close();
        this.notify();
        this.onMatch?.(m as QueueMatch);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ticket) { this.ticket = null; this.error = 'Lost the connection to the queue — try again'; }
      this.notify();
    };
  }

  cancel() {
    if (!this.ticket) return;
    this.ticket = null; this.status = null;
    try { this.ws?.send(JSON.stringify({ t: 'cancel' })); } catch { /* ignore */ }
    this.close();
    this.notify();
  }

  private close() { const ws = this.ws; this.ws = null; try { ws?.close(); } catch { /* ignore */ } }

  /** "0:42" since you queued */
  waited() { const s = Math.floor((performance.now() - this.since) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
}

export const queue = new QueueClient();

/** the modes you last queued for (empty = any) */
const PREF = 'bitblade.queueModes';
export function queueModes(): string[] { try { const v = JSON.parse(localStorage.getItem(PREF) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
export function saveQueueModes(m: string[]) { try { localStorage.setItem(PREF, JSON.stringify(m)); } catch { /* ignore */ } }
