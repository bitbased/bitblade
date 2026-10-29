// Match screen: runs the sim (local / host) or mirrors snapshots (client), renders, HUD, pause.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { Hud } from './hud';
import { Sim } from '../game/sim';
import { GameView } from '../game/render';
import { Input, TouchControls } from '../input/input';
import type { Control, ControllerSpec, GameEvent, GameState, MatchConfig } from '../game/types';
import type { ClientTransport, HostTransport } from '../net/transport';
import { setBackdropVisible } from './backdrop';
import { clientRoom, hostRoom } from '../net/room';
import { NetClient } from '../net/netclient';

export interface MatchArg {
  cfg: MatchConfig;
  host?: { t: HostTransport; peerSlot: Map<number, number> }; // peer -> player index
  client?: { t: ClientTransport; mine: number[] }; // player indices controlled here
}

export interface MatchSummary { cfg: MatchConfig; state: GameState; again?: MatchArg; online?: 'host' | 'client' }

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
  net: NetClient | null = null;
  acks: Record<number, number> = {};
  lastSent = new Map<number, { mx: number; mz: number }>();
  ended = false;
  wrongT = 0;
  unsubRoom: (() => void) | null = null;
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
    if (this.arg.host || this.arg.client) {
      const code = this.arg.host ? hostRoom.t?.code : clientRoom.t?.code;
      this.wrap.append(h('div.online-badge', null, h('span.dot'), `ROOM ${code ?? ''}`, h('small', null, this.arg.host ? 'YOU LEAD' : 'ESC: MENU')));
    }
    const clientTouch = !!this.arg.client && this.arg.client.mine.length > 0 && Input.isTouchDevice() && !matchMedia('(pointer: fine)').matches;
    if (clientTouch || cfg.players.some((p) => p.ctrl.type === 'touch' && this.isLocal(cfg.players.indexOf(p)))) {
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
      this.net = new NetClient(cfg, this.arg.client.mine);
      this.state = this.net.latest;
      clientRoom.handler = (m) => this.onHostMsg(m);
      clientRoom.closeHandler = (r) => { if (!this.ended) { this.ended = true; app.toast(`Disconnected: ${r}`); app.go('menu'); } };
    } else {
      this.sim = new Sim(cfg);
      this.state = this.sim.s;
      if (this.arg.host) {
        const { peerSlot } = this.arg.host;
        hostRoom.onInput = (peer, m) => {
          const idx = m.p as number;
          if (peerSlot.get(peer) !== idx) return;
          this.sim!.setControl(idx, m.c);
          if (typeof m.seq === 'number') this.acks[idx] = m.seq;
        };
        hostRoom.onQuitMatch = (peer) => {
          const idx = peerSlot.get(peer);
          const top = idx !== undefined ? this.sim!.s.tops[idx] : undefined;
          if (top?.alive) { top.spin = 0; this.app.toast(`${top.name} left the match (still in the room)`); }
        };
        this.unsubRoom = hostRoom.subscribe(() => {
          // a player who left the room spins out
          for (const [i, p] of cfg.players.entries()) if (p.ctrl.type === 'remote' && !hostRoom.members.has(p.ctrl.peer)) { const top = this.sim!.s.tops[i]; if (top?.alive) top.spin = 0; }
        });
      }
    }
    app.sfx.music(true);
  }

  /** merge every local device (keyboards, pads, touch, mouse) into one control */
  readAnyLocal(top: { x: number; z: number } | undefined): Control {
    const inp = this.app.input;
    const specs: ControllerSpec[] = [{ type: 'kb1' }, { type: 'kb2' }, { type: 'touch', gyro: inp.gyro.on }, ...inp.connectedPads().map((index) => ({ type: 'pad' as const, index }))];
    const out: Control = { mx: 0, mz: 0, dash: false, jump: false, item: false, special: false };
    for (const sp of specs) {
      const c = inp.read(sp, top);
      if (Math.hypot(c.mx, c.mz) > Math.hypot(out.mx, out.mz)) { out.mx = c.mx; out.mz = c.mz; }
      out.dash ||= c.dash; out.jump ||= c.jump; out.item ||= c.item; out.special ||= c.special;
    }
    if (inp.mouseButtons & 7 || inp.mousePressed & 6) {
      const c = inp.read({ type: 'mouse' }, top);
      if (Math.hypot(c.mx, c.mz) > 0) { out.mx = c.mx; out.mz = c.mz; }
      out.dash ||= c.dash;
    }
    return out;
  }

  isLocal(i: number) {
    const p = this.arg.cfg.players[i];
    if (!p) return false;
    if (this.arg.client) return this.arg.client.mine.includes(i);
    return p.ctrl.type !== 'cpu' && p.ctrl.type !== 'remote';
  }

  onHostMsg(m: any) {
    if (m?.t === 'snap' && this.net) {
      const ev = this.net.onSnap(m.s, m.ack);
      this.state = this.net.latest;
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
      // online guests: their slot is 'remote' from the host's point of view; drive it with any local device
      const usingMouse = !!this.arg.client && !!(inp.mouseButtons & 7);
      const c = this.arg.client ? this.readAnyLocal(top) : inp.read(p.ctrl, top);
      if (p.ctrl.type !== 'mouse' && !usingMouse) {
        // camera-relative steering: stick up = away from the camera
        const f = this.view.camFwd;
        const mx = c.mx, mz = c.mz;
        c.mx = -f.z * mx - f.x * mz;
        c.mz = f.x * mx - f.z * mz;
      }
      if (this.sim) this.sim.setControl(i, c);
      else if (this.net) {
        // predict locally right away, and send every frame (tiny messages) with a sequence number for reconciliation
        const seq = this.net.input(i, c, dt);
        clientRoom.send({ t: 'in', p: i, c, seq });
      }
    });
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
        if (this.snapAcc > 1 / 45) {
          this.snapAcc = 0;
          hostRoom.send('all', { t: 'snap', s: { ...this.sim.s, events: this.pendingEvents }, ack: this.acks });
          this.pendingEvents = [];
        }
      }
    }
    // client dead-reckoning between snapshots
    // guests: interpolated remote blades + predicted own blades
    const renderState = this.net && this.lastSnapAt ? this.net.frame(dt) : this.state;
    const launchPower = 0.5 - 0.5 * Math.cos(renderState.phaseT * 4.2);
    this.view.update(renderState, dt, launchPower);
    this.hud.update(renderState, dt);
    const TS = this.view.terrain.track;
    if (TS && renderState.phase === 'battle') {
      let wrong = false, off = 0;
      for (const i of this.view.focus) {
        const t = renderState.tops[i];
        if (!t?.alive) continue;
        if (t.off > 0) { off = Math.max(off, t.off); continue; }
        const along = t.vx * TS.tx[t.prog] + t.vz * TS.tz[t.prog];
        if (along < -2.5) wrong = true;
      }
      this.wrongT = wrong ? this.wrongT + dt : 0;
      this.hud.wrongWay(this.wrongT > 0.8, off);
    }
    // hum from the fastest local top
    let hum = 0;
    renderState.tops.forEach((t, i) => { if (t.alive && this.isLocal(i)) hum = Math.max(hum, t.spin); });
    app.sfx.setHum(renderState.phase === 'battle' ? hum : 0);
    this.view.render();
    if (renderState.phase === 'matchEnd' && renderState.phaseT > 3.5 && !this.ended) {
      if (this.arg.host) hostRoom.send('all', { t: 'end' });
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
      let buttons: HTMLElement[];
      if (this.arg.host) {
        buttons = [
          h('button.btn.nav', { onclick: () => this.quit() }, 'End Match — everyone back to room'),
          h('button.btn.nav', { onclick: () => { if (confirmTwice(this.app, 'close-room', 'Press again to close the room for everyone')) this.closeRoomAndQuit(); } }, 'Close Room & Quit'),
        ];
      } else if (this.arg.client) {
        buttons = [
          h('button.btn.nav', { onclick: () => this.leaveMatchStayInRoom() }, 'Leave Match — stay in room'),
          h('button.btn.nav', { onclick: () => { if (confirmTwice(this.app, 'leave-room', 'Press again to leave the room')) this.quit(); } }, 'Leave Room'),
        ];
      } else {
        buttons = [h('button.btn.nav', { onclick: () => this.restart() }, 'Restart'), h('button.btn.nav', { onclick: () => this.quit() }, 'Quit to Menu')];
      }
      const online = this.arg.host || this.arg.client;
      const code = this.arg.host ? hostRoom.t?.code : clientRoom.t?.code;
      this.pauseEl = h('div.pause', null, h('h2', null, online ? 'MENU' : 'PAUSED'),
        online ? h('div.hint', null, `ONLINE ROOM ${code ?? ''} · the match keeps running while this menu is open`) : null,
        resume, ...buttons, this.hud.controlsHelp());
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

  leaveMatchStayInRoom() {
    this.ended = true;
    clientRoom.send({ t: 'quitmatch' });
    clientRoom.busy = true;
    this.app.go('online', { resume: true });
  }

  closeRoomAndQuit() {
    this.ended = true;
    hostRoom.send('all', { t: 'end' });
    hostRoom.close();
    this.app.go('menu');
  }

  quit() {
    this.ended = true;
    if (this.arg.host) {
      // the leader ends the match for everyone and the room heads back to the lobby
      hostRoom.send('all', { t: 'end' });
      hostRoom.inMatch = false;
      this.app.go('lobby', { mode: this.arg.cfg.mode, keep: true });
      return;
    }
    if (this.arg.client) clientRoom.leave();
    this.app.go('menu');
  }

  finish() {
    this.ended = true;
    if (this.arg.host) hostRoom.inMatch = false;
    const summary: MatchSummary = { cfg: this.arg.cfg, state: this.state, again: this.arg.client || this.arg.host ? undefined : { ...this.arg, cfg: { ...this.arg.cfg, seed: (Math.random() * 1e9) | 0 } }, online: this.arg.host ? 'host' : this.arg.client ? 'client' : undefined };
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
    this.unsubRoom?.();
    if (this.arg.host) { hostRoom.onInput = null; hostRoom.onQuitMatch = null; }
    if (this.arg.client) { clientRoom.handler = null; clientRoom.closeHandler = null; }
  }
}
