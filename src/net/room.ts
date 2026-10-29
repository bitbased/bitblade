// Persistent online rooms. The room outlives screens: lobby → match → results → lobby, and everyone follows
// the room leader (or, with Open Control, anyone can drive). Screens plug handlers in and out; the transport
// listeners are registered exactly once per room.
import type { BladeDesign } from '../core/blade';
import type { ClientTransport, HostTransport } from './transport';

export interface Member { peer: number; name: string; blade: BladeDesign | null }

class HostRoom {
  t: HostTransport | null = null;
  members = new Map<number, Member>();
  openControl = false;
  inMatch = false;
  onCtl: ((peer: number, m: any) => void) | null = null; // lobby: remote room control
  onInput: ((peer: number, m: any) => void) | null = null; // match: remote player input
  onQuitMatch: ((peer: number) => void) | null = null; // match: a guest stepped out (still in the room)
  private subs = new Set<() => void>();

  open(t: HostTransport) {
    this.close();
    this.t = t;
    t.onJoin((peer, name) => {
      this.members.set(peer, { peer, name: name.slice(0, 16) || `Guest ${peer}`, blade: null });
      if (this.inMatch) t.send(peer, { t: 'busy' });
      this.notify();
    });
    t.onLeave((peer) => { this.members.delete(peer); this.notify(); });
    t.onMessage((peer, m) => {
      const mem = this.members.get(peer);
      if (!mem || !m) return;
      if (m.t === 'hello' || m.t === 'blade') {
        if (m.name) mem.name = String(m.name).slice(0, 16);
        if (m.blade) mem.blade = m.blade as BladeDesign;
        this.notify();
      } else if (m.t === 'ctl') this.onCtl?.(peer, m);
      else if (m.t === 'in') this.onInput?.(peer, m);
      else if (m.t === 'quitmatch') this.onQuitMatch?.(peer);
    });
    this.notify();
  }

  close() {
    if (this.t) { try { this.t.close(); } catch { /* ignore */ } }
    this.t = null;
    this.members.clear();
    this.inMatch = false;
    this.notify();
  }

  send(peer: number | 'all', m: unknown) { this.t?.send(peer, m); }
  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private notify() { for (const cb of this.subs) cb(); }
}

class ClientRoom {
  t: ClientTransport | null = null;
  lobby: any = null;
  busy = false;
  handler: ((m: any) => void) | null = null;
  closeHandler: ((reason: string) => void) | null = null;
  /** what we joined with last, so a dropped/left room can be rejoined in one click */
  lastJoin: string | null = (() => { try { return localStorage.getItem('bitblade.lastRoom'); } catch { return null; } })();

  remember(input: string) {
    this.lastJoin = input;
    try { localStorage.setItem('bitblade.lastRoom', input); } catch { /* ignore */ }
  }

  attach(t: ClientTransport) {
    this.leave();
    this.t = t;
    this.lobby = null;
    t.onMessage((m) => {
      if (m?.t === 'lobby') { this.lobby = m; this.busy = false; }
      if (m?.t === 'busy') this.busy = true;
      this.handler?.(m);
    });
    t.onClose((r) => {
      if (this.t !== t) return;
      this.t = null;
      this.closeHandler?.(r);
    });
  }

  send(m: unknown) { this.t?.send(m); }

  leave() {
    const t = this.t;
    this.t = null;
    this.lobby = null;
    try { t?.close(); } catch { /* ignore */ }
  }
}

export const hostRoom = new HostRoom();
export const clientRoom = new ClientRoom();
