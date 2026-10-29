// Title, main menu, mode select, results and settings screens.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { allSongs, loadCustomSongs, musicPrefs, saveCustomSongs, saveMusicPrefs, songById, surpriseSong } from '../game/music';
import { MODES, type ModeId } from '../game/types';
import { getPlatform, isInstalledApp, quitApp } from '../net/platform';
import { cloudRelayUrl } from '../net/transport';
import { FINISH_LABEL, fmtTime } from '../game/sim';
import type { MatchSummary } from './match';
import { TEAM_COLORS } from './hud';
import { setBackdropVisible, unpinBackdrop } from './backdrop';
import { Input } from '../input/input';
import { settings } from '../core/settings';
import { clientRoom, hostRoom } from '../net/room';
import { editorName, testRide } from './testRide';
import { icon } from './icons';
import { getRenderer } from '../game/render';
import { lobbySession } from './lobby';

abstract class Base implements Screen {
  app!: App;
  el!: HTMLElement;
  nav: MenuNav | null = null;
  abstract build(arg?: unknown): HTMLElement;
  backdrop = true;
  initialFocus = 0;
  mount(app: App, arg?: unknown) {
    this.app = app;
    app.sfx.useMusic('menu');
    setBackdropVisible(this.backdrop, app.canvas);
    if (!(this instanceof Results)) unpinBackdrop();
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
      (this.corner = new MusicCorner(this.app, '.on-title')).el,
      h('div.title-foot', null, h('span', null, icon('keyboard'), ' KEYBOARD'), h('span', null, icon('mouse'), ' MOUSE'), h('span', null, icon('gamepad'), ' GAMEPADS'), h('span', null, icon('phone'), ' TOUCH + GYRO')),
    );
  }
  start() {
    this.app.sfx.play('select');
    this.app.sfx.music(true);
    this.app.go('menu');
  }
  corner: MusicCorner | null = null;
  update(dt: number) {
    this.t += dt;
    this.corner?.watch();
    const i = this.app.input;
    const musicClick = performance.now() - ((this.app as unknown as { musicClick?: number }).musicClick ?? 0) < 400;
    if (this.t > 0.4 && !musicClick && (i.pressed.size > 0 || i.joinPresses().length || i.mousePressed)) this.start();
  }
  unmount() { this.corner?.dispose(); super.unmount(); }
}


/**
 * The music corner (main menu + title screen): what's playing, 🎲 a brand-new surprise song every press (not
 * saved), 📻 radio (new surprise songs keep coming), and while a surprise plays: 💾 keep it, ✕ usual music.
 */
export class MusicCorner {
  el: HTMLElement;
  constructor(private app: App, extraClass = '') {
    this.extra = extraClass;
    this.el = this.build();
  }
  private extra: string;
  refresh() { const n = this.build(); this.el.replaceWith(n); this.el = n; }
  /** radio / random switched songs by itself: show the new name */
  private live = false;
  watch() {
    this.app.sfx.onSongChange = () => { if (this.el.isConnected) this.refresh(); };
    if (this.app.sfx.musicLive !== this.live) { this.live = this.app.sfx.musicLive; if (this.el.isConnected) this.refresh(); }
  }
  dispose() { this.app.sfx.onSongChange = null; }
  build(): HTMLElement {
    const sfx = this.app.sfx;
    const on = musicPrefs.menu === 'surprise';
    const song = on ? sfx.surprise : songById(musicPrefs.menu);
    const saved = !!song && loadCustomSongs().some((s) => s.id === song.id);
    const redo = () => this.refresh();
    const roll = () => {
      sfx.music(true); // (the title screen starts silent)
      if (!on) musicPrefs.menuPrev = musicPrefs.menu;
      musicPrefs.menu = 'surprise'; saveMusicPrefs();
      sfx.surprise = surpriseSong(); sfx.useMusic('menu'); redo();
    };
    const el = h('div.music-chip' + this.extra, {
      // the title screen starts on any click: these clicks are for the music, not for 'press start'
      onpointerdown: (e: Event) => { e.stopPropagation(); this.app.sfx.ensure(); this.app.sfx.ctx?.resume(); this.app.sfx.music(true); this.app.sfx.useMusic('menu'); this.app.input.mousePressed = 0; (this.app as unknown as { musicClick?: number }).musicClick = performance.now(); },
      onmousedown: (e: Event) => e.stopPropagation(), // (the game's 'any press' listener watches mousedown too)
      onclick: (e: Event) => e.stopPropagation(),
    },
      !sfx.musicLive && musicPrefs.menu !== 'off'
        ? h('button.mm-play.nav', { title: 'Browsers wait for a click before playing sound — tap to start the music', onclick: () => { this.app.sfx.ensure(); void this.app.sfx.ctx?.resume().then(() => this.refresh()); this.app.sfx.music(true); this.app.sfx.useMusic('menu'); this.refresh(); } },
            h('b', null, icon('play')), h('span', null, h('i', null, 'TAP TO PLAY MUSIC'), h('em', null, on && musicPrefs.radio ? 'Surprise radio' : song ? `♪ ${song.name}` : '')))
        : null,
      sfx.musicLive || musicPrefs.menu === 'off' ? h('div.mm-now', null, (on && musicPrefs.radio ? h('span', null, icon('radio', 'ico mm-tiny'), ' RADIO ON') : h('span', null, on ? 'SURPRISE SONG' : 'NOW PLAYING')), h('b', null, song ? `♪ ${song.name}` : musicPrefs.menu === 'random' ? '♪ Random mix' : musicPrefs.menu === 'off' ? 'Music off' : '')) : null,
      h('button.mm-ic.nav', { title: 'Surprise me: a brand-new song (press again for another)', onclick: roll, 'data-ic': 'dice' }, icon('dice')),
      on && song ? (saved
        ? h('span.mm-ic.mm-done', { title: 'Saved in your Music Studio library', 'data-ic': 'check' }, icon('check'))
        : h('button.mm-ic.nav', { title: 'Save this song to your Music Studio library', onclick: () => { saveCustomSongs([{ ...song, custom: true }, ...loadCustomSongs().filter((s) => s.id !== song.id)]); this.app.toast(`♪ ${song.name} saved to your songs`); redo(); }, 'data-ic': 'save' }, icon('save'))) : null,
      h('button.mm-ic.mm-radio.nav' + (on && musicPrefs.radio ? '.on' : ''), {
        'aria-pressed': on && musicPrefs.radio ? 'true' : 'false',
        title: on && musicPrefs.radio ? 'Radio on: a new surprise song every 45s or so — click to stay on this one' : 'Radio: keep playing new surprise songs (each one at least 45s)',
        onclick: () => { musicPrefs.radio = !(on && musicPrefs.radio); saveMusicPrefs(); if (!on) roll(); else { sfx.useMusic('menu'); redo(); } },
        'data-ic': 'radio',
      }, icon('radio')),
      on ? h('button.mm-ic.nav', { title: 'Back to your usual music', onclick: () => { musicPrefs.menu = musicPrefs.menuPrev && musicPrefs.menuPrev !== 'surprise' ? musicPrefs.menuPrev : 'neon-drive'; saveMusicPrefs(); sfx.useMusic('menu'); redo(); }, 'data-ic': 'close' }, icon('close')) : null,
    );
    return el;
  }
}

// ------------------------------------------------------------------ main menu
export class MainMenu extends Base {
  build() {
    const item = (label: string, sub: string, fn: () => void) => h('button.menu-item.nav', { onclick: () => { this.app.sfx.play('select'); fn(); } }, label, h('small', null, sub));
    const p = getPlatform();
    testRide.from = null; // reaching the main menu ends a test ride: Back no longer returns to the editor
    const session = lobbySession();
    return h('div.menu-screen', null,
      h('div.menu-col', null,
        h('div.menu-logo', null, 'BITBLADE'),
        session ? item('CONTINUE', `${session.mode} · ${session.arena} · ${session.humans}P${session.total > session.humans ? ` + ${session.total - session.humans} CPU` : ''}`, () => this.app.go('lobby', { keep: true })) : null,
        item(session ? 'NEW GAME' : 'PLAY', 'Local battles · up to 8 players · CPUs', () => this.app.go('modes')),
        item('ONLINE', 'Host a room or join with a code / link', () => this.app.go('online')),
        item('BLADE FORGE', 'Design, paint and tune your blades', () => this.app.go('blades')),
        item('COURSE BUILDER', 'Connect skate pools into custom courses', () => this.app.go('courses')),
        item('TRACK STUDIO', 'Build race tracks and track adventures from segments', () => this.app.go('tracks')),
        item('MUSIC STUDIO', 'Make chip-tune songs for menus, tracks and courses', () => this.app.go('music')),
        item('SETTINGS', 'Audio · graphics · network', () => this.app.go('settings')),
        p || isInstalledApp() ? item('QUIT', p ? 'Exit to desktop' : 'Close BitBlade', () => quitApp(() => this.app.toast('Swipe BitBlade away in your app switcher to close it'))) : null,
      ),
      h('div.menu-foot', null, 'v0.1'),
      (this.corner = new MusicCorner(this.app)).el,
    );
  }

  corner: MusicCorner | null = null;
  update(dt: number) { super.update(dt); this.corner?.watch(); }
  unmount() { this.corner?.dispose(); super.unmount(); }
  onBack() { this.app.go('title'); }
}

// ------------------------------------------------------------------ mode select
export const MODE_ICON: Record<ModeId, string> = { duel: 'swords', tag: 'users', ffa: 'burst', ctf: 'hex', rush: 'gem', koth: 'crown', gauntlet: 'gear', race: 'finish', quest: 'trophy', pinball: 'target' };
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
    const { cfg, state, again, online } = arg as MatchSummary;
    this.online = online;
    if (online === 'client') {
      clientRoom.handler = (m) => {
        if (m?.t === 'start' && clientRoom.t) this.app.go('match', { cfg: m.cfg, client: { t: clientRoom.t, mine: m.mine } });
        else if (m?.t === 'lobby') this.app.go('online', { resume: true });
      };
      clientRoom.closeHandler = (r) => { this.app.toast(`Room closed: ${r}`); this.app.go('menu'); };
    }
    const w = state.winner;
    const isG = cfg.mode === 'gauntlet' || cfg.mode === 'quest';
    const teamName = (t: number) => {
      if (cfg.mode === 'tag' || cfg.mode === 'ctf') return t === 0 ? 'RED TEAM' : 'BLUE TEAM';
      return cfg.players.find((p) => p.team === t)?.name ?? `TEAM ${t + 1}`;
    };
    const wc = w >= 0 ? (cfg.mode === 'tag' || cfg.mode === 'ctf' ? TEAM_COLORS[w] : cfg.players.find((p) => p.team === w)?.blade.glow) : '#fff';
    const banner = isG ? (w === 0 ? (cfg.mode === 'quest' ? 'QUEST CLEAR!' : 'GAUNTLET CLEAR!') : (cfg.mode === 'quest' ? 'QUEST FAILED' : 'GAUNTLET FAILED')) : w === -2 ? 'DRAW!' : w >= 0 ? `${teamName(w)} WINS!` : 'MATCH OVER';
    const banner2 = h('div.res-banner', null, banner);
    banner2.style.setProperty('--wc', wc ?? '#fff');
    if (w >= 0) this.app.sfx.play('win');
    // columns depend on the mode: timed modes show finish times, collect modes show what you collected
    const t0 = state.t0 ?? 0;
    const time = (t: (typeof state.tops)[number]) => (t.finishT >= 0 ? fmtTime(t.finishT - t0) : null);
    const name = (t: (typeof state.tops)[number]) => h('b', { style: { color: t.color } }, t.name);
    const status = (t: (typeof state.tops)[number]) => (t.alive ? `${Math.round(t.spin * 100)}% spin` : t.out ? FINISH_LABEL[t.out] : '—');
    let head: string[];
    let list = state.tops.filter((t) => !t.drone);
    let cells: (t: (typeof list)[number]) => (string | Node)[];
    if (cfg.mode === 'quest') {
      head = ['BLADER', 'TIME', 'GEMS', 'LIVES LEFT', 'RESULT'];
      const total = cfg.arena.markers.filter((m) => m.kind === 'gem').length;
      list = [...list].sort((a, b) => (a.finishT >= 0 ? 0 : 1) - (b.finishT >= 0 ? 0 : 1) || b.score - a.score);
      cells = (t) => [name(t), time(t) ?? '—', `${t.score} / ${total}`, String(Math.max(0, t.lives)), t.finishT >= 0 ? 'GOAL!' : t.lives <= 0 ? 'OUT OF LIVES' : 'DID NOT FINISH'];
    } else if (cfg.mode === 'race') {
      head = ['POS', 'BLADER', 'TIME', 'LAPS', 'KOs'];
      list = [...list].sort((a, b) => (a.finishT >= 0 ? a.finishT : 1e9) - (b.finishT >= 0 ? b.finishT : 1e9) || (a.place || 99) - (b.place || 99));
      cells = (t) => [`P${t.place || list.indexOf(t) + 1}`, name(t), time(t) ?? 'DNF', `${Math.min(t.lap, cfg.target)} / ${cfg.target}`, String(t.kos)];
    } else if (cfg.mode === 'gauntlet') {
      head = ['BLADER', 'GEMS', 'KOs', 'LIVES LEFT', 'FINAL'];
      cells = (t) => [name(t), String(t.score), String(t.kos), String(Math.max(0, t.lives)), status(t)];
    } else {
      head = ['BLADER', 'SCORE', 'KOs', 'DAMAGE DEALT', 'FINAL'];
      cells = (t) => {
        const score = cfg.mode === 'rush' ? t.crystals : cfg.mode === 'koth' ? Math.floor(state.teamScores[t.team]) : state.teamScores[t.team];
        return [name(t), String(score ?? 0), String(t.kos), `${Math.round(t.dmg * 100)}%`, status(t)];
      };
    }
    const rows = list.map((t, i) => {
      const tr = h('tr', null, ...cells(t).map((c) => h('td', null, c)));
      if (cfg.mode === 'quest' || cfg.mode === 'race' ? t.finishT >= 0 && (cfg.mode === 'quest' || t.place === 1) : t.team === w) tr.classList.add('win');
      tr.style.animationDelay = `${0.3 + i * 0.08}s`;
      return tr;
    });
    return h('div.screen.results', null,
      banner2,
      h('div.screen-sub', null, state.lastFinish),
      h('table.res-table', null, h('tr', null, ...head.map((x) => h('th', null, x))), ...rows),
      online === 'client'
        ? h('div.lobby-bottom', null, h('div.hint', null, 'Back to the room shortly — the room leader picks the next match…'), h('button.btn.nav', { onclick: () => { if (!confirmTwice(this.app, 'leave-room', 'Press again to leave the room')) return; clientRoom.leave(); this.app.go('menu'); } }, 'Leave Room'))
        : h('div.lobby-bottom', null,
          // rematch / next go back through the lobby so a host's room follows along (and newcomers get slotted in)
          h('button.btn.primary.nav', { onclick: () => (again ? this.app.go('match', again) : this.app.go('lobby', { keep: true, autostart: true })) }, online === 'host' ? '↻ Rematch — everyone' : '↻ Rematch'),
          h('button.btn.nav', { onclick: () => this.app.go('lobby', { keep: true, next: true, autostart: true }) }, cfg.arena.track ? 'Next Track ▶' : 'Next Arena ▶'),
          h('button.btn.nav', { onclick: () => this.app.go('lobby', { keep: true }) }, online === 'host' ? 'Room Lobby — change track / players' : 'Lobby — change track / players'),
          online === 'host' ? (this.autoEl = h('div.hint', null, '')) : null,
          testRide.from && !online ? h('button.btn.nav', { onclick: () => this.app.go(testRide.from!) }, `◀ Back to ${editorName()}`) : null,
          h('button.btn.nav', { onclick: () => { if (online === 'host') { if (!confirmTwice(this.app, 'close-room', 'Press again to close the room for everyone')) return; hostRoom.close(); } this.app.go('menu'); } }, online === 'host' ? 'Close Room' : 'Main Menu')),
    );
  }
  online?: 'host' | 'client';
  autoEl: HTMLElement | null = null;
  autoT = 12;
  update(dt: number) {
    super.update(dt);
    if (this.online === 'host' && hostRoom.t) {
      this.autoT -= dt;
      if (this.autoEl) this.autoEl.textContent = `Room returns to the lobby in ${Math.ceil(Math.max(0, this.autoT))}s`;
      if (this.autoT <= 0) this.app.go('lobby', { keep: true });
    }
  }
  unmount() {
    super.unmount();
    if (this.online === 'client') { clientRoom.handler = null; clientRoom.closeHandler = null; }
  }
  // Esc / B from results: back to the lobby (the host's room stays open), never straight out
  onBack() { if (this.online !== 'client') this.app.go('lobby', { keep: true }); }
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
    const musicPick = (label: string, key: 'menu' | 'game', extra: [string, string][]) => {
      const opts: [string, string][] = [...extra, ...allSongs().map((s) => [s.id, `♪ ${s.name}${s.custom ? '' : ' ★'}`] as [string, string])];
      const se = h<HTMLSelectElement>('select.nav', { onchange: () => { musicPrefs[key] = se.value; saveMusicPrefs(); if (key === 'menu') sfx.useMusic('menu'); } }, ...opts.map(([v, t]) => h('option', { value: v, selected: musicPrefs[key] === v }, t)));
      return h('div.field', null, h('label', null, label), se);
    };
    const relay = h<HTMLInputElement>('input', { type: 'url', placeholder: 'https://bitblade.<you>.workers.dev', value: cloudRelayUrl() });
    relay.addEventListener('change', () => { try { localStorage.setItem('bitblade.cloudRelay', relay.value.trim()); } catch { /* ignore */ } });
    const p = getPlatform();
    return h('div.screen', null,
      h('div.screen-head', null, h('button.btn.small.nav', { onclick: () => this.app.back() }, '◀ Back'), h('div.screen-title', null, 'SETTINGS')),
      h('div.panel', { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '620px' } },
        slider('SFX VOLUME', sfx.volume, 0, 1, 0.05, (v) => { sfx.volume = v; sfx.save(); }),
        slider('MUSIC VOLUME', sfx.musicVolume, 0, 1, 0.05, (v) => { sfx.musicVolume = v; sfx.save(); }),
        musicPick('MENU MUSIC', 'menu', [['surprise', '🎲 Surprise — a brand-new song each session'], ['random', '🔀 Random — a new song every couple of loops'], ['off', 'Off']]),
        musicPick('MATCH MUSIC', 'game', [['track', "Each track / course's own song"], ['random', '🎲 Random — a new song every couple of loops'], ['off', 'Off']]),
        toggle('BLOOM GLOW', () => settings.bloom, (v) => { settings.bloom = v; settings.save(); }),
        toggle('TRAJECTORY PREDICTION', () => settings.trajectories, (v) => { settings.trajectories = v; settings.save(); }),
        toggle('AUTO RESOLUTION (keeps FPS up)', () => settings.adaptive, (v) => { settings.adaptive = v; settings.save(); }),
        slider('RESOLUTION SCALE', settings.pixelRatio, 0.5, 2, 0.25, (v) => { settings.pixelRatio = v; settings.save(); const r = getRenderer(this.app.canvas).renderer; r.setPixelRatio(v); r.setSize(innerWidth, innerHeight); }),
        h('div.field', null, h('label', null, 'CLOUD RELAY URL (Cloudflare Worker)'), relay),
        toggle('GYRO STEERING (touch players)', () => this.app.input.gyro.on, (v) => { if (v) this.app.input.enableGyro(); else this.app.input.gyro.on = false; }),
        h('button.btn.small.nav', { onclick: () => { this.app.input.calibrateGyro(); this.app.toast('Gyro calibrated — hold your phone like this to stand still'); } }, 'Calibrate Gyro'),
        p ? h('button.btn.small.nav', { onclick: () => p.toggleFullscreen() }, 'Toggle Fullscreen (F11)') : h('button.btn.small.nav', { onclick: () => document.documentElement.requestFullscreen?.() }, 'Fullscreen'),
      ),
    );
  }
}
