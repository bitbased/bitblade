// Local + online-host lobby: player slots (+ PLAYER: press any device to join · + CPU), blades, teams, arena, rules,
// invite codes. A player's input only changes on their card's input selector (or when they join).
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { glyph } from './nav';
import { allBlades, computeStats, findBlade, PRESETS, STAT_INFO, STAT_KEYS, type BladeDesign } from '../core/blade';
import { ringPoints } from '../core/bladeMesh';
import { allArenas, arenaSize, findArena, SIZE_LABEL, type ArenaDef, type ArenaSize } from '../game/terrain';
import { MODES, PICK_MODES, type ControllerSpec, type MatchConfig, type ModeId } from '../game/types';
import { Input, specKey, specLabel } from '../input/input';
import { cloudRelayUrl, hostCloud, hostLocal, publicJoinInput } from '../net/transport';
import { parseJoinInput } from '../net/relay';
import { getPlatform } from '../net/platform';
import { TEAM_COLORS } from './hud';
import { setBackdropVisible, setBackdropArena } from './backdrop';
import { settings } from '../core/settings';
import { icon, drawIcon } from './icons';
import type { MatchArg } from './match';
import { clientRoom, hostRoom } from '../net/room';
import { testRide } from './testRide';
import { findMyRoom, newOwnerKey, saveMyRoom } from '../net/myRooms';
import { acceptSong, armRadio, onRoomSong, RADIO_HOST, roomMusicRow, roomRadio, roomSongHost } from './roomMusic';
import { queue } from '../net/queue';
import { party, setHomePartyCode, type RoomOpts } from '../net/party';
import { joinParty, leaveLabel, leaveRoom, savePartyPrefs } from './partyFlow';
import { clean } from '../core/textFilter';
import { MATCH_ARRIVE, MATCH_COUNTDOWN, pendingMatch, travel } from './quickMatch';
import type { QueueMatch } from '../net/queue';
import type { Song } from '../game/music';

/** auto: a ghost CPU — a place the mode needs filled; it plays as a CPU unless a player takes it (+ PLAYER) or it's
 *  locked in as a CPU (+ CPU, or its difficulty is changed) */
interface Slot { name: string; ctrl: ControllerSpec; bladeId: string; team: number; blade?: BladeDesign; auto?: boolean; teamLock?: boolean; teamPicks?: number;
  /** a guest's view of the room: the host's label for the slot, and whether it's this guest's own */
  label?: string; mine?: boolean;
  /** the party a player came with (online guests: their party code) — parties stay on one team */
  party?: string }

interface Card {
  el: HTMLElement; pnum: HTMLElement; team: HTMLElement; cv: HTMLCanvasElement; name: HTMLInputElement; bname: HTMLElement;
  left: HTMLElement; right: HTMLElement; bars: { i: HTMLElement; row: HTMLElement }[]; ctrl: HTMLElement; ctrlKey: string; pad: HTMLElement; x: HTMLElement; d: BladeDesign | null;
}
interface Sel { el: HTMLElement; set(title: string, sub: string): void }
interface LobbyUI {
  back: HTMLButtonElement; desc: HTMLElement; mode: Sel; size: Sel; arena: Sel;
  items: HTMLElement; nudge: HTMLElement; share: HTMLElement; split: HTMLElement; rubber: HTMLElement; rubberVal: HTMLElement; target: HTMLElement; targetLbl: HTMLElement; targetVal: HTMLElement; timeVal: HTMLElement; count: HTMLElement; countVal: HTMLElement;
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
  kothShare: true,
  /** team games: parties stay together on a team, or MIXED — everyone shuffled across the teams */
  teamSplit: 'parties' as 'parties' | 'mixed',
  /** MIXED: the shuffle (a new one each time it's switched on) */
  mixSeed: 1,
  /** RANDOM: a new mode and course every match (and QUICK MATCH takes any mode) */
  random: false,
  target: 4,
  time: 90,
  /** how many places the lobby has: players + CPUs, with ghost CPUs filling the rest (0 = the mode's minimum) */
  count: 0,
  slots: [] as Slot[],
  /** set once the lobby has been visited: the menu offers CONTINUE back into it */
  active: false,
  /** online room music (null = each track's own song) and who picked it */
  song: null as Song | null,
  songBy: '',
  /** whose radio picked the room song (RADIO_HOST, a guest's room id) — null: picked by hand */
  radioBy: null as number | null,
};

/** a member the leader promoted: they take the party over when the leader steps down */
let promoted: number | null = null;

/** you lead a party with friends in it (not just yourself) */
export function leadsParty() {
  const t = hostRoom.t;
  return !!t && !hostRoom.matchOpen && [...hostRoom.members.values()].some((m) => m.party === t.code);
}
/** the party the people on this device belong to (hosting a match room: the party you came from) */
function myPartyCode() { return hostRoom.matchOpen ? party.home?.code ?? '' : hostRoom.t?.code ?? ''; }

/** your party's lobby, put aside while you host a quick match's room (back as it was when you go home) */
let partyLobby: string | null = null;

/**
 * QUICK MATCH, we open the match's room: our members are sent there, our party room closes, and this device's lobby
 * becomes the match room — our players (not our CPUs), everyone can drive, it starts by itself. Leaving it takes
 * everyone home: the party reopens as it was.
 */
export function hostMatch(app: App, m: QueueMatch) {
  const t = hostRoom.t;
  if (t && !hostRoom.matchOpen) {
    party.home = { code: t.code, leader: true, opts: currentRoomOpts() };
    hostRoom.send('all', { t: 'travel', code: m.code, why: 'match' });
  }
  L.slots = L.slots.filter((s) => s.ctrl.type !== 'remote');
  if (!partyLobby) partyLobby = JSON.stringify(L);
  L.slots = L.slots.filter((s) => s.ctrl.type !== 'cpu'); // (our CPUs aren't in the match)
  L.count = 0;
  L.random = false; // (the match's mode is the matchmaker's pick)
  pendingMatch.cur = { expect: m.expect, until: performance.now() + (MATCH_ARRIVE + MATCH_COUNTDOWN) * 1000, mode: m.mode };
  setTimeout(() => {
    hostRoom.close();
    app.go('lobby', { keep: true, online: true, matchMode: m.mode, room: { name: 'Quick match', public: false, persistent: false, code: m.code, openControl: true, match: true } });
  }, t ? 400 : 0);
}

/** leaving the match room we host: it closes (everyone in it goes home) and our party reopens as it was */
function hostMatchHome(app: App) {
  pendingMatch.cur = null;
  hostRoom.close();
  if (partyLobby) { try { Object.assign(L, JSON.parse(partyLobby)); } catch { /* ignore */ } partyLobby = null; }
  const home = party.home;
  app.toast('Back to your party');
  app.go('lobby', { keep: true, online: true, room: home?.opts ?? { name: '', public: false, persistent: false, code: home?.code } });
}

/** how to reopen the party you host, as it is now (after a visit, when someone takes it over) */
function currentRoomOpts(): RoomOpts {
  const t = hostRoom.t!, i = hostRoom.info;
  return { name: i.name, public: false, persistent: i.persistent, code: t.code, key: findMyRoom(t.code)?.key, openControl: hostRoom.openControl, password: i.password };
}

/**
 * Your party goes to another room together (a quick match, a friend's party): you join it first (so a wrong password
 * or a full room doesn't scatter everyone), then your members are sent after you and your own room closes. You
 * come home together when you leave it. A party of one just goes (a match is still a visit: you come back after).
 */
export async function partyTravel(app: App, input: string, why: 'match' | 'room'): Promise<string> {
  const t = hostRoom.t;
  let code = '';
  try { code = parseJoinInput(input).code; } catch (e) { return String((e as Error).message || e); }
  if (!t) return joinParty(app, input, { as: why === 'match' ? 'visit' : 'member', retryMs: why === 'match' ? 20_000 : 0 });
  const solo = !leadsParty();
  if (why === 'room' && solo) return joinParty(app, input, { as: 'member' });
  party.home = { code: t.code, leader: true, opts: currentRoomOpts() };
  if (queue.active) queue.cancel();
  pendingMatch.cur = null;
  return joinParty(app, input, {
    as: 'visit', retryMs: why === 'match' ? 20_000 : 0,
    onIn: () => {
      hostRoom.send('all', { t: 'travel', code, why, pw: party.pw.get(code) });
      L.slots = L.slots.filter((s) => s.ctrl.type !== 'remote');
    },
  });
}

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

/** the lobby on screen (for broadcasting room changes) and the app (for a room song set mid-match) */
let activeLobby: { dirty: boolean; renderOnline(): void; el?: HTMLElement } | null = null;
let lobbyApp: App | null = null;
/**
 * The host sets the room song — from the lobby or mid-match: it plays here, goes to everyone (with the lobby state,
 * or straight away during a match), and whoever's radio picked it keeps going (anyone else's radio switches off).
 */
function hostRoomSong(app: App, s: Song | null, by: string, radioBy: number | null) {
  L.song = s; L.songBy = s ? by : ''; L.radioBy = s ? radioBy : null;
  if (s) app.sfx.playSong(s, app.sfx.player?.song?.id !== s.id); else if (!hostRoom.inMatch) app.sfx.useMusic('menu');
  if (s) app.toast(`♪ ${s.name}${by ? ` — ${by.startsWith('📻') ? by : `picked by ${by}`}` : ''}`);
  if (s) onRoomSong(app, L.radioBy, (n) => hostRoomSong(app, n, `📻 ${L.slots[0]?.name ?? 'Host'}`, RADIO_HOST));
  if (hostRoom.inMatch) hostRoom.send('all', { t: 'song', song: s, by: L.songBy, radioBy: L.radioBy });
  if (activeLobby?.el?.isConnected) { activeLobby.dirty = true; activeLobby.renderOnline(); }
}
roomSongHost.set = (s, by, radioBy) => { if (lobbyApp) hostRoomSong(lobbyApp, s, by, radioBy); };
roomSongHost.radioBy = () => L.radioBy;
// a guest whose radio was running left: surprise radio (on the host) takes over, so the music keeps coming
hostRoom.onMemberLeft = (peer) => {
  if (!lobbyApp || !L.song || L.radioBy !== peer) return;
  const app = lobbyApp;
  roomRadio.mode = 'surprise'; L.radioBy = RADIO_HOST;
  app.toast('📻 Their radio left with them — surprise radio takes over');
  armRadio(app, (n) => hostRoomSong(app, n, '📻 Surprise radio', RADIO_HOST));
  if (activeLobby?.el?.isConnected) { activeLobby.dirty = true; activeLobby.renderOnline(); }
};

export class LobbyScreen implements Screen {
  app!: App;
  el!: HTMLElement;
  nav!: MenuNav;
  slotsEl!: HTMLElement;
  /** slot cards are built once and updated in place (no flicker, focus and animations survive) */
  cards: Card[] = [];
  joinCard!: HTMLElement;
  joinBtn!: HTMLButtonElement;
  joinMsg!: HTMLElement;
  /** a full lobby's + PLAYER (in the rules row) */
  joinMini?: HTMLButtonElement;
  startBtn?: HTMLButtonElement;
  midEl?: HTMLElement;
  bottomEl?: HTMLElement;
  cpuMini?: HTMLButtonElement;
  /** join mode: listening for a new player's device (time it started, ms) */
  joining = 0;
  private lastTap: { type: 'touch' | 'mouse'; t: number } | null = null;
  // (a tap / click only joins someone when it's on the join card itself — elsewhere it's just using the menus)
  private onTap = (e: PointerEvent) => { const el = e.target as Element; this.lastTap = this.joining && el.closest?.('.slot.join') && !el.closest('.join-btn') ? { type: e.pointerType === 'touch' ? 'touch' : 'mouse', t: performance.now() } : null; };
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

  /**
   * GUEST: in someone else's online room, this same lobby shows their room — their mode, arena, rules, players and
   * music, kept in step with what the host sends. You pick your own blade, name and team on your card; with OPEN
   * CONTROL the room's settings and START work for you too (they're sent to the host, who applies them).
   */
  guest = false;
  /** your own lobby, put back when you leave the room view */
  private guestBackup = '';
  private remoteArena: ArenaDef | null = null;
  private lastSong: string | null | undefined = undefined;
  get canCtl() { return this.guest && clientRoom.lobby?.control === 'all'; }
  /** a guest changing a room setting: sent to the host (OPEN CONTROL), or a note that the leader runs the room */
  guestCtl(a: string, extra: Record<string, unknown> = {}) {
    if (!this.guest) return false;
    if (this.canCtl) clientRoom.send({ t: 'ctl', a, ...extra });
    else this.app.toast(`${clientRoom.lobby?.leader ?? 'The leader'} runs this room — you choose your blade and team`);
    return true;
  }

  mount(app: App, arg?: unknown) {
    this.app = app;
    if (import.meta.env.DEV) (window as unknown as { __lobby?: unknown }).__lobby = this; // (headless checks)
    if ((arg as { guest?: boolean } | undefined)?.guest && clientRoom.t) { this.mountGuest(); return; }
    this.guest = false;
    // an online room keeps its chosen song between matches; otherwise menu music
    lobbyApp = app; activeLobby = this;
    if (hostRoom.t && L.song) { app.sfx.playSong(L.song, app.sfx.player?.song?.id !== L.song.id); onRoomSong(app, L.radioBy, (n) => hostRoomSong(app, n, `📻 ${L.slots[0]?.name ?? 'Host'}`, RADIO_HOST)); } else app.sfx.useMusic('menu');
    setBackdropVisible(true, app.canvas);
    // keep: coming back from a match/results/menu — leave mode, rules, players and arena exactly as they were
    // next: advance to the next arena for this mode; autostart: go straight into the match (rematch / next track)
    const a = (arg ?? {}) as { mode?: ModeId; bladeId?: string; arenaId?: string; keep?: boolean; online?: boolean; next?: boolean; autostart?: boolean; room?: RoomOpts; takeover?: any; matchMode?: ModeId };
    if (a.room) this.roomOpts = a.room;
    this.takeover = !!a.takeover;
    L.active = true;
    if (a.takeover) this.adoptParty(a.takeover);
    if (a.matchMode && a.matchMode !== L.mode) this.setMode(a.matchMode, true);
    if (a.mode && !a.keep && a.mode !== L.mode) this.setMode(a.mode);
    else if (a.mode && !a.keep) this.setMode(a.mode, true);
    if (a.arenaId && allArenas().some((x) => x.id === a.arenaId && this.fits(x))) L.arenaId = a.arenaId;
    if (!L.slots.length) { // (a fresh lobby starts with you in it; one you emptied of players stays that way)
      L.slots.unshift({ name: settings.playerName || 'Player 1', ctrl: Input.isTouchDevice() && !matchMedia('(pointer: fine)').matches ? { type: 'touch' } : { type: 'kb' }, bladeId: PRESETS[0].id, team: 0 });
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
    this.joining = 0;
    addEventListener('pointerdown', this.onTap, true);
    this.unsub = hostRoom.subscribe(() => this.syncMembers());
    queue.listeners.add(this.onQueue);
    travel.room = (code) => this.travelTo(code);
    hostRoom.onCtl = (peer, m) => this.onRemoteCtl(peer, m);
    hostRoom.inMatch = false;
    this.syncMembers();
    if (a.online && !hostRoom.t) this.openRoom(getPlatform() && !cloudRelayUrl() ? 'lan' : 'cloud');
    if (a.autostart) setTimeout(() => { if (this.el.isConnected) { this.el.style.visibility = ''; this.start(); } }, 0);
  }

  /** a guest's lobby: the room as the host has it */
  mountGuest() {
    const app = this.app;
    this.guest = true;
    this.guestBackup = JSON.stringify(L);
    this.lastSong = undefined;
    setBackdropVisible(true, app.canvas);
    this.build();
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.leave());
    this.nav.focus(1);
    this.joining = 0;
    clientRoom.handler = (m) => {
      if (m?.t === 'lobby') this.applyRemote();
      else if (m?.t === 'busy') this.renderOnline();
      else if (m?.t === 'full') app.toast('The room is full for this mode — you\'ll play when a place frees up');
      else if (m?.t === 'start' && clientRoom.t) app.go('match', { cfg: m.cfg, client: { t: clientRoom.t, mine: m.mine } } as MatchArg);
    };
    this.applyRemote();
  }

  /** guest: show the room as the host last sent it */
  applyRemote() {
    const lb = clientRoom.lobby;
    if (!this.guest) return;
    if (!lb) { this.renderOnline(); return; }
    const me = clientRoom.t?.id ?? -1;
    L.mode = (MODES.some((m) => m.id === lb.mode) ? lb.mode : 'duel') as ModeId;
    this.remoteArena = lb.arenaDef ?? allArenas().find((a) => a.id === lb.arenaId) ?? null;
    L.arenaId = lb.arenaId;
    L.sizeFilter = ((Object.entries(SIZE_LABEL) as [ArenaSize, string][]).find(([, v]) => v === lb.sizeFilter)?.[0] ?? 'ALL') as typeof L.sizeFilter;
    L.items = !!lb.items; L.target = lb.target ?? L.target; L.time = lb.time ?? L.time;
    if (lb.nudge !== undefined) L.nudge = !!lb.nudge;
    if (lb.kothShare !== undefined) L.kothShare = !!lb.kothShare;
    if (lb.rubber !== undefined) L.rubber = lb.rubber;
    if (lb.teamSplit) L.teamSplit = lb.teamSplit;
    L.random = !!lb.random;
    L.slots = (lb.slots as { name: string; ctrl: string; blade?: BladeDesign; team: number; lock?: boolean; auto?: boolean }[]).map((s) => {
      const peer = s.ctrl.startsWith('online:') ? Number(s.ctrl.slice(7)) : -1;
      const ctrl: ControllerSpec = s.ctrl.startsWith('CPU') ? { type: 'cpu', level: 2 } : { type: 'remote', peer };
      return { name: s.name, ctrl, bladeId: s.blade?.id ?? PRESETS[0].id, blade: s.blade, team: s.team, teamLock: !!s.lock, auto: !!s.auto, label: s.ctrl, mine: peer === me && me >= 0 };
    });
    L.count = L.slots.length;
    // the room's song plays for everyone in the room
    const song = lb.song ? acceptSong(lb.song) : null;
    if ((song?.id ?? null) !== this.lastSong) {
      this.lastSong = song?.id ?? null;
      if (song) this.app.sfx.playSong(song, this.app.sfx.player?.song?.id !== song.id); else this.app.sfx.useMusic('menu');
      if (song) onRoomSong(this.app, lb.radioBy, (n) => clientRoom.send({ t: 'ctl', a: 'song', song: n, radio: true }));
    }
    this.refresh();
    this.renderOnline();
  }

  setMode(id: ModeId, keepArena = false) {
    if (id === 'ffa') id = 'duel'; // (All For One is Battle with 3+ blades)
    L.mode = id;
    const m = this.mode;
    L.target = m.target;
    L.time = m.time;
    L.count = Math.min(L.count, m.maxPlayers);
    const cur = allArenas().find((x) => x.id === L.arenaId);
    const ok = !!cur && this.fits(cur, id) && (m.arenas.includes(L.arenaId) || !!cur.custom);
    if (id === 'race' || L.sizeFilter === 'TRACK') L.sizeFilter = 'ALL';
    if (!keepArena || !ok) L.arenaId = m.arenas[0];
    // (pinball: start without CPUs — one of you is a table, two or more is a party; add CPUs on purpose)
    if (id === 'pinball' && !keepArena) { L.slots = L.slots.filter((s) => s.ctrl.type !== 'cpu'); L.count = 0; }
    if (L.slots.length > m.maxPlayers) L.slots = L.slots.filter((s, i) => i < m.maxPlayers || s.ctrl.type === 'remote');
    this.assignTeams();
  }

  /** ghost CPUs: exactly as many as the mode needs to start (they play as CPUs unless someone takes their place) */
  fillCpus() {
    const m = this.mode;
    const names = ['Kai', 'Ryo', 'Mika', 'Zed', 'Nova', 'Juno', 'Rex', 'Ivy'];
    const base = Math.max(m.minPlayers, m.id === 'gauntlet' || m.id === 'quest' || m.id === 'pinball' ? 1 : 2);
    // (the places: at least the mode's minimum, at least everyone who's actually in, at most the mode's maximum)
    const real = L.slots.filter((s) => !s.auto).length;
    L.count = Math.min(m.maxPlayers, Math.max(base, real, L.count));
    if (this.isTeamMode() && L.count % 2 && L.count < m.maxPlayers) L.count++; // (teams: an even number of places — a ghost evens them out)
    const need = L.count;
    for (let i = L.slots.length - 1; i >= 0 && L.slots.length > need; i--) if (L.slots[i].auto) L.slots.splice(i, 1);
    while (L.slots.length < need) {
      const used = new Set(L.slots.map((s) => s.bladeId));
      const blade = PRESETS.find((b) => !used.has(b.id)) ?? PRESETS[L.slots.length % PRESETS.length];
      const taken = new Set(L.slots.map((s) => s.name));
      const name = names.map((n) => `CPU ${n}`).find((n) => !taken.has(n)) ?? `CPU ${L.slots.length + 1}`; // (a name nobody has)
      L.slots.push({ name, ctrl: { type: 'cpu', level: 2 }, bladeId: blade.id, team: L.slots.length, auto: true });
    }
    this.assignTeams();
  }

  /**
   * Teams, automatically: anyone locked to a team (their team tag was picked) keeps it; then the players — local and
   * online — are spread evenly across the teams, then CPUs, and the ghost CPUs last, so they even the numbers out.
   * In slot order, so someone joining never reshuffles the people already in.
   */
  assignTeams() {
    if (this.guest) return; // (the host balances the room's teams)
    const m = this.mode;
    if (m.id === 'gauntlet' || m.id === 'quest') { L.slots.forEach((s) => (s.team = 0)); return; }
    if (!this.isTeamMode()) { L.slots.forEach((s, i) => (s.team = i)); return; }
    const all = [0, 0], people = [0, 0];
    const isPerson = (s: Slot) => s.ctrl.type !== 'cpu';
    const cap = Math.ceil(L.slots.length / 2); // (a team holds at most half the places)
    for (const s of L.slots) if (s.teamLock) { s.team = s.team === 1 ? 1 : 0; all[s.team]++; if (isPerson(s)) people[s.team]++; }
    const pick = (byPeople: boolean) => byPeople && people[0] !== people[1] ? (people[0] < people[1] ? 0 : 1) : all[0] !== all[1] ? (all[0] < all[1] ? 0 : 1) : people[0] <= people[1] ? 0 : 1;
    const put = (s: Slot, t: number) => { if (all[t] >= cap) t = 1 - t; s.team = t; all[t]++; if (isPerson(s)) people[t]++; };
    const place = (s: Slot, byPeople: boolean) => put(s, pick(byPeople));
    // the players: PARTIES — each party (everyone on this device counts as the host's party) goes onto one team as a
    // group, biggest first, spilling over only if it's bigger than a team; MIXED — one by one in a shuffled order
    const persons = L.slots.filter((s) => !s.teamLock && isPerson(s));
    if (L.teamSplit === 'mixed') {
      const key = (s: Slot) => { let x = L.mixSeed; for (const c of s.name + (s.ctrl.type === 'remote' ? s.ctrl.peer : '')) x = (x * 31 + c.charCodeAt(0)) % 1000003; return x; };
      for (const s of [...persons].sort((a, b) => key(a) - key(b))) place(s, true);
    } else {
      const unitOf = (s: Slot) => s.ctrl.type === 'remote' ? (s.party ?? `peer:${s.ctrl.peer}`) : (myPartyCode() || 'local');
      const units = new Map<string, Slot[]>();
      for (const s of persons) { const k = unitOf(s); units.set(k, [...(units.get(k) ?? []), s]); }
      for (const u of [...units.values()].sort((a, b) => b.length - a.length)) { const t = pick(true); for (const s of u) put(s, t); }
    }
    for (const s of L.slots) if (!s.teamLock && !isPerson(s) && !s.auto) place(s, false);
    for (const s of L.slots) if (!s.teamLock && s.auto) place(s, false);
  }
  /** the team tag (or a pad's X): AUTO → the other team (locked) → back across (locked) → AUTO again */
  cycleTeam(i: number) {
    const s = L.slots[i];
    if (!s || !this.isTeamMode()) return;
    if (this.guest) { if (s.mine) clientRoom.send({ t: 'ctl', a: 'team' }); else this.app.toast('You pick your own team — the room balances the rest'); return; }
    if (!s.teamLock) { s.teamLock = true; s.team = 1 - s.team; s.auto = false; }
    else if (s.teamPicks === undefined || s.teamPicks < 1) { s.team = 1 - s.team; s.teamPicks = 1; }
    else { s.teamLock = false; s.teamPicks = undefined; }
    this.renderSlots(); this.dirty = true;
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
    const target = stepper(targetLbl, targetVal, (d) => this.stepTarget(d));
    const time = stepper(h('span', null, 'TIME'), timeVal, (d) => this.stepTime(d));
    // PLAYERS: how many places — the ones nobody's taken are ghost CPUs (online friends join into them)
    const countVal = h('b');
    const count = stepper(h('span', null, 'PLAYERS'), countVal, (d) => this.stepCount(d));
    const items = h('div.toggle.panel.nav', { onclick: () => this.toggleItems() }, h('span.dot'), 'ITEMS');
    const nudge = h('div.toggle.panel.nav', { title: 'Pinball: steering nudges the table — overdo it and it TILTs. Off: flippers only, like a classic table', onclick: () => this.toggleRule('nudge') }, h('span.dot'), 'NUDGE');
    const share = h('div.toggle.panel.nav', { title: 'King of the Hill: everyone in the zone banks time, even when it is contested. Off: only a top holding it alone scores', onclick: () => this.toggleRule('share') }, h('span.dot'), 'SHARED TIME');
    const split = h('div.toggle.panel.nav', { title: 'Teams: PARTIES keeps each party together on one team; MIXED shuffles everyone across the teams', onclick: () => this.toggleSplit() }, 'TEAMS: PARTIES');
    const rubber = h('div.toggle.panel.nav', { 'data-navx': '1', title: 'CPU catch-up: CPUs behind you get faster, CPUs far ahead ease off (like Mario Kart)', onclick: () => this.stepRubber(1) }, 'CPU CATCH-UP ', rubberVal);
    rubber.addEventListener('navx', (e) => this.stepRubber((e as CustomEvent).detail));
    const back = h<HTMLButtonElement>('button.btn.small.nav.back-btn', { onclick: () => this.leave(), 'data-k': 'ESC', 'data-p': 'B', 'data-ps': '○' }, '◀ Back');
    const desc = h('div.screen-sub');
    this.ui = { back, desc, mode, size, arena, items, nudge, share, split, rubber, rubberVal, target, targetLbl, targetVal, timeVal, count, countVal };
    this.el?.classList.toggle('guest', this.guest);

    this.slotsEl = h('div.slots');
    new ResizeObserver(() => this.placeJoin()).observe(this.slotsEl); // (columns change with the window)
    // + PLAYER: listen for the next device (a key, a gamepad, a tap or a click) and make it a new player · + CPU
    this.joinMsg = h('div.join-msg');
    this.joinBtn = h<HTMLButtonElement>('button.btn.nav.join-btn', { onclick: () => this.toggleJoin(), title: 'Add a local player: then press a key, a gamepad button, or tap' }, '+ PLAYER');
    this.joinCard = h('div.slot.join', null, this.joinBtn, h('button.btn.nav.join-btn', { onclick: () => this.addCpu(), title: 'Add a computer player' }, '+ CPU'), this.joinMsg);
    this.slotsEl.append(this.joinCard);

    this.onlineEl = h('div.online-box.panel');
    this.renderOnline();

    const el = h('div.screen.lobby', null,
      h('div.screen-head', null,
        back,
        h('div.screen-title', null, 'LOBBY'),
        desc,
        this.startBtn = h<HTMLButtonElement>('button.btn.primary.nav.start-btn', { onclick: () => this.start(), 'data-p': 'START', 'data-ps': 'OPTIONS' }, '▶ START')),
      h('div.lobby-top', null, mode.el, size.el, arena.el),
      // (the cards, and — in an online room — the room box beside them, so the rules row below stays on screen)
      this.midEl = h('div.lobby-mid', null, this.slotsEl),
      this.bottomEl = h('div.lobby-bottom', null,
        h('div.rules', null,
          count, items, nudge, share, split, rubber, target, time,
          // (at the end of the row: showing / hiding it never shifts the settings under your pointer)
          this.joinMini = h<HTMLButtonElement>('button.btn.small.nav', { onclick: () => this.toggleJoin(), title: 'Add a local player: then press a key or a gamepad button' }, '+ PLAYER'),
          this.cpuMini = h<HTMLButtonElement>('button.btn.small.nav', { onclick: () => this.addCpu(), title: 'Add a computer player' }, '+ CPU')),
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
    const arena = this.guest && this.remoteArena ? this.remoteArena : findArena(L.arenaId); // (a guest: the host's — maybe custom — arena)
    const sz = arenaSize(arena);
    u.back.textContent = this.backLabel();
    const startIn = this.guest ? clientRoom.lobby?.startIn : undefined;
    if (this.startBtn && !(pendingMatch.cur && !this.guest)) this.startBtn.textContent = typeof startIn === 'number' && startIn >= 0 ? `▶ START · ${startIn}` : this.guest && !this.canCtl ? `WAITING FOR ${String(clientRoom.lobby?.leader ?? 'HOST').toUpperCase()}` : '▶ START';
    u.mode.set(m.name.toUpperCase(), m.tag);
    if (L.random) u.mode.set('RANDOM', 'a new mode and course every match');
    u.size.set(L.sizeFilter === 'ALL' ? 'ALL' : SIZE_LABEL[L.sizeFilter], `${order.length} arena${order.length === 1 ? '' : 's'}`);
    u.arena.set(arena.name.toUpperCase(), `${SIZE_LABEL[sz]}${arena.custom ? ' · CUSTOM' : ''} · ${arena.desc}`);
    if (L.random) u.arena.set('RANDOM', 'picked when the match starts');
    u.arena.el.style.setProperty('border-color', arena.theme.glow);
    const bk = `${arena.id}|${L.mode}`;
    if (bk !== this.lastBackdrop) { this.lastBackdrop = bk; setBackdropArena(arena, L.mode); }
    u.items.style.display = m.id !== 'gauntlet' && m.id !== 'rush' ? '' : 'none';
    u.items.classList.toggle('on', L.items);
    u.rubber.style.display = m.id === 'race' ? '' : 'none';
    u.nudge.classList.toggle('on', L.nudge);
    u.share.style.display = m.id === 'koth' ? '' : 'none';
    u.split.style.display = this.isTeamMode() ? '' : 'none';
    u.split.textContent = L.teamSplit === 'mixed' ? 'TEAMS: MIXED' : 'TEAMS: PARTIES';
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
    const remote = () => { const s = L.slots[idx()]; return this.guest ? !s?.mine : s?.ctrl.type === 'remote'; }; // (a guest edits only their own card)
    const cv = h<HTMLCanvasElement>('canvas', { width: 200, height: 200 });
    const name = h<HTMLInputElement>('input.pname', { maxLength: 16 });
    name.addEventListener('change', () => {
      const i = idx(), s = L.slots[i];
      if (!s) return;
      if (this.guest) { if (!s.mine) return; settings.playerName = name.value.trim() || settings.playerName; settings.save(); clientRoom.send({ t: 'hello', name: settings.playerName }); return; }
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
    const team = h('div.team-tag', { title: 'Team: AUTO keeps the teams even — tap to pick one', onclick: () => this.cycleTeam(idx()) });
    const pad = h('div.slot-pad', { html: '<i class="g stick">◀▶</i> blade <i class="g g-y">Y</i> random <span class="tm"><i class="g g-x">X</i> team</span> <i class="g g-b">B</i> leave' });
    const x = h('div.x', { onclick: () => this.removeSlot(idx()), title: 'Remove' }, icon('close'));
    const pnum = h('div.pnum');
    const el = h('div.slot', null, pnum, team, cv, name, pick, h('div.slot-stats', null, ...bars.map((b) => b.row)), ctrl, pad, x);
    const card: Card = { el, pnum, team, cv, name, bname, left, right, bars, ctrl, ctrlKey: '', pad, x, d: null };
    return card;
  }

  updateCard(c: Card, s: Slot, i: number) {
    const d = this.bladeOf(s);
    const remote = this.guest ? !s.mine : s.ctrl.type === 'remote';
    c.el.dataset.i = String(i);
    c.el.classList.toggle('mine', !!s.mine);
    c.el.classList.toggle('ghost', !!s.auto);
    c.el.title = s.auto ? 'Auto CPU: plays if nobody joins — + PLAYER takes this place, + CPU (or picking its difficulty) keeps it' : '';
    c.el.style.setProperty('--slot', this.slotColor(s, i));
    c.pnum.textContent = `P${i + 1}`;
    c.team.style.display = this.isTeamMode() ? '' : 'none';
    c.team.innerHTML = (s.team === 0 ? 'RED' : 'BLUE') + (s.teamLock ? '' : '<span class="tauto"> · AUTO</span>');
    c.team.classList.toggle('auto', !s.teamLock);
    const shown = remote ? clean(s.name) : s.name; // (someone else's name: as this player wants to see it)
    if (document.activeElement !== c.name && c.name.value !== shown) c.name.value = shown;
    c.name.disabled = remote;
    c.left.style.visibility = c.right.style.visibility = remote ? 'hidden' : '';
    if (c.d !== d) {
      c.d = d;
      c.bname.textContent = remote ? clean(d.name) : d.name;
      const st = computeStats(d);
      STAT_KEYS.forEach((k, j) => { c.bars[j].i.style.width = `${st.points[k] * 10}%`; c.bars[j].row.title = `${STAT_INFO[k].label} ${st.points[k]}/10 — ${STAT_INFO[k].desc}`; });
      drawBladeIcon(c.cv, d, this.angle);
    }
    const ck = this.guest ? `g:${s.mine}:${s.label}:${s.auto}` : remote ? 'remote' : specKey(s.ctrl) + specLabel(s.ctrl) + (s.auto ? 'auto' : '');
    if (c.ctrlKey !== ck && this.guest) {
      // (a guest's view: who plays each place — YOU, an online player, the host's own players, CPUs)
      c.ctrlKey = ck;
      c.ctrl.innerHTML = '';
      const lbl = s.label ?? '';
      c.ctrl.append(icon(s.mine ? 'star' : lbl.startsWith('CPU') ? 'gear' : 'link'), ' ', s.mine ? 'YOU' : lbl.startsWith('online:') ? 'ONLINE PLAYER' : lbl.startsWith('CPU') ? (s.auto ? `AUTO · ${lbl}` : lbl) : `${String(clientRoom.lobby?.leader ?? 'HOST').toUpperCase()}'S ${lbl.toUpperCase()}`);
    } else if (c.ctrlKey !== ck) {
      c.ctrlKey = ck;
      c.ctrl.innerHTML = '';
      c.ctrl.append(icon(remote ? 'link' : s.ctrl.type === 'kb' || s.ctrl.type === 'kb1' || s.ctrl.type === 'kb2' ? 'keyboard' : s.ctrl.type === 'mouse' ? 'mouse' : s.ctrl.type === 'touch' ? 'phone' : s.ctrl.type === 'cpu' ? 'gear' : 'gamepad'), ' ', remote ? 'ONLINE PLAYER' : s.auto ? `AUTO · ${specLabel(s.ctrl)}` : specLabel(s.ctrl));
    }
    c.pad.style.display = this.isPersonalPad(i) ? '' : 'none';
    (c.pad.querySelector('.tm') as HTMLElement).style.display = this.isTeamMode() ? '' : 'none';
    c.x.style.display = s.auto || this.guest ? 'none' : ''; // (anyone can be removed, P1 too; ghosts are just placeholders — and only by the host)
  }

  cycleCtrl(i: number) {
    const s = L.slots[i];
    if (!s || s.ctrl.type === 'remote') return;
    // (players and CPUs are separate: a CPU's label only changes its difficulty, a player's only their device —
    // + PLAYER and + CPU add them, ✕ removes them)
    const cpu = s.ctrl.type === 'cpu';
    s.auto = false; // (picking a ghost's difficulty keeps it)
    const opts = this.controllerOptions(s.ctrl).filter((o) => (o.type === 'cpu') === cpu);
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

  stepTarget(d: number) { if (this.guestCtl('target', { d })) return; L.target = Math.max(1, L.target + d * (L.mode === 'koth' ? 5 : 1)); this.refresh(); }
  stepTime(d: number) { if (this.guestCtl('time', { d })) return; L.time = Math.max(30, L.time + d * 15); this.refresh(); }
  stepCount(d: number) {
    if (this.guestCtl('count', { d })) return;
    L.count = L.count + d * (this.isTeamMode() ? 2 : 1);
    if (d < 0) L.count = Math.max(L.slots.filter((s) => !s.auto).length, L.count);
    this.fillCpus(); this.renderSlots(); this.dirty = true;
  }
  stepRubber(d: number) { if (this.guestCtl('rubber', { d })) return; L.rubber = (L.rubber + d + 3) % 3; this.refresh(); }
  /** team games: parties together ↔ everyone mixed (a fresh shuffle each time) */
  toggleSplit() {
    if (this.guestCtl('split')) return;
    L.teamSplit = L.teamSplit === 'mixed' ? 'parties' : 'mixed';
    if (L.teamSplit === 'mixed') L.mixSeed = 1 + Math.floor(Math.random() * 1e6);
    this.app.toast(L.teamSplit === 'mixed' ? 'Teams: MIXED — everyone shuffled' : 'Teams: PARTIES — each party on one team');
    this.renderSlots(); this.refresh(); this.dirty = true;
  }
  toggleRule(k: 'nudge' | 'share') { if (this.guestCtl(k)) return; if (k === 'nudge') L.nudge = !L.nudge; else L.kothShare = !L.kothShare; this.refresh(); }

  stepMode(d: number) {
    if (this.guestCtl('mode', { d })) return;
    // (the wheel: every mode, then RANDOM)
    const n = PICK_MODES.length + 1;
    const i = L.random ? PICK_MODES.length : PICK_MODES.findIndex((x) => x.id === L.mode);
    const j = (i + d + n) % n;
    L.random = j === PICK_MODES.length;
    if (!L.random) this.setMode(PICK_MODES[j].id);
    this.fillCpus();
    this.rebuild();
    this.renderOnline(); // (QUICK MATCH · the mode)
  }

  stepArena(d: number) {
    if (this.guestCtl('arena', { d })) return;
    if (L.random) { L.random = false; this.app.toast(`${this.mode.name} — pick its course`); }
    const order = this.arenaOrder();
    const i = order.findIndex((a) => a.id === L.arenaId);
    L.arenaId = order[(i + d + order.length) % order.length].id;
    this.rebuild();
  }

  stepSize(d: number) {
    if (this.guestCtl('size', { d })) return;
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
    if (this.guestCtl('rand', { mode })) return;
    L.random = false;
    if (mode) {
      const pick = PICK_MODES.filter((m) => m.id !== L.mode)[Math.floor(Math.random() * (PICK_MODES.length - 1))];
      this.setMode(pick.id);
      this.fillCpus();
    }
    L.sizeFilter = 'ALL';
    const order = this.arenaOrder().filter((a) => a.id !== L.arenaId);
    if (order.length) L.arenaId = order[Math.floor(Math.random() * order.length)].id;
    this.refresh();
    this.app.toast(`${this.mode.name} · ${findArena(L.arenaId).name}`);
  }

  toggleItems() { if (this.guestCtl('items')) return; L.items = !L.items; this.rebuild(); }

  /** a room member asked to change something (only honoured with Open Control) */
  onRemoteCtl(peer: number, m: any) {
    // (your own team is yours to pick, OPEN CONTROL or not)
    if (m?.a === 'team') { const i = L.slots.findIndex((s) => s.ctrl.type === 'remote' && s.ctrl.peer === peer); if (i >= 0) this.cycleTeam(i); return; }
    if (!hostRoom.openControl) return;
    const who = hostRoom.members.get(peer)?.name ?? 'Someone';
    const d = m.d === -1 ? -1 : 1;
    switch (m.a) {
      case 'target': this.stepTarget(d); break;
      case 'time': this.stepTime(d); break;
      case 'count': this.stepCount(d); break;
      case 'rubber': this.stepRubber(d); break;
      case 'nudge': case 'share': this.toggleRule(m.a); break;
      case 'rand': this.randomize(!!m.mode); break;
      case 'split': this.toggleSplit(); break;
      case 'mode': this.stepMode(d); break;
      case 'arena': this.stepArena(d); break;
      case 'size': this.stepSize(d); break;
      case 'items': this.toggleItems(); break;
      case 'find': if (queue.active) queue.cancel(); else this.findPlayers(); this.app.toast(queue.active ? `${who} started a quick match search` : `${who} stopped the search`); return;
      case 'song': { const s = m.song === null ? null : acceptSong(m.song); if (m.song !== null && !s) return; this.setRoomSong(s, m.radio ? `📻 ${who}` : who, m.radio ? peer : null); return; }
      case 'start': this.app.toast(`${who} started the match`); this.start(); return;
      default: return;
    }
    this.app.toast(`${who} changed the room`);
  }

  /** online room music: everyone in the room hears it in the lobby and in matches */
  setRoomSong(s: Song | null, by: string, radioBy: number | null = null) {
    hostRoomSong(this.app, s, by, radioBy);
  }

  /** mirror room membership into lobby slots */
  syncMembers() {
    if (!this.el) return;
    let changed = false;
    const mem = hostRoom.members;
    for (let i = L.slots.length - 1; i >= 0; i--) {
      const sl = L.slots[i];
      if (sl.ctrl.type === 'remote' && !mem.has(sl.ctrl.peer)) { this.app.toast(`${clean(sl.name)} left`); L.slots.splice(i, 1); changed = true; }
    }
    for (const m of mem.values()) {
      const sl = L.slots.find((x) => x.ctrl.type === 'remote' && x.ctrl.peer === m.peer);
      if (sl) {
        if (sl.name !== m.name || (m.blade && sl.blade?.id !== m.blade.id) || sl.party !== m.party) { sl.name = m.name; if (m.blade) sl.blade = m.blade; sl.party = m.party; changed = true; }
        continue;
      }
      const ghost = L.slots.findIndex((x) => x.auto);
      if (ghost >= 0) L.slots.splice(ghost, 1); // (they take a ghost CPU's place)
      else if (L.slots.length >= this.mode.maxPlayers) {
        const cpu = L.slots.findIndex((x) => x.ctrl.type === 'cpu');
        if (cpu < 0) continue; // room full for this mode: they watch from the room until a slot frees up
        L.slots.splice(cpu, 1);
      }
      L.slots.push({ name: m.name, ctrl: { type: 'remote', peer: m.peer }, bladeId: PRESETS[m.peer % PRESETS.length].id, blade: m.blade ?? undefined, team: 0, party: m.party });
      this.app.sfx.play('select');
      this.app.toast(hostRoom.matchOpen ? `${clean(m.name)} is here for the match` : `${clean(m.name)} joined your party`);
      changed = true;
    }
    if (changed) { this.fillCpus(); this.assignTeams(); this.renderSlots(); }
    // (the party's password goes to its members — whoever takes the party over keeps it)
    if (hostRoom.t) for (const m of mem.values()) if (m.party === hostRoom.t.code && !this.cfgSent.has(m.peer)) { this.cfgSent.add(m.peer); hostRoom.send(m.peer, { t: 'partycfg', pw: hostRoom.info.password }); }
    this.dirty = true;
    if (this.onlineEl) this.renderOnline();
  }
  private cfgSent = new Set<number>();

  /** taking the party over from a leader who left: carry on with its mode, arena, rules and music — and its CPUs */
  adoptParty(s: any) {
    if (MODES.some((m) => m.id === s.mode)) L.mode = s.mode;
    if (allArenas().some((x) => x.id === s.arenaId)) L.arenaId = s.arenaId; else L.arenaId = this.mode.arenas[0];
    L.items = !!s.items; L.target = s.target ?? L.target; L.time = s.time ?? L.time;
    if (s.nudge !== undefined) L.nudge = !!s.nudge;
    if (s.kothShare !== undefined) L.kothShare = !!s.kothShare;
    if (s.rubber !== undefined) L.rubber = s.rubber;
    if (s.teamSplit) L.teamSplit = s.teamSplit;
    L.random = !!s.random;
    const song = s.song ? acceptSong(s.song) : null;
    L.song = song; L.songBy = song ? s.songBy ?? '' : ''; L.radioBy = null;
    const slots = (s.slots ?? []) as { name: string; ctrl: string; blade?: BladeDesign; team: number; auto?: boolean }[];
    const mine = slots.find((x) => x.ctrl === `online:${clientRoom.myId}`);
    const me: Slot = { name: settings.playerName || 'Player 1', ctrl: Input.isTouchDevice() && !matchMedia('(pointer: fine)').matches ? { type: 'touch' } : { type: 'kb' }, bladeId: mine?.blade?.id ?? PRESETS[0].id, blade: mine?.blade, team: 0 };
    L.slots = [me, ...slots.filter((x) => x.ctrl.startsWith('CPU') && !x.auto).map((x): Slot => ({ name: x.name, ctrl: { type: 'cpu', level: 2 }, bladeId: x.blade?.id ?? PRESETS[0].id, blade: x.blade, team: x.team }))];
    L.count = slots.length;
  }

  rebuild() { this.refresh(); }

  controllerOptions(current: ControllerSpec): ControllerSpec[] {
    const used = new Set(L.slots.map((s) => specKey(s.ctrl)));
    used.delete(specKey(current));
    const opts: ControllerSpec[] = [{ type: 'kb' }, { type: 'kb1' }, { type: 'kb2' }, { type: 'mouse' }];
    for (const i of this.app.input.connectedPads()) opts.push({ type: 'pad', index: i });
    if (Input.isTouchDevice()) opts.push({ type: 'touch' }, { type: 'touch', gyro: true });
    // (the shared keyboard holds both layouts; the mouse player uses the WASD side for buttons)
    const clash = (k: string) => used.has(k) || (k === 'kb' && (used.has('kb1') || used.has('kb2') || used.has('mouse'))) || ((k === 'kb1' || k === 'kb2' || k === 'mouse') && used.has('kb')) || (k === 'mouse' && used.has('kb1')) || (k === 'kb1' && used.has('mouse'));
    const free = opts.filter((o) => !clash(specKey(o)));
    return [...free, { type: 'cpu', level: 1 }, { type: 'cpu', level: 2 }, { type: 'cpu', level: 3 }];
  }

  /** sync slot cards with L.slots: reuse cards, add/remove only at the end */
  /** what depends on who's in: pinball with company is a PINBALL PARTY (its own blurb; no nudge or table timer) */
  rulesUi() {
    const u = this.ui, m = this.mode;
    if (!u) return;
    L.count = Math.max(L.count, L.slots.length);
    u.countVal.textContent = String(L.slots.length);
    u.count.style.display = m.maxPlayers > 1 ? '' : 'none';
    const party = m.id === 'pinball' && L.slots.length > 1;
    const brawl = m.id === 'duel' && L.slots.length > 2;
    const desc = brawl ? `FREE-FOR-ALL — ${L.slots.length} blades, everyone for themselves. KOs score, last spinner gets a bonus. (Two blades play a 1v1.)` : party ? 'PINBALL PARTY — a free-for-all on the table: knock rivals out or into the drain. The flippers play themselves; slots refill your spin — DASH fires you out where you steer. First to 10.' : m.desc;
    if (u.desc.textContent !== desc) u.desc.textContent = desc;
    u.mode.set(m.name.toUpperCase(), brawl ? `${L.slots.length} players · free-for-all` : m.id === 'duel' ? '1v1 · add blades for a free-for-all' : m.tag);
    if (L.random) u.mode.set('RANDOM', 'a new mode and course every match');
    u.nudge.style.display = m.id === 'pinball' && !party ? '' : 'none';
    const tw = u.timeVal.closest<HTMLElement>('.stepper');
    if (tw) tw.style.display = party ? 'none' : ''; // (a party plays free-for-all rounds)
  }

  renderSlots() {
    this.assignTeams();
    this.rulesUi();
    if (!this.slotsEl) return;
    while (this.cards.length < L.slots.length) { const c = this.makeCard(); this.cards.push(c); this.slotsEl.insertBefore(c.el, this.joinCard); }
    while (this.cards.length > L.slots.length) this.cards.pop()!.el.remove();
    L.slots.forEach((s, i) => this.updateCard(this.cards[i], s, i));
    // (5+ blades: compact cards, so two rows fit — counted by players, not by the + PLAYER card)
    this.slotsEl.classList.toggle('many', L.slots.length >= 5);
    this.placeJoin();
  }

  /**
   * + PLAYER / + CPU: a card in the grid while it fits on a row that already has players; when it would open a row
   * of its own (or the lobby is full — a player can still take a CPU's place), a slim + PLAYER button at the end of
   * the settings row instead. Nothing jumps around under your pointer.
   */
  placeJoin() {
    if (!this.slotsEl || !this.joinCard) return;
    if (this.guest) { this.joinCard.style.display = 'none'; if (this.joinMini) this.joinMini.style.display = 'none'; if (this.cpuMini) this.cpuMini.style.display = 'none'; return; }
    const room = L.slots.length < this.mode.maxPlayers;
    const tpl = getComputedStyle(this.slotsEl).gridTemplateColumns;
    const cols = !tpl || tpl === 'none' ? 0 : tpl.split(' ').filter(Boolean).length; // (0: one scrolling row — always fits)
    // (from 4 blades on it's always the slim buttons — no card popping in and out as the count changes)
    const fits = room && L.slots.length < 4 && (!cols || L.slots.length % cols !== 0);
    this.joinCard.style.display = fits ? '' : 'none';
    if (this.joinMini) this.joinMini.style.display = !fits && (room || L.slots.some((s) => s.ctrl.type === 'cpu')) ? '' : 'none';
    if (this.cpuMini) this.cpuMini.style.display = !fits && (room || L.slots.some((s) => s.auto)) ? '' : 'none';
  }

  /** pads that joined as P2+ steer their own slot; P1's device (or keyboard) drives the menu */
  isPersonalPad(i: number) {
    const s = L.slots[i];
    return i > 0 && s?.ctrl.type === 'pad';
  }

  cycleSlotBlade(i: number, dir: number, random = false) {
    const s = L.slots[i];
    const blades = allBlades();
    if (this.guest) {
      if (!s?.mine) return;
      const k0 = blades.findIndex((b) => b.id === (s.blade?.id ?? s.bladeId));
      const b = random ? blades[Math.floor(Math.random() * blades.length)] : blades[(k0 + dir + blades.length) % blades.length];
      s.blade = b; s.bladeId = b.id;
      try { localStorage.setItem('bitblade.lastBlade', b.id); } catch { /* ignore */ }
      clientRoom.send({ t: 'blade', blade: b });
      this.renderSlots(); this.app.sfx.play('tick'); this.flashSlot(i);
      return;
    }
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
      else if (e(2) && this.isTeamMode()) { this.cycleTeam(i); this.flashSlot(i); this.app.sfx.play('tick'); }
      else if (e(1)) { this.app.toast(`${s.name} left`); this.removeSlot(i); this.fillCpus(); this.renderSlots(); }
      else if (e(9)) this.start();
    });
    // those pads don't also move the shared menu
    this.nav.ignorePads = mine;
  }

  /** + PLAYER: start (or cancel) listening for a new player's device */
  toggleJoin() {
    if (!this.joining && L.slots.length >= this.mode.maxPlayers && !L.slots.some((s) => s.ctrl.type === 'cpu')) { this.app.toast('Lobby full for this mode'); return; }
    this.joining = this.joining ? 0 : performance.now();
    this.lastTap = null;
    this.joinUi();
    this.app.sfx.play(this.joining ? 'select' : 'back');
  }
  joinUi() {
    this.joinCard.classList.toggle('listening', !!this.joining);
    this.joinBtn.textContent = this.joining ? 'CANCEL' : '+ PLAYER';
    if (this.joinMini) this.joinMini.textContent = this.joining ? 'CANCEL · PRESS A KEY / PAD BUTTON' : '+ PLAYER';
    this.joinMsg.textContent = this.joining ? (Input.isTouchDevice() ? 'PRESS A KEY OR A GAMEPAD BUTTON — OR TAP HERE — TO JOIN' : 'PRESS A KEY OR A GAMEPAD BUTTON — OR CLICK HERE FOR MOUSE — TO JOIN') : '';
  }

  /**
   * Each frame: the device that was just used. In join mode it becomes a new player (unless someone already has it).
   * Nothing else changes anyone's input. Returns true when the press was used up.
   */
  joinFrame() {
    let dev = this.app.input.deviceUsed();
    const tap = this.lastTap; this.lastTap = null;
    if (!dev && tap) dev = tap.type === 'touch' ? { type: 'touch' } : { type: 'mouse' };
    if (this.joining && performance.now() - this.joining > 10000) { this.joining = 0; this.joinUi(); }
    if (!dev) return false;
    if (this.joining) {
      // (someone already on that device — a shared keyboard is fine: it splits into WASD + arrows in join())
      const taken = L.slots.find((s) => specKey(s.ctrl) === specKey(dev!) || (dev!.type === 'mouse' && (s.ctrl.type === 'kb' || s.ctrl.type === 'kb1')));
      if (taken) {
        this.app.toast(`${specLabel(dev)} is already ${taken.name} — use another key set, gamepad or tap`);
        return true;
      }
      if (this.join(dev)) { this.joining = 0; this.joinUi(); return true; }
      return false;
    }
    // (nobody's input changes on its own: only a card's input selector, or joining with + PLAYER, sets it — any other
    // press just works the menus)
    return false;
  }

  removeSlot(i: number) {
    const s = L.slots[i];
    if (s.auto) return;
    if (s.ctrl.type === 'remote') hostRoom.kick(s.ctrl.peer);
    L.slots.splice(i, 1);
    this.fillCpus();
    this.assignTeams();
    this.renderSlots();
    this.dirty = true;
  }

  addCpu() {
    // (a ghost waiting for someone? lock it in as a CPU instead of adding another)
    const ghost = L.slots.findIndex((s) => s.auto);
    if (ghost >= 0) { L.slots[ghost].auto = false; this.renderSlots(); this.flashSlot(ghost); this.dirty = true; this.app.sfx.play('select'); return; }
    if (L.slots.length >= this.mode.maxPlayers) { this.app.toast('Lobby full for this mode'); return; }
    const blade = PRESETS[(L.slots.length * 3) % PRESETS.length];
    L.slots.push({ name: `CPU ${L.slots.length + 1}`, ctrl: { type: 'cpu', level: 2 }, bladeId: blade.id, team: 0 });
    this.fillCpus();
    this.renderSlots();
    this.dirty = true;
    this.app.sfx.play('select');
  }

  join(spec: ControllerSpec) {
    const key = specKey(spec);
    if (L.slots.some((s) => specKey(s.ctrl) === key)) return false;
    // a second keyboard player: whoever had the whole keyboard keeps the other half
    const shared = L.slots.find((s) => s.ctrl.type === 'kb');
    if (shared && (spec.type === 'kb1' || spec.type === 'kb2')) shared.ctrl = { type: spec.type === 'kb1' ? 'kb2' : 'kb1' };
    if (spec.type === 'mouse' && L.slots.some((s) => s.ctrl.type === 'kb' || s.ctrl.type === 'kb1')) return false;
    // replace a CPU if full
    const m = this.mode;
    let idx = L.slots.findIndex((s) => s.auto); // (a ghost's place first)
    if (idx < 0) idx = L.slots.length;
    if (idx === L.slots.length && L.slots.length >= m.maxPlayers) {
      idx = L.slots.findIndex((s) => s.ctrl.type === 'cpu');
      if (idx < 0) return false;
    }
    const blades = allBlades();
    const slot: Slot = { name: spec.type === 'pad' ? `Pad ${spec.index + 1}` : `Player ${idx + 1}`, ctrl: spec, bladeId: blades[(idx * 2 + 1) % blades.length].id, team: idx % 2 };
    if (idx < L.slots.length) L.slots[idx] = { ...slot, team: L.slots[idx].team };
    else L.slots.push(slot);
    this.fillCpus(); // (teams: a ghost evens the numbers out again)
    this.renderSlots();
    this.dirty = true;
    this.app.sfx.play('select');
    this.app.toast(`${specLabel(spec)} joined as P${idx + 1}`);
    return true;
  }

  // -------------------------------------------------------------- your party (online)
  /** member chips: which one's actions are open */
  private openMember: number | null = null;
  private showBlocked = false;
  private editPw = false;

  renderOnline() {
    const el = this.onlineEl;
    // in a party: the party box beside the cards; otherwise the small GO ONLINE box at the end of the rules row
    const inRoom = this.guest || !!hostRoom.t;
    const home = inRoom ? this.midEl : this.bottomEl;
    if (home && el.parentElement !== home) home.append(el);
    this.el?.classList.toggle('in-room', inRoom);
    if (this.guest) { this.renderGuestBox(); return; }
    if (this.ui) this.ui.back.textContent = this.backLabel();
    // typing (party name, password): redraw once they're done instead of wiping the field mid-word
    const typing = el.querySelector<HTMLInputElement>('input:focus');
    if (typing) { typing.addEventListener('blur', () => this.renderOnline(), { once: true }); return; }
    el.innerHTML = '';
    if (hostRoom.t) { if (hostRoom.matchOpen) this.renderMatchBox(el); else this.renderPartyBox(el); return; }
    const p = getPlatform();
    el.append(
      h('div.hint', null, 'PLAY ONLINE — WITH FRIENDS OR A QUICK MATCH'),
      h('div.row', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        h('button.btn.small.primary.nav', { onclick: () => this.openRoom(p && !cloudRelayUrl() ? 'lan' : 'cloud'), title: 'Open your party online: friends join with its code, and you can quick match' }, icon('users'), ' GO ONLINE'),
        p ? h('button.btn.small.nav', { onclick: () => this.openRoom('lan'), title: 'Direct connection on your network' }, 'LAN') : null,
        p ? h('button.btn.small.nav', { onclick: () => this.openRoom('tunnel') }, 'Public Link') : null,
        h('button.btn.small.nav', { onclick: () => this.app.go('online'), title: 'Join a friend\'s party, a public party, or one of your kept parties' }, 'FIND A PARTY')),
    );
  }

  /** the quick match's room (we opened it): who's here, by party, the countdown, the music — no party controls */
  renderMatchBox(el: HTMLElement) {
    const pc = myPartyCode();
    const members = [...hostRoom.members.values()];
    const chip = (name: string, cls = '') => h('div.pm-chip' + cls, null, name);
    const others = [...new Set(members.filter((m) => m.party !== pc).map((m) => m.party ?? ''))];
    el.append(...[
      h('div.hint', null, `QUICK MATCH ROOM · ${this.mode.name.toUpperCase()} · ${members.length + 1} PLAYERS`),
      h('div.pm-row', null, h('span.pm-lbl', null, 'YOUR PARTY'), chip(`${L.slots[0]?.name ?? 'You'} (you)`, '.me'), ...members.filter((m) => m.party === pc).map((m) => chip(clean(m.name)))),
      ...others.map((o) => h('div.pm-row', null, h('span.pm-lbl', null, 'PARTY'), ...members.filter((m) => (m.party ?? '') === o).map((m) => chip(clean(m.name))))),
      this.findBtn(),
      h('div.hint', null, 'Everyone can change the match and press START. ◀ BACK TO YOUR PARTY ends this room — every party goes home.'),
      roomMusicRow(this.app, { song: L.song, by: L.songBy, canSet: true, onSet: (s, radio) => this.setRoomSong(s, (radio ? '📻 ' : '') + (L.slots[0]?.name ?? 'Host'), radio ? RADIO_HOST : null), onCopied: () => this.renderOnline(), onRadio: () => this.renderOnline() }),
    ].filter(Boolean) as Node[]);
  }

  /** the party box: name, code + invite link, quick match, privacy / control / kept code / password, members, music */
  renderPartyBox(el: HTMLElement) {
    const t = hostRoom.t!, info = hostRoom.info;
    const members = [...hostRoom.members.values()];
    const mine = members.filter((m) => m.party === t.code), visitors = members.filter((m) => m.party !== t.code); // (visitors: a friend's party visiting yours)
    const tog = (label: Node | string, on: boolean, title: string, click: () => void) => {
      const b = h('div.toggle.panel.nav', { title, onclick: click }, h('span.dot'), label);
      b.classList.toggle('on', on);
      return b;
    };
    const rname = h<HTMLInputElement>('input.room-name', { type: 'text', value: info.name, maxLength: 32, placeholder: `${L.slots[0]?.name ?? 'My'}'s party`, title: 'Party name — type to rename' });
    rname.addEventListener('change', () => { hostRoom.setInfo({ name: rname.value.trim() }); if (!info.persistent) savePartyPrefs({ name: rname.value.trim() }); this.pushSummary(); this.dirty = true; });
    rname.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') rname.blur(); });
    const ctlNow = hostRoom.openControl;
    const ctl = tog('SHARED CONTROL', ctlNow, 'Shared control: everyone in the party can change mode / arena / rules, quick match and start. Off: only you', () => {
      hostRoom.openControl = !hostRoom.openControl; if (!info.persistent) savePartyPrefs({ open: hostRoom.openControl }); this.app.toast(hostRoom.openControl ? 'Shared control — everyone can drive the party' : 'Only you drive the party');
      this.dirty = true; this.pushSummary(); this.renderOnline();
    });
    const keep = tog('KEEP CODE', info.persistent, info.persistent ? `Kept: ${t.code} is yours — the same code and link every time` : 'Keep this code: the same code and invite link every time you go online', () => {
      if (info.persistent) { this.app.toast('Forget kept parties in JOIN A PARTY → Kept parties'); return; }
      saveMyRoom({ code: t.code, key: newOwnerKey(), name: info.name || `${L.slots[0]?.name ?? 'My'}'s party`, public: info.public, openControl: ctlNow, password: info.password, mode: L.mode, arenaId: L.arenaId, lastUsed: Date.now() });
      setHomePartyCode(t.code);
      hostRoom.setInfo({ persistent: true });
      this.app.toast(`Kept — ${t.code} is your party's code from now on`);
      this.renderOnline();
    });
    const pw = tog(h('span', null, icon('lock'), ' PASSWORD'), !!info.password, info.password ? 'Password on — click to change or remove it' : 'Ask for a password to join (invite links still need it)', () => { this.editPw = !this.editPw || !info.password; this.renderOnline(); });
    const pwIn = h<HTMLInputElement>('input.room-name', { type: 'text', value: info.password, maxLength: 32, placeholder: 'password (empty = none)' });
    const setPw = () => {
      const v = pwIn.value.trim();
      this.editPw = false;
      if (v === info.password) { this.renderOnline(); return; }
      hostRoom.setInfo({ password: v });
      hostRoom.sendParty({ t: 'partycfg', pw: v });
      this.pushSummary();
      this.app.toast(v ? 'Password set — new people need it to join' : 'Password removed');
      this.renderOnline();
    };
    pwIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') pwIn.blur(); if (e.key === 'Escape') { pwIn.value = info.password; pwIn.blur(); } });
    pwIn.addEventListener('change', setPw);
    pwIn.addEventListener('blur', () => { if (this.editPw) setPw(); });

    // members: tap one for REMOVE / BLOCK / MAKE LEADER
    const chip = (m: typeof members[number] | null) => {
      const me = !m, open = m && this.openMember === m.peer;
      const visitor = m && m.party !== t.code;
      const c = h('div.pm-chip' + (me ? '.me' : '') + (visitor ? '.visitor' : '') + (open ? '.open' : ''), { onclick: () => { if (!m) return; this.openMember = open ? null : m.peer; this.renderOnline(); }, title: m ? `${m.name}${visitor ? ' — visiting with a quick match' : ''} — tap for options` : 'You lead the party' },
        me ? icon('crown') : null, me ? `${L.slots[0]?.name ?? 'You'} (you)` : clean(m!.name));
      if (!open || !m) return c;
      return h('div.pm-acts', null, c,
        h('button.btn.small.nav', { onclick: () => { if (!confirmTwice(this.app, 'kick-' + m.peer, `Press again to remove ${m.name}`)) return; this.openMember = null; hostRoom.kick(m.peer); } }, 'REMOVE'),
        h('button.btn.small.nav', { title: 'Remove them and keep this browser out of your parties', onclick: () => { if (!confirmTwice(this.app, 'block-' + m.peer, `Press again to remove and BLOCK ${m.name}`)) return; this.openMember = null; hostRoom.kick(m.peer, true); this.app.toast(`${m.name} is blocked`); } }, 'BLOCK'),
        !visitor && !info.persistent ? h('button.btn.small.nav', { title: 'They lead the party; you stay in it', onclick: () => this.promote(m.peer, m.name) }, 'MAKE LEADER') : null);
    };
    const blocked = party.blocked();
    el.append(...[
      h('div.hint', null, `YOUR PARTY · ${mine.length + 1} ${mine.length ? 'PEOPLE' : 'PERSON'}${visitors.length ? ` + ${visitors.length} VISITING` : ''} · ${t.kind === 'relay-tunnel' ? 'TUNNEL' : t.kind === 'relay-cloud' ? 'ONLINE' : 'LAN'}${info.password ? ' · 🔒' : ''}`),
      rname,
      h('div.code-row', null, h('div.code', null, t.code),
        ...t.invites.slice(1, 2).map((u) => h('div.url', { onclick: () => { navigator.clipboard?.writeText(u); this.app.toast(info.password ? 'Invite link copied — they\'ll need the password too' : 'Invite link copied'); }, title: `${u} — click to copy` }, icon('link'), ' ', u))),
      h('div.pm-row', null, chip(null), ...mine.map((m) => chip(m))),
      ...[...new Set(visitors.map((m) => m.party ?? ''))].map((pc) => h('div.pm-row', null, h('span.pm-lbl', null, 'VISITING'), ...visitors.filter((m) => (m.party ?? '') === pc).map((m) => chip(m)))),
      h('div.party-btns', null, this.findBtn(),
        h('button.btn.small.nav', { onclick: () => this.app.go('online'), title: 'Join a friend\'s party by code or link (yours comes along), or open one of your kept parties' }, 'JOIN A PARTY')),
      h('div.party-togs', null, ctl, keep, pw),
      this.editPw ? pwIn : null,
      blocked.length ? h('div.hint.pm-blocked', { onclick: () => { this.showBlocked = !this.showBlocked; this.renderOnline(); }, style: { cursor: 'pointer' } }, `${this.showBlocked ? '▾' : '▸'} BLOCKED (${blocked.length})`) : null,
      ...(this.showBlocked ? blocked.map((b) => h('div.pm-blk', null, h('span', null, b.name), h('button.btn.small.nav', { onclick: () => { party.unblock(b.id); this.app.toast(`${b.name} unblocked`); this.renderOnline(); } }, 'UNBLOCK'))) : []),
      roomMusicRow(this.app, { song: L.song, by: L.songBy, canSet: true, onSet: (s, radio) => this.setRoomSong(s, (radio ? '📻 ' : '') + (L.slots[0]?.name ?? 'Host'), radio ? RADIO_HOST : null), onCopied: () => this.renderOnline(), onRadio: () => this.renderOnline() }),
    ].filter(Boolean) as Node[]);
    if (this.editPw) queueMicrotask(() => { pwIn.focus(); pwIn.select(); });
  }

  /** MAKE LEADER: they take the party over (it reopens under the same code, with them hosting); you rejoin as a member */
  promote(peer: number, name: string) {
    const t = hostRoom.t;
    if (!t || !confirmTwice(this.app, 'promote-' + peer, `Press again to make ${name} the party leader`)) return;
    promoted = peer;
    this.dirty = true;
    hostRoom.send('all', this.lobbySnapshot());
    hostRoom.send('all', { t: 'promote', heir: peer });
    const code = t.code;
    if (hostRoom.info.password) party.pw.set(code, hostRoom.info.password);
    setTimeout(() => {
      if (queue.active) queue.cancel();
      hostRoom.close();
      L.slots = L.slots.filter((s) => s.ctrl.type !== 'remote');
      party.home = { code, leader: false };
      this.app.toast(`${name} leads the party now`);
      this.app.go('online', { rejoin: code, wait: 30 });
    }, 400);
  }

  /** who takes the party over if the leader goes: the one they promoted, else the first of the party to join */
  heir() {
    const t = hostRoom.t;
    if (!t || hostRoom.matchOpen) return -1;
    if (promoted !== null && hostRoom.members.has(promoted)) return promoted;
    for (const m of hostRoom.members.values()) if (m.party === t.code) return m.peer;
    return -1;
  }

  backLabel() {
    if (this.guest) return `◀ ${leaveLabel()}`;
    if (hostRoom.matchOpen) return '◀ Back to Your Party';
    return hostRoom.t ? (leadsParty() ? '◀ Leave Party' : '◀ Go Offline') : '◀ Back';
  }

  async openRoom(kind: 'lan' | 'tunnel' | 'cloud') {
    const el = this.onlineEl;
    const name = L.slots[0]?.name ?? 'host';
    const o = this.roomOpts;
    const hostOpts = o.code ? { code: o.code, ...(o.key ? { key: o.key } : {}) } : {}; // (a kept party: its code and key; reopening one: its code)
    el.innerHTML = '';
    el.append(h('div.hint', null, `Going online${o.name ? ` — ${o.name}` : ''}…`));
    try {
      const t = await (kind === 'cloud' ? hostCloud(name, hostOpts) : hostLocal(name, kind === 'tunnel', hostOpts));
      if (!this.el?.isConnected || this.guest) { t.close(); return; }
      promoted = null;
      this.cfgSent.clear();
      hostRoom.open(t, { name: o.name, public: false, persistent: o.persistent, password: o.password ?? '' }); // (a party is never listed: friends join by code, strangers by quick match)
      hostRoom.openControl = !!o.openControl;
      hostRoom.matchOpen = !!o.match;
      if (o.password) party.pw.set(t.code, o.password);
      if (!o.match) party.home = { code: t.code, leader: true, opts: currentRoomOpts() };
      this.roomOpts = { name: '', public: false, persistent: false };
      this.pushSummary();
      if (!this.takeover && !o.match) this.app.toast(`Your party ${t.code} is online — share the code!`);
      this.takeover = false;
      if (this.findAfterOpen) { this.findAfterOpen = false; this.findPlayers(); }
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (this.takeover && o.code) { this.takeover = false; this.app.go('online', { rejoin: o.code, wait: 30 }); return; } // (someone else took the party over first: join them)
      this.app.toast(msg === 'room already hosted' ? `${o.code ?? 'This party'} is already open (another tab or device?) — join it from FIND A PARTY instead` : msg);
    }
    this.renderOnline();
  }
  /** opening the party because its leader left and I'm next */
  takeover = false;

  /** keep the public listing / saved room in step with the lobby */
  pushSummary() {
    if (!hostRoom.t) return;
    const m = this.mode;
    const players = L.slots.filter((s) => s.ctrl.type !== 'cpu').length;
    hostRoom.setSummary({ host: L.slots[0]?.name ?? 'Host', mode: L.mode, modeName: m.name, arena: findArena(L.arenaId).name, players, max: m.maxPlayers });
    if (hostRoom.info.persistent) {
      const saved = findMyRoom(hostRoom.t.code);
      if (saved && !hostRoom.matchOpen) saveMyRoom({ ...saved, name: hostRoom.info.name || saved.name, public: false, openControl: hostRoom.openControl, password: hostRoom.info.password, mode: L.mode, arenaId: L.arenaId, lastUsed: Date.now() });
    }
  }

  lobbySnapshot() {
    const arena = findArena(L.arenaId);
    return {
      t: 'lobby', roomName: hostRoom.info.name, public: hostRoom.info.public, persistent: hostRoom.info.persistent, locked: !!hostRoom.info.password, mode: L.mode, random: L.random,
      heir: this.heir(), searching: queue.active ? queue.waited() : '', matchFound: pendingMatch.cur ? pendingMatch.cur.expect : 0,
      matchRoom: hostRoom.matchOpen,
      members: (() => { const code = myPartyCode(), grps: string[] = []; return [...hostRoom.members.values()].map((m) => { const g = m.party === code || !m.party ? 0 : (grps.indexOf(m.party) + 1 || grps.push(m.party)); return { peer: m.peer, name: m.name, mine: g === 0, grp: g }; }); })(), arena: arena.name, arenaId: arena.id, arenaDef: arena.custom ? arena : undefined, arenaDesc: arena.desc, size: SIZE_LABEL[arenaSize(arena)], sizeFilter: L.sizeFilter === 'ALL' ? 'ALL' : SIZE_LABEL[L.sizeFilter],
      startIn: pendingMatch.cur && !hostRoom.inMatch ? this.lastLeft : undefined,
      teamSplit: L.teamSplit,
      items: L.items, target: L.target, time: L.time, nudge: L.nudge, kothShare: L.kothShare, rubber: L.rubber, control: hostRoom.openControl ? 'all' : 'host', leader: L.slots[0]?.name ?? 'Host', song: L.song, songBy: L.songBy, radioBy: L.radioBy,
      slots: L.slots.map((s, i) => ({ name: s.name, ctrl: s.ctrl.type === 'remote' ? `online:${s.ctrl.peer}` : specLabel(s.ctrl), blade: this.bladeOf(s), team: s.team, color: this.slotColor(s, i), lock: !!s.teamLock, auto: !!s.auto })),
    };
  }

  // -------------------------------------------------------------- start / leave
  /** RANDOM: this match's mode (one that fits everyone here) and a course for it */
  rollRandom() {
    const people = L.slots.filter((s) => s.ctrl.type !== 'cpu').length;
    const ok = PICK_MODES.filter((m) => m.id !== 'pinball' && m.maxPlayers >= Math.max(1, people));
    const pick = ok[Math.floor(Math.random() * ok.length)] ?? PICK_MODES[0];
    this.setMode(pick.id);
    L.sizeFilter = 'ALL';
    const order = this.arenaOrder();
    L.arenaId = order[Math.floor(Math.random() * order.length)].id;
    this.fillCpus();
    this.app.toast(`🎲 ${pick.name} · ${findArena(L.arenaId).name}`);
  }

  start() {
    if (this.guestCtl('start')) return;
    pendingMatch.cur = null;
    if (L.random) this.rollRandom();
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
    // pinball with 2+ players: a PINBALL PARTY — free-for-all rules on the table, everyone for themselves
    if (cfg.mode === 'pinball' && cfg.players.length > 1) {
      const ffa = MODES.find((x) => x.id === 'ffa')!;
      Object.assign(cfg, { mode: 'ffa', target: 10, timeLimit: ffa.time, items: L.items });
      cfg.players.forEach((p, i) => (p.team = i));
    }
    // a duel with 3+ blades: free-for-all rules (the arena, target and time stay)
    if (cfg.mode === 'duel' && cfg.players.length > 2) {
      cfg.mode = 'ffa'; // (the target and time are what the lobby shows)
      cfg.players.forEach((p, i) => (p.team = i));
    }
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
    if (this.guest) {
      const label = leaveLabel();
      if (!confirmTwice(this.app, 'leave-room', label === 'Leave Party' ? 'Press again to leave the party' : 'Press again to take your party back home')) return;
      leaveRoom(this.app);
      return;
    }
    if (this.joining) { this.toggleJoin(); return; } // (Esc cancels join mode first)
    if (testRide.from && !hostRoom.t) { this.app.go(testRide.from); return; } // test ride: back to the editor
    if (hostRoom.matchOpen) {
      if (!confirmTwice(this.app, 'close-room', 'Press again to end the match room — every party goes home')) return;
      hostMatchHome(this.app);
      return;
    }
    if (hostRoom.t) {
      const others = leadsParty();
      const heir = [...hostRoom.members.values()].find((m) => m.peer === this.heir());
      if (others && !confirmTwice(this.app, 'close-room', `Press again to leave your party — ${heir?.name ?? 'the next member'} will lead it`)) return;
      if (queue.active) queue.cancel();
      pendingMatch.cur = null;
      hostRoom.close();
      party.home = null;
      L.slots = L.slots.filter((s) => s.ctrl.type !== 'remote');
      this.fillCpus();
      if (others) { this.app.go('menu'); return; }
      this.app.toast('Offline — back to your own lobby');
      this.renderSlots(); this.renderOnline(); this.refresh();
      return;
    }
    this.app.go('menu');
  }

  /** FIND PLAYERS (queue this room for its mode) — or, while searching, how long and CANCEL */
  findBtn() {
    const pm = pendingMatch.cur;
    if (pm && hostRoom.t) return h('div.hint', { style: { color: 'var(--gold)' } }, `MATCH FOUND — waiting for players (${L.slots.filter((s) => s.ctrl.type !== 'cpu').length}/${pm.expect})`);
    if (queue.active) {
      const st = queue.status;
      return h('button.btn.small.nav.qm-searching.qm-live', { onclick: () => queue.cancel(), title: 'Searching for players for this mode — click to stop' }, this.searchText());
    }
    return h('button.btn.small.primary.nav', { onclick: () => this.findPlayers(), title: 'Quick match: find players online for this mode. Your party plays together (your CPUs stay here)' }, icon('bolt'), ` QUICK MATCH · ${L.random ? 'ANY MODE' : this.mode.name.toUpperCase()}`);
  }

  /** the search, as the button says it (updated in place every second — the box isn't rebuilt for it) */
  searchText() {
    const st = queue.status;
    return `SEARCHING ${queue.waited()}${st ? ` · ${L.random ? st.queued : st.modes[L.mode] ?? 0} queued` : ''} · CANCEL`;
  }
  private qmWas = false;
  private guestKey = '';

  /** a guest's party box: whose party (or the room you're visiting with your party), who's in it, the search, the music */
  renderGuestBox() {
    const el = this.onlineEl, lb = clientRoom.lobby, t = clientRoom.t;
    if (!el) return;
    if (this.ui) this.ui.back.textContent = this.backLabel();
    // (the snapshot comes every second while searching / counting down: only the search text changes — patch it, don't
    // rebuild the box, so nothing flickers or replays its animation)
    const searchTxt = lb?.searching ? (this.canCtl ? `SEARCHING ${lb.searching} · CANCEL` : `QUICK MATCH — searching ${lb.searching}`) : '';
    const key = JSON.stringify([t?.code, this.canCtl, clientRoom.busy, L.slots.some((s) => s.mine), L.slots.filter((s) => s.ctrl.type !== 'cpu').length, party.home, lb && { ...lb, searching: !!lb.searching, startIn: undefined, slots: undefined }]);
    const live = el.querySelector('.qm-live');
    if (key === this.guestKey && el.childElementCount && (!searchTxt || live)) { if (live) live.textContent = searchTxt; return; }
    this.guestKey = key;
    el.innerHTML = '';
    if (!t) return;
    const link = publicJoinInput(t.code);
    const song = lb?.song ? acceptSong(lb.song) : null;
    const watching = lb && !L.slots.some((s) => s.mine);
    const away = party.away(t.code);
    const leader = clean(String(lb?.leader ?? 'the leader'));
    const members = (lb?.members ?? []) as { peer: number; name: string; mine: boolean; grp?: number }[];
    const chip = (name: string, cls: string, ic?: string, title = '') => h('div.pm-chip' + cls, { title }, ic ? icon(ic) : null, name);
    const mem = (m: (typeof members)[number]) => chip(m.peer === t.id ? `${m.name} (you)` : clean(m.name), m.peer === t.id ? '.me' : '', m.peer === lb.heir ? 'star' : undefined, m.peer === lb.heir ? 'Leads the party if the leader leaves' : '');
    const myGrp = members.find((m) => m.peer === t.id)?.grp ?? 0;
    const grps = [...new Set(members.map((m) => m.grp ?? 0))].filter((g) => g > 0);
    el.append(...([
      h('div.hint', null, lb?.matchRoom
        ? `QUICK MATCH ROOM · ${this.mode.name.toUpperCase()} · ${leader.toUpperCase()} OPENED IT`
        : away
        ? `VISITING ${lb?.roomName ? clean(String(lb.roomName)).toUpperCase() : `${leader.toUpperCase()}'S PARTY`} WITH YOUR PARTY`
        : `${lb?.roomName ? clean(String(lb.roomName)).toUpperCase() : `${leader.toUpperCase()}'S PARTY`} · ${lb ? (this.canCtl ? 'SHARED CONTROL' : `${leader.toUpperCase()} LEADS`) : 'CONNECTING…'}`),
      lb?.matchRoom ? null : h('div.code-row', null, h('div.code', null, t.code),
        h('div.url', { onclick: () => { navigator.clipboard?.writeText(link); this.app.toast(lb?.locked ? 'Invite link copied — they\'ll need the password too' : 'Invite link copied'); }, title: `${link} — click to copy` }, icon('link'), ' ', link)),
      lb ? h('div.pm-row', null, lb.matchRoom ? h('span.pm-lbl', null, myGrp === 0 ? 'YOUR PARTY' : 'PARTY') : null, chip(leader, '', 'crown', lb.matchRoom ? 'Opened the match room' : 'Party leader'), ...members.filter((m) => !m.grp).map(mem)) : null,
      ...(lb ? grps.map((g) => h('div.pm-row', null, h('span.pm-lbl', null, g === myGrp ? 'YOUR PARTY' : lb.matchRoom ? 'PARTY' : 'VISITING'), ...members.filter((m) => m.grp === g).map(mem))) : []),
      lb?.matchFound ? h('div.hint', { style: { color: 'var(--gold)' } }, `MATCH FOUND — waiting for players (${L.slots.filter((s) => s.ctrl.type !== 'cpu').length}/${lb.matchFound})`)
        : lb?.searching ? (this.canCtl
          ? h('button.btn.small.nav.qm-searching.qm-live', { onclick: () => clientRoom.send({ t: 'ctl', a: 'find' }) }, searchTxt)
          : h('div.hint.qm-live', { style: { color: 'var(--gold)' } }, searchTxt))
        : this.canCtl && !away ? h('button.btn.small.primary.nav', { onclick: () => clientRoom.send({ t: 'ctl', a: 'find' }), title: 'Quick match: the whole party plays together' }, icon('bolt'), ` QUICK MATCH · ${L.random ? 'ANY MODE' : this.mode.name.toUpperCase()}`) : null,
      away ? h('div.hint', null, party.home?.leader ? '◀ BACK TO YOUR PARTY takes your party home.' : 'Your party leader decides when you all go home.') : null,
      watching ? h('div.hint', { style: { color: 'var(--gold)' } }, clientRoom.busy ? 'A match is on — you\'ll join the next one' : 'Full for this mode — you\'ll play when a place frees up') : null,
      clientRoom.busy && !watching ? h('div.hint', { style: { color: 'var(--gold)' } }, 'A match is on — you\'ll join the next one') : null,
      lb ? roomMusicRow(this.app, { song, by: lb.songBy, canSet: this.canCtl, onSet: (s, radio) => clientRoom.send({ t: 'ctl', a: 'song', song: s, radio }), onCopied: () => this.renderOnline(), onRadio: () => this.renderOnline() }) : null,
    ].filter(Boolean) as Node[])); // (leaving: the ◀ button, top left)
  }

  update(dt: number) {
    if (this.guest) {
      this.nav.update(dt);
      this.angle += dt * 2.5;
      this.iconT += dt;
      if (this.iconT > 0.05) { this.iconT = 0; for (const c of this.cards) if (c.d) drawBladeIcon(c.cv, c.d, this.angle * c.d.spinDir); }
      return;
    }
    if (this.joinFrame()) return; // (the press that joined someone doesn't also work the menu)
    this.personalPads(dt);
    this.nav.update(dt);
    this.angle += dt * 2.5;
    this.iconT += dt;
    if (this.iconT > 0.05) { this.iconT = 0; for (const c of this.cards) if (c.d) drawBladeIcon(c.cv, c.d, this.angle * c.d.spinDir); }
    this.matchCountdown();
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

  /** the queue changed (searching, status, cancelled): the room box shows it */
  onQueue = () => {
    if (this.guest) return;
    // (a status tick while searching: just the button's text — no rebuild, no flicker)
    const live = this.onlineEl?.querySelector('.qm-live');
    if (live && queue.active && this.qmWas) live.textContent = this.searchText();
    else this.renderOnline();
    this.qmWas = queue.active;
    this.dirty = true;
  };

  /** QUICK MATCH for the whole room: everyone here (players and online guests) queues for this mode together */
  findPlayers() {
    if (!hostRoom.t) { this.findAfterOpen = true; this.openRoom(getPlatform() && !cloudRelayUrl() ? 'lan' : 'cloud'); return; }
    queue.start({ modes: L.random ? [] : [L.mode], size: Math.max(1, L.slots.filter((s) => s.ctrl.type !== 'cpu').length + [...hostRoom.members.keys()].filter((p) => !L.slots.some((s) => s.ctrl.type === 'remote' && s.ctrl.peer === p)).length), room: hostRoom.t.code, name: L.slots[0]?.name ?? settings.playerName });
    this.dirty = true;
  }
  findAfterOpen = false;
  private lastLeft = -1;

  /** our party was matched into another party's room: we all go there (and come home together afterwards) */
  travelTo(code: string) { partyTravel(this.app, code, 'match'); }

  /** a matched room: start once everyone's in (a short countdown), or when the wait runs out (CPUs fill in) */
  matchCountdown() {
    const pm = pendingMatch.cur;
    if (!pm || !hostRoom.t || hostRoom.inMatch) return;
    const now = performance.now();
    const people = L.slots.filter((s) => s.ctrl.type !== 'cpu').length;
    if (people >= pm.expect && pm.go === undefined) { pm.go = now + MATCH_COUNTDOWN * 1000; this.app.toast(`Everyone's here — starting in ${MATCH_COUNTDOWN}s (anyone can press START)`); }
    const at = Math.min(pm.go ?? Infinity, pm.until);
    const left = Math.max(0, Math.ceil((at - now) / 1000));
    if (this.startBtn) this.startBtn.textContent = `▶ START · ${left}`;
    if (left !== this.lastLeft) { this.lastLeft = left; this.dirty = true; } // (the guests' START shows it too)
    if (now >= at) { pendingMatch.cur = null; this.start(); }
  }

  unmount() {
    queue.listeners.delete(this.onQueue);
    travel.room = null;
    if (this.guest) {
      // (your own lobby comes back as you left it)
      try { Object.assign(L, JSON.parse(this.guestBackup)); } catch { /* ignore */ }
      clientRoom.handler = null;
      this.guest = false;
      this.el.remove();
      return;
    }
    removeEventListener('pointerdown', this.onTap, true);
    this.unsub?.();
    hostRoom.onCtl = null;
    this.el.remove();
  }
}
