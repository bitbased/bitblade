// Local + online-host lobby: press-to-join slots, blades, teams, arena, rules, invite codes.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { glyph } from './nav';
import { allBlades, computeStats, findBlade, PRESETS, STAT_INFO, STAT_KEYS, type BladeDesign } from '../core/blade';
import { ringPoints } from '../core/bladeMesh';
import { allArenas, arenaSize, findArena, SIZE_LABEL, type ArenaDef, type ArenaSize } from '../game/terrain';
import { MODES, type ControllerSpec, type MatchConfig, type ModeId } from '../game/types';
import { Input, specKey, specLabel } from '../input/input';
import { cloudRelayUrl, hostCloud, hostLocal } from '../net/transport';
import { getPlatform } from '../net/platform';
import { TEAM_COLORS } from './hud';
import { setBackdropVisible, setBackdropArena } from './backdrop';
import { settings } from '../core/settings';
import { icon, drawIcon } from './icons';
import type { MatchArg } from './match';
import { hostRoom } from '../net/room';
import { testRide } from './testRide';
import { findMyRoom, newOwnerKey, saveMyRoom } from '../net/myRooms';
import type { RoomOpts } from './online';
import { acceptSong, roomMusicRow } from './roomMusic';
import type { Song } from '../game/music';

interface Slot { name: string; ctrl: ControllerSpec; bladeId: string; team: number; blade?: BladeDesign }

interface Card {
  el: HTMLElement; pnum: HTMLElement; team: HTMLElement; cv: HTMLCanvasElement; name: HTMLInputElement; bname: HTMLElement;
  left: HTMLElement; right: HTMLElement; bars: { i: HTMLElement; row: HTMLElement }[]; ctrl: HTMLElement; ctrlKey: string; pad: HTMLElement; x: HTMLElement; d: BladeDesign | null;
}
interface Sel { el: HTMLElement; set(title: string, sub: string): void }
interface LobbyUI {
  back: HTMLButtonElement; desc: HTMLElement; mode: Sel; size: Sel; arena: Sel;
  items: HTMLElement; nudge: HTMLElement; share: HTMLElement; rubber: HTMLElement; rubberVal: HTMLElement; target: HTMLElement; targetLbl: HTMLElement; targetVal: HTMLElement; timeVal: HTMLElement;
}

const L = {
  mode: 'duel' as ModeId,
  arenaId: 'neon-stadium',
  items: true,
  sizeFilter: 'ALL' as 'ALL' | ArenaSize,
  rubber: 1,
  /** pinball: steering nudges the table (fills the tilt meter); off = flippers only, like a classic table */
  nudge: true,
  /** king of the hill: everyone in the zone banks time */
  kothShare: false,
  target: 4,
  time: 90,
  slots: [] as Slot[],
  /** set once the lobby has been visited: the menu offers CONTINUE back into it */
  active: false,
  /** online room music (null = each track's own song) and who picked it */
  song: null as Song | null,
  songBy: '',
};

/** the lobby you'll return to (players, mode, arena all kept), or null if there isn't one yet */
export function lobbySession() {
  if (!L.active) return null;
  const mode = MODES.find((m) => m.id === L.mode)!;
  const humans = L.slots.filter((s) => s.ctrl.type !== 'cpu').length;
  return { mode: mode.name, arena: findArena(L.arenaId).name, humans, total: Math.min(L.slots.length, mode.maxPlayers) };
}


export function drawBladeIcon(cv: HTMLCanvasElement, d: BladeDesign, angle = 0) {
  const S = cv.width;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, S, S);
  c.save();
  c.translate(S / 2, S / 2);
  c.rotate(angle);
  const pts = ringPoints(d, 120);
  const k = S * 0.42 / Math.max(...pts.map((p) => Math.hypot(p.x, p.y)));
  c.shadowColor = d.glow;
  c.shadowBlur = S * 0.12;
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(p.x * k, p.y * k) : c.moveTo(p.x * k, p.y * k)));
  c.closePath();
  const g = c.createRadialGradient(0, 0, S * 0.05, 0, 0, S * 0.45);
  g.addColorStop(0, d.accent);
  g.addColorStop(0.35, d.primary);
  g.addColorStop(1, d.secondary);
  c.fillStyle = g;
  c.fill();
  c.shadowBlur = 0;
  c.lineWidth = S * 0.02;
  c.strokeStyle = d.glow;
  c.stroke();
  c.beginPath();
  c.arc(0, 0, S * 0.13, 0, Math.PI * 2);
  c.fillStyle = d.secondary;
  c.fill();
  c.strokeStyle = d.accent;
  c.stroke();
  c.rotate(-angle);
  c.fillStyle = d.emblemColor;
  c.font = `900 ${S * 0.16}px Orbitron, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (!drawIcon(c, d.emblem, 0, 0, S * 0.18, d.emblemColor)) c.fillText(d.emblem || '', 0, S * 0.01);
  c.restore();
}

export class LobbyScreen implements Screen {
  app!: App;
  el!: HTMLElement;
  nav!: MenuNav;
  slotsEl!: HTMLElement;
  /** slot cards are built once and updated in place (no flicker, focus and animations survive) */
  cards: Card[] = [];
  joinCard!: HTMLElement;
  ui!: LobbyUI;
  lastBackdrop = '';
  angle = 0;
  onlineEl!: HTMLElement;
  peerSlot = new Map<number, number>();
  broadcastT = 0;
  dirty = true;
  iconT = 0;
  unsub: (() => void) | null = null;
  padCool = new Map<number, number>();
  /** how to open the room when hosting (name / public / persistent code) — set by the online hub */
  roomOpts: RoomOpts = { name: '', public: false, persistent: false };

  get mode() { return MODES.find((m) => m.id === L.mode)!; }

  mount(app: App, arg?: unknown) {
    this.app = app;
    // an online room keeps its chosen song between matches; otherwise menu music
    if (hostRoom.t && L.song) app.sfx.playSong(L.song, app.sfx.player?.song?.id !== L.song.id); else app.sfx.useMusic('menu');
    setBackdropVisible(true, app.canvas);
    // keep: coming back from a match/results/menu — leave mode, rules, players and arena exactly as they were
    // next: advance to the next arena for this mode; autostart: go straight into the match (rematch / next track)
    const a = (arg ?? {}) as { mode?: ModeId; bladeId?: string; arenaId?: string; keep?: boolean; online?: boolean; next?: boolean; autostart?: boolean; room?: RoomOpts };
    if (a.room) this.roomOpts = a.room;
    L.active = true;
    if (a.mode && !a.keep && a.mode !== L.mode) this.setMode(a.mode);
    else if (a.mode && !a.keep) this.setMode(a.mode, true);
    if (a.arenaId && allArenas().some((x) => x.id === a.arenaId && this.fits(x))) L.arenaId = a.arenaId;
    if (!L.slots.some((s) => s.ctrl.type !== 'cpu' && s.ctrl.type !== 'remote')) {
      L.slots.unshift({ name: settings.playerName || 'Player 1', ctrl: Input.isTouchDevice() && !matchMedia('(pointer: fine)').matches ? { type: 'touch' } : { type: 'kb1' }, bladeId: PRESETS[0].id, team: 0 });
    }
    if (a.bladeId) L.slots[0].bladeId = a.bladeId;
    this.fillCpus();
    if (a.next) {
      const order = this.arenaOrder();
      const i = order.findIndex((x) => x.id === L.arenaId);
      L.arenaId = order[(i + 1) % order.length].id;
    }
    this.build();
    if (a.autostart) this.el.style.visibility = 'hidden';
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.leave());
    this.nav.focus(1); // START
    this.unsub = hostRoom.subscribe(() => this.syncMembers());
    hostRoom.onCtl = (peer, m) => this.onRemoteCtl(peer, m);
    hostRoom.inMatch = false;
    this.syncMembers();
    if (a.online && !hostRoom.t) this.openRoom(getPlatform() && !cloudRelayUrl() ? 'lan' : 'cloud');
    if (a.autostart) setTimeout(() => { if (this.el.isConnected) { this.el.style.visibility = ''; this.start(); } }, 0);
  }

  setMode(id: ModeId, keepArena = false) {
    L.mode = id;
    const m = this.mode;
    L.target = m.target;
    L.time = m.time;
    const cur = allArenas().find((x) => x.id === L.arenaId);
    const ok = !!cur && this.fits(cur, id) && (m.arenas.includes(L.arenaId) || !!cur.custom);
    if (id === 'race' || L.sizeFilter === 'TRACK') L.sizeFilter = 'ALL';
    if (!keepArena || !ok) L.arenaId = m.arenas[0];
    if (L.slots.length > m.maxPlayers) L.slots = L.slots.filter((s, i) => i < m.maxPlayers || s.ctrl.type === 'remote');
    this.assignTeams();
  }

  fillCpus() {
    const m = this.mode;
    const names = ['Kai', 'Ryo', 'Mika', 'Zed', 'Nova', 'Juno', 'Rex', 'Ivy'];
    while (L.slots.length < Math.max(m.minPlayers, m.id === 'gauntlet' || m.id === 'quest' ? 1 : 2)) {
      const used = new Set(L.slots.map((s) => s.bladeId));
      const blade = PRESETS.find((b) => !used.has(b.id)) ?? PRESETS[L.slots.length % PRESETS.length];
      L.slots.push({ name: `CPU ${names[L.slots.length % names.length]}`, ctrl: { type: 'cpu', level: 2 }, bladeId: blade.id, team: L.slots.length });
    }
    this.assignTeams();
  }

  assignTeams(force = false) {
    const m = this.mode;
    L.slots.forEach((s, i) => {
      if (m.id === 'gauntlet' || m.id === 'quest') s.team = 0;
      else if (m.teams === 0 || m.id === 'duel') s.team = i;
      else if (force || s.team > 1) s.team = m.id === 'tag' ? (i < 2 ? 0 : 1) : i % 2;
    });
    if (m.teams === 2 && m.id !== 'duel' && !force) {
      // keep teams balanced-ish
      const c0 = L.slots.filter((s) => s.team === 0).length, c1 = L.slots.length - c0;
      if (Math.abs(c0 - c1) > 1) this.assignTeams(true);
    }
  }

  isTeamMode() { return L.mode === 'tag' || L.mode === 'ctf'; }
  slotColor(s: Slot, i: number) { return this.isTeamMode() ? TEAM_COLORS[s.team] : this.bladeOf(s).glow || TEAM_COLORS[i]; }
  bladeOf(s: Slot) { return s.blade ?? findBlade(s.bladeId); }

  build() {
    // keys: [prev key, next key, prev pad button, next pad button, PlayStation names] shown on the matching arrow
    const selector = (label: string, step: (d: number) => void, keys?: [string, string, string, string, string, string], dice?: { tip: string; roll: () => void }): Sel => {
      const val = h('b'), sub = h('span');
      const g = (i: number) => (keys ? { 'data-k': keys[i], 'data-p': keys[i + 2], 'data-ps': keys[i + 4] } : {});
      const el = h('div.selector.panel.nav', { 'data-navx': '1' },
        h('span.lbl', null, label),
        dice ? h('button.sel-dice', { title: dice.tip, onclick: (e: Event) => { e.stopPropagation(); dice.roll(); this.app.sfx.play('select'); } }, icon('dice')) : null,
        h('button.arrow', { onclick: (e: Event) => { e.stopPropagation(); step(-1); }, 'aria-label': 'previous', ...g(0) }, '◀'),
        h('div.val', null, val, sub),
        h('button.arrow', { onclick: (e: Event) => { e.stopPropagation(); step(1); }, 'aria-label': 'next', ...g(1) }, '▶'));
      el.addEventListener('navx', (e) => step((e as CustomEvent).detail));
      return { el, set: (t, s2) => { if (val.textContent !== t) val.textContent = t; if (sub.textContent !== s2) sub.textContent = s2; } };
    };
    const mode = selector('MODE', (d) => this.stepMode(d), ['Z', 'C', 'LT', 'RT', 'L2', 'R2'], { tip: 'Random mode and course', roll: () => this.randomize(true) });
    mode.el.dataset.trigger = 'mode';
    mode.el.classList.add('sel-mode');
    const size = selector('SIZE', (d) => this.stepSize(d));
    size.el.classList.add('sel-size');
    const arena = selector('ARENA', (d) => this.stepArena(d), ['Q', 'E', 'LB', 'RB', 'L1', 'R1'], { tip: 'Random course for this mode', roll: () => this.randomize(false) });
    arena.el.dataset.shoulder = 'arena';
    arena.el.classList.add('sel-arena');

    const stepper = (label: HTMLElement, val: HTMLElement, ch: (d: number) => void) => {
      const el = h('div.toggle.panel.nav.stepper', { 'data-navx': '1' }, label, h('button.arrow', { onclick: () => ch(-1), 'aria-label': 'less' }, '−'), val, h('button.arrow', { onclick: () => ch(1), 'aria-label': 'more' }, '+'));
      el.addEventListener('navx', (e) => ch((e as CustomEvent).detail));
      return el;
    };
    const targetLbl = h('span'), targetVal = h('b'), timeVal = h('b'), rubberVal = h('b');
    const target = stepper(targetLbl, targetVal, (d) => { L.target = Math.max(1, L.target + d * (L.mode === 'koth' ? 5 : 1)); this.refresh(); });
    const time = stepper(h('span', null, 'TIME'), timeVal, (d) => { L.time = Math.max(30, L.time + d * 15); this.refresh(); });
    const items = h('div.toggle.panel.nav', { onclick: () => this.toggleItems() }, h('span.dot'), 'ITEMS');
    const nudge = h('div.toggle.panel.nav', { title: 'Pinball: steering nudges the table — overdo it and it TILTs. Off: flippers only, like a classic table', onclick: () => { L.nudge = !L.nudge; this.refresh(); } }, h('span.dot'), 'NUDGE');
    const share = h('div.toggle.panel.nav', { title: 'King of the Hill: everyone in the zone banks time, even when it is contested. Off: only a top holding it alone scores', onclick: () => { L.kothShare = !L.kothShare; this.refresh(); } }, h('span.dot'), 'SHARED TIME');
    const rubber = h('div.toggle.panel.nav', { 'data-navx': '1', title: 'CPU catch-up: CPUs behind you get faster, CPUs far ahead ease off (like Mario Kart)', onclick: () => { L.rubber = (L.rubber + 1) % 3; this.refresh(); } }, 'CPU CATCH-UP ', rubberVal);
    rubber.addEventListener('navx', (e) => { L.rubber = (L.rubber + (e as CustomEvent).detail + 3) % 3; this.refresh(); });
    const back = h<HTMLButtonElement>('button.btn.small.nav.back-btn', { onclick: () => this.leave(), 'data-k': 'ESC', 'data-p': 'B', 'data-ps': '○' }, '◀ Back');
    const desc = h('div.screen-sub');
    this.ui = { back, desc, mode, size, arena, items, nudge, share, rubber, rubberVal, target, targetLbl, targetVal, timeVal };

    this.slotsEl = h('div.slots');
    const hint = Input.isTouchDevice() ? 'TAP + ADD CPU' : 'PRESS SPACE · ENTER · Ⓐ';
    this.joinCard = h('div.slot.join', null, h('div.big', null, '+'), hint, h('br'), 'TO JOIN');
    this.slotsEl.append(this.joinCard);

    this.onlineEl = h('div.online-box.panel');
    this.renderOnline();

    const el = h('div.screen.lobby', null,
      h('div.screen-head', null,
        back,
        h('div.screen-title', null, 'LOBBY'),
        desc,
        h('button.btn.primary.nav.start-btn', { onclick: () => this.start(), 'data-p': 'START', 'data-ps': 'OPTIONS' }, '▶ START')),
      h('div.lobby-top', null, mode.el, size.el, arena.el),
      this.slotsEl,
      h('div.lobby-bottom', null,
        h('div.rules', null,
          h('button.btn.small.nav', { onclick: () => this.addCpu() }, '+ CPU'),
          items, nudge, share, rubber, target, time),
        this.onlineEl),
    );
    this.el = el;
    this.refresh();
    return el;
  }

  /** push lobby state into the existing DOM — never rebuilds it */
  refresh() {
    if (!this.ui) return;
    const m = this.mode, u = this.ui;
    const order = this.arenaOrder();
    const arena = findArena(L.arenaId);
    const sz = arenaSize(arena);
    u.back.textContent = hostRoom.t ? '◀ Close Room' : '◀ Back';
    if (u.desc.textContent !== m.desc) u.desc.textContent = m.desc;
    u.mode.set(m.name.toUpperCase(), m.tag);
    u.size.set(L.sizeFilter === 'ALL' ? 'ALL' : SIZE_LABEL[L.sizeFilter], `${order.length} arena${order.length === 1 ? '' : 's'}`);
    u.arena.set(arena.name.toUpperCase(), `${SIZE_LABEL[sz]}${arena.custom ? ' · CUSTOM' : ''} · ${arena.desc}`);
    u.arena.el.style.setProperty('border-color', arena.theme.glow);
    const bk = `${arena.id}|${L.mode}`;
    if (bk !== this.lastBackdrop) { this.lastBackdrop = bk; setBackdropArena(arena, L.mode); }
    u.items.style.display = m.id !== 'gauntlet' && m.id !== 'rush' ? '' : 'none';
    u.items.classList.toggle('on', L.items);
    u.rubber.style.display = m.id === 'race' ? '' : 'none';
    u.nudge.style.display = m.id === 'pinball' ? '' : 'none';
    u.nudge.classList.toggle('on', L.nudge);
    u.share.style.display = m.id === 'koth' ? '' : 'none';
    u.share.classList.toggle('on', L.kothShare);
    u.rubberVal.textContent = ['OFF', 'NORMAL', 'STRONG'][L.rubber];
    u.target.style.display = m.target > 0 ? '' : 'none';
    u.targetLbl.textContent = m.id === 'koth' ? 'HOLD SECS' : m.id === 'gauntlet' ? 'GEMS' : m.id === 'race' ? 'LAPS' : 'TARGET';
    u.targetVal.textContent = String(L.target);
    u.timeVal.textContent = `${Math.floor(L.time / 60)}:${String(L.time % 60).padStart(2, '0')}`;
    this.renderSlots();
    this.dirty = true;
  }

  makeCard(): Card {
    const idx = () => Number(card.el.dataset.i);
    const remote = () => L.slots[idx()]?.ctrl.type === 'remote';
    const cv = h<HTMLCanvasElement>('canvas', { width: 200, height: 200 });
    const name = h<HTMLInputElement>('input.pname', { maxLength: 16 });
    name.addEventListener('change', () => {
      const i = idx(), s = L.slots[i];
      if (!s) return;
      s.name = name.value || `Player ${i + 1}`;
      if (i === 0 && s.ctrl.type !== 'cpu') { settings.playerName = s.name; settings.save(); }
      this.dirty = true;
    });
    const left = h('button.arrow', { onclick: () => { if (!remote()) this.cycleSlotBlade(idx(), -1); }, 'aria-label': 'previous blade' }, '◀');
    const right = h('button.arrow', { onclick: () => { if (!remote()) this.cycleSlotBlade(idx(), 1); }, 'aria-label': 'next blade' }, '▶');
    const bname = h('div.bname');
    const pick = h('div.bladepick.nav', { 'data-navx': '1' }, left, bname, right);
    pick.addEventListener('navx', (e) => { if (!remote()) this.cycleSlotBlade(idx(), (e as CustomEvent).detail); });
    const bars = STAT_KEYS.map((k) => {
      const info = STAT_INFO[k];
      const i = h('i', { style: { background: info.color } });
      const row = h('div.ss', null, h('b', null, info.short), h('span.ssbar', null, i));
      return { i, row };
    });
    const ctrl = h('div.ctrl.nav', { onclick: () => this.cycleCtrl(idx()) });
    const team = h('div.team-tag', { onclick: () => { const s = L.slots[idx()]; if (!s) return; s.team = 1 - s.team; this.renderSlots(); this.dirty = true; } });
    const pad = h('div.slot-pad', { html: '<i class="g stick">◀▶</i> blade <i class="g g-y">Y</i> random <span class="tm"><i class="g g-x">X</i> team</span> <i class="g g-b">B</i> leave' });
    const x = h('div.x', { onclick: () => this.removeSlot(idx()), title: 'Remove' }, icon('close'));
    const pnum = h('div.pnum');
    const el = h('div.slot', null, pnum, team, cv, name, pick, h('div.slot-stats', null, ...bars.map((b) => b.row)), ctrl, pad, x);
    const card: Card = { el, pnum, team, cv, name, bname, left, right, bars, ctrl, ctrlKey: '', pad, x, d: null };
    return card;
  }

  updateCard(c: Card, s: Slot, i: number) {
    const d = this.bladeOf(s);
    const remote = s.ctrl.type === 'remote';
    c.el.dataset.i = String(i);
    c.el.style.setProperty('--slot', this.slotColor(s, i));
    c.pnum.textContent = `P${i + 1}`;
    c.team.style.display = this.isTeamMode() ? '' : 'none';
    c.team.textContent = s.team === 0 ? 'RED' : 'BLUE';
    if (document.activeElement !== c.name && c.name.value !== s.name) c.name.value = s.name;
    c.name.disabled = remote;
    c.left.style.visibility = c.right.style.visibility = remote ? 'hidden' : '';
    if (c.d !== d) {
      c.d = d;
      c.bname.textContent = d.name;
      const st = computeStats(d);
      STAT_KEYS.forEach((k, j) => { c.bars[j].i.style.width = `${st.points[k] * 10}%`; c.bars[j].row.title = `${STAT_INFO[k].label} ${st.points[k]}/10 — ${STAT_INFO[k].desc}`; });
      drawBladeIcon(c.cv, d, this.angle);
    }
    const ck = remote ? 'remote' : specKey(s.ctrl) + specLabel(s.ctrl);
    if (c.ctrlKey !== ck) {
      c.ctrlKey = ck;
      c.ctrl.innerHTML = '';
      c.ctrl.append(icon(remote ? 'link' : s.ctrl.type === 'kb1' || s.ctrl.type === 'kb2' ? 'keyboard' : s.ctrl.type === 'mouse' ? 'mouse' : s.ctrl.type === 'touch' ? 'phone' : s.ctrl.type === 'cpu' ? 'gear' : 'gamepad'), ' ', remote ? 'ONLINE PLAYER' : specLabel(s.ctrl));
    }
    c.pad.style.display = this.isPersonalPad(i) ? '' : 'none';
    (c.pad.querySelector('.tm') as HTMLElement).style.display = this.isTeamMode() ? '' : 'none';
    c.x.style.display = L.slots.length > 1 ? '' : 'none';
  }

  cycleCtrl(i: number) {
    const s = L.slots[i];
    if (!s || s.ctrl.type === 'remote') return;
    const opts = this.controllerOptions(s.ctrl);
    const k = opts.findIndex((o) => specLabel(o) === specLabel(s.ctrl));
    s.ctrl = opts[(k + 1) % opts.length];
    if (s.ctrl.type === 'touch' && s.ctrl.gyro) this.app.input.enableGyro();
    if (s.ctrl.type === 'cpu' && !s.name.startsWith('CPU')) s.name = `CPU ${i + 1}`;
    if (s.ctrl.type !== 'cpu' && s.name.startsWith('CPU')) s.name = `Player ${i + 1}`;
    this.renderSlots();
    this.dirty = true;
  }

  /** arenas that make sense for a mode: races need a track, everything else needs an arena/course */
  fits(a: ArenaDef, mode = L.mode) {
    const quest = a.markers.some((m) => m.kind === 'goal');
    if (mode === 'pinball' || a.pinball) return mode === 'pinball' && !!a.pinball;
    return mode === 'race' ? !!a.track && !quest : mode === 'quest' ? quest : !a.track && !quest;
  }

  arenaOrder() {
    const m = this.mode;
    const arenas = allArenas().filter((a) => this.fits(a));
    let order = [...m.arenas.map((id) => arenas.find((a) => a.id === id)!).filter(Boolean), ...arenas.filter((a) => !m.arenas.includes(a.id))];
    if (L.sizeFilter !== 'ALL') order = order.filter((a) => arenaSize(a) === L.sizeFilter);
    if (!order.length) order = arenas.length ? arenas : [findArena(L.arenaId)];
    if (!order.some((a) => a.id === L.arenaId)) L.arenaId = order[0].id;
    return order;
  }

  stepMode(d: number) {
    const i = MODES.findIndex((x) => x.id === L.mode);
    this.setMode(MODES[(i + d + MODES.length) % MODES.length].id);
    this.fillCpus();
    this.rebuild();
  }

  stepArena(d: number) {
    const order = this.arenaOrder();
    const i = order.findIndex((a) => a.id === L.arenaId);
    L.arenaId = order[(i + d + order.length) % order.length].id;
    this.rebuild();
  }

  stepSize(d: number) {
    const sizes: ('ALL' | ArenaSize)[] = L.mode === 'race' ? ['ALL'] : ['ALL', 'S', 'M', 'L'];
    const i = Math.max(0, sizes.indexOf(L.sizeFilter));
    L.sizeFilter = sizes[(i + d + sizes.length) % sizes.length];
    const m = this.mode;
    const first = allArenas().find((a) => this.fits(a) && (L.sizeFilter === 'ALL' || arenaSize(a) === L.sizeFilter));
    if (first && L.sizeFilter !== 'ALL' && arenaSize(findArena(L.arenaId)) !== L.sizeFilter) L.arenaId = (m.arenas.map(findArena).find((a) => arenaSize(a) === L.sizeFilter) ?? first).id;
    this.rebuild();
  }

  /** dice: a random mode (and a course that suits it), or just a random course for the current mode */
  randomize(mode: boolean) {
    if (mode) {
      const pick = MODES.filter((m) => m.id !== L.mode)[Math.floor(Math.random() * (MODES.length - 1))];
      this.setMode(pick.id);
      this.fillCpus();
    }
    L.sizeFilter = 'ALL';
    const order = this.arenaOrder().filter((a) => a.id !== L.arenaId);
    if (order.length) L.arenaId = order[Math.floor(Math.random() * order.length)].id;
    this.refresh();
    this.app.toast(`${this.mode.name} · ${findArena(L.arenaId).name}`);
  }

  toggleItems() { L.items = !L.items; this.rebuild(); }

  /** a room member asked to change something (only honoured with Open Control) */
  onRemoteCtl(peer: number, m: any) {
    if (!hostRoom.openControl) return;
    const who = hostRoom.members.get(peer)?.name ?? 'Someone';
    const d = m.d === -1 ? -1 : 1;
    switch (m.a) {
      case 'mode': this.stepMode(d); break;
      case 'arena': this.stepArena(d); break;
      case 'size': this.stepSize(d); break;
      case 'items': this.toggleItems(); break;
      case 'song': { const s = m.song === null ? null : acceptSong(m.song); if (m.song !== null && !s) return; this.setRoomSong(s, who); return; }
      case 'start': this.app.toast(`${who} started the match`); this.start(); return;
      default: return;
    }
    this.app.toast(`${who} changed the room`);
  }

  /** online room music: everyone in the room hears it in the lobby and in matches */
  setRoomSong(s: Song | null, by: string) {
    L.song = s; L.songBy = s ? by : '';
    if (s) this.app.sfx.playSong(s, this.app.sfx.player?.song?.id !== s.id); else this.app.sfx.useMusic('menu');
    if (s) this.app.toast(`♪ ${s.name}${by ? ` — picked by ${by}` : ''}`);
    this.dirty = true;
    this.renderOnline();
  }

  /** mirror room membership into lobby slots */
  syncMembers() {
    if (!this.el) return;
    let changed = false;
    const mem = hostRoom.members;
    for (let i = L.slots.length - 1; i >= 0; i--) {
      const sl = L.slots[i];
      if (sl.ctrl.type === 'remote' && !mem.has(sl.ctrl.peer)) { this.app.toast(`${sl.name} left`); L.slots.splice(i, 1); changed = true; }
    }
    for (const m of mem.values()) {
      const sl = L.slots.find((x) => x.ctrl.type === 'remote' && x.ctrl.peer === m.peer);
      if (sl) {
        if (sl.name !== m.name || (m.blade && sl.blade?.id !== m.blade.id)) { sl.name = m.name; if (m.blade) sl.blade = m.blade; changed = true; }
        continue;
      }
      if (L.slots.length >= this.mode.maxPlayers) {
        const cpu = L.slots.findIndex((x) => x.ctrl.type === 'cpu');
        if (cpu < 0) continue; // room full for this mode: they watch from the room until a slot frees up
        L.slots.splice(cpu, 1);
      }
      L.slots.push({ name: m.name, ctrl: { type: 'remote', peer: m.peer }, bladeId: PRESETS[m.peer % PRESETS.length].id, blade: m.blade ?? undefined, team: L.slots.length % 2 });
      this.app.sfx.play('select');
      this.app.toast(`${m.name} joined the room`);
      changed = true;
    }
    if (changed) { this.fillCpus(); this.assignTeams(); this.renderSlots(); }
    this.dirty = true;
    if (this.onlineEl) this.renderOnline();
  }

  rebuild() { this.refresh(); }

  controllerOptions(current: ControllerSpec): ControllerSpec[] {
    const used = new Set(L.slots.map((s) => specKey(s.ctrl)));
    used.delete(specKey(current));
    const opts: ControllerSpec[] = [{ type: 'kb1' }, { type: 'kb2' }, { type: 'mouse' }];
    for (const i of this.app.input.connectedPads()) opts.push({ type: 'pad', index: i });
    if (Input.isTouchDevice()) opts.push({ type: 'touch' }, { type: 'touch', gyro: true });
    const free = opts.filter((o) => !used.has(specKey(o)) && !(o.type === 'mouse' && used.has('kb1')) && !(o.type === 'kb1' && used.has('mouse')));
    return [...free, { type: 'cpu', level: 1 }, { type: 'cpu', level: 2 }, { type: 'cpu', level: 3 }];
  }

  /** sync slot cards with L.slots: reuse cards, add/remove only at the end */
  renderSlots() {
    if (!this.slotsEl) return;
    while (this.cards.length < L.slots.length) { const c = this.makeCard(); this.cards.push(c); this.slotsEl.insertBefore(c.el, this.joinCard); }
    while (this.cards.length > L.slots.length) this.cards.pop()!.el.remove();
    L.slots.forEach((s, i) => this.updateCard(this.cards[i], s, i));
    this.joinCard.style.display = L.slots.length < this.mode.maxPlayers ? '' : 'none';
  }

  /** pads that joined as P2+ steer their own slot; P1's device (or keyboard) drives the menu */
  isPersonalPad(i: number) {
    const s = L.slots[i];
    return i > 0 && s?.ctrl.type === 'pad';
  }

  cycleSlotBlade(i: number, dir: number, random = false) {
    const s = L.slots[i];
    const blades = allBlades();
    const k = blades.findIndex((b) => b.id === s.bladeId);
    s.bladeId = random ? blades[Math.floor(Math.random() * blades.length)].id : blades[(k + dir + blades.length) % blades.length].id;
    s.blade = undefined;
    this.renderSlots();
    this.dirty = true;
    this.app.sfx.play('tick');
    this.flashSlot(i);
  }

  flashSlot(i: number) {
    const el = this.slotsEl.children[i] as HTMLElement | undefined;
    if (!el) return;
    el.classList.remove('slot-bump');
    void el.offsetWidth;
    el.classList.add('slot-bump');
  }

  /** each joined pad (P2+) changes its own blade / team or leaves, without touching the shared menu */
  personalPads(dt: number) {
    const inp = this.app.input;
    const mine = new Set<number>();
    L.slots.forEach((s, i) => {
      if (!this.isPersonalPad(i) || s.ctrl.type !== 'pad') return;
      const p = s.ctrl.index;
      mine.add(p);
      const now = inp.padNow[p] ?? [], prev = inp.padPrev[p] ?? [];
      const e = (b: number) => now[b] && !prev[b];
      const ax = inp.padAxes[p]?.[0] ?? 0;
      let cool = (this.padCool.get(p) ?? 0) - dt;
      let dir = e(15) ? 1 : e(14) ? -1 : 0;
      if (!dir && Math.abs(ax) > 0.6 && cool <= 0) { dir = Math.sign(ax); cool = 0.28; }
      if (Math.abs(ax) < 0.3) cool = 0;
      this.padCool.set(p, cool);
      if (dir) this.cycleSlotBlade(i, dir);
      else if (e(3)) this.cycleSlotBlade(i, 0, true);
      else if (e(2) && this.isTeamMode()) { s.team = 1 - s.team; this.renderSlots(); this.dirty = true; this.flashSlot(i); this.app.sfx.play('tick'); }
      else if (e(1)) { this.app.toast(`${s.name} left`); this.removeSlot(i); this.fillCpus(); this.renderSlots(); }
      else if (e(9)) this.start();
    });
    // those pads don't also move the shared menu
    this.nav.ignorePads = mine;
  }

  removeSlot(i: number) {
    const s = L.slots[i];
    if (s.ctrl.type === 'remote') hostRoom.t?.kick(s.ctrl.peer);
    L.slots.splice(i, 1);
    this.assignTeams();
    this.renderSlots();
    this.dirty = true;
  }

  addCpu() {
    if (L.slots.length >= this.mode.maxPlayers) { this.app.toast('Lobby full for this mode'); return; }
    const blade = PRESETS[(L.slots.length * 3) % PRESETS.length];
    L.slots.push({ name: `CPU ${L.slots.length + 1}`, ctrl: { type: 'cpu', level: 2 }, bladeId: blade.id, team: L.slots.length % 2 });
    this.assignTeams();
    this.renderSlots();
    this.dirty = true;
    this.app.sfx.play('select');
  }

  join(spec: ControllerSpec) {
    const key = specKey(spec);
    if (L.slots.some((s) => specKey(s.ctrl) === key)) return false;
    // replace a CPU if full
    const m = this.mode;
    let idx = L.slots.length;
    if (L.slots.length >= m.maxPlayers) {
      idx = L.slots.findIndex((s) => s.ctrl.type === 'cpu');
      if (idx < 0) return false;
    } else {
      const cpu = L.slots.findIndex((s) => s.ctrl.type === 'cpu');
      if (cpu >= 0 && L.slots.length >= m.minPlayers) idx = cpu;
    }
    const blades = allBlades();
    const slot: Slot = { name: spec.type === 'pad' ? `Pad ${spec.index + 1}` : `Player ${idx + 1}`, ctrl: spec, bladeId: blades[(idx * 2 + 1) % blades.length].id, team: idx % 2 };
    if (idx < L.slots.length) L.slots[idx] = { ...slot, bladeId: L.slots[idx].bladeId, team: L.slots[idx].team };
    else L.slots.push(slot);
    this.assignTeams();
    this.renderSlots();
    this.dirty = true;
    this.app.sfx.play('select');
    this.app.toast(`${specLabel(spec)} joined as P${idx + 1}`);
    return true;
  }

  // -------------------------------------------------------------- online host
  renderOnline() {
    const el = this.onlineEl;
    if (this.ui) this.ui.back.textContent = hostRoom.t ? '◀ Close Room' : '◀ Back';
    // typing a room name: redraw once they're done instead of wiping the field mid-word
    const typing = el.querySelector<HTMLInputElement>('.room-name');
    if (typing && document.activeElement === typing) { typing.addEventListener('blur', () => this.renderOnline(), { once: true }); return; }
    el.innerHTML = '';
    if (hostRoom.t) {
      const t = hostRoom.t;
      const ctl = h('div.toggle.panel.nav', { onclick: () => { hostRoom.openControl = !hostRoom.openControl; this.dirty = true; this.app.toast(hostRoom.openControl ? 'OPEN CONTROL on — everyone in the room can change mode / arena and start' : 'Open Control off — only you can change the room'); this.renderOnline(); }, title: 'Let everyone in the room change mode / arena and start matches' }, h('span.dot'), 'OPEN CONTROL');
      ctl.classList.toggle('on', hostRoom.openControl);
      ctl.addEventListener('click', () => this.pushSummary());
      const info = hostRoom.info;
      const rname = h<HTMLInputElement>('input.room-name', { type: 'text', value: info.name, maxLength: 32, placeholder: `${L.slots[0]?.name ?? 'Host'}'s room` });
      rname.addEventListener('change', () => { hostRoom.setInfo({ name: rname.value.trim() }); this.pushSummary(); this.dirty = true; this.app.toast(`Room renamed to ${rname.value.trim() || rname.placeholder}`); });
      rname.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') rname.blur(); });
      const pub = h('div.toggle.panel.nav', { title: t.listable ? 'List this room in Public Rooms' : 'Desktop LAN / tunnel rooms can\'t be listed — host a Cloud room to go public', onclick: () => { if (!t.listable) { this.app.toast('Host a Cloud room to list it publicly'); return; } hostRoom.setInfo({ public: !info.public }); this.app.toast(hostRoom.info.public ? 'Room is now PUBLIC — listed for everyone' : 'Room is now private (invite only)'); this.pushSummary(); this.renderOnline(); } }, h('span.dot'), 'PUBLIC');
      pub.classList.toggle('on', info.public);
      const keep = info.persistent
        ? h('div.hint', { style: { color: 'var(--gold)' } }, icon('lock'), ' SAVED ROOM — same code every time')
        : h('button.btn.small.nav', { title: 'Save to My Rooms: reopen later with this same code and invite link', onclick: () => {
            saveMyRoom({ code: t.code, key: newOwnerKey(), name: info.name || `${L.slots[0]?.name ?? 'My'}'s room`, public: info.public, openControl: hostRoom.openControl, mode: L.mode, arenaId: L.arenaId, lastUsed: Date.now() });
            hostRoom.setInfo({ persistent: true });
            this.app.toast(`Saved to My Rooms — ${t.code} is yours next time you open it`);
            this.renderOnline();
          } }, 'KEEP ROOM');
      el.append(
        h('div.hint', null, `${t.kind === 'relay-tunnel' ? 'TUNNEL ROOM' : t.kind === 'relay-cloud' ? 'CLOUD ROOM' : 'LAN ROOM'} · ${hostRoom.members.size + 1} in room · everyone follows the leader`),
        h('label.room-name-lbl', null, 'ROOM NAME — type to rename'),
        rname,
        h('div.code', null, t.code),
        ...t.invites.slice(1).map((u) => h('div.url', { onclick: () => { navigator.clipboard?.writeText(u); this.app.toast('Invite link copied'); }, title: 'Click to copy' }, icon('link'), ' ', u)),
        roomMusicRow(this.app, { song: L.song, by: L.songBy, canSet: true, onSet: (s) => this.setRoomSong(s, L.slots[0]?.name ?? 'Host'), onCopied: () => this.renderOnline() }),
        h('div.row', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } }, pub, ctl, keep,
          h('button.btn.small.nav', { onclick: () => { if (!confirmTwice(this.app, 'close-room', 'Press again to close the room for everyone')) return; hostRoom.close(); L.slots = L.slots.filter((x) => x.ctrl.type !== 'remote'); this.fillCpus(); this.renderSlots(); this.renderOnline(); } }, 'Close Room')),
      );
      return;
    }
    const p = getPlatform();
    el.append(
      h('div.hint', null, 'INVITE ONLINE FRIENDS'),
      h('div.row', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        h('button.btn.small.nav', { onclick: () => this.openRoom('lan'), title: p ? 'Direct connection on your network' : 'Same-origin relay' }, 'LAN'),
        p ? h('button.btn.small.nav', { onclick: () => this.openRoom('tunnel') }, 'Public Link') : null,
        h('button.btn.small.nav', { onclick: () => this.openRoom('cloud') }, 'Cloud')),
    );
  }

  async openRoom(kind: 'lan' | 'tunnel' | 'cloud') {
    const el = this.onlineEl;
    const name = L.slots[0]?.name ?? 'host';
    const o = this.roomOpts;
    const hostOpts = o.code && o.key ? { code: o.code, key: o.key } : {};
    el.innerHTML = '';
    el.append(h('div.hint', null, `Opening ${o.name || (kind === 'tunnel' ? 'Cloudflare tunnel' : kind === 'cloud' ? 'cloud room' : 'LAN room')}…`));
    try {
      const t = await (kind === 'cloud' ? hostCloud(name, hostOpts) : hostLocal(name, kind === 'tunnel', hostOpts));
      hostRoom.open(t, { name: o.name, public: o.public && t.listable, persistent: o.persistent });
      hostRoom.openControl = !!o.openControl;
      this.pushSummary();
      this.app.toast(`${o.name || 'Room'} ${t.code} open${hostRoom.info.public ? ' · listed in Public Rooms' : ''} — share the code!`);
    } catch (e) {
      const msg = String((e as Error).message || e);
      this.app.toast(msg === 'room already hosted' ? `${o.code ?? 'This room'} is already open (another tab or device?) — join it from ONLINE instead` : msg);
    }
    this.renderOnline();
  }

  /** keep the public listing / saved room in step with the lobby */
  pushSummary() {
    if (!hostRoom.t) return;
    const m = this.mode;
    const players = L.slots.filter((s) => s.ctrl.type !== 'cpu').length;
    hostRoom.setSummary({ host: L.slots[0]?.name ?? 'Host', mode: L.mode, modeName: m.name, arena: findArena(L.arenaId).name, players, max: m.maxPlayers });
    if (hostRoom.info.persistent) {
      const saved = findMyRoom(hostRoom.t.code);
      if (saved) saveMyRoom({ ...saved, name: hostRoom.info.name || saved.name, public: hostRoom.info.public, openControl: hostRoom.openControl, mode: L.mode, arenaId: L.arenaId, lastUsed: Date.now() });
    }
  }

  lobbySnapshot() {
    const arena = findArena(L.arenaId);
    return {
      t: 'lobby', roomName: hostRoom.info.name, public: hostRoom.info.public, mode: L.mode, arena: arena.name, arenaId: arena.id, arenaDef: arena.custom ? arena : undefined, arenaDesc: arena.desc, size: SIZE_LABEL[arenaSize(arena)], sizeFilter: L.sizeFilter === 'ALL' ? 'ALL' : SIZE_LABEL[L.sizeFilter],
      items: L.items, target: L.target, time: L.time, control: hostRoom.openControl ? 'all' : 'host', leader: L.slots[0]?.name ?? 'Host', song: L.song, songBy: L.songBy,
      slots: L.slots.map((s, i) => ({ name: s.name, ctrl: s.ctrl.type === 'remote' ? `online:${s.ctrl.peer}` : specLabel(s.ctrl), blade: this.bladeOf(s), team: s.team, color: this.slotColor(s, i) })),
    };
  }

  // -------------------------------------------------------------- start / leave
  start() {
    const m = this.mode;
    this.fillCpus();
    if (L.slots.length < m.minPlayers) { this.app.toast(`${m.name} needs ${m.minPlayers} players`); return; }
    this.assignTeams();
    const cfg: MatchConfig = {
      mode: L.mode, arena: findArena(L.arenaId), items: L.items || L.mode === 'rush', target: L.target, timeLimit: L.time, seed: (Math.random() * 1e9) | 0, rubber: L.rubber, nudge: L.nudge, kothShare: L.kothShare,
      players: L.slots.slice(0, m.maxPlayers).map((s, i) => ({ slot: i, name: s.name, team: s.team, blade: this.bladeOf(s), ctrl: s.ctrl })),
      song: hostRoom.t && L.song ? L.song : undefined,
    };
    // compact team indices (ffa etc.)
    const teams = [...new Set(cfg.players.map((p) => p.team))].sort((a, b) => a - b);
    cfg.players.forEach((p) => (p.team = teams.indexOf(p.team)));
    this.app.sfx.play('go');
    const arg: MatchArg = { cfg };
    if (hostRoom.t) {
      const peerSlot = new Map<number, number>();
      cfg.players.forEach((p, i) => { if (p.ctrl.type === 'remote') peerSlot.set(p.ctrl.peer, i); });
      // everyone in the room follows: players get their slots, extra members spectate
      for (const peer of hostRoom.members.keys()) hostRoom.send(peer, { t: 'start', cfg, mine: peerSlot.has(peer) ? [peerSlot.get(peer)] : [] });
      hostRoom.inMatch = true;
      arg.host = { t: hostRoom.t, peerSlot };
    }
    this.app.go('match', arg);
  }

  leave() {
    if (testRide.from && !hostRoom.t) { this.app.go(testRide.from); return; } // test ride: back to the editor
    if (hostRoom.t) {
      if (!confirmTwice(this.app, 'close-room', `Room ${hostRoom.t.code} is open — press again to CLOSE it for everyone`)) return;
      hostRoom.close();
      L.slots = L.slots.filter((s) => s.ctrl.type !== 'remote');
    }
    this.app.go('menu');
  }

  update(dt: number) {
    for (const spec of this.app.input.joinPresses()) {
      const joined = this.join(spec);
      if (joined) return; // swallow the confirm press
    }
    this.personalPads(dt);
    this.nav.update(dt);
    this.angle += dt * 2.5;
    this.iconT += dt;
    if (this.iconT > 0.05) { this.iconT = 0; for (const c of this.cards) if (c.d) drawBladeIcon(c.cv, c.d, this.angle * c.d.spinDir); }
    if (hostRoom.t) {
      this.broadcastT -= dt;
      if (this.dirty && this.broadcastT <= 0) {
        hostRoom.send('all', this.lobbySnapshot());
        this.pushSummary();
        this.dirty = false;
        this.broadcastT = 0.25;
      }
    }
  }

  unmount() {
    this.unsub?.();
    hostRoom.onCtl = null;
    this.el.remove();
  }
}
