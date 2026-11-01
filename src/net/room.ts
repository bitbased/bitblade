// Persistent online rooms — every online room is a party's room (see party.ts). The room outlives screens: lobby →
// match → results → lobby, and everyone follows the room leader (or, with shared control, anyone can drive).
// Screens plug handlers in and out; the transport listeners are registered exactly once per room.
//
// The door: someone connecting is only "pending" until their hello passes — not blocked, and the right password
// (a matched quick-match room lets its players in without one). Pending peers get nothing from the room, and are
// dropped if they never say hello.
import { sanitizeBlade } from '../core/blade';
import type { BladeDesign } from '../core/blade';
import type { ClientTransport, HostTransport, RoomListing } from './transport';
import { party } from './party';
import { LINK_TIMEOUT, PeerLink } from './p2p';
import { onlineState, rtcPolicy } from './onlineStatus';

/** dev: their browser id (blocking) · party: the party they belong to (parties stay together on teams, go home together) */
export interface Member { peer: number; name: string; blade: BladeDesign | null; party?: string; dev?: string }

/** how the room presents itself: display name, listed publicly or not, a kept code, and a password (empty: none) */
export interface RoomInfo { name: string; public: boolean; persistent: boolean; password: string }

class HostRoom {
  t: HostTransport | null = null;
  /** everyone let in (in join order) */
  members = new Map<number, Member>();
  /** connected, not let in yet (waiting for their hello) */
  private pending = new Map<number, ReturnType<typeof setTimeout>>();
  openControl = false;
  /** a quick match's own room (not anyone's party): its players come in without a password, and go home after */
  matchOpen = false;
  info: RoomInfo = { name: '', public: false, persistent: false, password: '' };
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
    const m: RoomListing = { ...this.summary, name: this.info.name || `${this.summary.host}'s party`, public: this.info.public, persistent: this.info.persistent, inMatch: this._inMatch, openControl: this.openControl, locked: !!this.info.password };
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
    this.info = { name: '', public: false, persistent: false, password: '', ...info };
    this.lastSent = '';
    // directory listings expire unless refreshed
    this.beat = setInterval(() => { if (this.info.public) this.publish(true); }, 25_000);
    t.onJoin((peer) => {
      // (let in only once their hello passes — someone who never says hello is dropped)
      this.pending.set(peer, setTimeout(() => this.deny(peer, 'timeout'), 12_000));
    });
    t.onLeave((peer) => {
      this.dropLink(peer);
      const p = this.pending.get(peer);
      if (p !== undefined) { clearTimeout(p); this.pending.delete(peer); return; }
      if (!this.members.delete(peer)) return;
      this.onMemberLeft?.(peer); this.notify();
    });
    t.onMessage((peer, m) => {
      if (!m) return;
      if (this.pending.has(peer)) { if (m.t === 'hello') this.admit(peer, m); return; }
      if (m.t === 'rtc') { this.onRtc(peer, m); return; }
      this.handle(peer, m);
    });
    this.notify();
  }

  /** a member's message — through the relay or straight from them (WebRTC): the same either way */
  private handle(peer: number, m: any) {
    const t = this.t;
    const mem = this.members.get(peer);
    if (!mem || !t || !m) return;
    {
      if (m.t === 'hello' || m.t === 'blade') {
        if (m.name) mem.name = String(m.name).slice(0, 16);
        if (m.blade) mem.blade = sanitizeBlade(m.blade) ?? mem.blade;
        this.notify();
      } else if (m.t === 'home' && typeof m.party === 'string') {
        // a visiting party's leader is taking them home: tell the rest of their party
        for (const o of this.members.values()) if (o.peer !== peer && o.party === m.party) t.send(o.peer, { t: 'gohome', code: m.party });
      } else if (m.t === 'ctl') this.onCtl?.(peer, m);
      else if (m.t === 'in') this.onInput?.(peer, m);
      else if (m.t === 'quitmatch') this.onQuitMatch?.(peer);
    }
  }

  // ---- WebRTC: direct links to members (the relay introduces them; it carries on wherever a link doesn't open)
  private links = new Map<number, PeerLink>();
  /** a member is linked directly (their match traffic skips the server) */
  isDirect(peer: number) { return !!this.links.get(peer)?.open; }
  private onRtc(peer: number, m: any) {
    if (!this.members.has(peer) || rtcPolicy() === 'off') return;
    let link = this.links.get(peer);
    if (!link || link.closed) {
      link = new PeerLink(false, (sig) => this.t?.send(peer, sig), (msg) => this.handle(peer, msg), () => {
        if (this.links.get(peer)?.closed) this.links.delete(peer);
        this.notify();
      });
      this.links.set(peer, link);
    }
    void link.signal(m);
  }
  private dropLink(peer: number) { this.links.get(peer)?.close(); this.links.delete(peer); }

  /** a pending peer's hello: blocked? the password? — then they're in */
  private admit(peer: number, m: any) {
    const dev = typeof m.dev === 'string' ? m.dev.slice(0, 40) : undefined;
    if (party.isBlocked(dev)) { this.deny(peer, 'blocked'); return; }
    const pw = this.info.password;
    if (pw && !this.matchOpen && String(m.pw ?? '') !== pw) { this.deny(peer, m.pw ? 'wrong password' : 'password'); return; }
    clearTimeout(this.pending.get(peer)!);
    this.pending.delete(peer);
    this.members.set(peer, {
      peer, name: String(m.name ?? '').slice(0, 16) || `Guest ${peer}`, blade: sanitizeBlade(m.blade), dev,
      party: typeof m.party === 'string' && /^[A-Z0-9]{4,10}$/.test(m.party) ? m.party : undefined,
    });
    this.t?.send(peer, { t: 'admitted' });
    if (this.inMatch) this.t?.send(peer, { t: 'busy' });
    // (WebRTC REQUIRED: a member has a little while to link up directly, or they're out)
    if (rtcPolicy() === 'required') setTimeout(() => { if (this.members.has(peer) && !this.isDirect(peer)) this.deny(peer, 'direct'); }, LINK_TIMEOUT + 4000);
    this.notify();
  }

  /** turn someone away (or out): they're told why, then disconnected */
  deny(peer: number, why: string) {
    this.dropLink(peer);
    const p = this.pending.get(peer);
    if (p !== undefined) { clearTimeout(p); this.pending.delete(peer); }
    const t = this.t;
    t?.send(peer, { t: 'denied', why });
    setTimeout(() => t?.kick(peer), 250);
  }

  /** remove a member from the party (and, with `block`, keep their browser out from now on) */
  kick(peer: number, block = false) {
    const mem = this.members.get(peer);
    if (block && mem?.dev) party.block(mem.dev, mem.name);
    this.deny(peer, block ? 'blocked' : 'removed');
  }

  close() {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    for (const p of this.pending.values()) clearTimeout(p);
    this.pending.clear();
    for (const l of this.links.values()) l.close();
    this.links.clear();
    if (this.t) { try { this.t.close(); } catch { /* ignore */ } }
    this.t = null;
    this.members.clear();
    this.matchOpen = false;
    this._inMatch = false;
    this.notify();
  }

  /** to one member, or everyone let in (never to someone still at the door) */
  send(peer: number | 'all', m: unknown) {
    if (!this.t) return;
    const msg = m as { t?: string };
    if (peer !== 'all') { if (!this.links.get(peer)?.send(msg)) this.t.send(peer, m); return; }
    // (nobody linked directly and nobody at the door: one message to the relay reaches everyone)
    if (!this.pending.size && ![...this.links.values()].some((l) => l.open)) { this.t.send('all', m); return; }
    for (const p of this.members.keys()) if (!this.links.get(p)?.send(msg)) this.t.send(p, m);
  }
  /** to the party's own members only (not visitors from a quick match) */
  sendParty(m: unknown) { if (this.t) for (const mem of this.members.values()) if (mem.party === this.t.code) this.t.send(mem.peer, m); }
  subscribe(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  notify() { for (const cb of this.subs) cb(); }
}

/** what came of joining: in, turned away (and why), or the connection closed first */
export type JoinResult = { ok: true } | { ok: false; why: string };

class ClientRoom {
  t: ClientTransport | null = null;
  /** the room as its host last sent it (kept after the room closes: who takes over, the settings to carry on with) */
  lobby: any = null;
  busy = false;
  /** the party's password, from the leader (a member who takes over the party keeps it) */
  partyPw = '';
  /** who takes over the party if its leader goes (set by a promotion) */
  heir: number | null = null;
  handler: ((m: any) => void) | null = null;
  /** party traffic, whatever screen is up: travel, go home, promote (main.ts) */
  onParty: ((m: any) => void) | null = null;
  /** the room went away under us (host left, kicked, lost connection) — main.ts decides where everyone goes */
  onLost: ((reason: string, code: string) => void) | null = null;
  denied = '';
  /** my id in the room (kept after it closes: am I the one who takes over?) */
  myId = -1;
  private acceptWait: ((r: JoinResult) => void) | null = null;
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
    this.busy = false;
    this.denied = '';
    this.heir = null;
    this.partyPw = '';
    this.myId = t.id;
    t.onMessage((m) => {
      if (this.t !== t) return;
      if (m?.t === 'rtc') { void this.link?.signal(m); return; }
      if (m?.t === 'admitted') this.startLink(t);
      this.dispatch(m);
    });
    t.onClose((r) => {
      if (this.t !== t) return;
      this.t = null;
      this.link?.close(); this.link = null;
      const why = this.denied || r;
      const joining = !!this.acceptWait;
      this.settle({ ok: false, why });
      if (!joining) this.onLost?.(why, t.code);
    });
  }

  // ---- WebRTC: a direct link to the party leader (match traffic skips the server); the relay carries on otherwise
  link: PeerLink | null = null;
  /** linked directly to the leader */
  get direct() { return !!this.link?.open; }
  /** link state changes (the lobby shows DIRECT / RELAY) */
  onLink: (() => void) | null = null;
  private async startLink(t: ClientTransport) {
    this.link?.close();
    this.link = null;
    if (!onlineState.st) await onlineState.refresh(); // (the server's WebRTC setting decides)
    if (this.t !== t || rtcPolicy() === 'off') return;
    const link: PeerLink = new PeerLink(true, (sig) => t.send(sig), (msg) => { if (this.t === t) this.dispatch(msg); }, () => this.onLink?.());
    this.link = link;
    void link.start();
  }

  /** a message from the host — through the relay or straight from them: the same either way */
  private dispatch(m: any) {
    const t = this.t;
    if (!t) return;
    {
      if (m?.t === 'denied') { this.denied = String(m.why ?? 'denied'); this.settle({ ok: false, why: this.denied }); return; }
      if (m?.t === 'admitted') { this.settle({ ok: true }); return; }
      if (m?.t === 'lobby' || m?.t === 'busy' || m?.t === 'start') this.settle({ ok: true });
      if (m?.t === 'lobby') { this.lobby = m; this.busy = false; }
      if (m?.t === 'busy') this.busy = true;
      if (m?.t === 'partycfg') { this.partyPw = String(m.pw ?? ''); if (this.partyPw) party.pw.set(t.code, this.partyPw); else party.pw.delete(t.code); return; }
      if (m?.t === 'travel' || m?.t === 'gohome' || m?.t === 'promote') { if (m.t === 'promote') this.heir = Number(m.heir); this.onParty?.(m); return; }
      this.handler?.(m);
    }
  }

  /** after the hello: wait to be let in (the first lobby / busy) or turned away */
  waitAccepted(ms: number): Promise<JoinResult> {
    return new Promise((res) => {
      const done = (r: JoinResult) => { clearTimeout(timer); this.acceptWait = null; res(r); };
      const timer = setTimeout(() => done({ ok: false, why: 'no answer from the party' }), ms);
      this.acceptWait = done;
    });
  }
  private settle(r: JoinResult) { this.acceptWait?.(r); }

  send(m: unknown) { if (!this.link?.send(m as { t?: string })) this.t?.send(m); }

  leave() {
    const t = this.t;
    this.t = null;
    this.link?.close(); this.link = null;
    this.lobby = null;
    try { t?.close(); } catch { /* ignore */ }
  }
}

export const hostRoom = new HostRoom();
export const clientRoom = new ClientRoom();
