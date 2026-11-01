// Online: find a party. Your own party is the lobby (ONLINE in the menu opens it); this screen is for going somewhere
// else — a public party, a party by code / invite link (with its password, if it has one), or one of your kept
// parties (same code every time). Leading a party with friends in it, joining a room takes the whole party there.
// It's also where a guest waits to get back in: the leader reopening the party, a match's room opening.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { fetchPublicRooms, publicJoinInput, type PublicRoom } from '../net/transport';
import { parseJoinInput } from '../net/relay';
import { clientRoom, hostRoom } from '../net/room';
import { deleteMyRoom, loadMyRooms, newOwnerKey, newRoomCode, saveMyRoom, type SavedRoom } from '../net/myRooms';
import { homePartyCode, party, setHomePartyCode } from '../net/party';
import { setBackdropVisible } from './backdrop';
import { settings } from '../core/settings';
import { MODES, PICK_MODES, type ModeId } from '../game/types';
import { icon } from './icons';
import { MODE_ICON } from './menus';
import { DENIED_TEXT, goOnline, joinParty } from './partyFlow';
import { leadsParty, partyTravel } from './lobby';

export type { RoomOpts } from '../net/party';

export class OnlineScreen implements Screen {
  app!: App;
  el!: HTMLElement;
  nav!: MenuNav;
  statusEl!: HTMLElement;
  listEl!: HTMLElement;
  myEl!: HTMLElement;
  codeIn!: HTMLInputElement;
  pwIn!: HTMLInputElement;
  pwRow!: HTMLElement;
  rooms: PublicRoom[] = [];
  listErr = '';
  listT = 0;
  modeFilter: 'all' | ModeId = 'all';
  /** waiting to get back in (the party reopening, a match's room opening): until when, and what for */
  wait: { code: string; until: number; label: string } | null = null;
  busy = false;

  mount(app: App, arg?: unknown) {
    this.app = app;
    setBackdropVisible(true, app.canvas);
    const a = (arg ?? {}) as { join?: string; party?: string; resume?: boolean; rejoin?: string; wait?: number; match?: string };
    // (a guest stepping out of a match is still in the room: back to its lobby)
    if (a.resume && clientRoom.t) { queueMicrotask(() => this.app.go('lobby', { guest: true })); this.el = h('div'); this.nav = new MenuNav(app, this.el); return; }
    this.el = this.build(a.join ?? a.party ?? '');
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.back());
    this.nav.focus(1);
    if (a.match) this.waitFor(a.match, 25, 'MATCH FOUND — joining', 'visit');
    else if (a.rejoin) this.waitFor(a.rejoin, a.wait ?? 30, 'Getting back into the party', 'member');
    else if (a.join || a.party) this.join();
    this.refreshList();
  }

  build(prefill: string) {
    const name = h<HTMLInputElement>('input', { type: 'text', value: settings.playerName, maxLength: 16 });
    name.addEventListener('change', () => { settings.playerName = name.value; settings.save(); });
    this.codeIn = h<HTMLInputElement>('input', { type: 'text', placeholder: 'ABCDE  or  https://bitblade.bitbased.net/join/ABCDE', value: prefill });
    this.codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
    this.pwIn = h<HTMLInputElement>('input', { type: 'password', placeholder: 'only if the party has one', maxLength: 32 });
    this.pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
    this.pwRow = h('div.field', null, h('label', null, 'PASSWORD'), this.pwIn);
    this.statusEl = h('div.online-status');
    this.listEl = h('div.room-list');
    this.myEl = h('div.room-list');
    this.renderMyRooms();
    const filter = h<HTMLSelectElement>('select', null, h('option', { value: 'all' }, 'All modes'), ...PICK_MODES.map((m) => h('option', { value: m.id }, m.name)));
    filter.value = this.modeFilter;
    filter.addEventListener('change', () => { this.modeFilter = filter.value as 'all' | ModeId; this.renderList(); });
    const leading = leadsParty();
    const col = (w: string, ...kids: (Node | null)[]) => h('div.panel', { style: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', width: w, flex: '1 1 auto' } }, ...kids);
    return h('div.screen', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.back() }, hostRoom.t ? '◀ Your Party' : '◀ Back'), h('div.screen-title', null, 'ONLINE'),
        h('div.screen-sub', null, leading ? 'Joining a party takes your whole party there — you come home together' : 'Join a party · public parties · your kept parties'),
        h('div.spacer'), hostRoom.t ? null : h('button.btn.primary.nav', { onclick: () => goOnline(this.app) }, icon('users'), ' MY PARTY')),
      h('div.online-grid', null,
        col('min(520px, 100%)',
          h('div.row-head', null, h('h3', null, 'PUBLIC PARTIES'), h('div.spacer'), filter, h('button.btn.small.nav', { onclick: () => this.refreshList(true) }, '↻')),
          this.listEl),
        col('min(420px, 100%)',
          h('h3', null, 'JOIN A PARTY'),
          h('div.field', null, h('label', null, 'YOUR NAME'), name),
          h('div.field', null, h('label', null, 'PARTY CODE OR INVITE LINK'), this.codeIn),
          this.pwRow,
          h('button.btn.primary.nav', { onclick: () => this.join() }, leading ? 'TAKE MY PARTY ▶' : 'JOIN ▶'),
          clientRoom.lastJoin ? h('button.btn.small.nav', { onclick: () => { this.codeIn.value = clientRoom.lastJoin!; this.join(); }, title: clientRoom.lastJoin }, `↻ Last party (${clientRoom.lastJoin.split('/').pop()!.toUpperCase()})`) : null,
          this.statusEl),
        col('min(420px, 100%)',
          h('h3', null, 'KEPT PARTIES'),
          h('div.hint', null, 'A kept party has the same code and invite link every time. Your HOME party is the one ONLINE opens.'),
          this.myEl,
          h('button.btn.small.nav', { onclick: () => this.newKept() }, '+ NEW KEPT PARTY'))),
    );
  }

  status(msg: string, color = '') {
    this.statusEl.innerHTML = '';
    if (msg) this.statusEl.append(h('div.hint', { style: { color } }, msg));
  }

  back() {
    if (this.wait) { this.wait = null; this.status(''); return; }
    if (hostRoom.t) this.app.go('lobby', { keep: true });
    else if (clientRoom.t) this.app.go('lobby', { guest: true });
    else this.app.go('menu');
  }

  /** JOIN: your party goes there together (if you lead one with friends in it), or it becomes your party */
  async join(input = this.codeIn.value) {
    if (this.busy) return;
    if (!input.trim()) { this.app.toast('Enter a party code or link'); return; }
    let code: string;
    try { code = parseJoinInput(input).code; } catch (e) { this.status(String((e as Error).message || e), 'var(--red)'); return; }
    if (this.pwIn.value) party.pw.set(code, this.pwIn.value);
    this.busy = true;
    this.status('Connecting…');
    const why = leadsParty() ? await partyTravel(this.app, input, 'room') : await joinParty(this.app, input, { alive: () => this.el.isConnected });
    this.busy = false;
    if (!why || !this.el.isConnected) return;
    if (why === 'password' || why === 'wrong password') { this.pwIn.focus(); this.pwRow.classList.add('need'); }
    this.status(DENIED_TEXT[why] ?? `Could not join: ${why}`, 'var(--red)');
  }

  /** keep trying to get in: a match's room opening, the party being reopened (by its leader, or whoever takes over) */
  async waitFor(code: string, secs: number, label: string, as: 'member' | 'visit') {
    this.wait = { code, until: performance.now() + secs * 1000, label };
    this.renderWait();
    const why = await joinParty(this.app, code, { as, retryMs: secs * 1000, alive: () => !!this.wait && this.el.isConnected });
    if (!this.el.isConnected || why === 'cancelled') return;
    this.wait = null;
    if (!why) return;
    if (as === 'member' && party.home?.code === code) party.home = null;
    this.status(why === 'no host' ? 'The party didn\'t come back.' : DENIED_TEXT[why] ?? `Could not get back in: ${why}`, 'var(--red)');
  }

  renderWait() {
    if (!this.wait) return;
    const left = Math.max(0, Math.ceil((this.wait.until - performance.now()) / 1000));
    this.statusEl.innerHTML = '';
    this.statusEl.append(
      h('div.hint', { style: { color: 'var(--gold)' } }, `${this.wait.label} ${this.wait.code}… (${left}s)`),
      h('button.btn.small.nav', { onclick: () => { this.wait = null; this.status(''); } }, 'Stop waiting'));
  }

  // -------------------------------------------------------------- public parties
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

  renderList() {
    const el = this.listEl;
    el.innerHTML = '';
    if (this.listErr) { el.append(h('div.hint', { style: { color: 'var(--red)' } }, this.listErr)); return; }
    const list = this.rooms.filter((r) => this.modeFilter === 'all' || r.mode === this.modeFilter);
    if (!list.length) {
      el.append(h('div.hint', null, this.rooms.length ? 'No public parties for this mode right now.' : 'No public parties right now — make yours PUBLIC in your party, or use QUICK MATCH there.'));
      return;
    }
    const mine = new Set(loadMyRooms().map((x) => x.code));
    for (const r of list) {
      const full = r.players >= r.max;
      el.append(h('div.room-row.nav', { onclick: () => { this.codeIn.value = publicJoinInput(r.code); if (r.locked && !this.pwIn.value) { this.pwRow.classList.add('need'); this.pwIn.focus(); this.status('This party needs a password', 'var(--gold)'); return; } this.join(); }, title: `Join ${r.name}` },
        h('div.rr-icon', null, icon(MODE_ICON[r.mode as ModeId] ?? 'users')),
        h('div.rr-main', null,
          h('b', null, r.name || `${r.host}'s party`, r.locked ? h('span.rr-tag', null, icon('lock'), ' PASSWORD') : null, mine.has(r.code) ? h('span.rr-tag.yours', null, 'YOURS') : r.persistent ? h('span.rr-tag', null, 'KEPT') : null),
          h('span', null, `${r.modeName || r.mode} · ${r.arena} · ${r.openControl ? 'shared control' : `led by ${r.host}`}`)),
        h('div.rr-side', null,
          h('b', { style: { color: full ? 'var(--red)' : 'var(--accent)' } }, `${r.players}/${r.max}`),
          h('span', null, r.inMatch ? 'IN MATCH' : full ? 'FULL' : 'IN LOBBY'))));
    }
  }

  // -------------------------------------------------------------- kept parties
  /** a new kept party: a fixed code (and key) of your own, opened right away */
  newKept() {
    const code = newRoomCode();
    const r: SavedRoom = { code, key: newOwnerKey(), name: `${settings.playerName || 'My'}'s party`, public: false, openControl: false, mode: 'duel', arenaId: '', lastUsed: Date.now() };
    saveMyRoom(r);
    if (!homePartyCode()) setHomePartyCode(code);
    this.renderMyRooms();
    this.app.toast(`Kept party ${code} saved${homePartyCode() === code ? ' — it\'s your home party' : ''}`);
  }

  renderMyRooms() {
    const el = this.myEl;
    if (el.querySelector('.rr-rename')) return; // don't wipe a rename in progress (the list refreshes every few seconds)
    el.innerHTML = '';
    const mine = loadMyRooms();
    if (!mine.length) { el.append(h('div.hint', null, 'None yet — KEEP CODE in your party saves it here.')); return; }
    const homeCode = homePartyCode();
    for (const r of mine) {
      const mode = MODES.find((m) => m.id === r.mode);
      const live = this.rooms.find((x) => x.code === r.code) || (hostRoom.t?.code === r.code ? {} : null);
      const nameEl = h('span.rr-name', null, r.name);
      const isHome = r.code === homeCode;
      el.append(h('div.room-row', null,
        h('div.rr-icon', null, icon(isHome ? 'star' : MODE_ICON[r.mode as ModeId] ?? 'users')),
        h('div.rr-main', null, h('b', null, nameEl, isHome ? h('span.rr-tag.yours', null, 'HOME') : null, r.password ? h('span.rr-tag', null, icon('lock')) : null, live ? h('span.rr-tag.live', null, 'OPEN') : null),
          h('span', null, `CODE ${r.code} · ${mode?.name ?? r.mode}${r.openControl ? ' · shared control' : ''}`)),
        h('div.rr-side.row', null,
          h('button.btn.small.primary.nav', { title: 'Open it as your party', onclick: () => this.openKept(r) }, hostRoom.t?.code === r.code ? 'GO' : 'OPEN'),
          h('button.btn.small.nav' + (isHome ? '.on' : ''), { title: isHome ? 'Your home party: ONLINE opens it — click to open a fresh party instead' : 'Make this your home party: ONLINE opens it', onclick: () => { setHomePartyCode(isHome ? '' : r.code); this.renderMyRooms(); } }, icon('star')),
          h('button.btn.small.nav', { title: 'Rename', onclick: () => this.renameSaved(r, nameEl) }, 'RENAME'),
          h('button.btn.small.nav', { title: 'Copy invite link', onclick: () => { navigator.clipboard?.writeText(publicJoinInput(r.code)); this.app.toast('Invite link copied'); } }, icon('link')),
          h('button.btn.small.nav', { title: 'Forget this party', onclick: () => { if (!confirmTwice(this.app, 'del-room-' + r.code, `Press again to forget ${r.name} (its code is released only on this device)`)) return; deleteMyRoom(r.code); if (isHome) setHomePartyCode(''); this.renderMyRooms(); } }, icon('close')))));
    }
  }

  /** open a kept party as yours (your current party closes — or, if it's this one, just go back to it) */
  openKept(r: SavedRoom) {
    if (hostRoom.t?.code === r.code) { this.app.go('lobby', { keep: true }); return; }
    if (leadsParty() && !confirmTwice(this.app, 'switch-party', 'Press again to close your party and open this one — your friends will need the new code')) return;
    if (hostRoom.t) hostRoom.close();
    if (clientRoom.t) clientRoom.leave();
    saveMyRoom({ ...r, lastUsed: Date.now() });
    this.app.go('lobby', { keep: true, online: true, arenaId: r.arenaId || undefined, room: { name: r.name, public: r.public, persistent: true, code: r.code, key: r.key, openControl: r.openControl, password: r.password ?? '' } });
  }

  /** inline rename: Enter / click away saves, Esc cancels */
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

  update(dt: number) {
    this.nav.update(dt);
    if (!this.listEl) return;
    this.listT -= dt;
    if (this.listT <= 0) this.refreshList();
    if (this.wait && Math.floor(performance.now() / 1000) !== Math.floor((performance.now() - dt * 1000) / 1000)) this.renderWait();
  }

  unmount() {
    this.wait = null;
    this.el.remove();
  }
}

