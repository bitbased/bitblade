// Parties: you and your friends, together across rooms. Online play is party-first — a party (even a party of one)
// goes into a room together: the leader hosts a room, joins one, or is matched by QUICK MATCH, and every member
// follows. When the leader leaves a room, the party comes back to the Online screen together.
//
// A party is a small private room on the relay with no game in it — just who's in the party and where they're
// headed. The leader hosts it; members are its clients. If the leader drops, the next member re-hosts the same code
// and everyone else reconnects, so the party survives.
//
//   leader → all     { t: 'party', members: [{ id, name }], leader, room }   who's here and which room we're in
//   member → leader  { t: 'hi', name }                                       my name (on join and when it changes)
import { cloudRelayUrl, hostCloud, hostLocal, joinAny, type ClientTransport, type HostTransport } from './transport';
import { getPlatform } from './platform';

export interface PartyMember { id: number; name: string }

class Party {
  /** I lead: the party's room is mine */
  private host: HostTransport | null = null;
  /** I'm a member: my connection to the leader */
  private client: ClientTransport | null = null;
  code = '';
  myId = 0;
  myName = 'Player';
  /** everyone, leader first (the leader's id is 0) */
  members: PartyMember[] = [];
  /** the game room the party is in (the leader's room; null = the Online screen) */
  room: string | null = null;
  /** redraw whatever shows the party */
  listeners = new Set<() => void>();
  /** a member: the leader's moved the party to another room (or back out of one) — main.ts follows */
  onGoto: ((room: string | null) => void) | null = null;
  /** a member: the party ended (left, kicked, or nobody could take over) */
  onEnded: ((why: string) => void) | null = null;
  private leaveT: ReturnType<typeof setTimeout> | null = null;
  private migrating = false;

  get inParty() { return !!(this.host || this.client); }
  /** solo counts as leading a party of one */
  get leads() { return !this.client; }
  get size() { return this.inParty ? Math.max(1, this.members.length) : 1; }
  get leaderName() { return this.members[0]?.name ?? this.myName; }
  /** the party code as an invite link */
  link() { return this.code ? `${(cloudRelayUrl() || location.origin).replace(/^ws/, 'http').replace(/\/+$/, '')}/?party=${this.code}` : ''; }

  private notify() { for (const f of this.listeners) f(); }

  private async hostTransport(code?: string) {
    const opts = code ? { code } : {};
    if (cloudRelayUrl()) return hostCloud(this.myName, opts);
    if (!getPlatform()) return hostLocal(this.myName, false, opts); // (the page's own relay)
    throw new Error('Parties need the online relay (Settings → Cloud relay URL)');
  }

  /** start a party: you lead it (whatever room you're in, the party follows from now on) */
  async create(name: string, code?: string) {
    this.myName = name || 'Player';
    const t = await this.hostTransport(code);
    this.leaveNow();
    this.host = t;
    this.code = t.code;
    this.myId = 0;
    this.members = [{ id: 0, name: this.myName }];
    t.onJoin((peer, n) => { if (!this.members.some((m) => m.id === peer)) this.members.push({ id: peer, name: n.slice(0, 16) || `Player ${peer}` }); this.broadcast(); });
    t.onLeave((peer) => { this.members = this.members.filter((m) => m.id !== peer); this.broadcast(); });
    t.onMessage((peer, m) => {
      if (m?.t === 'hi') { const mem = this.members.find((x) => x.id === peer); if (mem && m.name) { mem.name = String(m.name).slice(0, 16); this.broadcast(); } }
    });
    this.broadcast();
  }

  /** join a friend's party (they lead; you follow them into rooms) */
  async join(code: string, name: string) {
    this.myName = name || 'Player';
    const t = await joinAny(code.trim().toUpperCase(), this.myName);
    this.leaveNow();
    this.client = t;
    this.code = t.code;
    this.myId = t.id;
    t.onMessage((m) => {
      if (m?.t !== 'party') return;
      this.members = Array.isArray(m.members) ? m.members : [];
      const room = typeof m.room === 'string' ? m.room : null;
      const moved = room !== this.room;
      this.room = room;
      this.notify();
      if (moved) this.onGoto?.(room);
    });
    t.onClose((why) => { if (this.client === t) this.leaderGone(why); });
    t.send({ t: 'hi', name: this.myName });
    this.notify();
  }

  /** the leader dropped: the first member left re-hosts the same code; the others reconnect to it */
  private async leaderGone(why: string) {
    const code = this.code, mine = this.myId;
    const next = this.members.filter((m) => m.id !== 0)[0];
    this.client = null;
    if (why === 'kicked') { this.reset(); this.onEnded?.('You were removed from the party'); return; }
    this.migrating = true;
    this.notify();
    if (next?.id === mine) {
      try { await this.create(this.myName, code); this.migrating = false; this.notify(); return; } catch { /* someone else got it: join instead */ }
    }
    const until = performance.now() + 12_000;
    while (performance.now() < until && this.migrating) {
      await new Promise((r) => setTimeout(r, 1200));
      try { await this.join(code, this.myName); this.migrating = false; this.notify(); return; } catch { /* not back yet */ }
    }
    if (!this.migrating) return;
    this.reset();
    this.onEnded?.('Your party ended — the leader left');
  }

  private broadcast() {
    if (!this.host) return;
    this.host.send('all', { t: 'party', members: this.members, leader: this.myName, room: this.room });
    this.notify();
  }

  /**
   * The leader's game room changed (hosted, joined, matched — or left): the party follows. Leaving is held a moment,
   * so moving straight on to another room (a quick match, a room travelling) doesn't bounce everyone out first.
   */
  leaderAt(room: string | null) {
    if (!this.host) return;
    if (this.leaveT) { clearTimeout(this.leaveT); this.leaveT = null; }
    if (room === null) { this.leaveT = setTimeout(() => { this.leaveT = null; this.room = null; this.broadcast(); }, 1500); return; }
    if (room === this.room) return;
    this.room = room;
    this.broadcast();
  }

  rename(name: string) {
    this.myName = name || this.myName;
    const me = this.members.find((m) => m.id === this.myId);
    if (me) me.name = this.myName;
    if (this.host) this.broadcast(); else this.client?.send({ t: 'hi', name: this.myName });
  }

  kick(id: number) { if (this.host && id !== 0) this.host.kick(id); }

  /** leave (a member) or end the party for everyone (the leader — the next member takes over) */
  leave() { this.leaveNow(); this.notify(); }

  private leaveNow() {
    this.migrating = false;
    const h = this.host, c = this.client;
    this.host = null; this.client = null;
    try { h?.close(); } catch { /* ignore */ }
    try { c?.close(); } catch { /* ignore */ }
    this.reset(false);
  }

  private reset(notify = true) {
    if (this.leaveT) { clearTimeout(this.leaveT); this.leaveT = null; }
    this.code = ''; this.members = []; this.room = null; this.myId = 0;
    if (notify) this.notify();
  }

  get reconnecting() { return this.migrating; }
}

export const party = new Party();
