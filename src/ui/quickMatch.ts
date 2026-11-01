// QUICK MATCH: a party queues from its lobby (the leader, or anyone with shared control) for the lobby's mode, as one
// group — its people, not its CPUs. A match gets a room of its own — never anyone's party: the biggest party's leader
// opens it (everyone can drive it, it starts by itself), every party goes there together, and goes home afterwards.
import type { App } from './app';
import { MODES } from '../game/types';
import type { QueueMatch } from '../net/queue';
import { settings } from '../core/settings';
import { clean } from '../core/textFilter';
import { hostMatch, partyTravel } from './lobby';

/**
 * A match we're hosting. Everyone in it can drive the room and press START; otherwise it starts by itself: a
 * countdown once everyone's arrived (`go`), or when the wait for them runs out (`until` — CPUs fill in).
 */
export const pendingMatch: { cur: { expect: number; until: number; mode: string; go?: number } | null } = { cur: null };
/** seconds of countdown once everyone's in, and the longest we wait for players to arrive */
export const MATCH_COUNTDOWN = 15, MATCH_ARRIVE = 30;

/** the lobby on screen takes a match to go elsewhere itself (so its screen goes cleanly) */
export const travel: { room: ((code: string) => void) | null } = { room: null };

export function onQueueMatch(app: App, m: QueueMatch) {
  const mode = MODES.find((x) => x.id === m.mode);
  const others = m.names.filter((n) => n !== settings.playerName).map(clean);
  app.toast(`Match found — ${mode?.name ?? m.mode}${others.length ? ` with ${others.join(', ')}` : ''}`);
  app.sfx.play('go');
  if (m.role === 'host') { hostMatch(app, m); return; }
  if (travel.room) travel.room(m.code);
  else partyTravel(app, m.code, 'match');
}
