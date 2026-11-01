// BitBlade matchmaker: the queue behind QUICK MATCH. Pure logic — the transport (Bun relay, Cloudflare Durable Object)
// gives it messages and a way to send; it groups waiting players by the modes they'll play and hands out rooms.
//
//   client → { t: 'queue', modes: string[] (empty = any), size, room?, name }   join / update your ticket
//   client → { t: 'cancel' }                                                    leave the queue
//   server → { t: 'status', wait, queued, modes: {mode: players} }               about once a second
//   server → { t: 'match', role: 'host' | 'join', mode, code, expect, host }      you're in a match
//
// A ticket is one client: a solo player, or a whole room (size = its players, room = its code). The host of a match
// (who opens the match's own room) is the biggest party, then whoever waited longest; everyone else joins its
// room. A match starts at the mode's ideal size, or — once the longest-waiting player has waited RELAX seconds — at
// its minimum (bots fill the rest). Never with fewer than two tickets: one person alone can play CPUs anywhere.

export type MMSend = (id: number, m: unknown) => void;

export interface Ticket { id: number; name: string; modes: string[]; size: number; room?: string; since: number }

/** players per match: the least worth starting with, the size we wait for, and the most a room takes */
export const MODE_SIZE: Record<string, { min: number; ideal: number; max: number }> = {
  duel: { min: 2, ideal: 2, max: 8 },
  tag: { min: 2, ideal: 4, max: 8 },
  ctf: { min: 2, ideal: 4, max: 8 },
  rush: { min: 2, ideal: 4, max: 8 },
  koth: { min: 2, ideal: 4, max: 8 },
  race: { min: 2, ideal: 4, max: 8 },
  gauntlet: { min: 2, ideal: 2, max: 4 },
  quest: { min: 2, ideal: 2, max: 4 },
  pinball: { min: 2, ideal: 3, max: 8 },
};
export const MM_MODES = Object.keys(MODE_SIZE);
/** seconds the longest-waiting player waits for a full match before a smaller one will do */
export const RELAX = 15;

const clean = (s: unknown, n: number) => String(s ?? '').slice(0, n);

export class Matchmaker {
  tickets = new Map<number, Ticket>();
  constructor(private send: MMSend, private newCode: () => string, private now: () => number = () => Date.now()) {}

  /** a client's queue message (queue / cancel); returns true when the ticket set changed */
  message(id: number, m: any) {
    if (m?.t === 'cancel') return this.remove(id);
    if (m?.t !== 'queue') return false;
    const modes = (Array.isArray(m.modes) ? m.modes : []).map((x: unknown) => clean(x, 12)).filter((x: string) => MODE_SIZE[x]);
    const old = this.tickets.get(id);
    this.tickets.set(id, {
      id, name: clean(m.name, 16) || 'Player', modes, size: Math.max(1, Math.min(8, Math.floor(Number(m.size) || 1))),
      room: /^[A-Z0-9]{4,10}$/.test(String(m.room ?? '')) ? String(m.room) : undefined, since: old?.since ?? this.now(),
    });
    this.tick();
    return true;
  }

  remove(id: number) { return this.tickets.delete(id); }

  accepts(t: Ticket, mode: string) { return !t.modes.length || t.modes.includes(mode); }

  /** match whoever can be matched, then tell everyone still waiting how it looks */
  tick() {
    const now = this.now();
    for (;;) {
      const m = this.findMatch(now);
      if (!m) break;
      this.start(m.mode, m.group);
    }
    this.status(now);
  }

  /** the best match available now: for the longest-waiting tickets first, the mode that gathers the most players */
  findMatch(now: number): { mode: string; group: Ticket[] } | null {
    const queue = [...this.tickets.values()].sort((a, b) => a.since - b.since);
    for (const first of queue) {
      const waited = (now - first.since) / 1000;
      let best: { mode: string; group: Ticket[]; players: number } | null = null;
      for (const mode of first.modes.length ? first.modes : MM_MODES) {
        const sz = MODE_SIZE[mode];
        // oldest first, as many as fit
        const group: Ticket[] = [first];
        let players = first.size;
        for (const t of queue) {
          if (t === first || !this.accepts(t, mode) || players + t.size > sz.max) continue;
          group.push(t); players += t.size;
          if (players >= sz.ideal && waited < RELAX) break; // (full enough: leave the rest for the next match)
        }
        if (group.length < 2) continue;
        const ready = players >= sz.ideal || (players >= sz.min && waited >= RELAX);
        if (ready && (!best || players > best.players)) best = { mode, group, players };
      }
      if (best) return best;
    }
    return null;
  }

  start(mode: string, group: Ticket[]) {
    // (the biggest party with a room hosts — every party has one now; then the longest waiting)
    const rooms = group.filter((t) => t.room);
    const host = [...(rooms.length ? rooms : group)].sort((a, b) => b.size - a.size || a.since - b.since)[0];
    const code = this.newCode(); // (its own room: parties never take strangers into their party)
    const expect = group.reduce((n, t) => n + t.size, 0);
    for (const t of group) {
      this.tickets.delete(t.id);
      this.send(t.id, { t: 'match', role: t === host ? 'host' : 'join', mode, code, expect, host: host.name, names: group.map((g) => g.name) });
    }
  }

  status(now: number) {
    const modes: Record<string, number> = {};
    let queued = 0;
    for (const t of this.tickets.values()) {
      queued += t.size;
      for (const m of t.modes.length ? t.modes : MM_MODES) modes[m] = (modes[m] ?? 0) + t.size;
    }
    for (const t of this.tickets.values()) this.send(t.id, { t: 'status', wait: Math.floor((now - t.since) / 1000), queued, modes });
  }
}
