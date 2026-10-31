// Online: party first. Your party (a party of one is just you; friends join with its code or link) goes everywhere
// together — the leader picks QUICK MATCH, hosts a room (fresh, public, or a saved one) or joins one by code / link /
// the public list, and the members follow. Then: rooms, and the lobby (the same screen for host and guests).
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { allBlades, findBlade, type BladeDesign } from '../core/blade';
import { fetchPublicRooms, joinAny, publicJoinInput, type PublicRoom } from '../net/transport';
import { clientRoom } from '../net/room';
import { cleanCode, deleteMyRoom, loadMyRooms, newOwnerKey, newRoomCode, saveMyRoom, type SavedRoom } from '../net/myRooms';
import { setBackdropVisible, setBackdropArena } from './backdrop';
import { drawBladeIcon } from './lobby';
import { settings } from '../core/settings';
import { MODES, PICK_MODES, type ModeId } from '../game/types';
import { icon } from './icons';
import { MODE_ICON } from './menus';
import type { MatchArg } from './match';
import { acceptSong, onRoomSong, roomMusicRow } from './roomMusic';
import { quickMatchBox } from './quickMatch';
import { party } from '../net/party';
import { queue } from '../net/queue';

/** what the lobby needs to open a room the way the hub set it up */
export interface RoomOpts { name: string; public: boolean; persistent: boolean; code?: string; key?: string; openControl?: boolean }

const PREF_KEY = 'bitblade.roomPrefs';
type Prefs = { name: string; public: boolean; keep: boolean; open: boolean };
function loadPrefs(): Prefs {
  const d: Prefs = { name: '', public: false, keep: false, open: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return d; }
}
function savePrefs(p: Prefs) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

export class OnlineScreen implements Screen {
  app!: App;
  el!: HTMLElement;
  nav!: MenuNav;
  roomEl!: HTMLElement;
  listEl!: HTMLElement;
  myEl!: HTMLElement;
  myBlade: BladeDesign = allBlades()[0];
  icon: HTMLCanvasElement | null = null;
  angle = 0;
  lastArena = '';
  lastSong: string | null | undefined = undefined;
  rooms: PublicRoom[] = [];
  listErr = '';
  listT = 0;
  modeFilter: 'all' | ModeId = 'all';
  /** host left: keep trying to rejoin (persistent rooms come back with the same code) */
  retry: { input: string; until: number; next: number } | null = null;

  mount(app: App, arg?: unknown) {
    this.app = app;
    setBackdropVisible(true, app.canvas);
    const a = (arg ?? {}) as { join?: string; resume?: boolean; rejoin?: string; match?: string; party?: string };
    try { this.myBlade = findBlade(localStorage.getItem('bitblade.lastBlade') || ''); } catch { /* ignore */ }
    this.el = this.buildHub(a.join ?? '');
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.leave());
    this.nav.focus(1);
    party.listeners.add(this.renderParty);
    this.renderParty();
    if (a.party) this.joinParty(a.party);
    // in a room: it's shown in the lobby (the same screen the host uses)
    if (a.resume && clientRoom.t) { queueMicrotask(() => this.app.go('lobby', { guest: true })); return; }
    else if (a.match) this.joinMatch(a.match);
    else if (a.join) this.join(a.join);
    else if (a.rejoin) this.startRetry(a.rejoin);
    this.refreshList();
  }

  buildHub(prefill: string) {
    const prefs = loadPrefs();
    const name = h<HTMLInputElement>('input', { type: 'text', value: settings.playerName, maxLength: 16 });
    name.addEventListener('change', () => { settings.playerName = name.value; settings.save(); party.rename(name.value); });
    const code = h<HTMLInputElement>('input', { type: 'text', placeholder: 'Room code or invite link', value: prefill, style: { flex: '1', minWidth: '0' } });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(code.value); });
    this.roomEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });

    // ---- create
    const roomName = h<HTMLInputElement>('input', { type: 'text', value: prefs.name, maxLength: 32, placeholder: `${settings.playerName || 'Your'}'s room` });
    const custom = h<HTMLInputElement>('input', { type: 'text', maxLength: 10, placeholder: 'auto (e.g. K7QM2X)' });
    custom.addEventListener('input', () => { custom.value = cleanCode(custom.value); });
    const pub = this.toggle('PUBLIC', 'List this room in Public Rooms so anyone can find and join it', prefs.public, () => persist());
    const keep = this.toggle('KEEP ROOM', 'Save it to My Rooms with a fixed code and invite link you can reopen any time', prefs.keep, () => { persist(); customRow.style.display = keep.classList.contains('on') ? '' : 'none'; });
    const openCtl = this.toggle('OPEN CONTROL', 'Let everyone in the room change mode / arena and start matches (you can change this any time in the lobby)', prefs.open, () => persist());
    const customRow = h('div.field', { style: { display: prefs.keep ? '' : 'none' } }, h('label', null, 'ROOM CODE (4-10 LETTERS / DIGITS)'), custom);
    const persist = () => savePrefs({ name: roomName.value, public: pub.classList.contains('on'), keep: keep.classList.contains('on'), open: openCtl.classList.contains('on') });
    roomName.addEventListener('change', persist);
    const create = (mode: ModeId) => {
      const isKeep = keep.classList.contains('on');
      const opts: RoomOpts = { name: roomName.value.trim(), public: pub.classList.contains('on'), persistent: isKeep, openControl: openCtl.classList.contains('on') };
      if (isKeep) {
        const c = custom.value || newRoomCode();
        if (c.length < 4) { this.app.toast('Room codes need at least 4 letters / digits'); return; }
        opts.code = c; opts.key = newOwnerKey();
        saveMyRoom({ code: c, key: opts.key, name: opts.name || `${settings.playerName || 'My'}'s room`, public: opts.public, openControl: !!opts.openControl, mode, arenaId: '', lastUsed: Date.now() });
      }
      this.app.go('lobby', { mode, online: true, room: opts });
    };

    this.listEl = h('div.room-list');
    this.myEl = h('div.room-list');
    this.renderMyRooms();
    const filter = h<HTMLSelectElement>('select', null, h('option', { value: 'all' }, 'All modes'), ...PICK_MODES.map((m) => h('option', { value: m.id }, m.name)));
    filter.value = this.modeFilter;
    filter.addEventListener('change', () => { this.modeFilter = filter.value as 'all' | ModeId; this.renderList(); });

    const col = (w: string, ...kids: (Node | null)[]) => h('div.panel', { style: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', width: w, flex: '1 1 auto' } }, ...kids);
    const hub = h('div.screen.online', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.leave() }, '◀ Back'), h('div.screen-title', null, 'ONLINE'), h('div.screen-sub', null, 'Your party · quick match · rooms')),
      h('div.online-grid', null,
        col('min(520px, 100%)',
          h('div.row-head', null, h('h3', null, 'PUBLIC ROOMS'), h('div.spacer'), filter, h('button.btn.small.nav', { onclick: () => this.refreshList(true) }, '↻')),
          this.listEl,
          h('h3', { style: { marginTop: '8px' } }, 'MY ROOMS'),
          this.myEl),
      ),
    );
    // PLAY (the party leader — or you, solo): quick match, host a room, join a room. Members follow instead.
    this.qm = quickMatchBox(this.app);
    this.playEl = h('div.play-inner', null,
      h('h3', null, icon('bolt'), ' QUICK MATCH'),
      this.qm.el,
      h('h3', { style: { marginTop: '6px' } }, 'HOST A ROOM'),
      h('div.field', null, h('label', null, 'ROOM NAME'), roomName),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, pub, openCtl, keep),
      customRow,
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
        ...PICK_MODES.map((m) => h('button.btn.small.nav', { onclick: () => create(m.id) }, icon(MODE_ICON[m.id]), ` ${m.name}`))),
      h('h3', { style: { marginTop: '6px' } }, 'JOIN A ROOM'),
      h('div.row', { style: { display: 'flex', gap: '8px' } }, code, h('button.btn.small.primary.nav', { onclick: () => this.join(code.value) }, 'JOIN ▶')),
      clientRoom.lastJoin ? h('button.btn.small.nav', { onclick: () => this.join(clientRoom.lastJoin!), title: clientRoom.lastJoin }, `↻ Rejoin last room (${clientRoom.lastJoin.split('/').pop()!.toUpperCase()})`) : null);
    this.followEl = h('div.party-follow');
    this.partyEl = h('div.party-box');
    const grid = hub.querySelector('.online-grid')!;
    grid.prepend(
      col('min(380px, 100%)', h('h3', null, icon('users'), ' YOUR PARTY'), this.partyEl, h('div.field', null, h('label', null, 'YOUR NAME'), name)),
      col('min(460px, 100%)', h('h3.play-title', null, 'PLAY'), this.followEl, this.playEl, this.roomEl));
    return hub;
  }

  toggle(label: string, title: string, on: boolean, changed: () => void) {
    const el = h('div.toggle.panel.nav', { title, onclick: () => { el.classList.toggle('on'); changed(); } }, h('span.dot'), label);
    el.classList.toggle('on', on);
    return el;
  }

  // -------------------------------------------------------------- public rooms
  async refreshList(manual = false) {
    this.listT = 5;
    try {
      this.rooms = await fetchPublicRooms();
      this.listErr = '';
    } catch (e) {
      this.listErr = String((e as Error).message || e);
    }
    if (this.el?.isConnected) { this.renderList(); this.renderMyRooms(); }
    if (manual) this.app.sfx.play('tick');
  }

  filtered() { return this.rooms.filter((r) => this.modeFilter === 'all' || r.mode === this.modeFilter); }

  renderList() {
    const el = this.listEl;
    el.innerHTML = '';
    if (this.listErr) { el.append(h('div.hint', { style: { color: 'var(--red)' } }, this.listErr)); return; }
    const list = this.filtered();
    if (!list.length) {
      el.append(h('div.hint', null, this.rooms.length ? 'No public rooms for this mode right now.' : 'No public rooms right now — host one and tick PUBLIC, or hit QUICK MATCH.'));
      return;
    }
    const mine = new Set(loadMyRooms().map((x) => x.code));
    for (const r of list) {
      const full = r.players >= r.max;
      el.append(h('div.room-row.nav', { onclick: () => this.join(publicJoinInput(r.code)), title: `Join ${r.name}` },
        h('div.rr-icon', null, icon(MODE_ICON[r.mode as ModeId] ?? 'users')),
        h('div.rr-main', null,
          h('b', null, r.name || `${r.host}'s room`, mine.has(r.code) ? h('span.rr-tag.yours', null, 'YOURS') : r.persistent ? h('span.rr-tag', null, 'SAVED') : null),
          h('span', null, `${r.modeName || r.mode} · ${r.arena} · ${r.openControl ? 'OPEN CONTROL — anyone can drive' : `host ${r.host} leads`}`)),
        h('div.rr-side', null,
          h('b', { style: { color: full ? 'var(--red)' : 'var(--accent)' } }, `${r.players}/${r.max}`),
          h('span', null, r.inMatch ? 'IN MATCH' : full ? 'FULL' : 'IN LOBBY'))));
    }
  }

  // -------------------------------------------------------------- your party
  qm: { el: HTMLElement; dispose: () => void } | null = null;
  partyEl!: HTMLElement;
  playEl!: HTMLElement;
  followEl!: HTMLElement;
  partyBusy = false;

  /** YOUR PARTY: who's in it, its code / link, invite / join / leave — and, for members, who they're following */
  renderParty = () => {
    const el = this.partyEl;
    if (!el) return;
    const typing = el.querySelector<HTMLInputElement>('input');
    if (typing && document.activeElement === typing) return; // (don't wipe a code being typed)
    el.innerHTML = '';
    const member = party.inParty && !party.leads;
    if (this.playEl) this.playEl.style.display = member ? 'none' : '';
    if (this.followEl) {
      this.followEl.innerHTML = '';
      this.followEl.style.display = member ? '' : 'none';
      if (member) this.followEl.append(
        h('div.party-following', null, icon('users'), ` Following ${party.leaderName}`),
        h('div.hint', null, party.room ? `In room ${party.room} — joining…` : `${party.leaderName} picks the game: quick match, a room, or a code. You'll go wherever they go.`));
    }
    if (party.reconnecting) { el.append(h('div.hint', { style: { color: 'var(--gold)' } }, 'Your party leader dropped — reconnecting the party…')); return; }
    if (!party.inParty) {
      const pc = h<HTMLInputElement>('input', { type: 'text', placeholder: 'Party code', maxLength: 10, style: { flex: '1', minWidth: '0' } });
      pc.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.joinParty(pc.value); });
      el.append(
        h('div.party-member.me', null, h('span.pm-dot'), h('b', null, settings.playerName || 'You'), h('span.pm-tag', null, 'YOU')),
        h('div.hint', null, 'Playing with friends? Make a party and send them the code — they come with you into every room and match.'),
        h('button.btn.primary.nav', { onclick: () => this.createParty() }, icon('users'), ' MAKE A PARTY'),
        h('div.row', { style: { display: 'flex', gap: '8px' } }, pc, h('button.btn.small.nav', { onclick: () => this.joinParty(pc.value) }, 'JOIN PARTY')));
      return;
    }
    el.append(...party.members.map((m, i) => h('div.party-member' + (m.id === party.myId ? '.me' : ''), null,
      h('span.pm-dot'), h('b', null, m.name),
      i === 0 ? h('span.pm-tag.lead', null, '♛ LEADER') : null,
      m.id === party.myId ? h('span.pm-tag', null, 'YOU') : null,
      party.leads && m.id !== party.myId ? h('button.pm-kick.nav', { title: `Remove ${m.name} from the party`, onclick: () => { if (confirmTwice(this.app, 'kick-' + m.id, `Press again to remove ${m.name}`)) party.kick(m.id); } }, icon('close')) : null)));
    const link = party.link();
    el.append(
      h('div.code-row', null, h('div.code', null, party.code),
        h('div.url', { onclick: () => { navigator.clipboard?.writeText(link); this.app.toast('Party invite link copied'); }, title: `${link} — click to copy` }, icon('link'), ' ', link)),
      h('div.hint', null, party.leads ? (party.size > 1 ? 'You lead: where you go, your party goes.' : 'Send the code or link — friends who join come along with you.') : `${party.leaderName} leads the party.`),
      h('button.btn.small.nav', { onclick: () => { if (!confirmTwice(this.app, 'leave-party', party.leads && party.size > 1 ? 'Press again to leave — the next member takes over the party' : 'Press again to leave the party')) return; party.leave(); this.app.toast('You left the party'); } }, 'LEAVE PARTY'));
  };

  async createParty() {
    if (this.partyBusy) return;
    this.partyBusy = true;
    try { await party.create(settings.playerName || 'Player'); this.app.toast(`Party ${party.code} — send friends the code or link`); }
    catch (e) { this.app.toast(`Couldn't make a party: ${(e as Error).message || e}`); }
    this.partyBusy = false;
  }

  async joinParty(code: string) {
    code = code.trim().toUpperCase();
    if (!code) { this.app.toast('Enter a party code'); return; }
    if (this.partyBusy) return;
    this.partyBusy = true;
    try { await party.join(code, settings.playerName || 'Player'); this.app.toast(`Joined ${party.leaderName}'s party`); }
    catch (e) { this.app.toast(`Couldn't join party ${code}: ${(e as Error).message || e}`); }
    this.partyBusy = false;
  }

  // -------------------------------------------------------------- my rooms
  renderMyRooms() {
    const el = this.myEl;
    if (el.querySelector('.rr-rename')) return; // don't wipe a rename in progress (the list refreshes every few seconds)
    el.innerHTML = '';
    const mine = loadMyRooms();
    if (!mine.length) { el.append(h('div.hint', null, 'Tick KEEP ROOM when hosting to save a room with a fixed code and link.')); return; }
    for (const r of mine) {
      const mode = MODES.find((m) => m.id === r.mode);
      // already open (e.g. in another tab): join it instead of trying to host it twice
      const live = this.rooms.find((x) => x.code === r.code);
      const nameEl = h('span.rr-name', null, r.name);
      el.append(h('div.room-row', null,
        h('div.rr-icon', null, icon(MODE_ICON[r.mode as ModeId] ?? 'users')),
        h('div.rr-main', null, h('b', null, nameEl, live ? h('span.rr-tag.live', null, 'LIVE') : r.public ? h('span.rr-tag', null, 'PUBLIC') : null), h('span', null, live ? `CODE ${r.code} · open now · ${live.players}/${live.max} players` : `CODE ${r.code} · ${mode?.name ?? r.mode}`)),
        h('div.rr-side.row', null,
          live
            ? h('button.btn.small.primary.nav', { title: 'This room is already open — join it', onclick: () => this.join(publicJoinInput(r.code)) }, 'JOIN')
            : h('button.btn.small.primary.nav', { onclick: () => this.openSaved(r) }, 'OPEN'),
          h('button.btn.small.nav' + (r.openControl ? '.on' : ''), { title: r.openControl ? 'Open Control: everyone can drive — click for leader only' : 'Leader only — click to let everyone drive (Open Control)', onclick: () => { saveMyRoom({ ...r, openControl: !r.openControl }); this.app.toast(r.openControl ? `${r.name}: leader only` : `${r.name}: Open Control on`); this.renderMyRooms(); } }, r.openControl ? 'CTRL: ALL' : 'CTRL: HOST'),
          h('button.btn.small.nav', { title: 'Rename this room', onclick: () => this.renameSaved(r, nameEl) }, 'RENAME'),
          h('button.btn.small.nav', { title: 'Copy invite link', onclick: () => { navigator.clipboard?.writeText(publicJoinInput(r.code)); this.app.toast('Invite link copied'); } }, icon('link')),
          h('button.btn.small.nav', { title: 'Forget this room', onclick: () => { if (!confirmTwice(this.app, 'del-room-' + r.code, `Press again to forget ${r.name} (its code is released only on this device)`)) return; deleteMyRoom(r.code); this.renderMyRooms(); } }, icon('close')))));
    }
  }

  /** inline rename: Enter / click away saves, Esc cancels. A live room picks up the new name next time it's opened. */
  renameSaved(r: SavedRoom, nameEl: HTMLElement) {
    const inp = h<HTMLInputElement>('input.rr-rename', { type: 'text', value: r.name, maxLength: 32 });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      inp.remove();
      const v = inp.value.trim();
      if (save && v && v !== r.name) { saveMyRoom({ ...r, name: v }); this.app.toast(`Renamed to ${v}`); }
      this.renderMyRooms();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', (e) => e.stopPropagation());
    nameEl.replaceWith(inp);
    inp.focus();
    inp.select();
  }

  openSaved(r: SavedRoom) {
    saveMyRoom({ ...r, lastUsed: Date.now() });
    const opts: RoomOpts = { name: r.name, public: r.public, persistent: true, code: r.code, key: r.key, openControl: r.openControl };
    this.app.go('lobby', { mode: r.mode as ModeId, arenaId: r.arenaId || undefined, online: true, room: opts });
  }

  // -------------------------------------------------------------- joined room
  listen() {
    clientRoom.handler = (m) => {
      if (m?.t === 'lobby' || m?.t === 'busy') this.renderRoom();
      else if (m?.t === 'full') this.app.toast('Room is full for this mode — you\'ll join when a slot frees up');
      else if (m?.t === 'start' && clientRoom.t) {
        const arg: MatchArg = { cfg: m.cfg, client: { t: clientRoom.t, mine: m.mine } };
        this.app.go('match', arg);
      }
    };
    clientRoom.closeHandler = (r) => {
      if (r === 'Host left' && clientRoom.lastJoin) { this.startRetry(clientRoom.lastJoin); return; }
      this.app.toast(`Disconnected: ${r}`);
      this.renderRoom();
    };
  }

  startRetry(input: string) {
    this.retry = { input, until: performance.now() + 180_000, next: performance.now() + 4000 };
    this.renderRetry();
  }

  renderRetry() {
    const el = this.roomEl;
    if (!this.retry) return;
    el.innerHTML = '';
    const left = Math.max(0, Math.ceil((this.retry.until - performance.now()) / 1000));
    el.append(
      h('div.hint', { style: { color: 'var(--gold)' } }, `HOST LEFT — waiting for the room to come back… (${left}s)`),
      h('div.hint', null, 'Saved rooms reopen with the same code, so you\'ll drop straight back in.'),
      h('button.btn.small.nav', { onclick: () => { this.retry = null; this.roomEl.innerHTML = ''; } }, 'Stop waiting'));
  }

  /** a match from the queue: the host is opening the room right now — keep trying for a little while */
  async joinMatch(code: string) {
    const until = performance.now() + 20_000;
    this.roomEl.innerHTML = '';
    this.roomEl.append(h('div.hint', { style: { color: 'var(--gold)' } }, `MATCH FOUND — joining room ${code}…`));
    while (this.el.isConnected && performance.now() < until) {
      if (await this.join(code, true)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!this.el.isConnected) return;
    this.roomEl.innerHTML = '';
    this.roomEl.append(h('div.hint', { style: { color: 'var(--red)' } }, 'The match\'s room didn\'t open — try QUICK MATCH again'));
  }

  async join(input: string, quiet = false): Promise<boolean> {
    if (!input.trim()) { this.app.toast('Enter a room code or link'); return false; }
    if (!quiet && party.inParty && !party.leads && input.trim().toUpperCase() !== party.room) { this.app.toast(`${party.leaderName} picks the rooms — leave the party to go on your own`); return false; }
    if (!quiet) { this.retry = null; this.roomEl.innerHTML = ''; this.roomEl.append(h('div.hint', null, 'Connecting…')); }
    try {
      const t = await joinAny(input, settings.playerName || 'Guest');
      this.retry = null;
      clientRoom.attach(t);
      clientRoom.remember(input.trim());
      this.listen();
      clientRoom.send({ t: 'hello', name: settings.playerName || 'Guest', blade: this.myBlade, party: party.code || undefined });
      this.app.sfx.play('select');
      this.app.go('lobby', { guest: true });
      return true;
    } catch (e) {
      if (quiet) return false;
      this.roomEl.innerHTML = '';
      this.roomEl.append(h('div.hint', { style: { color: 'var(--red)' } }, `Could not join: ${(e as Error).message || e}`));
      return false;
    }
  }

  renderRoom() {
    const el = this.roomEl;
    el.innerHTML = '';
    if (!clientRoom.t) return;
    const lobby = clientRoom.lobby;
    const blades = allBlades();
    this.icon = h<HTMLCanvasElement>('canvas', { width: 160, height: 160, style: { width: '80px', height: '80px' } });
    const cycle = (d: number) => {
      const k = blades.findIndex((b) => b.id === this.myBlade.id);
      this.myBlade = blades[(k + d + blades.length) % blades.length];
      try { localStorage.setItem('bitblade.lastBlade', this.myBlade.id); } catch { /* ignore */ }
      clientRoom.send({ t: 'blade', blade: this.myBlade });
      this.renderRoom();
    };
    const row = h('div.selector.panel.nav', { 'data-navx': '1' }, h('button.arrow', { onclick: () => cycle(-1) }, '◀'), this.icon, h('div.val', null, h('b', null, this.myBlade.name), h('span', null, 'your blade')), h('button.arrow', { onclick: () => cycle(1) }, '▶'));
    row.addEventListener('navx', (e) => cycle((e as CustomEvent).detail));
    el.append(h('div.hint', { style: { color: 'var(--accent)' } }, lobby?.roomName ? `IN ${String(lobby.roomName).toUpperCase()} · ${clientRoom.t.code}` : `IN ROOM ${clientRoom.t.code}`), row);
    if (!lobby) { el.append(h('div.hint', null, clientRoom.busy ? 'A match is in progress — you\'ll join the next one.' : 'Waiting for the room…')); return; }
    if (lobby.arenaId && lobby.arenaId !== this.lastArena) { this.lastArena = lobby.arenaId; setBackdropArena(lobby.arenaDef ?? lobby.arenaId, lobby.mode as ModeId); }
    const mode = MODES.find((x) => x.id === lobby.mode);
    const canCtl = lobby.control === 'all';
    // the room's song plays for everyone in the room
    const song = lobby.song ? acceptSong(lobby.song) : null;
    if ((song?.id ?? null) !== this.lastSong) {
      this.lastSong = song?.id ?? null;
      if (song) this.app.sfx.playSong(song, this.app.sfx.player?.song?.id !== song.id); else this.app.sfx.useMusic('menu');
      // (only one radio runs: mine keeps going if it picked this song; anyone else's pick switches mine off)
      if (song) onRoomSong(this.app, lobby.radioBy, (n) => clientRoom.send({ t: 'ctl', a: 'song', song: n, radio: true }));
    }
    const ctl = (a: string, label: string, val: string, sub: string) => {
      const send = (d: number) => clientRoom.send({ t: 'ctl', a, d });
      const sel = h('div.selector.panel' + (canCtl ? '.nav' : ''), { 'data-navx': canCtl ? '1' : undefined },
        h('span.lbl', null, label),
        canCtl ? h('button.arrow', { onclick: () => send(-1) }, '◀') : null,
        h('div.val', null, h('b', null, val), h('span', null, sub)),
        canCtl ? h('button.arrow', { onclick: () => send(1) }, '▶') : null);
      if (canCtl) sel.addEventListener('navx', (e) => send((e as CustomEvent).detail));
      return sel;
    };
    el.append(...([
      ctl('mode', 'MODE', (mode?.name ?? lobby.mode).toUpperCase(), mode?.tag ?? ''),
      ctl('size', 'SIZE', lobby.sizeFilter ?? 'ALL', ''),
      ctl('arena', 'ARENA', String(lobby.arena).toUpperCase(), `${lobby.size ?? ''} · ${lobby.arenaDesc ?? ''}`),
      roomMusicRow(this.app, { song, by: lobby.songBy, canSet: canCtl, onSet: (s, radio) => clientRoom.send({ t: 'ctl', a: 'song', song: s, radio }), onCopied: () => this.renderRoom(), onRadio: () => this.renderRoom() }),
      h('div.hint', null, canCtl ? 'OPEN CONTROL — anyone can change the room and start.' : `Room leader: ${lobby.leader}. Waiting for them to start…`),
      canCtl ? h('button.btn.primary.nav', { onclick: () => clientRoom.send({ t: 'ctl', a: 'start' }) }, '▶ START MATCH') : null,
      h('div.hint', null, `PLAYERS (${lobby.slots.length})`),
      ...lobby.slots.map((s: any) => h('div', { style: { color: s.color, fontFamily: 'var(--font-h)', fontSize: '13px' } }, `● ${s.name} — ${s.blade?.name ?? ''}${String(s.ctrl).startsWith('CPU') ? ' (CPU)' : ''}`)),
      h('button.btn.small.nav', { onclick: () => { if (!confirmTwice(this.app, 'leave-room', 'Press again to leave the room')) return; clientRoom.leave(); this.renderRoom(); this.app.toast('Left the room — use Rejoin to come back'); } }, 'Leave Room'),
    ].filter(Boolean) as Node[]));
  }

  leave() {
    if (clientRoom.t && !confirmTwice(this.app, 'leave-room', `You're in room ${clientRoom.t.code} — press again to leave it`)) return;
    clientRoom.leave();
    this.app.go('menu');
  }

  update(dt: number) {
    this.nav.update(dt);
    this.angle += dt * 2.5;
    if (this.icon) drawBladeIcon(this.icon, this.myBlade, this.angle * this.myBlade.spinDir);
    // live public list while browsing
    this.listT -= dt;
    if (this.listT <= 0) this.refreshList();
    if (this.retry) {
      const now = performance.now();
      if (now > this.retry.until) { this.retry = null; this.roomEl.innerHTML = ''; this.roomEl.append(h('div.hint', null, 'The room didn\'t come back. Try Rejoin later.')); }
      else {
        if (now > this.retry.next) { this.retry.next = now + 5000; this.join(this.retry.input, true); }
        if (Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) this.renderRetry();
      }
    }
  }

  unmount() {
    party.listeners.delete(this.renderParty);
    this.qm?.dispose();
    clientRoom.handler = null;
    clientRoom.closeHandler = null;
    this.el.remove();
  }
}
