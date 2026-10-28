// Match screen: runs the sim (local / host) or mirrors snapshots (client), renders, HUD, pause.
import { h, MenuNav, type App, type Screen } from './app';
import { Hud } from './hud';
import { Sim } from '../game/sim';
import { GameView } from '../game/render';
import { TouchControls } from '../input/input';
import type { GameEvent, GameState, MatchConfig } from '../game/types';
import type { ClientTransport, HostTransport } from '../net/transport';
import { setBackdropVisible } from './backdrop';

export interface MatchArg {
  cfg: MatchConfig;
  host?: { t: HostTransport; peerSlot: Map<number, number> }; // peer -> player index
  client?: { t: ClientTransport; mine: number[] }; // player indices controlled here
}

export interface MatchSummary { cfg: MatchConfig; state: GameState; again?: MatchArg }

const STEP = 1 / 120;

export class MatchScreen implements Screen {
  app!: App;
  arg!: MatchArg;
  sim: Sim | null = null;
  view!: GameView;
  hud!: Hud;
  state!: GameState;
  acc = 0;
  paused = false;
  pauseEl: HTMLElement | null = null;
  pauseNav: MenuNav | null = null;
  touch: TouchControls | null = null;
  snapAcc = 0;
  pendingEvents: GameEvent[] = [];
  lastSnapAt = 0;
  sendAcc = 0;
  ended = false;
  wrap!: HTMLElement;
  private pendingCtl = new Map<number, { mx: number; mz: number; dash: boolean; jump: boolean; item: boolean; special: boolean }>();

  mount(app: App, arg: unknown) {
    this.app = app;
    this.arg = arg as MatchArg;
    const cfg = this.arg.cfg;
    setBackdropVisible(false);
    document.body.classList.add('ingame');
    this.view = new GameView(app.canvas, cfg);
    this.view.focus = cfg.players.map((_, i) => i).filter((i) => this.isLocal(i));
    this.wrap = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
    app.root.append(this.wrap);
    this.hud = new Hud(this.wrap, cfg);
    if (cfg.players.some((p) => p.ctrl.type === 'touch' && this.isLocal(cfg.players.indexOf(p)))) {
      this.touch = new TouchControls(this.wrap);
      app.input.touch = this.touch;
    }
    app.input.mouseWorld = () => {
      const me = cfg.players.findIndex((p) => p.ctrl.type === 'mouse');
      const y = me >= 0 ? this.state.tops[me]?.y ?? 0 : 0;
      return this.view.groundPoint(app.input.mouseNdc, y);
    };
    if (this.arg.client) {
      // mirror mode: wait for first snapshot; build a throwaway sim just for an initial state
      const tmp = new Sim(cfg);
      this.state = tmp.s;
      this.arg.client.t.onMessage((m) => this.onHostMsg(m));
      this.arg.client.t.onClose((r) => { if (!this.ended) { app.toast(`Disconnected: ${r}`); app.go('menu'); } });
    } else {
      this.sim = new Sim(cfg);
      this.state = this.sim.s;
      if (this.arg.host) {
        const { t, peerSlot } = this.arg.host;
        t.onMessage((peer, m) => {
          if (m?.t === 'in') {
            const idx = m.p as number;
            if (peerSlot.get(peer) === undefined) return;
            if (cfg.players[idx]?.ctrl.type === 'remote' && (cfg.players[idx].ctrl as { peer: number }).peer === peer) this.sim!.setControl(idx, m.c);
          }
        });
        t.onLeave((peer) => {
          for (const [i, p] of cfg.players.entries()) if (p.ctrl.type === 'remote' && p.ctrl.peer === peer) { const top = this.sim!.s.tops[i]; if (top) top.spin = 0; }
        });
      }
    }
    app.sfx.music(true);
  }

  isLocal(i: number) {
    const p = this.arg.cfg.players[i];
    if (!p) return false;
    if (this.arg.client) return this.arg.client.mine.includes(i);
    return p.ctrl.type !== 'cpu' && p.ctrl.type !== 'remote';
  }

  onHostMsg(m: any) {
    if (m?.t === 'snap') {
      const ev = m.s.events as GameEvent[];
      this.state = m.s;
      this.state.events = [];
      this.lastSnapAt = performance.now();
      this.consumeEvents(ev);
    } else if (m?.t === 'end') {
      this.finish();
    }
  }

  update(dt: number) {
    const app = this.app;
    const inp = app.input;
    const cfg = this.arg.cfg;
    if (inp.pausePressed() && !this.ended) {
      // toggle and swallow this press so the pause menu's own back handler doesn't immediately close it
      this.togglePause();
      this.view.render();
      return;
    }
    const online = !!(this.arg.host || this.arg.client);
    if (this.paused) {
      this.pauseNav?.update(dt);
      if (!online) { this.view.render(); return; }
    }
    // local input (online games keep running behind the pause menu)
    cfg.players.forEach((p, i) => {
      if (!this.isLocal(i) || this.paused) return;
      const top = this.state.tops[i];
      const c = inp.read(p.ctrl, top);
      if (this.sim) this.sim.setControl(i, c);
      else {
        const prev = this.pendingCtl.get(i);
        this.pendingCtl.set(i, prev ? { ...c, dash: c.dash || prev.dash, jump: c.jump || prev.jump, item: c.item || prev.item, special: c.special || prev.special } : c);
      }
    });
    if (this.arg.client) {
      this.sendAcc += dt;
      if (this.sendAcc > 1 / 30) {
        this.sendAcc = 0;
        for (const [i, c] of this.pendingCtl) this.arg.client.t.send({ t: 'in', p: i, c });
        this.pendingCtl.clear();
      }
    }
    // simulate
    if (this.sim) {
      this.acc += Math.min(dt, 0.1);
      let n = 0;
      while (this.acc >= STEP && n < 12) { this.sim.step(STEP); this.acc -= STEP; n++; }
      const ev = this.sim.s.events.splice(0);
      this.consumeEvents(ev);
      if (this.arg.host) {
        this.pendingEvents.push(...ev);
        this.snapAcc += dt;
        if (this.snapAcc > 1 / 30) {
          this.snapAcc = 0;
          this.arg.host.t.send('all', { t: 'snap', s: { ...this.sim.s, events: this.pendingEvents } });
          this.pendingEvents = [];
        }
      }
    }
    // client dead-reckoning between snapshots
    let renderState = this.state;
    if (this.arg.client && this.lastSnapAt) {
      const age = Math.min(0.1, (performance.now() - this.lastSnapAt) / 1000);
      renderState = { ...this.state, tops: this.state.tops.map((t) => ({ ...t, x: t.x + t.vx * age, y: t.y + t.vy * age, z: t.z + t.vz * age })) };
    }
    const launchPower = 0.5 - 0.5 * Math.cos(renderState.phaseT * 4.2);
    this.view.update(renderState, dt, launchPower);
    this.hud.update(renderState, dt);
    // hum from the fastest local top
    let hum = 0;
    renderState.tops.forEach((t, i) => { if (t.alive && this.isLocal(i)) hum = Math.max(hum, t.spin); });
    app.sfx.setHum(renderState.phase === 'battle' ? hum : 0);
    this.view.render();
    if (renderState.phase === 'matchEnd' && renderState.phaseT > 3.5 && !this.ended) {
      if (this.arg.host) this.arg.host.t.send('all', { t: 'end' });
      this.finish();
    }
  }

  consumeEvents(ev: GameEvent[]) {
    if (!ev.length) return;
    const sfx = this.app.sfx;
    const s = this.state;
    this.view.handleEvents(ev, s);
    for (const e of ev) {
      switch (e.k) {
        case 'clash': sfx.play(e.s > 8 ? 'bigclash' : 'clash', e.s / 8); this.rumble([e.a, e.b], e.s / 10); break;
        case 'land': sfx.play('land', e.s / 8); this.rumble([e.id], e.s / 14); break;
        case 'grind': sfx.play('grind'); break;
        case 'finish': sfx.play('finish'); this.rumble([e.id], 1, 300); break;
        case 'burst': sfx.play('burst'); break;
        case 'shock': sfx.play('shock'); break;
        case 'pickup': sfx.play(e.what === 'crystal' ? 'crystal' : e.what === 'gem' ? 'gem' : e.what === 'box' ? 'item' : 'pickup'); break;
        case 'use': sfx.play('pickup'); break;
        case 'special': sfx.play('special'); break;
        case 'dash': sfx.play('dash'); break;
        case 'jump': sfx.play('jump'); break;
        case 'hazard': sfx.play('hazard'); this.rumble([e.id], 0.6); break;
        case 'announce': this.hud.announce(e.text, e.sub, e.color); break;
        case 'count': this.hud.count(e.n); sfx.play('count'); break;
        case 'go': sfx.play('go'); sfx.play('launch'); break;
      }
    }
  }

  rumble(ids: number[], strength: number, ms = 120) {
    for (const id of ids) {
      if (!this.isLocal(id)) continue;
      const p = this.arg.cfg.players[id];
      if (p) this.app.input.rumble(p.ctrl, strength, ms);
    }
  }

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      const resume = h('button.btn.nav', { onclick: () => this.togglePause() }, 'Resume');
      const restart = h('button.btn.nav', { onclick: () => this.restart(), disabled: !!this.arg.client }, 'Restart');
      const quit = h('button.btn.nav', { onclick: () => { this.quit(); } }, this.arg.host || this.arg.client ? 'Leave Match' : 'Quit to Menu');
      this.pauseEl = h('div.pause', null, h('h2', null, this.arg.host || this.arg.client ? 'MENU' : 'PAUSED'), resume, restart, quit, this.hud.controlsHelp());
      this.wrap.append(this.pauseEl);
      this.pauseNav = new MenuNav(this.app, this.pauseEl);
      this.pauseNav.focus(0);
    } else {
      this.pauseEl?.remove();
      this.pauseEl = null;
      this.pauseNav = null;
    }
  }

  restart() {
    const arg = { ...this.arg, cfg: { ...this.arg.cfg, seed: (Math.random() * 1e9) | 0 } };
    this.app.go('match', arg);
  }

  quit() {
    this.ended = true;
    this.arg.host?.t.close();
    this.arg.client?.t.close();
    this.app.go('menu');
  }

  finish() {
    this.ended = true;
    const summary: MatchSummary = { cfg: this.arg.cfg, state: this.state, again: this.arg.client ? undefined : { ...this.arg, cfg: { ...this.arg.cfg, seed: (Math.random() * 1e9) | 0 } } };
    this.app.go('results', summary);
  }

  resize() { this.view.onResize(); }

  unmount() {
    document.body.classList.remove('ingame');
    this.app.sfx.setHum(0);
    this.app.input.mouseWorld = null;
    this.touch?.dispose();
    this.app.input.touch = null;
    this.wrap.remove();
    this.view.dispose();
  }
}
