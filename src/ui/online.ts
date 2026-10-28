// Online hub: host (goes to lobby) or join a room by code / invite link, then wait in the host's lobby.
import { h, MenuNav, type App, type Screen } from './app';
import { allBlades, findBlade, type BladeDesign } from '../core/blade';
import { joinAny, type ClientTransport } from '../net/transport';
import { setBackdropVisible } from './backdrop';
import { drawBladeIcon } from './lobby';
import { settings } from '../core/settings';
import { MODES } from '../game/types';
import type { MatchArg } from './match';

export class OnlineScreen implements Screen {
  app!: App;
  el!: HTMLElement;
  nav!: MenuNav;
  t: ClientTransport | null = null;
  lobbyEl: HTMLElement | null = null;
  myBlade: BladeDesign = allBlades()[0];
  icon: HTMLCanvasElement | null = null;
  angle = 0;
  starting = false;

  mount(app: App, arg?: unknown) {
    this.app = app;
    setBackdropVisible(true, app.canvas);
    const a = (arg ?? {}) as { join?: string };
    try { this.myBlade = findBlade(localStorage.getItem('bitblade.lastBlade') || ''); } catch { /* ignore */ }
    this.el = this.buildHub(a.join ?? '');
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.leave());
    this.nav.focus(1);
    if (a.join) this.join(a.join);
  }

  buildHub(prefill: string) {
    const name = h<HTMLInputElement>('input', { type: 'text', value: settings.playerName, maxLength: 16 });
    name.addEventListener('change', () => { settings.playerName = name.value; settings.save(); });
    const code = h<HTMLInputElement>('input', { type: 'text', placeholder: 'ABCDE  or  https://….trycloudflare.com/join/ABCDE', value: prefill });
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(code.value); });
    return h('div.screen', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.leave() }, '◀ Back'), h('div.screen-title', null, 'ONLINE'), h('div.screen-sub', null, 'Experimental — host-authoritative netcode')),
      h('div', { style: { display: 'flex', gap: '24px', flexWrap: 'wrap' } },
        h('div.panel', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px', width: 'min(460px, 100%)' } },
          h('h3', null, 'HOST A ROOM'),
          h('div.hint', null, 'Opens a lobby. Choose LAN (direct), Public Link (Cloudflare tunnel, desktop app) or Cloud (Worker relay) in the lobby\'s invite box.'),
          ...MODES.filter((m) => m.maxPlayers > 1).slice(0, 4).map((m) => h('button.btn.nav', { onclick: () => this.app.go('lobby', { mode: m.id }) }, `Host ${m.name}`))),
        h('div.panel', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px', width: 'min(520px, 100%)' } },
          h('h3', null, 'JOIN A ROOM'),
          h('div.field', null, h('label', null, 'YOUR NAME'), name),
          h('div.field', null, h('label', null, 'ROOM CODE OR INVITE LINK'), code),
          h('button.btn.primary.nav', { onclick: () => this.join(code.value) }, 'JOIN ▶'),
          this.lobbyEl = h('div'))),
    );
  }

  async join(input: string) {
    if (!input.trim()) { this.app.toast('Enter a room code or link'); return; }
    this.lobbyEl!.innerHTML = '';
    this.lobbyEl!.append(h('div.hint', null, 'Connecting…'));
    try {
      this.t?.close();
      const t = await joinAny(input, settings.playerName || 'Guest');
      this.t = t;
      t.onMessage((m) => this.onMsg(m));
      t.onClose((r) => { if (!this.starting) { this.app.toast(`Disconnected: ${r}`); this.renderWaiting(null); } });
      t.send({ t: 'hello', name: settings.playerName || 'Guest', blade: this.myBlade });
      this.renderWaiting(null);
      this.app.sfx.play('select');
    } catch (e) {
      this.lobbyEl!.innerHTML = '';
      this.lobbyEl!.append(h('div.hint', { style: { color: 'var(--red)' } }, `Could not join: ${(e as Error).message || e}`));
    }
  }

  onMsg(m: any) {
    if (m?.t === 'lobby') this.renderWaiting(m);
    else if (m?.t === 'full') this.app.toast('Room is full');
    else if (m?.t === 'start' && this.t) {
      this.starting = true;
      const arg: MatchArg = { cfg: m.cfg, client: { t: this.t, mine: m.mine } };
      this.t = null; // ownership passes to the match
      this.app.go('match', arg);
    }
  }

  renderWaiting(lobby: any) {
    const el = this.lobbyEl!;
    el.innerHTML = '';
    if (!this.t) return;
    const blades = allBlades();
    this.icon = h<HTMLCanvasElement>('canvas', { width: 160, height: 160, style: { width: '80px', height: '80px' } });
    const cycle = (d: number) => {
      const k = blades.findIndex((b) => b.id === this.myBlade.id);
      this.myBlade = blades[(k + d + blades.length) % blades.length];
      try { localStorage.setItem('bitblade.lastBlade', this.myBlade.id); } catch { /* ignore */ }
      this.t?.send({ t: 'blade', blade: this.myBlade });
      this.renderWaiting(lobby);
    };
    const row = h('div.selector.panel.nav', { 'data-navx': '1' }, h('button.arrow', { onclick: () => cycle(-1) }, '◀'), this.icon, h('div.val', null, h('b', null, this.myBlade.name), h('span', null, 'your blade')), h('button.arrow', { onclick: () => cycle(1) }, '▶'));
    row.addEventListener('navx', (e) => cycle((e as CustomEvent).detail));
    el.append(h('div.hint', { style: { color: 'var(--accent)' } }, `CONNECTED · ROOM ${this.t.code}`), row);
    if (lobby) {
      const mode = MODES.find((x) => x.id === lobby.mode);
      el.append(h('div.hint', null, `${mode?.name ?? lobby.mode} · ${lobby.arena} · waiting for host to start…`));
      for (const s of lobby.slots) el.append(h('div', { style: { color: s.color, fontFamily: 'var(--font-h)', fontSize: '13px' } }, `● ${s.name} — ${s.blade?.name ?? ''}`));
    } else el.append(h('div.hint', null, 'Waiting for lobby…'));
  }

  leave() {
    this.t?.close();
    this.t = null;
    this.app.go('menu');
  }

  update(dt: number) {
    this.nav.update(dt);
    this.angle += dt * 2.5;
    if (this.icon) drawBladeIcon(this.icon, this.myBlade, this.angle * this.myBlade.spinDir);
  }

  unmount() {
    if (!this.starting) this.t?.close();
    this.el.remove();
  }
}
