// Match screen: runs the sim (local / host) or mirrors snapshots (client), renders, HUD, pause.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { Hud } from './hud';
import { icon } from './icons';
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
  splitWrongT: number[] = [];
  safeT = 0;
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
    // local multiplayer races: split-screen, one chase camera each
    if (cfg.arena.track && this.view.focus.length > 1) {
      this.view.enableSplit(this.view.focus);
    }
    this.wrap = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
    app.root.append(this.wrap);
    this.hud = new Hud(this.wrap, cfg);
    // always-reachable pause / menu (touch has no Esc; also handy with a mouse)
    this.wrap.append(h('button.pause-btn', { 'aria-label': 'Pause', title: 'Pause (Esc / P / START)', onclick: () => { if (!this.ended) this.togglePause(); } }, icon('pause')));
    if (this.view.splits.length > 1) this.hud.split(this.view.focus);
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
      return this.view.groundPoint(app.input.mouseNdc, y, me);
    };
    if (this.arg.client) {
      // mirror mode: wait for first snapshot; build a throwaway sim just for an initial state
      this.net = new NetClient(cfg, this.arg.client.mine);
      this.state = this.net.latest;
      clientRoom.handler = (m) => this.onHostMsg(m);
      clientRoom.closeHandler = (r) => {
        if (this.ended) return;
        this.ended = true;
        app.toast(`Disconnected: ${r}`);
        // the host dropped: wait in the online hub and rejoin automatically if the room comes back
        if (r === 'Host left' && clientRoom.lastJoin) app.go('online', { rejoin: clientRoom.lastJoin });
        else app.go('menu');
      };
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
    } else if (m?.t === 'start' && clientRoom.t) {
      // host restarted / started the next match while we were still in this one
      this.ended = true;
      this.app.go('match', { cfg: m.cfg, client: { t: clientRoom.t, mine: m.mine } });
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
        const f = this.view.camFwdOf(i);
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
      this.acc += Math.min(dt, 0.25); // up to a 4 fps frame is still real-time
      let n = 0;
      while (this.acc >= STEP && n < 32) { this.sim.step(STEP); this.acc -= STEP; n++; }
      if (n >= 32) this.acc = Math.min(this.acc, STEP); // machine can't keep up: drop the backlog rather than spiral
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
    this.hud.tips(renderState, this.view.focus);
    this.safeT -= dt;
    if (this.safeT <= 0) {
      this.safeT = 0.5;
      const safe = this.hud.safeInsets();
      // on-screen touch buttons / joystick cover the bottom of the screen too
      const H = innerHeight || 1;
      for (const el of this.wrap.querySelectorAll<HTMLElement>('.touch-btns .tb, .touch-base')) {
        const r = el.getBoundingClientRect();
        if (r.height && r.top > H * 0.4) safe.bottom = Math.min(0.45, Math.max(safe.bottom, (H - r.top) / H + 0.01));
      }
      this.view.safe = safe;
    }
    const TS = this.view.terrain.track;
    if (TS && renderState.phase === 'battle') {
      const isWrong = (t: (typeof renderState.tops)[number]) => t.grounded && t.vx * TS.tx[t.prog] + t.vz * TS.tz[t.prog] < -2.5; // airborne shortcuts aren't wrong-way
      if (this.hud.vps.length) {
        // split-screen: every viewport gets its own tag + warning
        this.hud.vps.forEach((v, k) => {
          const t = renderState.tops[v.id];
          if (!t) return;
          this.splitWrongT[k] = t.alive && !t.off && isWrong(t) ? (this.splitWrongT[k] ?? 0) + dt : 0;
          const warn = !t.alive ? '' : t.off > 0 ? `OFF COURSE — TURN BACK ${Math.max(0, Math.ceil(5 - t.off))}` : this.splitWrongT[k] > 0.8 ? 'WRONG WAY' : '';
          const tag = `P${v.id + 1} ${cfg.players[v.id].name} · ${t.finishT >= 0 ? 'FINISHED' : `POS ${t.place} · LAP ${Math.min(t.lap + 1, cfg.target)}/${cfg.target}`}`;
          this.hud.vpText(k, tag, warn);
        });
      } else {
        let wrong = false, off = 0;
        for (const i of this.view.focus) {
          const t = renderState.tops[i];
          if (!t?.alive) continue;
          if (t.off > 0) { off = Math.max(off, t.off); continue; }
          if (isWrong(t)) wrong = true;
        }
        this.wrongT = wrong ? this.wrongT + dt : 0;
        this.hud.wrongWay(this.wrongT > 0.8, off);
      }
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
        case 'use': sfx.play(e.item === 'surge' ? 'special' : 'pickup'); if (e.item === 'surge') this.rumble([e.id], 0.5, 200); break;
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
          h('button.btn.nav', { onclick: () => this.hostRestart() }, 'Restart Match — everyone'),
          h('button.btn.nav', { onclick: () => this.quit() }, 'Back to Room Lobby — change track / players'),
          h('button.btn.nav', { onclick: () => { if (confirmTwice(this.app, 'close-room', 'Press again to close the room for everyone')) this.closeRoomAndQuit(); } }, 'Close Room & Quit'),
        ];
      } else if (this.arg.client) {
        buttons = [
          h('button.btn.nav', { onclick: () => this.leaveMatchStayInRoom() }, 'Leave Match — stay in room'),
          h('button.btn.nav', { onclick: () => { if (confirmTwice(this.app, 'leave-room', 'Press again to leave the room')) this.quit(); } }, 'Leave Room'),
        ];
      } else {
        buttons = [
          h('button.btn.nav', { onclick: () => this.restart() }, 'Restart'),
          h('button.btn.nav', { onclick: () => this.toLobby() }, 'Back to Lobby — change track / players'),
          h('button.btn.nav', { onclick: () => this.quit() }, 'Quit to Menu'),
        ];
      }
      const online = this.arg.host || this.arg.client;
      const code = this.arg.host ? hostRoom.t?.code : clientRoom.t?.code;
      this.pauseEl = h('div.pause', null, h('h2', null, online ? 'MENU' : 'PAUSED'),
        online ? h('div.hint', null, `ONLINE ROOM ${code ?? ''} · the match keeps running while this menu is open`) : null,
        resume, ...buttons, this.hud.controlsHelp(this.view.focus));
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

  /** local: back to the lobby with everything kept (players, blades, mode, arena, rules) */
  toLobby() {
    this.ended = true;
    this.app.go('lobby', { keep: true });
  }

  /** host: restart for the whole room — the lobby re-sends 'start' and guests jump straight into the new match */
  hostRestart() {
    this.ended = true;
    hostRoom.inMatch = false;
    this.app.go('lobby', { keep: true, autostart: true });
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
      this.app.go('lobby', { keep: true });
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
