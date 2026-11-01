// Is online play available right now (the admin can pause it, or quick match alone; a banned player sees exactly the
// same "temporarily unavailable")? One shared answer for every screen — the main menu, the lobby's GO ONLINE / QUICK
// MATCH, the Online screen — refreshed when they open, and corrected at once when a connection is turned away.
import { onlineStatus as fetchStatus } from './transport';
import { party } from './party';

export interface OnlineState { online: boolean; queue: boolean; message: string }

const UNAVAILABLE = 'Online play is temporarily unavailable';

class OnlineStatusStore {
  /** null: not known yet (or no server to ask) — treated as available */
  st: OnlineState | null = null;
  private at = 0;
  private busy: Promise<void> | null = null;
  /** screens showing it redraw on these */
  listeners = new Set<() => void>();

  get ok() { return !this.st || this.st.online; }
  get queueOk() { return this.ok && (!this.st || this.st.queue); }
  /** why not, for the player */
  get message() { return this.st?.message || UNAVAILABLE; }

  private set(st: OnlineState | null) {
    const changed = JSON.stringify(st) !== JSON.stringify(this.st);
    this.st = st;
    if (changed) for (const f of this.listeners) f();
  }

  /** ask the server (at most every 15s unless `force`) */
  refresh(force = false): Promise<void> {
    if (this.busy) return this.busy;
    if (!force && performance.now() - this.at < 15_000 && this.at) return Promise.resolve();
    this.busy = fetchStatus(party.deviceId).then((st) => { this.at = performance.now(); if (st) this.set(st); }).finally(() => { this.busy = null; });
    return this.busy;
  }

  /** a connection was just turned away with this message: if it's the pause / ban, everything shows it now */
  turnedAway(msg: string) {
    if (msg.startsWith(UNAVAILABLE)) this.set({ online: false, queue: false, message: msg });
    else if (msg.startsWith('Quick match is temporarily unavailable')) this.set({ online: true, queue: false, message: msg });
    else return false;
    this.at = performance.now();
    return true;
  }
}

export const onlineState = new OnlineStatusStore();
