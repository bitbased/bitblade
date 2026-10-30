// QUICK MATCH: pick the modes you'll play (any, or some) and queue; the matchmaker puts you in a room with other
// players. What a match does: host it (your lobby opens the room and starts once everyone's in), join it (you land in
// the host's lobby), or — queued as a room that's joining someone else's — bring your whole room along.
import { h, type App } from './app';
import { MODES, PICK_MODES } from '../game/types';
import { queue, queueModes, saveQueueModes, type QueueMatch } from '../net/queue';
import { clientRoom, hostRoom } from '../net/room';
import { settings } from '../core/settings';
import { icon } from './icons';
import { MODE_ICON } from './menus';

/**
 * A match we're hosting. Everyone in it can drive the room (OPEN CONTROL) and press START; otherwise it starts by
 * itself: a countdown once everyone's arrived (`go`), or when the wait for them runs out (`until` — CPUs fill in).
 */
export const pendingMatch: { cur: { expect: number; until: number; mode: string; go?: number } | null } = { cur: null };
/** seconds of countdown once everyone's in, and the longest we wait for players to arrive */
export const MATCH_COUNTDOWN = 15, MATCH_ARRIVE = 30;

/** a room host whose room is matched into someone else's: tells its guests to travel, then follows them */
export const travel: { room: ((code: string) => void) | null } = { room: null };

export function onQueueMatch(app: App, m: QueueMatch) {
  const mode = MODES.find((x) => x.id === m.mode);
  const others = m.names.filter((n) => n !== settings.playerName);
  app.toast(`Match found — ${mode?.name ?? m.mode}${others.length ? ` with ${others.join(', ')}` : ''}`);
  app.sfx.play('go');
  if (m.role === 'host') {
    pendingMatch.cur = { expect: m.expect, until: performance.now() + (MATCH_ARRIVE + MATCH_COUNTDOWN) * 1000, mode: m.mode };
    if (hostRoom.t && hostRoom.t.code === m.code) { hostRoom.openControl = true; app.go('lobby', { mode: m.mode }); }
    else app.go('lobby', { mode: m.mode, online: true, room: { name: 'Quick match', public: false, persistent: false, code: m.code, openControl: true } });
    return;
  }
  if (hostRoom.t && travel.room) { travel.room(m.code); return; }
  if (clientRoom.t) clientRoom.leave();
  app.go('online', { match: m.code });
}

/** the QUICK MATCH window (Online screen): modes to play, FIND MATCH / CANCEL, and how the queue looks */
export function quickMatchPanel(app: App, onClose: () => void) {
  let picked = new Set(queueModes());
  const body = h('div.qm-body');
  const el = h('div.qm-overlay', { onclick: (e: Event) => { if (e.target === el) close(); } }, h('div.qm-panel.panel', null, body));
  const close = () => { queue.listeners.delete(render); el.remove(); onClose(); };
  function render() {
    body.innerHTML = '';
    const active = queue.active, st = queue.status;
    const chip = (id: string, label: string, ic?: string) => {
      const on = id === 'any' ? !picked.size : picked.has(id);
      return h('button.qm-chip.nav' + (on ? '.on' : ''), {
        disabled: active,
        onclick: () => {
          if (id === 'any') picked = new Set();
          else if (picked.has(id)) picked.delete(id); else picked.add(id);
          if (picked.size === PICK_MODES.length) picked = new Set(); // (every mode = any)
          saveQueueModes([...picked]); render();
        },
      }, ic ? icon(ic) : null, ' ', label);
    };
    const count = (id: string) => st?.modes[id] ?? 0;
    body.append(...[
      h('div.qm-head', null, h('h2', null, 'QUICK MATCH'), h('button.btn.small.nav', { onclick: () => close() }, active ? 'Hide' : 'Close')),
      h('div.hint', null, active ? 'Searching for players who want the same game…' : 'Pick what you\'d play — the more you pick, the sooner you\'re matched.'),
      h('div.qm-chips', null, chip('any', 'ANY MODE'), ...PICK_MODES.map((m) => chip(m.id, m.name.toUpperCase(), MODE_ICON[m.id]))),
      active
        ? h('div.qm-status', null,
            h('b', null, `SEARCHING · ${queue.waited()}`),
            h('span', null, st ? `${st.queued} player${st.queued === 1 ? '' : 's'} in the queue` : 'connecting…'),
            st ? h('span.qm-modes', null, PICK_MODES.filter((m) => count(m.id) > 0).map((m) => `${m.name} ${count(m.id)}`).join(' · ')) : null)
        : queue.error ? h('div.hint', { style: { color: 'var(--red)' } }, queue.error) : null,
      active
        ? h('button.btn.nav', { onclick: () => { queue.cancel(); } }, 'CANCEL')
        : h('button.btn.primary.nav', { onclick: () => queue.start({ modes: [...picked], size: 1, name: settings.playerName || 'Player' }) }, icon('bolt'), ' FIND MATCH'),
    ].filter(Boolean) as Node[]);
  }
  queue.listeners.add(render);
  render();
  return el;
}
