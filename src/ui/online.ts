// Online hub: host (goes to lobby) or join a room by code / invite link. Joined players wait in the room
// and follow the room leader into every match; with Open Control they can drive the room too.
import { h, MenuNav, type App, type Screen } from './app';
import { allBlades, findBlade, type BladeDesign } from '../core/blade';
import { joinAny } from '../net/transport';
import { clientRoom } from '../net/room';
import { setBackdropVisible, setBackdropArena } from './backdrop';
import { drawBladeIcon } from './lobby';
import { settings } from '../core/settings';
import { MODES, type ModeId } from '../game/types';
import { icon } from './icons';
import { MODE_ICON } from './menus';
import type { MatchArg } from './match';

export class OnlineScreen implements Screen {
  app!: App;
  el!: HTMLElement;
  nav!: MenuNav;
  roomEl!: HTMLElement;
  myBlade: BladeDesign = allBlades()[0];
  icon: HTMLCanvasElement | null = null;
  angle = 0;
  lastArena = '';

  mount(app: App, arg?: unknown) {
    this.app = app;
    setBackdropVisible(true, app.canvas);
    const a = (arg ?? {}) as { join?: string; resume?: boolean };
    try { this.myBlade = findBlade(localStorage.getItem('bitblade.lastBlade') || ''); } catch { /* ignore */ }
    this.el = this.buildHub(a.join ?? '');
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.leave());
    this.nav.focus(1);
    if (a.resume && clientRoom.t) { this.listen(); this.renderRoom(); }
    else if (a.join) this.join(a.join);
  }

  buildHub(prefill: string) {
    const name = h<HTMLInputElement>('input', { type: 'text', value: settings.playerName, maxLength: 16 });
    name.addEventListener('change', () => { settings.playerName = name.value; settings.save(); });
    const code = h<HTMLInputElement>('input', { type: 'text', placeholder: 'ABCDE  or  https://bitblade.bitbased.net/join/ABCDE', value: prefill });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(code.value); });
    this.roomEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    return h('div.screen', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.leave() }, '◀ Back'), h('div.screen-title', null, 'ONLINE'), h('div.screen-sub', null, 'Rooms: the leader picks, everyone follows')),
      h('div', { style: { display: 'flex', gap: '24px', flexWrap: 'wrap', overflowY: 'auto' } },
        h('div.panel', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px', width: 'min(460px, 100%)' } },
          h('h3', null, 'CREATE A ROOM'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
            ...MODES.map((m) => h('button.btn.small.nav', { onclick: () => this.app.go('lobby', { mode: m.id, online: true }) }, icon(MODE_ICON[m.id]), ` ${m.name}`))),
          h('div.hint', null, 'You become the room leader. Share the code; switch modes and arenas between matches and the whole room follows. Turn on OPEN CONTROL to let anyone drive.')),
        h('div.panel', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px', width: 'min(540px, 100%)' } },
          h('h3', null, 'JOIN A ROOM'),
          h('div.field', null, h('label', null, 'YOUR NAME'), name),
          h('div.field', null, h('label', null, 'ROOM CODE OR INVITE LINK'), code),
          h('button.btn.primary.nav', { onclick: () => this.join(code.value) }, 'JOIN ▶'),
          this.roomEl)),
    );
  }

  listen() {
    clientRoom.handler = (m) => {
      if (m?.t === 'lobby' || m?.t === 'busy') this.renderRoom();
      else if (m?.t === 'full') this.app.toast('Room is full for this mode — you\'ll join when a slot frees up');
      else if (m?.t === 'start' && clientRoom.t) {
        const arg: MatchArg = { cfg: m.cfg, client: { t: clientRoom.t, mine: m.mine } };
        this.app.go('match', arg);
      }
    };
    clientRoom.closeHandler = (r) => { this.app.toast(`Disconnected: ${r}`); this.renderRoom(); };
  }

  async join(input: string) {
    if (!input.trim()) { this.app.toast('Enter a room code or link'); return; }
    this.roomEl.innerHTML = '';
    this.roomEl.append(h('div.hint', null, 'Connecting…'));
    try {
      const t = await joinAny(input, settings.playerName || 'Guest');
      clientRoom.attach(t);
      this.listen();
      clientRoom.send({ t: 'hello', name: settings.playerName || 'Guest', blade: this.myBlade });
      this.renderRoom();
      this.app.sfx.play('select');
    } catch (e) {
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
    el.append(h('div.hint', { style: { color: 'var(--accent)' } }, `IN ROOM ${clientRoom.t.code}`), row);
    if (!lobby) { el.append(h('div.hint', null, clientRoom.busy ? 'A match is in progress — you\'ll join the next one.' : 'Waiting for the room…')); return; }
    if (lobby.arenaId && lobby.arenaId !== this.lastArena) { this.lastArena = lobby.arenaId; setBackdropArena(lobby.arenaDef ?? lobby.arenaId, lobby.mode as ModeId); }
    const mode = MODES.find((x) => x.id === lobby.mode);
    const canCtl = lobby.control === 'all';
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
      h('div.hint', null, canCtl ? 'OPEN CONTROL — anyone can change the room and start.' : `Room leader: ${lobby.leader}. Waiting for them to start…`),
      canCtl ? h('button.btn.primary.nav', { onclick: () => clientRoom.send({ t: 'ctl', a: 'start' }) }, '▶ START MATCH') : null,
      h('div.hint', null, `PLAYERS (${lobby.slots.length})`),
      ...lobby.slots.map((s: any) => h('div', { style: { color: s.color, fontFamily: 'var(--font-h)', fontSize: '13px' } }, `● ${s.name} — ${s.blade?.name ?? ''}${String(s.ctrl).startsWith('CPU') ? ' (CPU)' : ''}`)),
      h('button.btn.small.nav', { onclick: () => { clientRoom.leave(); this.renderRoom(); this.app.toast('Left the room'); } }, 'Leave Room'),
    ].filter(Boolean) as Node[]));
  }

  leave() {
    clientRoom.leave();
    this.app.go('menu');
  }

  update(dt: number) {
    this.nav.update(dt);
    this.angle += dt * 2.5;
    if (this.icon) drawBladeIcon(this.icon, this.myBlade, this.angle * this.myBlade.spinDir);
  }

  unmount() {
    clientRoom.handler = null;
    clientRoom.closeHandler = null;
    this.el.remove();
  }
}
