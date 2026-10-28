// Title, main menu, mode select, results and settings screens.
import { h, MenuNav, type App, type Screen } from './app';
import { MODES, type ModeId } from '../game/types';
import { getPlatform } from '../net/platform';
import { cloudRelayUrl } from '../net/transport';
import { FINISH_LABEL } from '../game/sim';
import type { MatchSummary } from './match';
import { TEAM_COLORS } from './hud';
import { setBackdropVisible } from './backdrop';
import { Input } from '../input/input';
import { settings } from '../core/settings';
import { icon } from './icons';
import { getRenderer } from '../game/render';

abstract class Base implements Screen {
  app!: App;
  el!: HTMLElement;
  nav: MenuNav | null = null;
  abstract build(arg?: unknown): HTMLElement;
  backdrop = true;
  initialFocus = 0;
  mount(app: App, arg?: unknown) {
    this.app = app;
    setBackdropVisible(this.backdrop, app.canvas);
    this.el = this.build(arg);
    app.root.append(this.el);
    this.nav = new MenuNav(app, this.el, () => this.onBack());
    this.nav.focus(this.initialFocus);
  }
  onBack() { this.app.back(); }
  update(dt: number) { this.nav?.update(dt); }
  unmount() { this.el.remove(); }
}

// ------------------------------------------------------------------ title
export class TitleScreen extends Base {
  t = 0;
  build() {
    const logo = h('div.logo', { 'data-text': 'BITBLADE' }, 'BIT', h('span.x', null, 'B'), 'LADE');
    return h('div.title-screen', { onclick: () => this.start() },
      logo,
      h('div.tagline', null, 'LET IT RIP'),
      h('div.press-start', null, Input.isTouchDevice() ? 'TAP TO START' : 'PRESS START'),
      h('div.title-foot', null, h('span', null, icon('keyboard'), ' KEYBOARD'), h('span', null, icon('mouse'), ' MOUSE'), h('span', null, icon('gamepad'), ' GAMEPADS'), h('span', null, icon('phone'), ' TOUCH + GYRO')),
    );
  }
  start() {
    this.app.sfx.play('select');
    this.app.sfx.music(true);
    this.app.go('menu');
  }
  update(dt: number) {
    this.t += dt;
    const i = this.app.input;
    if (this.t > 0.4 && (i.pressed.size > 0 || i.joinPresses().length || i.mousePressed)) this.start();
  }
}

// ------------------------------------------------------------------ main menu
export class MainMenu extends Base {
  build() {
    const item = (label: string, sub: string, fn: () => void) => h('button.menu-item.nav', { onclick: () => { this.app.sfx.play('select'); fn(); } }, label, h('small', null, sub));
    const p = getPlatform();
    return h('div.menu-screen', null,
      h('div.menu-col', null,
        h('div.menu-logo', null, 'BITBLADE'),
        item('PLAY', 'Local battles · up to 8 players · CPUs', () => this.app.go('modes')),
        item('ONLINE', 'Host a room or join with a code / link', () => this.app.go('online')),
        item('BLADE FORGE', 'Design, paint and tune your blades', () => this.app.go('blades')),
        item('COURSE BUILDER', 'Connect skate pools into custom courses', () => this.app.go('courses')),
        item('SETTINGS', 'Audio · graphics · network', () => this.app.go('settings')),
        p ? item('QUIT', 'Exit to desktop', () => window.close()) : null,
      ),
      h('div.menu-foot', null, 'v0.1 · ', h('span.kbd', null, '↑↓'), ' navigate ', h('span.kbd', null, 'ENTER / A'), ' select ', h('span.kbd', null, 'ESC / B'), ' back'),
    );
  }
  onBack() { this.app.go('title'); }
}

// ------------------------------------------------------------------ mode select
export const MODE_ICON: Record<ModeId, string> = { duel: 'swords', tag: 'users', ffa: 'burst', ctf: 'hex', rush: 'gem', koth: 'crown', gauntlet: 'gear', race: 'finish' };
export class ModeSelect extends Base {
  initialFocus = 1;
  build() {
    return h('div.screen', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.app.back() }, '◀ Back'), h('div.screen-title', null, 'SELECT MODE')),
      h('div.mode-grid', null, ...MODES.map((m, i) => {
        const card = h('div.mode-card.nav', { onclick: () => { this.app.sfx.play('select'); this.app.go('lobby', { mode: m.id }); } },
          h('div.icon', null, icon(MODE_ICON[m.id])), h('div.tag', null, m.tag), h('h3', null, m.name.toUpperCase()), h('p', null, m.desc));
        card.style.animation = `fadeUp 0.4s ${i * 0.05}s both`;
        return card;
      })),
    );
  }
}

// ------------------------------------------------------------------ results
export class Results extends Base {
  build(arg: unknown) {
    const { cfg, state, again } = arg as MatchSummary;
    const w = state.winner;
    const isG = cfg.mode === 'gauntlet';
    const teamName = (t: number) => {
      if (cfg.mode === 'tag' || cfg.mode === 'ctf') return t === 0 ? 'RED TEAM' : 'BLUE TEAM';
      return cfg.players.find((p) => p.team === t)?.name ?? `TEAM ${t + 1}`;
    };
    const wc = w >= 0 ? (cfg.mode === 'tag' || cfg.mode === 'ctf' ? TEAM_COLORS[w] : cfg.players.find((p) => p.team === w)?.blade.glow) : '#fff';
    const banner = isG ? (w === 0 ? 'GAUNTLET CLEAR!' : 'GAUNTLET FAILED') : w === -2 ? 'DRAW!' : w >= 0 ? `${teamName(w)} WINS!` : 'MATCH OVER';
    const banner2 = h('div.res-banner', null, banner);
    banner2.style.setProperty('--wc', wc ?? '#fff');
    if (w >= 0) this.app.sfx.play('win');
    const rows = state.tops.filter((t) => !t.drone).map((t, i) => {
      const score = cfg.mode === 'rush' ? t.crystals : cfg.mode === 'gauntlet' ? t.score : cfg.mode === 'koth' ? Math.floor(state.teamScores[t.team]) : state.teamScores[t.team];
      const tr = h('tr', null,
        h('td', null, h('b', { style: { color: t.color } }, t.name)),
        h('td', null, String(score ?? 0)),
        h('td', null, String(t.kos)),
        h('td', null, `${Math.round(t.dmg * 100)}%`),
        h('td', null, t.alive ? `${Math.round(t.spin * 100)}% spin` : t.out ? FINISH_LABEL[t.out] : '—'));
      if (t.team === w) tr.classList.add('win');
      tr.style.animationDelay = `${0.3 + i * 0.08}s`;
      return tr;
    });
    return h('div.screen.results', null,
      banner2,
      h('div.screen-sub', null, state.lastFinish),
      h('table.res-table', null, h('tr', null, ...['BLADER', 'SCORE', 'KOs', 'DAMAGE DEALT', 'FINAL'].map((x) => h('th', null, x))), ...rows),
      h('div.lobby-bottom', null,
        again ? h('button.btn.primary.nav', { onclick: () => this.app.go('match', again) }, '↻ Rematch') : null,
        h('button.btn.nav', { onclick: () => this.app.go('lobby', { mode: cfg.mode, keep: true }) }, 'Lobby'),
        h('button.btn.nav', { onclick: () => this.app.go('menu') }, 'Main Menu')),
    );
  }
  onBack() { this.app.go('menu'); }
}

// ------------------------------------------------------------------ settings

export class SettingsScreen extends Base {
  initialFocus = 1;
  build() {
    const sfx = this.app.sfx;
    const slider = (label: string, val: number, min: number, max: number, step: number, on: (v: number) => void) => {
      const inp = h<HTMLInputElement>('input.nav', { type: 'range', min, max, step, value: val, 'data-navx': '1' });
      inp.addEventListener('input', () => on(parseFloat(inp.value)));
      inp.addEventListener('navx', (e) => { inp.value = String(parseFloat(inp.value) + (e as CustomEvent).detail * step); on(parseFloat(inp.value)); });
      return h('div.field', null, h('label', null, label), inp);
    };
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const el = h('div.toggle.panel.nav', { onclick: () => { set(!get()); el.classList.toggle('on', get()); } }, h('span.dot'), label);
      el.classList.toggle('on', get());
      return el;
    };
    const relay = h<HTMLInputElement>('input', { type: 'url', placeholder: 'https://bitblade.<you>.workers.dev', value: cloudRelayUrl() });
    relay.addEventListener('change', () => { try { localStorage.setItem('bitblade.cloudRelay', relay.value.trim()); } catch { /* ignore */ } });
    const p = getPlatform();
    return h('div.screen', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.app.back() }, '◀ Back'), h('div.screen-title', null, 'SETTINGS')),
      h('div.panel', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '620px' } },
        slider('SFX VOLUME', sfx.volume, 0, 1, 0.05, (v) => { sfx.volume = v; sfx.save(); }),
        slider('MUSIC VOLUME', sfx.musicVolume, 0, 1, 0.05, (v) => { sfx.musicVolume = v; sfx.save(); }),
        toggle('BLOOM GLOW', () => settings.bloom, (v) => { settings.bloom = v; settings.save(); }),
        toggle('TRAJECTORY PREDICTION', () => settings.trajectories, (v) => { settings.trajectories = v; settings.save(); }),
        slider('RESOLUTION SCALE', settings.pixelRatio, 0.5, 2, 0.25, (v) => { settings.pixelRatio = v; settings.save(); const r = getRenderer(this.app.canvas).renderer; r.setPixelRatio(v); r.setSize(innerWidth, innerHeight); }),
        h('div.field', null, h('label', null, 'CLOUD RELAY URL (Cloudflare Worker)'), relay),
        toggle('GYRO STEERING (touch players)', () => this.app.input.gyro.on, (v) => { if (v) this.app.input.enableGyro(); else this.app.input.gyro.on = false; }),
        h('button.btn.small.nav', { onclick: () => { this.app.input.calibrateGyro(); this.app.toast('Gyro calibrated — hold your phone like this to stand still'); } }, 'Calibrate Gyro'),
        p ? h('button.btn.small.nav', { onclick: () => p.toggleFullscreen() }, 'Toggle Fullscreen (F11)') : h('button.btn.small.nav', { onclick: () => document.documentElement.requestFullscreen?.() }, 'Fullscreen'),
      ),
    );
  }
}
