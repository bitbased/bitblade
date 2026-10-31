// Persistent online rooms. The room outlives screens: lobby → match → results → lobby, and everyone follows
// the room leader (or, with Open Control, anyone can drive). Screens plug handlers in and out; the transport
// listeners are registered exactly once per room.
import type { BladeDesign } from '../core/blade';
import type { ClientTransport, HostTransport, RoomListing } from './transport';
import { party } from './party';

/** party: the guest's party code (party members stay on one team) */
export interface Member { peer: number; name: string; blade: BladeDesign | null; party?: string }

/** how the room presents itself: display name, listed publicly or not, and whether it's a saved (persistent) room */
export interface RoomInfo { name: string; public: boolean; persistent: boolean }

class HostRoom {
  t: HostTransport | null = null;
  members = new Map<number, Member>();
  openControl = false;
  info: RoomInfo = { name: '', public: false, persistent: false };
  /** latest lobby summary (mode / arena / players) — the lobby keeps it fresh */
  summary: Omit<RoomListing, 'public' | 'name' | 'persistent' | 'inMatch'> = { host: '', mode: '', modeName: '', arena: '', players: 0, max: 0 };
  private _inMatch = false;
  private beat: ReturnType<typeof setInterval> | null = null;
  private lastSent = '';
  get inMatch() { return this._inMatch; }
  set inMatch(v: boolean) { this._inMatch = v; this.publish(); }

  /** push the room listing to the directory if it changed (or `force` for the heartbeat) */
  publish(force = false) {
    const t = this.t;
    if (!t || !t.listable) return;
    const m: RoomListing = { ...this.summary, name: this.info.name || `${this.summary.host}'s room`, public: this.info.public, persistent: this.info.persistent, inMatch: this._inMatch, openControl: this.openControl };
    const k = JSON.stringify(m);
    if (!force && k === this.lastSent) return;
    if (!m.public && !this.lastSent.includes('"public":true') && !force) { this.lastSent = k; return; }
    this.lastSent = k;
    t.meta(m);
  }

  setInfo(p: Partial<RoomInfo>) { this.info = { ...this.info, ...p }; this.publish(); this.notify(); }
  setSummary(p: Partial<HostRoom['summary']>) { this.summary = { ...this.summary, ...p }; this.publish(); }
  onCtl: ((peer: number, m: any) => void) | null = null; // lobby: remote room control
  onInput: ((peer: number, m: any) => void) | null = null; // match: remote player input
  onQuitMatch: ((peer: number) => void) | null = null; // match: a guest stepped out (still in the room)
  onMemberLeft: ((peer: number) => void) | null = null; // a guest left the room (lobby or match)
  private subs = new Set<() => void>();

  open(t: HostTransport, info?: Partial<RoomInfo>) {
    this.close();
    this.t = t;
    this.info = { name: '', public: false, persistent: false, ...info };
    this.lastSent = '';
    // directory listings expire unless refreshed
    this.beat = setInterval(() => { if (this.info.public) this.publish(true); }, 25_000);
    t.onJoin((peer, name) => {
      this.members.set(peer, { peer, name: name.slice(0, 16) || `Guest ${peer}`, blade: null });
      if (this.inMatch) t.send(peer, { t: 'busy' });
      this.notify();
    });
    t.onLeave((peer) => { this.members.delete(peer); this.onMemberLeft?.(peer); this.notify(); });
    party.leaderAt(t.code); // (my party comes into my room)
    t.onMessage((peer, m) => {
      const mem = this.members.get(peer);
      if (!mem || !m) return;
      if (m.t === 'hello' || m.t === 'blade') {
        if (m.name) mem.name = String(m.name).slice(0, 16);
        if (typeof m.party === 'string') mem.party = m.party.slice(0, 10) || undefined;
        if (m.blade) mem.blade = m.blade as BladeDesign;
        this.notify();
      } else if (m.t === 'ctl') this.onCtl?.(peer, m);
      else if (m.t === 'in') this.onInput?.(peer, m);
      else if (m.t === 'quitmatch') this.onQuitMatch?.(peer);
    });
    this.notify();
  }

  close() {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    if (this.t) { try { this.t.close(); } catch { /* ignore */ } party.leaderAt(null); }
    this.t = null;
    this.members.clear();
    this._inMatch = false;
    this.notify();
  }

  send(peer: number | 'all', m: unknown) { this.t?.send(peer, m); }
  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  notify() { for (const cb of this.subs) cb(); }
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
    party.leaderAt(t.code); // (my party follows me in)
    t.onMessage((m) => {
      if (m?.t === 'lobby') { this.lobby = m; this.busy = false; }
      if (m?.t === 'busy') this.busy = true;
      this.handler?.(m);
    });
    t.onClose((r) => {
      if (this.t !== t) return;
      this.t = null;
      party.leaderAt(null);
      this.closeHandler?.(r);
    });
  }

  send(m: unknown) { this.t?.send(m); }

  leave() {
    const t = this.t;
    this.t = null;
    this.lobby = null;
    if (t) party.leaderAt(null);
    try { t?.close(); } catch { /* ignore */ }
  }
}

export const hostRoom = new HostRoom();
export const clientRoom = new ClientRoom();
