// Online hub: browse public rooms / quick match, host (goes to lobby) — fresh, public, or one of your saved
// persistent rooms — or join by code / invite link. Joined players wait in the room and follow the room
// leader into every match; with Open Control they can drive the room too.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { allBlades, findBlade, type BladeDesign } from '../core/blade';
import { fetchPublicRooms, joinAny, publicJoinInput, type PublicRoom } from '../net/transport';
import { clientRoom } from '../net/room';
import { cleanCode, deleteMyRoom, loadMyRooms, newOwnerKey, newRoomCode, saveMyRoom, type SavedRoom } from '../net/myRooms';
import { setBackdropVisible, setBackdropArena } from './backdrop';
import { drawBladeIcon } from './lobby';
import { settings } from '../core/settings';
import { MODES, type ModeId } from '../game/types';
import { icon } from './icons';
import { MODE_ICON } from './menus';
import type { MatchArg } from './match';
import { acceptSong, armRadio, roomMusicRow } from './roomMusic';

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
    const a = (arg ?? {}) as { join?: string; resume?: boolean; rejoin?: string };
    try { this.myBlade = findBlade(localStorage.getItem('bitblade.lastBlade') || ''); } catch { /* ignore */ }
    this.el = this.buildHub(a.join ?? '');
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.leave());
    this.nav.focus(1);
    if (a.resume && clientRoom.t) { this.listen(); this.renderRoom(); }
    else if (a.join) this.join(a.join);
    else if (a.rejoin) this.startRetry(a.rejoin);
    this.refreshList();
  }

  buildHub(prefill: string) {
    const prefs = loadPrefs();
    const name = h<HTMLInputElement>('input', { type: 'text', value: settings.playerName, maxLength: 16 });
    name.addEventListener('change', () => { settings.playerName = name.value; settings.save(); });
    const code = h<HTMLInputElement>('input', { type: 'text', placeholder: 'ABCDE  or  https://bitblade.bitbased.net/join/ABCDE', value: prefill });
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
    const filter = h<HTMLSelectElement>('select', null, h('option', { value: 'all' }, 'All modes'), ...MODES.map((m) => h('option', { value: m.id }, m.name)));
    filter.value = this.modeFilter;
    filter.addEventListener('change', () => { this.modeFilter = filter.value as 'all' | ModeId; this.renderList(); });

    const col = (w: string, ...kids: (Node | null)[]) => h('div.panel', { style: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', width: w, flex: '1 1 auto' } }, ...kids);
    return h('div.screen', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.leave() }, '◀ Back'), h('div.screen-title', null, 'ONLINE'), h('div.screen-sub', null, 'Public rooms · quick match · your saved rooms'),
        h('div.spacer'), h('button.btn.primary.nav', { onclick: () => this.quickMatch() }, icon('bolt'), ' QUICK MATCH')),
      h('div.online-grid', null,
        col('min(520px, 100%)',
          h('div.row-head', null, h('h3', null, 'PUBLIC ROOMS'), h('div.spacer'), filter, h('button.btn.small.nav', { onclick: () => this.refreshList(true) }, '↻')),
          this.listEl),
        col('min(420px, 100%)',
          h('h3', null, 'JOIN A ROOM'),
          h('div.field', null, h('label', null, 'YOUR NAME'), name),
          h('div.field', null, h('label', null, 'ROOM CODE OR INVITE LINK'), code),
          h('button.btn.primary.nav', { onclick: () => this.join(code.value) }, 'JOIN ▶'),
          clientRoom.lastJoin ? h('button.btn.small.nav', { onclick: () => this.join(clientRoom.lastJoin!), title: clientRoom.lastJoin }, `↻ Rejoin last room (${clientRoom.lastJoin.split('/').pop()!.toUpperCase()})`) : null,
          this.roomEl),
        col('min(420px, 100%)',
          h('h3', null, 'HOST A ROOM'),
          h('div.field', null, h('label', null, 'ROOM NAME'), roomName),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, pub, openCtl, keep),
          customRow,
          h('div.hint', null, 'Pick a mode to open the room. You lead: switch modes and arenas between matches and everyone follows.'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
            ...MODES.map((m) => h('button.btn.small.nav', { onclick: () => create(m.id) }, icon(MODE_ICON[m.id]), ` ${m.name}`))),
          h('h3', { style: { marginTop: '8px' } }, 'MY ROOMS'),
          this.myEl)),
    );
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

  /** join the busiest public room that has a free slot (lobby first); otherwise offer to host one */
  async quickMatch() {
    await this.refreshList();
    const open = this.filtered().filter((r) => r.players < r.max);
    const pick = open.find((r) => !r.inMatch) ?? open[0];
    if (pick) { this.app.toast(`Quick match: ${pick.name || pick.code}`); this.join(publicJoinInput(pick.code)); return; }
    const mode: ModeId = this.modeFilter === 'all' ? 'ffa' : this.modeFilter;
    if (!confirmTwice(this.app, 'qm-host', 'No open public rooms — press QUICK MATCH again to host a public one')) return;
    this.app.go('lobby', { mode, online: true, room: { name: '', public: true, persistent: false } satisfies RoomOpts });
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

  async join(input: string, quiet = false) {
    if (!input.trim()) { this.app.toast('Enter a room code or link'); return; }
    if (!quiet) { this.retry = null; this.roomEl.innerHTML = ''; this.roomEl.append(h('div.hint', null, 'Connecting…')); }
    try {
      const t = await joinAny(input, settings.playerName || 'Guest');
      this.retry = null;
      clientRoom.attach(t);
      clientRoom.remember(input.trim());
      this.listen();
      clientRoom.send({ t: 'hello', name: settings.playerName || 'Guest', blade: this.myBlade });
      this.renderRoom();
      this.app.sfx.play('select');
    } catch (e) {
      if (quiet) return;
      this.roomEl.innerHTML = '';
      this.roomEl.append(h('div.hint', { style: { color: 'var(--red)' } }, `Could not join: ${(e as Error).message || e}`));
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
      // (my room radio, if I switched it on: the next pick goes to the room once this song's had its time)
      if (song && canCtl) armRadio(this.app, (n) => clientRoom.send({ t: 'ctl', a: 'song', song: n, radio: true }));
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
    clientRoom.handler = null;
    clientRoom.closeHandler = null;
    this.el.remove();
  }
}
