// Local + online-host lobby: press-to-join slots, blades, teams, arena, rules, invite codes.
import { h, MenuNav, type App, type Screen } from './app';
import { allBlades, findBlade, PRESETS, type BladeDesign } from '../core/blade';
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

interface Slot { name: string; ctrl: ControllerSpec; bladeId: string; team: number; blade?: BladeDesign }

const L = {
  mode: 'duel' as ModeId,
  arenaId: 'neon-stadium',
  items: true,
  sizeFilter: 'ALL' as 'ALL' | ArenaSize,
  target: 4,
  time: 90,
  slots: [] as Slot[],
};


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
  icons: { cv: HTMLCanvasElement; d: BladeDesign }[] = [];
  angle = 0;
  onlineEl!: HTMLElement;
  peerSlot = new Map<number, number>();
  broadcastT = 0;
  dirty = true;
  unsub: (() => void) | null = null;

  get mode() { return MODES.find((m) => m.id === L.mode)!; }

  mount(app: App, arg?: unknown) {
    this.app = app;
    setBackdropVisible(true, app.canvas);
    const a = (arg ?? {}) as { mode?: ModeId; bladeId?: string; arenaId?: string; keep?: boolean; online?: boolean };
    if (a.mode && a.mode !== L.mode) this.setMode(a.mode);
    else if (a.mode) this.setMode(a.mode, true);
    if (a.arenaId) L.arenaId = a.arenaId;
    if (!L.slots.some((s) => s.ctrl.type !== 'cpu' && s.ctrl.type !== 'remote')) {
      L.slots.unshift({ name: settings.playerName || 'Player 1', ctrl: Input.isTouchDevice() && !matchMedia('(pointer: fine)').matches ? { type: 'touch' } : { type: 'kb1' }, bladeId: PRESETS[0].id, team: 0 });
    }
    if (a.bladeId) L.slots[0].bladeId = a.bladeId;
    this.fillCpus();
    this.el = this.build();
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.leave());
    this.nav.focus(1); // START
    this.unsub = hostRoom.subscribe(() => this.syncMembers());
    hostRoom.onCtl = (peer, m) => this.onRemoteCtl(peer, m);
    hostRoom.inMatch = false;
    this.syncMembers();
    if (a.online && !hostRoom.t) this.openRoom(getPlatform() && !cloudRelayUrl() ? 'lan' : 'cloud');
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
    while (L.slots.length < Math.max(m.minPlayers, m.id === 'gauntlet' ? 1 : 2)) {
      const used = new Set(L.slots.map((s) => s.bladeId));
      const blade = PRESETS.find((b) => !used.has(b.id)) ?? PRESETS[L.slots.length % PRESETS.length];
      L.slots.push({ name: `CPU ${names[L.slots.length % names.length]}`, ctrl: { type: 'cpu', level: 2 }, bladeId: blade.id, team: L.slots.length });
    }
    this.assignTeams();
  }

  assignTeams(force = false) {
    const m = this.mode;
    L.slots.forEach((s, i) => {
      if (m.id === 'gauntlet') s.team = 0;
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
    const m = this.mode;
    const arenas = allArenas();
    const arena = findArena(L.arenaId);
    const selector = (label: string, title: string, sub: string, step: (d: number) => void) => {
      const el = h('div.selector.panel.nav', { 'data-navx': '1' },
        h('span.lbl', null, label),
        h('button.arrow', { onclick: (e: Event) => { e.stopPropagation(); step(-1); } }, '◀'),
        h('div.val', null, h('b', null, title), h('span', null, sub)),
        h('button.arrow', { onclick: (e: Event) => { e.stopPropagation(); step(1); } }, '▶'));
      el.addEventListener('navx', (e) => step((e as CustomEvent).detail));
      return el;
    };
    const modeSel = selector('MODE', m.name.toUpperCase(), m.tag, (d) => this.stepMode(d));
    const order = this.arenaOrder();
    setBackdropArena(findArena(L.arenaId), L.mode);
    const sz = arenaSize(arena);
    const arenaSel = selector('ARENA', arena.name.toUpperCase(), `${SIZE_LABEL[sz]}${arena.custom ? ' · CUSTOM' : ''} · ${arena.desc}`, (d) => this.stepArena(d));
    arenaSel.style.flex = '1';
    const sizeSel = selector('SIZE', L.sizeFilter === 'ALL' ? 'ALL' : SIZE_LABEL[L.sizeFilter], `${order.length} arena${order.length === 1 ? '' : 's'}`, (d) => this.stepSize(d));
    sizeSel.style.minWidth = '200px';
    arenaSel.style.setProperty('border-color', arena.theme.glow);

    this.slotsEl = h('div.slots');
    this.renderSlots();

    const num = (label: string, get: () => number, set: (v: number) => void, step: number, min: number, fmt = (v: number) => String(v)) => {
      const val = h('b', null, fmt(get()));
      const el = h('div.toggle.panel.nav', { 'data-navx': '1' }, label, ' ', h('button.arrow', { onclick: () => ch(-1), style: { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer' } }, '−'), val, h('button.arrow', { onclick: () => ch(1), style: { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer' } }, '+'));
      const ch = (d: number) => { set(Math.max(min, get() + d * step)); val.textContent = fmt(get()); this.dirty = true; };
      el.addEventListener('navx', (e) => ch((e as CustomEvent).detail));
      return el;
    };
    const items = h('div.toggle.panel.nav', { onclick: () => this.toggleItems() }, h('span.dot'), 'ITEMS');
    items.classList.toggle('on', L.items);

    this.onlineEl = h('div.online-box.panel');
    this.renderOnline();

    return h('div.screen', null,
      h('div.screen-head', null,
        h('button.btn.small.nav', { onclick: () => this.leave() }, '◀ Back'),
        h('div.screen-title', null, 'LOBBY'),
        h('div.screen-sub', null, m.desc),
        h('div.spacer'),
        h('button.btn.primary.nav', { onclick: () => this.start() }, '▶ START')),
      h('div.lobby-top', null, modeSel, sizeSel, arenaSel),
      this.slotsEl,
      h('div.lobby-bottom', null,
        h('button.btn.small.nav', { onclick: () => this.addCpu() }, '+ Add CPU'),
        m.id !== 'gauntlet' && m.id !== 'rush' ? items : null,
        m.target > 0 ? num(m.id === 'koth' ? 'HOLD SECS' : m.id === 'gauntlet' ? 'GEMS' : 'TARGET', () => L.target, (v) => (L.target = v), m.id === 'koth' ? 5 : 1, 1) : null,
        num('TIME', () => L.time, (v) => (L.time = v), 15, 30, (v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`),
        h('div.spacer'),
        this.onlineEl),
    );
  }

  /** arenas that make sense for a mode: races need a track, everything else needs an arena/course */
  fits(a: ArenaDef, mode = L.mode) { return mode === 'race' ? !!a.track : !a.track; }

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
      case 'start': this.app.toast(`${who} started the match`); this.start(); return;
      default: return;
    }
    this.app.toast(`${who} changed the room`);
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

  rebuild() {
    const focus = this.nav?.idx ?? 0;
    this.el.remove();
    this.el = this.build();
    this.app.root.append(this.el);
    this.nav = new MenuNav(this.app, this.el, () => this.leave());
    this.nav.focus(focus);
    this.dirty = true;
  }

  controllerOptions(current: ControllerSpec): ControllerSpec[] {
    const used = new Set(L.slots.map((s) => specKey(s.ctrl)));
    used.delete(specKey(current));
    const opts: ControllerSpec[] = [{ type: 'kb1' }, { type: 'kb2' }, { type: 'mouse' }];
    for (const i of this.app.input.connectedPads()) opts.push({ type: 'pad', index: i });
    if (Input.isTouchDevice()) opts.push({ type: 'touch' }, { type: 'touch', gyro: true });
    const free = opts.filter((o) => !used.has(specKey(o)) && !(o.type === 'mouse' && used.has('kb1')) && !(o.type === 'kb1' && used.has('mouse')));
    return [...free, { type: 'cpu', level: 1 }, { type: 'cpu', level: 2 }, { type: 'cpu', level: 3 }];
  }

  renderSlots() {
    this.slotsEl.innerHTML = '';
    this.icons = [];
    const m = this.mode;
    const blades = allBlades();
    L.slots.forEach((s, i) => {
      const d = this.bladeOf(s);
      const cv = h<HTMLCanvasElement>('canvas', { width: 240, height: 240 });
      this.icons.push({ cv, d });
      const remote = s.ctrl.type === 'remote';
      const cycleBlade = (dir: number) => {
        if (remote) return;
        const k = blades.findIndex((b) => b.id === s.bladeId);
        s.bladeId = blades[(k + dir + blades.length) % blades.length].id;
        this.renderSlots();
        this.dirty = true;
        this.app.sfx.play('tick');
      };
      const bladeRow = h('div.row.nav', { 'data-navx': '1' },
        h('button.selector.arrow', { onclick: () => cycleBlade(-1), style: { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '18px' } }, '◀'),
        h('div.bname', null, d.name),
        h('button.selector.arrow', { onclick: () => cycleBlade(1), style: { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '18px' } }, '▶'));
      bladeRow.addEventListener('navx', (e) => cycleBlade((e as CustomEvent).detail));
      const ctrl = h('div.ctrl.nav', {
        onclick: () => {
          if (remote) return;
          const opts = this.controllerOptions(s.ctrl);
          const k = opts.findIndex((o) => specLabel(o) === specLabel(s.ctrl));
          s.ctrl = opts[(k + 1) % opts.length];
          if (s.ctrl.type === 'touch' && s.ctrl.gyro) this.app.input.enableGyro();
          if (s.ctrl.type === 'cpu' && !s.name.startsWith('CPU')) s.name = `CPU ${i + 1}`;
          if (s.ctrl.type !== 'cpu' && s.name.startsWith('CPU')) s.name = `Player ${i + 1}`;
          this.renderSlots();
          this.dirty = true;
        },
      }, icon(remote ? 'link' : s.ctrl.type === 'kb1' || s.ctrl.type === 'kb2' ? 'keyboard' : s.ctrl.type === 'mouse' ? 'mouse' : s.ctrl.type === 'touch' ? 'phone' : s.ctrl.type === 'cpu' ? 'gear' : 'gamepad'), ' ', remote ? 'ONLINE PLAYER' : specLabel(s.ctrl));
      const name = h<HTMLInputElement>('input.pname', { value: s.name, maxLength: 16, disabled: remote });
      name.addEventListener('change', () => { s.name = name.value || `Player ${i + 1}`; if (i === 0 && s.ctrl.type !== 'cpu') { settings.playerName = s.name; settings.save(); } this.dirty = true; });
      const card = h('div.slot', null,
        h('div.pnum', null, `P${i + 1}`),
        this.isTeamMode() ? h('div.team-tag', { onclick: () => { s.team = 1 - s.team; this.renderSlots(); this.dirty = true; } }, s.team === 0 ? 'RED' : 'BLUE') : null,
        cv, name, bladeRow, ctrl,
        L.slots.length > 1 ? h('div.x', { onclick: () => this.removeSlot(i), title: 'Remove' }, icon('close')) : null);
      card.style.setProperty('--slot', this.slotColor(s, i));
      card.style.animationDelay = `${i * 0.04}s`;
      this.slotsEl.append(card);
    });
    if (L.slots.length < m.maxPlayers) {
      const hint = Input.isTouchDevice() ? 'TAP + ADD CPU OR' : 'PRESS';
      this.slotsEl.append(h('div.slot.join', null, h('div.big', null, '+'), `${hint} SPACE · ENTER · Ⓐ`, h('br'), 'TO JOIN'));
    }
    for (const ic of this.icons) drawBladeIcon(ic.cv, ic.d, this.angle);
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
    el.innerHTML = '';
    if (hostRoom.t) {
      const t = hostRoom.t;
      const ctl = h('div.toggle.panel.nav', { onclick: () => { hostRoom.openControl = !hostRoom.openControl; this.dirty = true; this.renderOnline(); }, title: 'Let everyone in the room change mode / arena and start matches' }, h('span.dot'), 'OPEN CONTROL');
      ctl.classList.toggle('on', hostRoom.openControl);
      el.append(
        h('div.hint', null, `${t.kind === 'relay-tunnel' ? 'PUBLIC ROOM' : t.kind === 'relay-cloud' ? 'CLOUD ROOM' : 'LAN ROOM'} · ${hostRoom.members.size + 1} in room · everyone follows the leader`),
        h('div.code', null, t.code),
        ...t.invites.slice(1).map((u) => h('div.url', { onclick: () => { navigator.clipboard?.writeText(u); this.app.toast('Invite link copied'); }, title: 'Click to copy' }, icon('link'), ' ', u)),
        h('div.row', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, ctl,
          h('button.btn.small.nav', { onclick: () => { hostRoom.close(); L.slots = L.slots.filter((x) => x.ctrl.type !== 'remote'); this.fillCpus(); this.renderSlots(); this.renderOnline(); } }, 'Close Room')),
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
    el.innerHTML = '';
    el.append(h('div.hint', null, `Opening ${kind === 'tunnel' ? 'Cloudflare tunnel' : kind === 'cloud' ? 'cloud room' : 'LAN room'}…`));
    try {
      const t = await (kind === 'cloud' ? hostCloud(name) : hostLocal(name, kind === 'tunnel'));
      hostRoom.open(t);
      this.app.toast(`Room ${t.code} open — share the code!`);
    } catch (e) {
      this.app.toast(String((e as Error).message || e));
    }
    this.renderOnline();
  }

  lobbySnapshot() {
    const arena = findArena(L.arenaId);
    return {
      t: 'lobby', mode: L.mode, arena: arena.name, arenaId: arena.id, arenaDef: arena.custom ? arena : undefined, arenaDesc: arena.desc, size: SIZE_LABEL[arenaSize(arena)], sizeFilter: L.sizeFilter === 'ALL' ? 'ALL' : SIZE_LABEL[L.sizeFilter],
      items: L.items, target: L.target, time: L.time, control: hostRoom.openControl ? 'all' : 'host', leader: L.slots[0]?.name ?? 'Host',
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
      mode: L.mode, arena: findArena(L.arenaId), items: L.items || L.mode === 'rush', target: L.target, timeLimit: L.time, seed: (Math.random() * 1e9) | 0,
      players: L.slots.slice(0, m.maxPlayers).map((s, i) => ({ slot: i, name: s.name, team: s.team, blade: this.bladeOf(s), ctrl: s.ctrl })),
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
    if (hostRoom.t) { hostRoom.close(); L.slots = L.slots.filter((s) => s.ctrl.type !== 'remote'); }
    this.app.go('menu');
  }

  update(dt: number) {
    for (const spec of this.app.input.joinPresses()) {
      const joined = this.join(spec);
      if (joined) return; // swallow the confirm press
    }
    this.nav.update(dt);
    this.angle += dt * 2.5;
    for (const ic of this.icons) drawBladeIcon(ic.cv, ic.d, this.angle * (ic.d.spinDir));
    if (hostRoom.t) {
      this.broadcastT -= dt;
      if (this.dirty && this.broadcastT <= 0) {
        hostRoom.send('all', this.lobbySnapshot());
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
