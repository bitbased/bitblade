// Authoritative game simulation. Plain-data state (GameState) so it can be snapshotted over the network.
import { computeStats, type BladeStats } from '../core/blade';
import { Terrain, VOID, type Marker } from './terrain';
import { hazardPose, closestOnSeg } from './hazards';
import { arenaRails, flyEnd, flipperHalf, flipperPose, flipperSide, flyLiftAlong, railSegments, rampRails, segDist, FLIP_DOWN_SPEED, FLIP_UP_SPEED, type RailSeg } from './pinball';
import { aiControl, newAI, type AIState } from './ai';
import { globalNearest, nearestSample } from './track';
import {
  MODES, NO_CONTROL, type Control, type FinishType, type GameState, type ItemKind, type MatchConfig, type ModeInfo, type TopState,
} from './types';

export const G = 20;
export const S_SURF = 7;
const POINTS: Record<FinishType, number> = { spin: 1, over: 2, burst: 2, xtreme: 3 };
export const FINISH_LABEL: Record<FinishType, string> = { spin: 'SPIN FINISH', over: 'OVER FINISH', burst: 'BURST FINISH', xtreme: 'XTREME FINISH' };
const ITEM_POOL: ItemKind[] = ['turbo', 'shield', 'shock', 'surge', 'vortex', 'titan', 'comet', 'mine'];
/** 83.456 -> '1:23.45' */
export function fmtTime(sec: number) {
  const m = Math.floor(sec / 60), r = sec - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
}

const RESPAWN_MODES = new Set(['ctf', 'rush', 'koth', 'gauntlet', 'race', 'quest', 'pinball']);

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const grad = { gx: 0, gz: 0 };

export class Sim {
  cfg: MatchConfig;
  mode: ModeInfo;
  terrain: Terrain;
  s: GameState;
  st: BladeStats[] = [];
  rnd: () => number;
  controls: Control[] = [];
  ai: (AIState | null)[] = [];
  numTeams: number;
  markers: Marker[];
  spawns: { x: number; z: number; team?: number }[] = [];
  pairCd = new Map<number, number>();
  hazardHitCd = new Map<string, number>();

  constructor(cfg: MatchConfig) {
    this.cfg = cfg;
    this.mode = MODES.find((m) => m.id === cfg.mode)!;
    this.terrain = new Terrain(cfg.arena);
    this.markers = cfg.arena.markers;
    this.rnd = mulberry(cfg.seed);
    this.numTeams = Math.max(1, ...cfg.players.map((p) => p.team + 1));
    this.s = {
      t: 0, phase: 'launch', phaseT: 0, round: 1, timeLeft: cfg.timeLimit,
      tops: [], teamScores: new Array(this.numTeams).fill(0),
      boxes: [], crystals: [], flags: [], projs: [], mines: [], gems: [], gemsLeft: 0, zone: null,
      events: [], winner: -1, lastFinish: '', nextId: 1,
    };
    this.buildSpawns();
    cfg.players.forEach((p, i) => this.addTop(p.name, p.team, p.blade, p.ctrl.type === 'cpu' ? p.ctrl.level : 0, i));
    // objects
    if (cfg.items || cfg.mode === 'rush' || cfg.mode === 'gauntlet' || cfg.mode === 'quest') {
      let items = this.markers.filter((m) => m.kind === 'item');
      if (items.length === 0) items = [0, 1, 2].map(() => ({ kind: 'item', ...this.terrain.randomSafePoint(this.rnd) }) as Marker);
      for (const m of items) this.s.boxes.push({ x: m.x, y: this.ground(m.x, m.z), z: m.z, t: 0 });
      if (cfg.mode === 'rush') for (let k = 0; k < 3; k++) { const p = this.terrain.randomSafePoint(this.rnd); this.s.boxes.push({ x: p.x, y: this.ground(p.x, p.z), z: p.z, t: 0 }); }
    }
    if (cfg.mode === 'ctf') {
      let fl = this.markers.filter((m) => m.kind === 'flag');
      if (fl.length < 2) {
        const e = this.terrain.size * 0.6;
        fl = [{ kind: 'flag', x: -e, z: 0, team: 0 }, { kind: 'flag', x: e, z: 0, team: 1 }].map((m) => {
          const p = this.terrain.randomSafePoint(this.rnd, { x: m.x, z: m.z, r: 4 });
          return { ...m, ...p } as Marker;
        });
      }
      for (const m of fl.slice(0, 2)) {
        const y = this.ground(m.x, m.z);
        this.s.flags.push({ team: m.team ?? 0, hx: m.x, hy: y, hz: m.z, x: m.x, y, z: m.z, carrier: -1, home: true, t: 0 });
      }
    }
    if (cfg.mode === 'koth') this.moveZone(true);
    if (cfg.mode === 'gauntlet') {
      this.s.gemsLeft = cfg.target || 15;
      for (let k = 0; k < 3; k++) this.spawnGem();
    }
    if (cfg.mode === 'quest') {
      // every gem in the level is out from the start; the goal is the finish line
      for (const m of this.markers) if (m.kind === 'gem') this.s.gems.push({ id: this.s.nextId++, x: m.x, y: this.ground(m.x, m.z) + 0.6, z: m.z });
      this.s.gemsLeft = this.s.gems.length;
      this.hiveCool = this.markers.map(() => 1.5);
    }
    this.railSegs = railSegments([...(this.cfg.arena.rails ?? []), ...(this.cfg.arena.ramps ?? []).flatMap(rampRails), ...this.markers.flatMap((m, mi) => (m.kind === 'arena' ? arenaRails(m, mi) : []))]);
    // pinball tables (and any arena with flippers): table state
    if (this.cfg.mode === 'pinball' || this.markers.some((m) => m.kind === 'flipper')) {
      this.s.pin = { flip: this.markers.map((m) => (m.kind === 'flipper' ? m.rot ?? 0 : 0)), lit: this.markers.map(() => false), charge: 0, mult: 0, litT: 0, tilt: 0, tilted: false, warned: false, tm: this.markers.map(() => 0), save: 0, swarm: [], swarmT: 0, swarmHive: -1, duel: null, foe: -1 };
    }
    this.startLaunch();
  }

  get rounds() { return this.mode.rounds; }

  ground(x: number, z: number) {
    const h = this.terrain.height(x, z);
    return h <= VOID ? 0 : h;
  }

  buildSpawns() {
    const sp = this.markers.filter((m) => m.kind === 'spawn');
    if (sp.length) { this.spawns = sp.map((m) => ({ x: m.x, z: m.z, team: m.team })); }
    const n = Math.max(this.cfg.players.length, 2);
    const R = this.cfg.arena.stadium ? this.cfg.arena.stadium.radius * 0.55 : Math.min(this.terrain.size * 0.45, 8);
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i / n) * Math.PI * 2;
      let x = Math.cos(a) * R, z = Math.sin(a) * R;
      if (!this.terrain.isSafe(x, z)) { const p = this.terrain.randomSafePoint(this.rnd, { x, z, r: 5 }); x = p.x; z = p.z; }
      this.spawns.push({ x, z });
    }
  }

  spawnFor(top: TopState, idx: number) {
    const teamSp = this.spawns.filter((s) => s.team === top.team);
    const list = teamSp.length && this.cfg.mode !== 'ffa' ? teamSp : this.spawns.filter((s) => s.team === undefined);
    const pick = list.length ? list[idx % list.length] : { x: 0, z: 0 };
    return pick;
  }

  addTop(name: string, team: number, blade: MatchConfig['players'][0]['blade'], cpuLevel: number, idx: number, drone = false) {
    const st = computeStats(blade);
    const kinds: [TopState['specialKind'], number][] = [['rush', st.attack], ['fortress', st.defense], ['vortex', st.stamina], ['skydive', st.speed]];
    let best = kinds[0];
    for (const k of kinds) if (k[1] > best[1]) best = k;
    const t: TopState = {
      id: this.s.tops.length, team, name, color: blade.glow, cpu: cpuLevel > 0,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 1, dir: blade.spinDir, angle: 0, tx: 0, tz: 0,
      grounded: false, air: 0, alive: true, out: '', outT: 0, burst: 0, special: 0, specialKind: best[0],
      dashCd: 0, jumpCd: 0, itemCd: 0, item: null, roll: 0,
      fx: { turbo: 0, shield: 0, titan: 0, vortex: 0, frozen: 0, special: 0, dash: 0, surge: 0 },
      flag: -1, crystals: 0, score: 0, kos: 0, dmg: 0, lives: this.cfg.mode === 'gauntlet' || this.cfg.mode === 'pinball' ? 3 : this.cfg.mode === 'quest' ? 5 : 99, qcp: -1,
      respawnT: 0, lastHit: -1, lastHitT: -99, launch: 0.6, launchLocked: false, drone, scale: 1,
      lap: 0, prog: 0, cp: 0, place: 0, finishT: -1, off: 0,
    };
    this.s.tops.push(t);
    this.st.push(st);
    this.controls.push({ ...NO_CONTROL });
    this.ai.push(cpuLevel > 0 ? newAI(cpuLevel, this.rnd) : null);
    const sp = this.spawnFor(t, idx);
    this.placeTop(t, sp.x, sp.z, 1.6);
    return t;
  }

  placeTop(t: TopState, x: number, z: number, lift: number) {
    const T = this.terrain.track;
    if (T) t.prog = globalNearest(T, x, z);
    // on overlapping tracks, land on the road this point belongs to (not the bridge above it)
    const prev = this.terrain.hintY;
    if (T && this.terrain.layered) this.terrain.hintY = T.y[t.prog] + 1.5;
    t.x = x; t.z = z; t.y = this.ground(x, z) + lift;
    this.terrain.hintY = prev;
    t.vx = t.vy = t.vz = 0;
  }

  endT = -1;
  /** per-blade speed multiplier from race catch-up (rubber banding) */
  rubber: number[] = [];
  /** race slipstream: true while tucked in behind another racer */
  draft: boolean[] = [];
  finishers = 0;

  /** Merge input; edge flags persist until consumed by a substep. */
  setControl(i: number, c: Control) {
    const p = this.controls[i];
    if (!p) return;
    p.mx = c.mx; p.mz = c.mz; p.hold = c.hold; p.flipL = c.flipL; p.flipR = c.flipR;
    p.dash ||= c.dash; p.jump ||= c.jump; p.item ||= c.item; p.special ||= c.special;
  }

  ev(e: GameState['events'][0]) { this.s.events.push(e); }

  // ---------------- phases ----------------
  startLaunch() {
    const s = this.s;
    s.phase = 'launch';
    s.phaseT = 0;
    this.pairCd.clear();
    s.tops.forEach((t, i) => {
      if (t.drone) return;
      t.alive = true; t.out = ''; t.outT = 0; t.spin = 1; t.burst = 0; t.launchLocked = false; t.launch = 0.6;
      t.fx = { turbo: 0, shield: 0, titan: 0, vortex: 0, frozen: 0, special: 0, dash: 0, surge: 0 };
      t.flag = -1; t.item = null; t.roll = 0; t.scale = 1;
      const sp = this.spawnFor(t, i);
      this.placeTop(t, sp.x, sp.z, 1.6);
    });
    s.tops = s.tops.filter((t) => !t.drone);
    this.ev({ k: 'announce', text: this.rounds ? `ROUND ${s.round}` : this.mode.name.toUpperCase(), sub: this.cfg.mode === 'pinball' ? 'Hold ↓ to pull the plunger, let go to fire' : 'Press DASH at full power to launch!' });
  }

  launchPower(t = this.s.phaseT) { return 0.5 - 0.5 * Math.cos(t * 4.2); }

  updateLaunch(dt: number) {
    const s = this.s;
    const counts = [0.6, 1.4, 2.2];
    for (let k = 0; k < 3; k++) if (s.phaseT - dt < counts[k] && s.phaseT >= counts[k]) this.ev({ k: 'count', n: 3 - k });
    s.tops.forEach((t, i) => {
      t.angle += t.dir * dt * 30;
      const c = this.controls[i];
      if (!t.launchLocked) {
        if (this.ai[i]) {
          const lv = this.ai[i]!.level;
          if (s.phaseT > 1.2 + i * 0.13 && Math.abs(this.launchPower() - 1) < 0.08 + (3 - lv) * 0.12) { t.launch = this.launchPower(); t.launchLocked = true; }
        } else if (c.dash) {
          t.launch = this.launchPower();
          t.launchLocked = true;
        }
      }
      // hover
      const g = this.ground(t.x, t.z);
      t.y = g + 1.6 + Math.sin(s.t * 3 + i) * 0.05;
      t.vx = t.vy = t.vz = 0;
    });
    if (s.phaseT >= 3.0) {
      for (const t of s.tops) {
        const p = t.launchLocked ? t.launch : 0.45;
        t.spin = 0.72 + 0.4 * p;
        // launch toward center with sideways spin-kick
        const dx = -t.x, dz = -t.z, d = Math.hypot(dx, dz) || 1;
        const sp = 2 + p * 4;
        t.vx = (dx / d) * sp + (-dz / d) * t.dir * 2;
        t.vz = (dz / d) * sp + (dx / d) * t.dir * 2;
        const TS = this.terrain.track;
        if (TS) { t.vx = TS.tx[t.prog] * (4 + p * 8); t.vz = TS.tz[t.prog] * (4 + p * 8); }
        if (this.cfg.mode === 'pinball') { t.vx = t.vz = 0; t.spin = 1; }
        t.vy = -2;
      }
      s.phase = 'battle';
      s.phaseT = 0;
      s.t0 = s.t;
      this.ev({ k: 'go' });
      this.ev({ k: 'announce', text: 'LET IT RIP!', color: '#ffd23a' });
    }
  }

  // ---------------- main step ----------------
  step(dt: number) {
    const s = this.s;
    s.t += dt;
    s.phaseT += dt;
    if (s.phase === 'launch') {
      this.updateLaunch(dt);
      this.clearEdges();
      return;
    }
    if (s.phase === 'battle') {
      s.timeLeft -= dt;
      // AI
      s.tops.forEach((t, i) => {
        const a = this.ai[i];
        if (a && t.alive) { this.terrain.hintY = t.y + 0.5; this.setControl(i, aiControl(this, t, a, dt)); this.terrain.hintY = undefined; }
      });
    }
    // tops
    s.tops.forEach((t, i) => { this.terrain.hintY = t.y + 0.5; this.updateTop(t, i, dt); });
    this.terrain.hintY = undefined;
    this.collideTops(dt);
    if (this.railSegs.length) this.collideRails();
    this.hazards(dt);
    if (this.s.pin) this.pinballUpdate(dt);
    this.updateObjects(dt);
    this.clearEdges();
    if (s.phase === 'battle') this.modeUpdate(dt);
    else if (s.phase === 'roundEnd' && s.phaseT > 3.2) {
      if (s.winner !== -1) { s.phase = 'matchEnd'; s.phaseT = 0; }
      else { s.round++; s.timeLeft = this.cfg.timeLimit; this.startLaunch(); }
    }
  }

  /** Client-side prediction: advance only blade i (terrain, hazards, abilities), no other blades. */
  predictStep(i: number, dt: number) {
    const t = this.s.tops[i];
    if (!t) return;
    this.updateTop(t, i, dt);
    this.hazards(dt);
    const c = this.controls[i];
    c.dash = c.jump = c.item = c.special = false;
    this.s.events.length = 0;
  }

  clearEdges() {
    for (const c of this.controls) c.dash = c.jump = c.item = c.special = false;
  }

  // ---------------- per-top physics ----------------
  mass(t: TopState) {
    const st = this.st[t.id];
    return st.mass * (t.fx.titan > 0 ? 2.2 : 1) * (t.fx.special > 0 && t.specialKind === 'fortress' ? 4 : 1);
  }
  radius(t: TopState) { return this.st[t.id].radius * t.scale; }

  updateTop(t: TopState, i: number, dt: number) {
    const s = this.s;
    const st = this.st[i];
    const c = this.controls[i];
    // match over / race finished: brake to a stop where you are (no drifting off an edge with no one steering)
    if (t.alive && (s.phase === 'matchEnd' || this.safeFinished(t))) {
      const k = Math.max(0, 1 - dt * 2.5);
      t.vx *= k; t.vz *= k;
      if (t.spin < 0.4) t.spin = 0.4;
      // already sailing off an edge when you crossed the line: quietly put you back on the road, no penalty
      const TS = this.terrain.track;
      if (TS && this.safeFinished(t) && t.y < this.ground(t.x, t.z) - 6) { this.placeTop(t, TS.x[t.prog], TS.z[t.prog], 1); t.vx = t.vz = 0; }
    }
    for (const k in t.fx) { const kk = k as keyof typeof t.fx; if (t.fx[kk] > 0) t.fx[kk] = Math.max(0, t.fx[kk] - dt); }
    t.dashCd = Math.max(0, t.dashCd - dt);
    t.jumpCd = Math.max(0, t.jumpCd - dt);
    t.itemCd = Math.max(0, t.itemCd - dt);
    t.scale += ((t.fx.titan > 0 ? 1.3 : 1) - t.scale) * Math.min(1, dt * 6);
    if (t.roll > 0) {
      t.roll -= dt;
      if (t.roll <= 0) t.roll = 0;
    }

    if (t.graceT) t.graceT = Math.max(0, t.graceT - dt);
    if (!t.alive) {
      t.outT += dt;
      if (t.out === 'over' || t.out === 'xtreme') this.integrate(t, i, dt, false);
      else { t.vx *= 0.9; t.vz *= 0.9; }
      if (t.respawnT > 0) {
        t.respawnT -= dt;
        if (t.respawnT <= 0) this.respawn(t, i);
      }
      return;
    }

    if (t.held !== undefined) return; // sitting in a capture saucer (pinball)
    const canAct = s.phase === 'battle' && t.fx.frozen <= 0;
    // ---- abilities
    if (canAct) {
      let ix = c.mx, iz = c.mz;
      const il = Math.hypot(ix, iz);
      if (il > 1) { ix /= il; iz /= il; }
      if (this.cfg.mode === 'pinball') {
        c.jump = false; c.hold = false;
        if (c.flipL || c.flipR) c.dash = false; // (RT is a flipper on pads)
        if (c.dash && this.inPlunger(t)) { this.plunge(t, 1); c.dash = false; }
      }
      if (c.dash && t.dashCd <= 0 && t.spin > 0.08) {
        let dx = ix, dz = iz;
        if (this.cfg.mode === 'pinball') { const a = this.pinAim(t); if (a) { dx = a.x - t.x; dz = a.z - t.z; } }
        if (Math.hypot(dx, dz) < 0.2) { const v = Math.hypot(t.vx, t.vz) || 1; dx = t.vx / v; dz = t.vz / v; }
        const dl = Math.hypot(dx, dz) || 1;
        const dashV = (this.cfg.mode === 'race' ? 11 : 9) * this.rpmK(t);
        t.vx += (dx / dl) * dashV; t.vz += (dz / dl) * dashV;
        t.spin -= this.cfg.mode === 'race' ? 0.01 : 0.025;
        t.dashCd = 1.1;
        t.fx.dash = 0.35;
        this.ev({ k: 'dash', id: t.id });
      }
      if (c.jump && t.jumpCd <= 0 && t.grounded) {
        t.vy += 7.5;
        t.grounded = false;
        t.spin -= 0.015;
        t.jumpCd = 0.8;
        this.ev({ k: 'jump', id: t.id });
      }
      if (c.item && t.item && t.roll <= 0 && t.itemCd <= 0) this.useItem(t);
      if (c.special && t.special >= 1) this.useSpecial(t);
    }

    this.integrate(t, i, dt, canAct);

    // spin decay
    const decay = st.spinDecay * (0.55 + 0.45 * t.spin) * (t.grounded ? 1 : 0.25) * (this.cfg.mode === 'gauntlet' ? 1.25 : this.cfg.mode === 'race' ? 0.3 : this.cfg.mode === 'quest' ? 0.45 : 1) + (t.spin < 0.25 ? 0.006 : 0);
    if (!(t.fx.special > 0 && t.specialKind === 'vortex')) t.spin -= decay * (t.fx.surge > 0 ? 0.3 : 1) * (t.duel ? 0.6 : 1) * dt + (t.spin > 1 && t.fx.surge <= 0 ? (t.spin - 1) * 0.6 * dt : 0);
    else t.spin = Math.max(t.spin, Math.min(1.1, t.spin + 0.12 * dt));
    t.angle += t.dir * (6 + t.spin * 34) * dt;

    // finishes
    if (t.spin <= 0.03 && t.duel && !t.drone) t.spin = 0.05; // (an arena duel is decided by the table, not a lost ball)
    else if (t.spin <= 0.03) this.finish(t, 'spin');
    else if (t.y < -4) {
      const hs = Math.hypot(t.vx, t.vz);
      this.finish(t, hs > 11 ? 'xtreme' : 'over');
    }
  }

  integrate(t: TopState, i: number, dt: number, control: boolean) {
    const st = this.st[i];
    const c = this.controls[i];
    let ax = 0, az = 0;
    // overdrive: keep holding dash after the burst → more speed and climbing push, paid for in spin, steering wider
    t.holdT = c.hold && control && t.alive ? (t.holdT ?? 0) + dt : 0;
    t.od = t.holdT > 0.35 && t.spin > 0.12;
    if (t.od) t.spin -= (this.cfg.mode === 'race' ? 0.09 : 0.13) * dt;
    if (control) {
      let ix = c.mx, iz = c.mz;
      const il = Math.hypot(ix, iz);
      if (il > 1) { ix /= il; iz /= il; }
      if (this.cfg.mode === 'pinball' && !t.duel) { const k = this.s.pin?.tilted || t.extra ? 0 : 0.33; ix *= k; iz *= k; }
      if (t.od) {
        // wider turns: the part of your input across your travel direction is weaker
        const vl0 = Math.hypot(t.vx, t.vz);
        if (vl0 > 2) { const ux = t.vx / vl0, uz = t.vz / vl0, along = ix * ux + iz * uz; ix = ux * along + (ix - ux * along) * 0.6; iz = uz * along + (iz - uz * along) * 0.6; }
      }
      let acc = 17 * this.rpmK(t) * (this.cfg.mode === 'race' ? 1.2 * (this.draft[i] ? 1.12 : 1) : 1) * (this.rubber[i] ?? 1) * st.control * (t.fx.turbo > 0 ? 1.7 : 1) * (t.od ? 1.45 : 1) * (t.flag >= 0 ? 0.8 : 1) * (t.grounded ? 1 : 0.3);
      // counter-steering bites harder so low-grip tips can still turn and stop
      const vl = Math.hypot(t.vx, t.vz);
      if (vl > 0.5 && il > 0.1 && (ix * t.vx + iz * t.vz) / (vl * Math.min(1, il)) < -0.2) acc *= 1.4;
      ax += ix * acc; az += iz * acc;
      t.spin -= Math.min(1, il) * 0.004 * dt;
    }
    // vortex pull from others
    for (const o of this.s.tops) {
      if (o === t || !o.alive || o.team === t.team) continue;
      const pull = o.fx.vortex > 0 || (o.fx.special > 0 && o.specialKind === 'vortex');
      if (!pull) continue;
      const dx = o.x - t.x, dz = o.z - t.z, d = Math.hypot(dx, dz);
      if (d < 7 && d > 0.1) { ax += (dx / d) * 11 * (1 - d / 7); az += (dz / d) * 11 * (1 - d / 7); }
    }
    // rush special: home onto nearest enemy
    if (t.fx.special > 0 && t.specialKind === 'rush') {
      const e = this.nearestEnemy(t);
      if (e) { const dx = e.x - t.x, dz = e.z - t.z, d = Math.hypot(dx, dz) || 1; ax += (dx / d) * 40; az += (dz / d) * 40; }
    }

    if (t.grounded && t.alive) {
      this.terrain.gradient(t.x, t.z, grad);
      // gyroscopic tilt: slope + low-spin wobble -> tip contact offset -> drift
      const wob = Math.max(0, 0.4 - t.spin) * 2.5;
      const prec = this.s.t * (3 + t.spin * 4) * t.dir;
      const targetTx = grad.gx * 0.35 + Math.cos(prec) * wob * 0.35;
      const targetTz = grad.gz * 0.35 + Math.sin(prec) * wob * 0.35;
      t.tx += (targetTx - t.tx) * Math.min(1, dt * 8);
      t.tz += (targetTz - t.tz) * Math.min(1, dt * 8);
      const drift = t.spin * st.tipFriction * 10 * t.dir * (this.cfg.mode === 'pinball' && !t.duel ? 0.25 : 1);
      ax += -t.tz * drift;
      az += t.tx * drift;
      const slope = Math.hypot(grad.gx, grad.gz);
      // wall riding: steep surface + spin = grind along it (xtreme dash)
      if (slope > 1.2 && this.cfg.mode !== 'pinball') { // (no wall-riding on a pinball table: walls just bounce)
        const nx = -grad.gx / slope, nz = -grad.gz / slope; // horizontal normal (pointing downhill)
        const ride = t.spin * (st.tipFriction + 0.35) * 9 * t.dir;
        ax += -nz * ride; az += nx * ride;
        if (Math.random() < dt * 20) this.ev({ k: 'grind', x: t.x, y: t.y, z: t.z, id: t.id });
        // grind regen: a fast wall ride feeds spin back in (rewards style; slow crawling up a wall doesn't count)
        const sp = Math.hypot(t.vx, t.vz);
        if (sp > 6 && t.spin < 1) t.spin = Math.min(1, t.spin + Math.min(0.08, 0.05 + (sp - 6) * 0.005) * dt);
      } else if (slope > 0.3 && t.spin < 1 && !this.terrain.track) {
        // carving: riding ALONG a curved wall (bowl, quarter pipe, banked edge) at speed feeds spin back too —
        // steeper and faster = more; going straight up/down the wall doesn't count
        const sp = Math.hypot(t.vx, t.vz);
        const across = Math.abs((t.vx * grad.gx + t.vz * grad.gz) / ((sp || 1) * slope));
        if (sp > 6 && across < 0.55) {
          t.spin = Math.min(1, t.spin + (0.035 + Math.min(0.035, (sp - 6) * 0.004)) * Math.min(1, slope / 0.9) * dt);
          if (Math.random() < dt * 6) this.ev({ k: 'grind', x: t.x, y: t.y, z: t.z, id: t.id });
        }
      }
    } else {
      t.tx *= 1 - dt * 2; t.tz *= 1 - dt * 2;
    }

    t.vx += ax * dt; t.vz += az * dt;
    t.vy -= G * dt * (t.fx.special > 0 && t.specialKind === 'skydive' && t.vy < 0 ? 2.2 : 1);
    if (t.grounded) {
      const k = (this.cfg.mode === 'pinball' && !t.duel ? 0.06 : 0.32 + st.tipFriction * 0.3) + (t.fx.frozen > 0 ? 2.5 : 0) + (t.alive ? 0 : 3);
      const f = Math.max(0, 1 - k * dt);
      t.vx *= f; t.vz *= f;
    }
    const hs = Math.hypot(t.vx, t.vz);
    const race = this.cfg.mode === 'race';
    const cap = this.cfg.mode === 'pinball' && !t.duel ? 36 : (race ? 16 : 12.5) * this.rpmK(t) * (this.draft[i] ? 1.12 : 1) * (1 + ((this.rubber[i] ?? 1) - 1) * 0.8) * (t.fx.turbo > 0 ? 1.4 : 1) * (t.od ? 1.22 : 1) + (t.fx.dash > 0 ? 7 : 0) + (t.fx.special > 0 && t.specialKind === 'rush' ? 10 : 0);
    if (hs > cap) { const f = 1 - Math.min(0.5, ((hs - cap) / hs) * 4 * dt); t.vx *= f; t.vz *= f; }

    t.x += t.vx * dt; t.y += t.vy * dt; t.z += t.vz * dt;
    if (this.cfg.mode === 'pinball') this.pinballBounds(t);

    const wasGrounded = t.grounded;
    t.grounded = false;
    let h = this.terrain.height(t.x, t.z);
    if (h > VOID && t.y <= h + 0.002) {
      let nx = 0, ny = 1, nz = 0;
      for (let k = 0; k < 3; k++) {
        this.terrain.gradient(t.x, t.z, grad);
        const L = Math.hypot(grad.gx, 1, grad.gz);
        nx = -grad.gx / L; ny = 1 / L; nz = -grad.gz / L;
        h = this.terrain.height(t.x, t.z);
        if (h <= VOID || t.y >= h) break;
        const pen = (h - t.y) * ny;
        t.x += nx * pen; t.y += ny * pen; t.z += nz * pen;
      }
      h = this.terrain.height(t.x, t.z);
      if (h > VOID) {
        if (t.y < h) t.y = h;
        const vn = t.vx * nx + t.vy * ny + t.vz * nz;
        if (vn < 0) {
          const impact = -vn;
          const e = this.cfg.mode === 'pinball' && ny < 0.6 ? 0.42 : impact > 5 ? 0.25 : 0;
          t.vx -= (1 + e) * vn * nx; t.vy -= (1 + e) * vn * ny; t.vz -= (1 + e) * vn * nz;
          if (!wasGrounded && t.air > 0.18 && impact > 3) {
            this.ev({ k: 'land', x: t.x, y: t.y, z: t.z, s: impact, id: t.id });
            if (t.alive) t.spin -= impact * 0.0035 * (1.2 - st.defense * 0.5);
            if (t.fx.special > 0 && t.specialKind === 'skydive') { this.shockwave(t, 5.5, 14, 0.08); t.fx.special = 0; }
          }
        }
        t.grounded = true;
        t.air = 0;
      }
    }
    if (!t.grounded) t.air += dt;
  }

  // ---------------- collisions ----------------
  collideTops(dt: number) {
    const tops = this.s.tops;
    for (const [k, v] of this.pairCd) { if (v - dt <= 0) this.pairCd.delete(k); else this.pairCd.set(k, v - dt); }
    for (let i = 0; i < tops.length; i++)
      for (let j = i + 1; j < tops.length; j++) {
        const A = tops[i], B = tops[j];
        if (!A.alive || !B.alive) continue;
        if (this.safeFinished(A) || this.safeFinished(B)) continue; // finished racers are ghosts
        const dx = B.x - A.x, dz = B.z - A.z, dy = B.y - A.y;
        const rA = this.radius(A), rB = this.radius(B);
        const dist = Math.hypot(dx, dz);
        if (dist >= rA + rB || Math.abs(dy) > 0.85 || dist < 1e-4) continue;
        const nx = dx / dist, nz = dz / dist;
        const mA = this.mass(A), mB = this.mass(B);
        const inv = 1 / mA + 1 / mB;
        // separate
        const ov = rA + rB - dist;
        A.x -= nx * ov * (1 / mA) / inv; A.z -= nz * ov * (1 / mA) / inv;
        B.x += nx * ov * (1 / mB) / inv; B.z += nz * ov * (1 / mB) / inv;
        const key = i * 64 + j;
        if (this.pairCd.has(key)) continue;
        const vn = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
        if (vn > 1.5) continue;
        this.pairCd.set(key, 0.09);
        this.clash(A, B, nx, nz, vn, dy);
      }
  }

  clash(A: TopState, B: TopState, nx: number, nz: number, vn: number, dy: number) {
    const sa = this.st[A.id], sb = this.st[B.id];
    const mA = this.mass(A), mB = this.mass(B);
    const mEff = 1 / (1 / mA + 1 / mB);
    const tx = nz, tz = -nx;
    const sA = A.dir * A.spin * S_SURF, sB = -B.dir * B.spin * S_SURF;
    const vt = (A.vx - B.vx) * tx + (A.vz - B.vz) * tz;
    const slip = vt + sA - sB;
    const atk = (t: TopState, s: BladeStats) => s.attack * (t.fx.dash > 0 ? 1.6 : 1) * (t.fx.special > 0 && t.specialKind === 'rush' ? 2 : 1) * (t.fx.titan > 0 ? 1.3 : 1) * (0.5 + Math.min(1, t.spin) * 0.6); // overcharge (>100%) is defence, not extra punch
    const def = (t: TopState, s: BladeStats) => (s.defense + 0.3) * (t.fx.shield > 0 ? 4 : 1) * (t.fx.special > 0 && t.specialKind === 'fortress' ? 3 : 1);
    const aA = atk(A, sa), aB = atk(B, sb), dA = def(A, sa), dB = def(B, sb);
    const approach = Math.max(0, -vn);
    const e = 0.55;
    const jn = mEff * (approach * (1 + e) + (2.0 + Math.abs(slip) * 0.32) * (0.55 + (aA + aB) * 0.55));
    const jt = Math.sign(slip) * Math.min(0.55 * jn, Math.abs(slip) * mEff * 0.5);
    const kA = A.fx.shield > 0 ? 0.4 : 1, kB = B.fx.shield > 0 ? 0.4 : 1;
    A.vx -= ((nx * jn + tx * jt) / mA) * kA; A.vz -= ((nz * jn + tz * jt) / mA) * kA;
    B.vx += ((nx * jn + tx * jt) / mB) * kB; B.vz += ((nz * jn + tz * jt) / mB) * kB;
    // vertical: upper attack lifts, higher top smashes down
    const tiltA = this.cfg.players[A.id]?.blade.wingTilt ?? 0, tiltB = this.cfg.players[B.id]?.blade.wingTilt ?? 0;
    B.vy += (jn / mB) * 0.22 * Math.max(0, tiltA) + (dy < -0.2 ? -2 : 0);
    A.vy += (jn / mA) * 0.22 * Math.max(0, tiltB) + (dy > 0.2 ? -2 : 0);
    // spin exchange through contact friction
    const fric = 0.06;
    const sAn = sA - (jt * 2 / mA) * fric * (1.3 - dA * 0.35);
    const sBn = sB + (jt * 2 / mB) * fric * (1.3 - dB * 0.35);
    const before = [A.spin, B.spin];
    A.spin = Math.max(0, Math.min(1.35, (sAn * A.dir) / S_SURF));
    B.spin = Math.max(0, Math.min(1.35, (-sBn * B.dir) / S_SURF));
    // direct impact damage (a surging top shrugs off half)
    A.spin -= (approach * 0.003 + 0.004) * (aB / dA) * (A.fx.surge > 0 ? 0.5 : 1);
    B.spin -= (approach * 0.003 + 0.004) * (aA / dB) * (B.fx.surge > 0 ? 0.5 : 1);
    // pinball: your own balls bounce off each other, no battle damage
    const friendly = this.cfg.mode === 'pinball' && A.team === B.team;
    if (friendly) { A.spin = before[0]; B.spin = before[1]; }
    else if (A.duel && B.duel) { A.spin = before[0] - (before[0] - A.spin) * 0.6; B.spin = before[1] - (before[1] - B.spin) * 0.6; } // (arena duel: a tight bowl means constant contact)
    const lossA = Math.max(0, before[0] - A.spin), lossB = Math.max(0, before[1] - B.spin);
    A.dmg += lossB; B.dmg += lossA;
    A.special = Math.min(1, A.special + lossB * 2.2 + 0.015);
    B.special = Math.min(1, B.special + lossA * 2.2 + 0.015);
    A.lastHit = B.id; A.lastHitT = this.s.t;
    B.lastHit = A.id; B.lastHitT = this.s.t;
    // burst
    const I = jn + Math.abs(jt);
    const bth = 8;
    if (I > bth) {
      if (B.fx.shield <= 0 && !friendly) B.burst += ((I - bth) * aA * 0.0075) / (sb.burstRes + 0.2) * (1.5 - B.spin);
      if (A.fx.shield <= 0 && !friendly) A.burst += ((I - bth) * aB * 0.0075) / (sa.burstRes + 0.2) * (1.5 - A.spin);
    }
    // flag carriers drop on hard hits
    if (I > 6) { if (A.flag >= 0) this.dropFlag(A); if (B.flag >= 0) this.dropFlag(B); }
    // rush crystals spill
    if (this.cfg.mode === 'rush' && I > 5) {
      const loser = lossA > lossB ? A : B;
      this.spillCrystals(loser, Math.min(loser.crystals, 1 + Math.floor(I / 5)));
    }
    const cx = A.x + nx * this.radius(A), cz = A.z + nz * this.radius(A);
    this.ev({ k: 'clash', x: cx, y: (A.y + B.y) / 2 + 0.35, z: cz, s: I, a: A.id, b: B.id });
    if (B.burst >= 1) this.finish(B, 'burst', A.id);
    if (A.burst >= 1) this.finish(A, 'burst', B.id);
  }

  hazards(dt: number) {
    for (const [k, v] of this.hazardHitCd) { if (v - dt <= 0) this.hazardHitCd.delete(k); else this.hazardHitCd.set(k, v - dt); }
    const t = this.s.t;
    this.markers.forEach((m, mi) => {
      if (m.kind === 'boost' || m.kind === 'spinpad') {
        for (const top of this.s.tops) {
          if (!top.alive || !top.grounded) continue;
          const dx = top.x - m.x, dz = top.z - m.z;
          if (m.kind === 'spinpad') {
            // spin pads: park on one to re-spin (worth fighting over); fastest when nearly spun out
            if (Math.hypot(dx, dz) < (m.r ?? 1.1) && top.spin < 1) top.spin = Math.min(1, top.spin + (0.13 + (1 - top.spin) * 0.12) * dt);
          } else {
            const a = m.rot ?? 0, fx = Math.sin(a), fz = Math.cos(a);
            const along = dx * fx + dz * fz, side = dx * fz - dz * fx;
            const race = this.cfg.mode === 'race';
            if (Math.abs(along) < (race ? 1.8 : 1.4) && Math.abs(side) < (m.r ?? 0.9)) {
              top.vx += fx * (race ? 62 : 34) * dt; top.vz += fz * (race ? 62 : 34) * dt;
              if (race) top.fx.turbo = Math.max(top.fx.turbo, 1.0);
              const key = `b${mi}:${top.id}`;
              if (!this.hazardHitCd.has(key)) { this.hazardHitCd.set(key, 1); this.ev({ k: 'pickup', id: top.id, what: 'boost', x: top.x, y: top.y, z: top.z }); }
            }
          }
        }
        return;
      }
      const hp = hazardPose(m, t);
      if (!hp) return;
      const baseY = this.ground(m.x, m.z);
      for (const top of this.s.tops) {
        if (!top.alive || top.graceT) continue; // just respawned: it passes through you
        if (top.y > baseY + 1.1) continue; // jumped over it
        const r = this.radius(top);
        let px: number, pz: number, hvx = hp.vx, hvz = hp.vz;
        if (hp.kind === 'arm') {
          const cp = closestOnSeg(hp.ax, hp.az, hp.bx, hp.bz, top.x, top.z);
          px = cp.x; pz = cp.z;
          // velocity of the arm at that point
          const rx = cp.x - hp.ax, rz = cp.z - hp.az;
          hvx = -rz * hp.w; hvz = rx * hp.w;
        } else { px = hp.ax; pz = hp.az; }
        const dx = top.x - px, dz = top.z - pz, d = Math.hypot(dx, dz);
        const R = r + hp.r;
        if (d >= R || d < 1e-4) continue;
        const nx = dx / d, nz = dz / d;
        top.x = px + nx * R; top.z = pz + nz * R;
        const rvn = (top.vx - hvx) * nx + (top.vz - hvz) * nz;
        const key = `${mi}:${top.id}`;
        if (rvn < 0) {
          const bounce = hp.kind === 'bumper' ? 1.0 : hp.kind === 'pillar' ? 0.6 : 1.1;
          top.vx -= (1 + bounce) * rvn * nx; top.vz -= (1 + bounce) * rvn * nz;
        }
        // on race ribbons obstacles slow you and cost spin, but shouldn't fling you into the void every time
        const kb = this.cfg.mode === 'race' ? 0.55 : this.cfg.mode === 'pinball' ? 1.35 : 1;
        if (hp.kind === 'bumper') { top.vx += nx * 9 * kb; top.vz += nz * 9 * kb; }
        if (hp.kind === 'arm' || hp.kind === 'saw') { top.vx += (hvx * 0.6 + nx * 4) * kb; top.vz += (hvz * 0.6 + nz * 4) * kb; top.vy += 2.5 * kb; }
        if (!this.hazardHitCd.has(key)) {
          this.hazardHitCd.set(key, 0.4);
          const dmg = hp.kind === 'saw' ? 0.09 : hp.kind === 'arm' ? 0.05 : hp.kind === 'bumper' ? 0.01 : 0.004;
          if (top.fx.shield <= 0 && this.cfg.mode !== 'pinball') top.spin -= dmg;
          if (this.s.pin && hp.kind === 'bumper') { this.addScore(top, 100); top.spin = Math.min(1, top.spin + 0.015); this.ev({ k: 'pin', what: 'bumper', x: hp.ax, y: top.y, z: hp.az, pts: 100 }); }
          this.ev({ k: 'hazard', x: px + nx * hp.r, y: top.y + 0.3, z: pz + nz * hp.r, id: top.id });
          if (top.flag >= 0 && hp.kind !== 'pillar') this.dropFlag(top);
        }
      }
    });
  }

  // ---------------- finishes / respawns ----------------
  /**
   * Spin speed drives the blade: full spin = 1 (unchanged balance), winding down to ~0.78 near spin-out,
   * overcharge (Spin Surge) up to ~1.09. Scales dash strength, acceleration and top speed.
   */
  rpmK(t: TopState) { const s = Math.max(0, t.spin); return 0.72 + 0.28 * Math.min(1, s) + 0.25 * Math.max(0, Math.min(0.35, s - 1)); }

  /** a racer who has crossed the line: coasts to a stop as a ghost while the rest finish (can't be knocked out) */
  safeFinished(t: TopState) { return this.cfg.mode === 'race' && t.finishT >= 0; }

  finish(t: TopState, type: FinishType, by = -1) {
    if (!t.alive) return;
    // once the round/match is decided (or you've finished the race) nothing can knock you out or cost a life
    if (this.s.phase !== 'battle' || this.safeFinished(t)) return;
    t.alive = false;
    t.out = type;
    t.outT = 0;
    if (by < 0 && this.s.t - t.lastHitT < 5) by = t.lastHit;
    if (t.flag >= 0) this.dropFlag(t);
    if (this.cfg.mode === 'rush') this.spillCrystals(t, Math.ceil(t.crystals / 2));
    this.ev({ k: 'finish', id: t.id, type, by });
    if (type === 'burst') this.ev({ k: 'burst', id: t.id, x: t.x, y: t.y, z: t.z });
    const killer = by >= 0 ? this.s.tops[by] : null;
    if (killer && killer.team !== t.team) killer.kos++;
    this.s.lastFinish = FINISH_LABEL[type];
    if (this.rounds && this.s.phase === 'battle') {
      // award points
      let team = -1;
      if (this.numTeams === 2) team = 1 - t.team;
      else if (killer && killer.team !== t.team) team = killer.team;
      if (team >= 0) {
        this.s.teamScores[team] += POINTS[type];
        const k = this.s.tops.find((x) => x.team === team);
        this.ev({ k: 'announce', text: FINISH_LABEL[type], sub: `${t.name} is out! +${POINTS[type]} ${this.teamLabel(team)}`, color: k?.color });
      } else this.ev({ k: 'announce', text: FINISH_LABEL[type], sub: `${t.name} self-destructed!` });
    } else if (!t.drone && this.cfg.mode !== 'pinball') {
      this.ev({ k: 'announce', text: FINISH_LABEL[type], sub: `${t.name}${RESPAWN_MODES.has(this.cfg.mode) ? ' respawning…' : ''}` });
    }
    if (this.cfg.mode === 'pinball' && !t.drone) {
      // multiball balls just go; the main ball only costs a life when it's the last ball on the table
      if (t.extra) return;
      const others = this.s.tops.some((o) => o !== t && o.extra && o.alive);
      if (!others) t.lives--;
      if (t.lives > 0) t.respawnT = 1.4;
      this.ev({ k: 'announce', text: others ? 'BALL SAVED' : t.lives > 0 ? 'BALL LOST' : 'GAME OVER', sub: others ? 'multiball keeps you in' : t.lives > 0 ? `${t.lives} ball${t.lives === 1 ? '' : 's'} left` : `final score ${this.s.teamScores[t.team] | 0}` });
      return;
    }
    if (RESPAWN_MODES.has(this.cfg.mode) && !t.drone) {
      if (this.cfg.mode === 'gauntlet' || this.cfg.mode === 'quest') {
        t.lives--;
        if (t.lives > 0) t.respawnT = this.cfg.mode === 'quest' ? 1.4 : 2.5;
      } else t.respawnT = this.cfg.mode === 'race' ? 1.2 : 2.5;
    }
  }

  teamLabel(team: number) {
    if (this.numTeams === 2 && this.cfg.mode !== 'duel') return team === 0 ? 'RED' : 'BLUE';
    return this.s.tops.find((t) => t.team === team)?.name ?? `Team ${team + 1}`;
  }

  respawn(t: TopState, i: number) {
    t.alive = true; t.out = ''; t.spin = 1; t.burst = 0; t.fx.shield = 2; t.flag = -1; t.off = 0;
    t.graceT = 1.6;
    if (this.cfg.mode === 'pinball') {
      const sp = this.spawnFor(t, i);
      this.placeTop(t, sp.x, sp.z, 0.5); t.vx = t.vy = t.vz = 0;
      if (this.s.pin) { this.s.pin.tilted = false; this.s.pin.tilt = 0; this.s.pin.warned = false; this.s.pin.charge = 0; }
      return;
    }
    const TS = this.terrain.track;
    if (TS) {
      // back on the ribbon where we fell off, facing forward: the first solid ground at/after it that's clear of
      // obstacles (so gaps and sweeping arms don't become fall loops)
      let k = t.prog;
      for (let n = 0; n < 120 && !(this.terrain.isSafe(TS.x[k], TS.z[k], 1.5) && this.clearOfHazards(TS.x[k], TS.z[k], 1.2)); n++) k = TS.open ? Math.min(TS.n - 1, k + 2) : (k + 2) % TS.n;
      const keep = t.prog;
      this.placeTop(t, TS.x[k], TS.z[k], 1.5);
      t.prog = k < keep && keep - k < TS.n / 2 ? keep : k;
      t.vx = TS.tx[k] * 6; t.vz = TS.tz[k] * 6;
      return;
    }
    if (this.cfg.mode === 'quest') {
      // back at your last checkpoint (or the start), full spin
      const cp = (t.qcp ?? -1) >= 0 ? this.markers[t.qcp!] : null;
      const sp = this.clearSpotNear(cp ? { x: cp.x, z: cp.z } : this.spawnFor(t, i));
      this.placeTop(t, sp.x, sp.z, 2.5);
      return;
    }
    let sp = this.cfg.mode === 'gauntlet' ? this.spawnFor(t, i) : this.terrain.randomSafePoint(this.rnd, { ...this.spawnFor(t, i), r: 3 });
    for (let n = 0; n < 12 && this.cfg.mode !== 'gauntlet' && !this.clearOfHazards(sp.x, sp.z, 1.2); n++) sp = this.terrain.randomSafePoint(this.rnd, { ...this.spawnFor(t, i), r: 3 + n });
    if (this.cfg.mode === 'gauntlet') sp = this.clearSpotNear(sp);
    this.placeTop(t, sp.x, sp.z, 3);
  }

  /** is (x,z) outside every obstacle's reach (the whole sweep of an arm, a saw's whole orbit), with `margin` to spare? */
  clearOfHazards(x: number, z: number, margin: number) {
    for (const m of this.markers) {
      const d = Math.hypot(x - m.x, z - m.z);
      if (m.kind === 'arm' && d < (m.len ?? 4) + 0.5 + margin) return false;
      if (m.kind === 'saw' && Math.abs(d - (m.r ?? 5)) < 0.9 + margin) return false;
      if ((m.kind === 'bumper' || m.kind === 'pillar') && d < (m.r ?? 0.8) + 0.6 + margin) return false;
    }
    return true;
  }

  /** the nearest safe, obstacle-free spot to p (rings outward); p itself if nothing better */
  clearSpotNear(p: { x: number; z: number }) {
    if (this.terrain.isSafe(p.x, p.z, 1.2) && this.clearOfHazards(p.x, p.z, 1.2)) return p;
    for (let r = 1.5; r <= 12; r += 1.5)
      for (let a = 0; a < 16; a++) {
        const x = p.x + Math.cos((a / 16) * Math.PI * 2) * r, z = p.z + Math.sin((a / 16) * Math.PI * 2) * r;
        if (this.terrain.isSafe(x, z, 1.2) && this.clearOfHazards(x, z, 1.2)) return { x, z };
      }
    return p;
  }

  // ---------------- pinball ----------------
  railSegs: RailSeg[] = [];

  /**
   * Rails are vertical walls: push a blade out of any it overlaps and bounce it off sideways (never upward — as
   * floor bumps, fast balls launched off them). Slingshot rails also fire the ball off. Jump high enough and you
   * clear a rail.
   */
  collideRails() {
    const pinball = this.cfg.mode === 'pinball';
    for (const t of this.s.tops) {
      if (!t.alive) continue;
      const r = this.radius(t);
      for (let si = 0; si < this.railSegs.length; si++) {
        const sg = this.railSegs[si];
        // cheap reject on the bounding box
        if (t.x < Math.min(sg.ax, sg.bx) - r - sg.half || t.x > Math.max(sg.ax, sg.bx) + r + sg.half || t.z < Math.min(sg.az, sg.bz) - r - sg.half || t.z > Math.max(sg.az, sg.bz) + r + sg.half) continue;
        const { d, cx, cz } = segDist(sg, t.x, t.z);
        const R = r + sg.half;
        if (d >= R || d < 1e-5) continue;
        let base = this.ground(cx, cz);
        if (sg.below) {
          // a flyover's underside skirt: only for balls down below the deck
          if (t.y > this.ground(t.x, t.z) + flyLiftAlong(sg.deck!, t.x, t.z) - 0.6) continue; // (judged where the ball is: one riding up the deck passes over it)
        } else if (sg.deck) {
          // a flyover's wall stands on its deck: balls passing underneath (1.5m+ below) go by it
          base += flyLiftAlong(sg.deck, cx, cz);
          if (t.y < base - 1.5) continue;
        }
        if (!sg.below && t.y > base + sg.h) continue; // over the top
        if (sg.gate !== undefined && this.gateOpen(sg.gate)) continue; // an arena gate, open
        if ((sg.ox || sg.oz) && t.vx * sg.ox + t.vz * sg.oz > 0.5) continue; // a one-way gate, passed the right way (moving clearly through)
        const nx = (t.x - cx) / d, nz = (t.z - cz) / d;
        t.x = cx + nx * R; t.z = cz + nz * R;
        const vn = t.vx * nx + t.vz * nz;
        if (vn < 0) { const e = pinball ? 0.42 : 0.25; t.vx -= (1 + e) * vn * nx; t.vz -= (1 + e) * vn * nz; }
        if (sg.kick > 0 && nx * sg.kx + nz * sg.kz > 0.2) { // (only the front face kicks)
          const key = `k${si}:${t.id}`;
          if (!this.hazardHitCd.has(key)) {
            t.vx += nx * sg.kick; t.vz += nz * sg.kick;
            this.hazardHitCd.set(key, 0.25);
            if (pinball) this.addScore(t, 10);
            this.ev({ k: 'pin', what: 'sling', x: cx, y: t.y, z: cz, pts: 10 });
          }
        }
      }
    }
  }

  addScore(t: TopState, n: number) {
    this.s.teamScores[t.team] = (this.s.teamScores[t.team] ?? 0) + n;
    const owner = t.extra ? this.s.tops.find((o) => o.team === t.team && !o.extra && !o.drone) ?? t : t;
    owner.score += n;
  }

  /**
   * The table's glass cover and cabinet: a ball launched by a ramp bounces off the glass instead of flying away,
   * and can't leave through the sides or top — only the drain at the bottom.
   */
  pinballBounds(t: TopState) {
    const c = this.cfg.arena.course;
    const g = this.terrain.height(t.x, t.z);
    if (g > VOID) {
      const glass = g + 1.15; // just under the lowest rail: a ball can never hop a wall
      // (a ball dropping off the end of a flyover is above the glass on its way down: let it fall)
      if (t.y > glass && (t.vy > 0 || t.y < glass + 0.4)) { t.y = glass; if (t.vy > 0) t.vy = -t.vy * 0.3; }
      // under a flyover: its deck is the ceiling
      const deck = this.terrain.deckAbove(t.x, t.z, t.y);
      if (deck !== undefined && t.y > deck - 1.6) { t.y = deck - 1.6; if (t.vy > 0) t.vy = -t.vy * 0.3; } // (clear of its walls' band)
    }
    if (!c) return;
    const hw = (c.w * c.tile) / 2 - 0.6, hh = (c.h * c.tile) / 2 - 0.6;
    if (t.x < -hw) { t.x = -hw; t.vx = Math.abs(t.vx) * 0.4; }
    if (t.x > hw) { t.x = hw; t.vx = -Math.abs(t.vx) * 0.4; }
    if (t.z < -hh) { t.z = -hh; t.vz = Math.abs(t.vz) * 0.4; }
  }

  /** how far a ball can travel from (x, z) along angle a before meeting a wall, bumper, post or target (max 6m) */
  kickClearance(x: number, z: number, a: number, start: number) {
    const cx = Math.cos(a), cz = Math.sin(a), br = 0.75;
    for (let d = start; d <= 6; d += 0.2) {
      const px = x + cx * d, pz = z + cz * d;
      if (this.railSegs.some((sg) => !(sg.ox || sg.oz) && !sg.deck && segDist(sg, px, pz).d < sg.half + br)) return d;
      if (this.markers.some((m) => (m.kind === 'bumper' || m.kind === 'pillar' || m.kind === 'target' || m.kind === 'post') && Math.hypot(px - m.x, pz - m.z) < (m.r ?? 0.8) + br)) return d;
    }
    return 6;
  }

  /** the kick angle nearest `a` that has at least 4m of clear path (or the clearest one if none does) */
  clearKick(x: number, z: number, a: number, start: number) {
    let best = a, bestClear = -1;
    for (let k = 0; k <= 16; k++) {
      const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.12;
      const c = this.kickClearance(x, z, a + off, start);
      if (c >= 4) return a + off;
      if (c > bestClear) { bestClear = c; best = a + off; }
    }
    return best;
  }

  /** is this ball on the same level as the marker (the floor, or for `fly` markers the flyover deck above it)? */
  atLevel(t: TopState, m: Marker) {
    const y = m.fly ? this.terrain.topHeight(m.x, m.z) : this.ground(m.x, m.z);
    return Math.abs(t.y - y) < 1.2;
  }

  /** is this ball sitting in the plunger lane? */
  inPlunger(t: TopState) {
    const pl = this.markers.find((m) => m.kind === 'plunger');
    return !!pl && Math.abs(t.x - pl.x) < (pl.r ?? 1.1) + 0.3 && Math.abs(t.z - pl.z) < 2.6 && Math.hypot(t.vx, t.vz) < 4;
  }

  /** fire the ball up the plunger lane (k = how far the plunger was pulled, 0..1) */
  plunge(t: TopState, k: number) {
    const pl = this.markers.find((m) => m.kind === 'plunger');
    if (!pl) return;
    const v = (15 + 25 * k) * (pl.len ?? 1);
    t.x = pl.x; t.vx = 0; t.vz = -v;
    t.spin = Math.max(t.spin, 1); // a fresh launch is a full-spin launch
    if (this.s.pin) { this.s.pin.charge = 0; if (!t.extra) this.s.pin.save = 10; }
    this.ev({ k: 'pin', what: 'plunge', x: t.x, y: t.y, z: t.z });
  }

  /** dash aim on a table: the nearest drone / rival, else the nearest unlit target ahead of you */
  pinAim(t: TopState): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null, bd = 16;
    for (const o of this.s.tops) if (o !== t && o.alive && (o.drone || o.team !== t.team)) { const d = Math.hypot(o.x - t.x, o.z - t.z); if (d < bd) { bd = d; best = o; } }
    for (const d of this.s.pin?.swarm ?? []) if (d.hp > 0) { const dd = Math.hypot(d.x - t.x, d.z - t.z); if (dd < bd) { bd = dd; best = d; } }
    if (best) return best;
    this.markers.forEach((m, mi) => {
      if (m.kind !== 'target' || this.s.pin?.lit[mi]) return;
      const d = Math.hypot(m.x - t.x, m.z - t.z);
      if (d < bd && m.z < t.z + 2) { bd = d; best = m; }
    });
    return best;
  }

  /** multiball: another ball, fired straight up the plunger lane */
  spawnExtraBall() {
    const p0 = this.s.tops.find((o) => !o.drone && !o.extra);
    if (!p0) return;
    const n = this.s.tops.filter((o) => o.extra).length + 2;
    const t = this.addTop(`Ball ${n}`, p0.team, this.cfg.players[0].blade, 0, 0);
    t.extra = true; t.spin = 1; t.lives = 0;
    t.color = p0.color;
    this.plunge(t, 0.85 + this.rnd() * 0.15);
  }

  pinballUpdate(dt: number) {
    const s = this.s, pin = s.pin!, ms = this.markers;
    const table = this.cfg.mode === 'pinball';
    const owner = s.tops.findIndex((o) => !o.drone && !o.extra);
    const c0 = this.controls[owner] ?? NO_CONTROL;
    // tilt meter: steering is a nudge — a little is fine, too much and the machine TILTs (flippers die until
    // the ball drains)
    if (table && s.phase === 'battle' && !pin.tilted) {
      const main = s.tops[owner];
      const steer = main && main.alive && !this.inPlunger(main) && main.held === undefined && !main.duel ? Math.min(1, Math.hypot(c0.mx, c0.mz)) : 0; // (pulling the plunger isn't a nudge)
      pin.tilt = Math.max(0, pin.tilt + (steer > 0.15 ? steer * 0.45 : -0.3) * dt);
      if (pin.tilt > 0.7 && !pin.warned) { pin.warned = true; this.ev({ k: 'announce', text: 'DANGER', sub: 'easy on the nudging — any more and it TILTs' }); this.ev({ k: 'pin', what: 'danger', x: 0, y: 0, z: 0 }); }
      if (pin.tilt < 0.45) pin.warned = false;
      if (pin.tilt >= 1) { pin.tilted = true; this.ev({ k: 'announce', text: 'TILT', sub: 'flippers are dead until this ball drains' }); this.ev({ k: 'pin', what: 'tilt', x: 0, y: 0, z: 0 }); }
    }
    // flippers
    ms.forEach((m, mi) => {
      if (m.kind !== 'flipper') return;
      let up: boolean;
      if (table) up = !pin.tilted && s.phase === 'battle' && (flipperSide(m) === 'L' ? !!c0.flipL : !!c0.flipR);
      else {
        // on a regular course a flipper is a trap: it fires by itself when a blade rolls onto it
        const P0 = flipperPose(m, m.rot ?? 0);
        up = s.tops.some((t) => t.alive && segDist(P0, t.x, t.z).d < 1.6);
      }
      const rest = m.rot ?? 0, target = up ? rest + (m.r ?? -1) : rest, cur = pin.flip[mi];
      const step = (up ? FLIP_UP_SPEED : FLIP_DOWN_SPEED) * dt;
      const nxt = cur + Math.max(-step, Math.min(step, target - cur));
      const w = (nxt - cur) / dt;
      if (up && Math.abs(cur - rest) < 0.02 && Math.abs(nxt - rest) >= 0.02) this.ev({ k: 'pin', what: 'flip', x: m.x, y: 0, z: m.z });
      pin.flip[mi] = nxt;
      const P = flipperPose(m, nxt), g = this.ground(m.x, m.z);
      for (const t of s.tops) {
        if (!t.alive || t.y > g + 1.6) continue;
        const dx = P.bx - P.ax, dz = P.bz - P.az, L2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((t.x - P.ax) * dx + (t.z - P.az) * dz) / L2));
        const cx = P.ax + dx * u, cz = P.az + dz * u;
        const ex = t.x - cx, ez = t.z - cz, d = Math.hypot(ex, ez), R = this.radius(t) + flipperHalf(u);
        if (d >= R || d < 1e-4) continue;
        const nx = ex / d, nz = ez / d;
        t.x = cx + nx * R; t.z = cz + nz * R;
        // the flipper's own speed where it touches you: a swing fires the ball
        const fvx = -w * (cz - P.az), fvz = w * (cx - P.ax);
        const rvn = (t.vx - fvx) * nx + (t.vz - fvz) * nz;
        if (rvn < 0) { t.vx -= 1.35 * rvn * nx; t.vz -= 1.35 * rvn * nz; }
        t.capN = 0;
      }
    });
    // plunger: hold down to pull it back, let go to fire (dash = a full shot)
    const pl = ms.find((m) => m.kind === 'plunger');
    if (pl) for (const t of s.tops) {
      if (!t.alive || !this.inPlunger(t)) continue;
      t.spin = Math.max(t.spin, 1); // waiting to launch: no spin lost
      if (t.extra) { this.plunge(t, 0.9); continue; }
      if (s.phase !== 'battle') continue;
      const c = this.controls[t.id] ?? NO_CONTROL;
      if (c.mz > 0.35) { pin.charge = Math.min(1, pin.charge + dt / 1.1); t.vx = 0; t.vz = Math.max(0, t.vz); t.x = pl.x; }
      else if (pin.charge > 0.05) this.plunge(t, pin.charge);
    }
    // targets: little posts that light up (light them all for MULTIBALL)
    if (pin.litT > 0) { pin.litT -= dt; if (pin.litT <= 0) pin.lit = pin.lit.map(() => false); }
    ms.forEach((m, mi) => {
      if (m.kind !== 'target') return;
      for (const t of s.tops) {
        if (!t.alive || !this.atLevel(t, m)) continue;
        const ex = t.x - m.x, ez = t.z - m.z, d = Math.hypot(ex, ez), R = (m.r ?? 0.8) * 0.7 + this.radius(t);
        if (d >= R || d < 1e-4) continue;
        const nx = ex / d, nz = ez / d;
        t.x = m.x + nx * R; t.z = m.z + nz * R;
        const vn = t.vx * nx + t.vz * nz;
        if (vn < 0) { t.vx -= 1.5 * vn * nx; t.vz -= 1.5 * vn * nz; }
        if (!pin.lit[mi] && pin.litT <= 0) {
          pin.lit[mi] = true;
          this.addScore(t, 500);
          t.spin = Math.min(1, t.spin + 0.08);
          this.ev({ k: 'pin', what: 'target', x: m.x, y: t.y, z: m.z, pts: 500 });
          const all = ms.every((q, qi) => q.kind !== 'target' || pin.lit[qi]);
          if (all && table) {
            pin.mult++; pin.litT = 4;
            this.addScore(t, 5000);
            this.ev({ k: 'announce', text: 'MULTIBALL!', sub: '+5000 · every target lit' });
            this.ev({ k: 'pin', what: 'multiball', x: m.x, y: t.y, z: m.z, pts: 5000 });
            this.spawnExtraBall();
          }
        }
      }
    });
    for (let i = 0; i < pin.tm.length; i++) if (pin.tm[i] > 0) pin.tm[i] = Math.max(0, pin.tm[i] - dt);
    if (pin.save > 0) pin.save = Math.max(0, pin.save - dt);
    // center post: up between the flippers while ball save runs (the first seconds after a launch)
    ms.forEach((m, mi) => {
      if (m.kind !== 'post' || pin.save <= 0) return;
      for (const t of s.tops) {
        if (!t.alive || !this.atLevel(t, m)) continue;
        const ex = t.x - m.x, ez = t.z - m.z, d = Math.hypot(ex, ez), R = (m.r ?? 0.45) + this.radius(t);
        if (d >= R || d < 1e-4) continue;
        const nx = ex / d, nz = ez / d;
        t.x = m.x + nx * R; t.z = m.z + nz * R;
        const vn = t.vx * nx + t.vz * nz;
        if (vn < 0) { t.vx -= 1.6 * vn * nx; t.vz -= 1.6 * vn * nz; this.ev({ k: 'pin', what: 'post', x: m.x, y: t.y, z: m.z }); }
      }
      void mi;
    });
    // kickback: an outlane saver — fires the ball straight back up, then needs ~25s to recharge
    ms.forEach((m, mi) => {
      if (m.kind !== 'kickback' || pin.tm[mi] > 0) return;
      for (const t of s.tops) {
        if (!t.alive || Math.hypot(t.x - m.x, t.z - m.z) > (m.r ?? 0.9) || !this.atLevel(t, m)) continue;
        const a = m.rot ?? -Math.PI / 2, v = m.len ?? 30;
        t.vx = Math.cos(a) * v; t.vz = Math.sin(a) * v;
        pin.tm[mi] = 25;
        this.addScore(t, 250);
        this.ev({ k: 'pin', what: 'kickback', x: m.x, y: t.y, z: m.z, pts: 250 });
        this.ev({ k: 'announce', text: 'KICKBACK!', sub: 'recharging…' });
        break;
      }
    });
    // drop targets: plates (width 2r, facing rot) that drop when hit; a whole bank (same team number) down scores a
    // bonus and refills spin, then the bank pops back up
    ms.forEach((m, mi) => {
      if (m.kind !== 'drop' || pin.lit[mi]) return;
      const fx = Math.cos(m.rot ?? 0), fz = Math.sin(m.rot ?? 0); // the face direction
      const half = m.r ?? 0.8, sg = { ax: m.x - fz * half, az: m.z + fx * half, bx: m.x + fz * half, bz: m.z - fx * half };
      for (const t of s.tops) {
        if (!t.alive || !this.atLevel(t, m)) continue;
        const { d, cx, cz } = segDist(sg, t.x, t.z), R = this.radius(t) + 0.2;
        if (d >= R || d < 1e-4) continue;
        const nx = (t.x - cx) / d, nz = (t.z - cz) / d;
        t.x = cx + nx * R; t.z = cz + nz * R;
        const vn = t.vx * nx + t.vz * nz;
        if (vn < 0) { t.vx -= 1.3 * vn * nx; t.vz -= 1.3 * vn * nz; }
        pin.lit[mi] = true; // down
        this.addScore(t, 300);
        this.ev({ k: 'pin', what: 'drop', x: m.x, y: t.y, z: m.z, pts: 300 });
        const bank = ms.map((q, qi) => ({ q, qi })).filter(({ q }) => q.kind === 'drop' && (q.team ?? 0) === (m.team ?? 0));
        if (bank.every(({ qi }) => pin.lit[qi])) {
          this.addScore(t, 3000);
          t.spin = Math.max(t.spin, 1);
          this.ev({ k: 'announce', text: 'BANK DOWN!', sub: '+3000 · full spin' });
          this.ev({ k: 'pin', what: 'bank', x: m.x, y: t.y, z: m.z, pts: 3000 });
          for (const { qi } of bank) pin.tm[qi] = 3; // pop back up in 3s
          ms.forEach((a, ai) => {
            if (a.kind !== 'arena' || (a.team ?? 0) !== (m.team ?? 0) || pin.lit[ai] || pin.duel?.mi === ai) return;
            pin.lit[ai] = true;
            this.ev({ k: 'announce', text: 'ARENA UNLOCKED', sub: 'roll into the bowl to battle the guardian', color: '#ff3b6b' });
            this.ev({ k: 'pin', what: 'unlock', x: a.x, y: t.y, z: a.z });
          });
        }
        break;
      }
    });
    // banks pop back up (unless a ball sits right where a plate would rise)
    ms.forEach((m, mi) => {
      if (m.kind === 'drop' && pin.lit[mi] && pin.tm[mi] > 0 && pin.tm[mi] <= dt * 1.5 && !s.tops.some((t) => t.alive && Math.hypot(t.x - m.x, t.z - m.z) < (m.r ?? 0.8) + 0.8)) pin.lit[mi] = false;
    });
    // rollover groups: rollovers sharing a team number light up; light the whole group for a bonus
    // capture saucers: catch the ball, spin it right back up while it sits there, then kick it out (rot = the
    // kick direction, len = kick speed). On a table you can't stop on a spin pad — this is where spin comes from.
    for (const t of s.tops) {
      if (!t.alive) continue;
      if (t.held !== undefined) {
        const m = ms[t.held];
        t.x = m.x; t.z = m.z; t.vx = t.vz = 0;
        t.spin = Math.min(1, t.spin + dt * 0.55);
        t.heldT = (t.heldT ?? 0) - dt;
        if (m.aim) {
          // an aim lock: swing the shot with the flippers (or steering), fire with DASH — or it fires by itself
          const c = this.controls[t.extra ? owner : t.id] ?? NO_CONTROL;
          const a = t.aimA ?? m.rot ?? 0;
          const left = (c.flipL ? 1 : 0) - (c.flipR ? 1 : 0) - Math.max(-1, Math.min(1, c.mx));
          const rot = m.rot ?? 0;
          t.aimA = Math.max(rot - m.aim, Math.min(rot + m.aim, a + left * (Math.sin(a) >= 0 ? 1 : -1) * 1.5 * dt));
          if (c.dash || t.heldT <= 0) {
            const v = m.len ?? 22;
            t.vx = Math.cos(t.aimA) * v; t.vz = Math.sin(t.aimA) * v;
            t.x += Math.cos(t.aimA) * ((m.r ?? 1) + 0.3); t.z += Math.sin(t.aimA) * ((m.r ?? 1) + 0.3);
            t.held = undefined; t.portalT = 1.6; t.capN = 0;
            this.ev({ k: 'pin', what: 'fire', x: m.x, y: t.y, z: m.z });
          }
          continue;
        }
        if (t.heldT <= 0) {
          // a wormhole: saucers sharing a team number are linked — you come out of the other one
          const partner = m.team !== undefined ? ms.find((q) => q !== m && q.kind === 'saucer' && q.team === m.team) : undefined;
          if (partner) { t.x = partner.x; t.z = partner.z; t.y = this.ground(partner.x, partner.z) + 0.2; this.addScore(t, 1500); this.ev({ k: 'pin', what: 'wormhole', x: partner.x, y: t.y, z: partner.z, pts: 1500 }); }
          const out = partner ?? m;
          // a little variety every time, and never straight into a wall or bumper (turn to the nearest clear way)
          const a = this.clearKick(out.x, out.z, (out.rot ?? -Math.PI / 2) + (this.rnd() - 0.5) * 0.5, (out.r ?? 1) + 0.3);
          const v = (out.len ?? 18) * (0.85 + this.rnd() * 0.3);
          t.vx = Math.cos(a) * v; t.vz = Math.sin(a) * v;
          t.x += Math.cos(a) * ((out.r ?? 1) + 0.3); t.z += Math.sin(a) * ((out.r ?? 1) + 0.3);
          t.held = undefined; t.portalT = 1.6; // (no saucer or portal can catch it straight back)
          // loop breaker: after two catches in a row without a flipper touching it, saucers let this ball go by
          t.capN = (t.capN ?? 0) + 1;
          if (t.capN >= 2) { t.noCapT = 6; t.capN = 0; }
          this.ev({ k: 'pin', what: 'kickout', x: out.x, y: t.y, z: out.z });
        }
        continue;
      }
      if (t.noCapT) t.noCapT = Math.max(0, t.noCapT - dt);
      if (t.portalT || t.noCapT) continue;
      const mi = ms.findIndex((m) => m.kind === 'saucer' && Math.hypot(t.x - m.x, t.z - m.z) < (m.r ?? 1) * 0.8 && this.atLevel(t, m));
      if (mi < 0) continue;
      t.held = mi; t.heldT = ms[mi].aim ? ms[mi].hold ?? 8 : 1.6;
      if (ms[mi].aim) { t.aimA = ms[mi].rot ?? 0; this.ev({ k: 'announce', text: 'TARGET LOCK', sub: 'aim: flippers or ← →  ·  fire: SPACE', color: '#39ff9c' }); this.ev({ k: 'pin', what: 'lock', x: ms[mi].x, y: t.y, z: ms[mi].z }); }
      this.addScore(t, 750);
      this.ev({ k: 'pin', what: 'capture', x: ms[mi].x, y: t.y, z: ms[mi].z, pts: 750 });
    }
    // spin rollovers: roll through a lane switch for a burst of spin (and points)
    for (const t of s.tops) {
      if (!t.alive) continue;
      if (t.rollT) { t.rollT = Math.max(0, t.rollT - dt); continue; }
      const m = ms.find((q) => q.kind === 'rollover' && Math.hypot(t.x - q.x, t.z - q.z) < (q.r ?? 0.9) && this.atLevel(t, q));
      if (!m) continue;
      t.spin = Math.min(1, t.spin + 0.12);
      t.rollT = 0.7;
      this.addScore(t, 100);
      this.ev({ k: 'pin', what: 'rollover', x: m.x, y: t.y, z: m.z, pts: 100 });
      if (m.team !== undefined) {
        const mi = ms.indexOf(m);
        pin.lit[mi] = true;
        const group = ms.map((q, qi) => ({ q, qi })).filter(({ q }) => q.kind === 'rollover' && q.team === m.team);
        if (group.every(({ qi }) => pin.lit[qi])) {
          for (const { qi } of group) pin.lit[qi] = false;
          this.addScore(t, 2500);
          t.spin = Math.max(t.spin, 1);
          this.ev({ k: 'announce', text: 'LANES COMPLETE', sub: '+2500 · full spin' });
          this.ev({ k: 'pin', what: 'group', x: m.x, y: t.y, z: m.z, pts: 2500 });
          const hive = ms.findIndex((q) => q.kind === 'hive' && q.team === m.team);
          if (hive >= 0 && table) this.launchSwarm(hive);
        }
      }
    }
    // portals: in one, out of its partner (same team number), keeping your speed
    for (const t of s.tops) {
      if (!t.alive) continue;
      if (t.portalT) { t.portalT = Math.max(0, t.portalT - dt); continue; }
      const a = ms.find((m) => m.kind === 'portal' && Math.hypot(t.x - m.x, t.z - m.z) < (m.r ?? 1) && this.atLevel(t, m));
      if (!a) continue;
      const b = ms.find((m) => m.kind === 'portal' && m !== a && (m.team ?? 0) === (a.team ?? 0));
      if (!b) continue;
      const sp = Math.max(8, Math.hypot(t.vx, t.vz));
      const dir = b.rot !== undefined ? { x: Math.cos(b.rot), z: Math.sin(b.rot) } : { x: t.vx / (sp || 1), z: t.vz / (sp || 1) };
      t.x = b.x + dir.x * ((b.r ?? 1) + 0.4); t.z = b.z + dir.z * ((b.r ?? 1) + 0.4); t.y = this.ground(t.x, t.z) + 0.3;
      t.vx = dir.x * sp; t.vz = dir.z * sp;
      t.portalT = 0.8;
      this.addScore(t, 250);
      this.ev({ k: 'pin', what: 'portal', x: b.x, y: t.y, z: b.z, pts: 250 });
    }
    // flyover exits: the last stretch of a flyover hands the ball off at its exit speed, along the ramp (a wire ramp's
    // exit curve) — so a hot ramp shot drops into the inlane instead of flying over it
    for (const rp of this.cfg.arena.ramps ?? []) {
      if (!rp.fly) continue;
      const E = flyEnd(rp), vx0 = rp.exit ?? 7;
      for (const t of s.tops) {
        if (!t.alive || Math.hypot(t.x - E.x, t.z - E.z) > (rp.w ?? 3) / 2 + 1.2) continue;
        if (t.y < this.ground(t.x, t.z) + (rp.end ?? 1.8) - 0.6) continue; // (passing underneath)
        const along = t.vx * E.dx + t.vz * E.dz;
        if (Math.hypot(t.vx, t.vz) <= vx0 + 0.5 && along > 0) continue;
        const v = Math.max(3, Math.min(vx0, Math.abs(along)));
        t.vx = E.dx * v; t.vz = E.dz * v;
      }
    }
    if (pin.swarmT > 0) this.swarmUpdate(dt);
    this.arenaUpdate(dt);
  }

  /** an arena gate is passable while the arena is unlocked, or for a moment while a ball is let out */
  gateOpen(mi: number) { const pin = this.s.pin; return !!pin && (pin.lit[mi] || pin.tm[mi] > 0); }

  /** a hive's drone swarm takes off: `len` drones (default 5) hunt balls round the hive for 40s */
  launchSwarm(hi: number) {
    const pin = this.s.pin!, hv = this.markers[hi];
    if (pin.swarmT > 0) return;
    const n = hv.len ?? 5;
    pin.swarm = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      pin.swarm.push({ x: hv.x + Math.cos(a) * 1.2, z: hv.z + Math.sin(a) * 1.2, vx: Math.cos(a) * 4, vz: Math.sin(a) * 4, hp: 1, zap: 1.2, ph: a });
    }
    pin.swarmT = 40; pin.swarmHive = hi;
    this.ev({ k: 'announce', text: 'SWARM INCOMING', sub: 'smash the drones — hit them fast (slow balls get zapped)', color: '#ff2a6d' });
    this.ev({ k: 'pin', what: 'swarm', x: hv.x, y: 0, z: hv.z });
  }

  swarmUpdate(dt: number) {
    const s = this.s, pin = s.pin!, hv = this.markers[pin.swarmHive];
    if (!hv) { pin.swarmT = 0; return; }
    pin.swarmT -= dt;
    const R = hv.r ?? 8;
    const balls = s.tops.filter((t) => t.alive && !t.drone && t.held === undefined && !t.duel && this.atLevel(t, hv));
    for (const d of pin.swarm) {
      if (d.hp <= 0) continue;
      d.zap = Math.max(0, d.zap - dt);
      d.ph += dt * 0.9;
      // hunt the nearest ball in the swarm's airspace (leading it a little); after a zap, peel off and patrol
      let tgt: TopState | null = null, bd = Infinity;
      for (const b of balls) {
        if (Math.hypot(b.x - hv.x, b.z - hv.z) > R + 1.5) continue;
        const dd = Math.hypot(b.x - d.x, b.z - d.z);
        if (dd < bd) { bd = dd; tgt = b; }
      }
      let gx: number, gz: number, acc: number, vmax: number;
      if (tgt && d.zap <= 0) { gx = tgt.x + tgt.vx * 0.25; gz = tgt.z + tgt.vz * 0.25; acc = 16; vmax = 7.5; }
      else { gx = hv.x + Math.cos(d.ph) * R * 0.55; gz = hv.z + Math.sin(d.ph * 1.3) * R * 0.4; acc = 10; vmax = 5; }
      const ex = gx - d.x, ez = gz - d.z, el = Math.hypot(ex, ez) || 1;
      d.vx += (ex / el) * acc * dt; d.vz += (ez / el) * acc * dt;
      for (const o of pin.swarm) {
        if (o === d || o.hp <= 0) continue;
        const sx = d.x - o.x, sz = d.z - o.z, sl = Math.hypot(sx, sz);
        if (sl < 1.6 && sl > 1e-3) { d.vx += (sx / sl) * 12 * dt; d.vz += (sz / sl) * 12 * dt; }
      }
      const hd = Math.hypot(d.x - hv.x, d.z - hv.z);
      if (hd > R) { d.vx += ((hv.x - d.x) / hd) * 20 * dt; d.vz += ((hv.z - d.z) / hd) * 20 * dt; }
      const sp = Math.hypot(d.vx, d.vz);
      if (sp > vmax) { d.vx *= vmax / sp; d.vz *= vmax / sp; }
      d.x += d.vx * dt; d.z += d.vz * dt;
      // contact with a ball: a fast ball smashes the drone; a slow one gets zapped (loses spin) and the drone peels off
      for (const b of balls) {
        const nx0 = b.x - d.x, nz0 = b.z - d.z, dd = Math.hypot(nx0, nz0), Rr = this.radius(b) + 0.55;
        if (dd >= Rr || dd < 1e-4) continue;
        const nx = nx0 / dd, nz = nz0 / dd;
        const bs = Math.hypot(b.vx, b.vz);
        const vn = b.vx * nx + b.vz * nz;
        if (vn < 0) { b.vx -= 1.5 * vn * nx; b.vz -= 1.5 * vn * nz; }
        b.x = d.x + nx * Rr; b.z = d.z + nz * Rr;
        if (bs > 7 || b.fx.dash > 0) {
          d.hp = 0;
          this.addScore(b, 2500);
          b.spin = Math.min(1, b.spin + 0.1);
          this.ev({ k: 'pin', what: 'drone', x: d.x, y: b.y + 0.9, z: d.z, pts: 2500 });
          break;
        } else if (d.zap <= 0) {
          b.spin = Math.max(0.05, b.spin - 0.06);
          d.zap = 1.6; d.vx = -nx * 6; d.vz = -nz * 6;
          this.ev({ k: 'pin', what: 'zap', x: d.x, y: b.y + 0.6, z: d.z });
        }
      }
    }
    const left = pin.swarm.filter((d) => d.hp > 0).length;
    const main = s.tops.find((t) => !t.drone && !t.extra) ?? s.tops[0];
    if (!left) {
      pin.swarmT = 0;
      this.addScore(main, 25000);
      for (const t of s.tops) if (t.alive && !t.drone) t.spin = Math.max(t.spin, 1);
      this.ev({ k: 'announce', text: 'SWARM DOWN!', sub: '+25000 · full spin', color: '#ff2a6d' });
      this.ev({ k: 'pin', what: 'bank', x: hv.x, y: 0, z: hv.z, pts: 25000 });
    } else if (pin.swarmT <= 0) {
      pin.swarm = [];
      this.ev({ k: 'announce', text: 'SWARM RETREATS', sub: `${left} drone${left === 1 ? '' : 's'} got away` });
    }
  }

  /**
   * Arena bowls: once unlocked, the first ball to roll into the dish shuts the gate behind it and a guardian blade
   * drops in — a real 1v1 battle (normal grip and steering inside). Spin it out (or out-spin it when the 25s run
   * out) for the jackpot; either way the gate opens and the ball is fired back out onto the table.
   */
  arenaUpdate(dt: number) {
    const s = this.s, pin = s.pin!, ms = this.markers;
    if (!pin.duel) {
      ms.forEach((m, mi) => {
        if (m.kind !== 'arena' || !pin.lit[mi] || pin.duel) return;
        const R = m.r ?? 2.6;
        const t = s.tops.find((b) => b.alive && !b.drone && b.held === undefined && Math.hypot(b.x - m.x, b.z - m.z) < R * 0.7);
        if (!t) return;
        pin.lit[mi] = false;
        pin.duel = { mi, ball: t.id, t: 25 };
        t.duel = true; t.spin = Math.max(t.spin, 1); // (a fresh, full-spin battle)
        let f = s.tops[pin.foe];
        if (!f) {
          const blade = { ...this.cfg.players[0].blade, id: 'guardian', name: 'Guardian', primary: '#2a0a14', secondary: '#120408', glow: '#ff2a6d', spinDir: (-this.cfg.players[0].blade.spinDir || -1) as 1 | -1 };
          f = this.addTop('Guardian', 9, blade, 2, 0, true);
          pin.foe = f.id;
        }
        const ax = t.x - m.x, az = t.z - m.z, al = Math.hypot(ax, az) || 1;
        f.alive = true; f.out = ''; f.spin = 1; f.duel = true; f.burst = 0; f.fx.frozen = 0;
        this.placeTop(f, m.x - (ax / al) * R * 0.55, m.z - (az / al) * R * 0.55, 1.2);
        t.vx *= 0.3; t.vz *= 0.3;
        this.ev({ k: 'announce', text: 'ARENA DUEL!', sub: 'steer freely in here — spin the guardian out', color: '#ff2a6d' });
        this.ev({ k: 'pin', what: 'duel', x: m.x, y: t.y, z: m.z });
      });
      return;
    }
    const d = pin.duel, m = ms[d.mi], b = s.tops[d.ball], f = s.tops[pin.foe];
    d.t -= dt;
    let res = 0;
    if (!b?.alive) res = -1;
    else if (!f?.alive || f.spin < 0.1) res = 1;
    else if (b.spin < 0.12) res = -1;
    else if (d.t <= 0) res = b.spin >= f.spin ? 1 : -1;
    if (!res) return;
    if (f) { f.alive = false; f.out = 'spin'; f.duel = false; f.x = m.x; f.z = m.z; f.y = -60; f.vx = f.vy = f.vz = 0; }
    pin.duel = null;
    pin.tm[d.mi] = 1.5; // the gate lets the ball out, then locks again (light the bank to reopen it)
    if (!b) return;
    b.duel = false;
    const g = m.rot ?? Math.PI / 2, R = m.r ?? 2.6;
    if (b.alive) {
      b.x = m.x + Math.cos(g) * R * 0.5; b.z = m.z + Math.sin(g) * R * 0.5;
      b.vx = Math.cos(g) * 15; b.vz = Math.sin(g) * 15;
    }
    if (res > 0) {
      b.spin = Math.max(b.spin, 1);
      this.addScore(b, 30000);
      this.ev({ k: 'announce', text: 'GUARDIAN DOWN!', sub: '+30000 · full spin', color: '#ffd23a' });
      this.ev({ k: 'pin', what: 'duelwin', x: m.x, y: b.y, z: m.z, pts: 30000 });
    } else {
      b.spin = Math.max(b.spin, 0.5);
      this.addScore(b, 2500);
      this.ev({ k: 'announce', text: 'GUARDIAN WINS', sub: 'reopen the arena for a rematch' });
      this.ev({ k: 'pin', what: 'duellose', x: m.x, y: b.y, z: m.z, pts: 2500 });
    }
  }

  // ---------------- items & specials ----------------
  rollItem(t: TopState) {
    // rubber-banding: weaker tops get stronger items
    const weak = t.spin < 0.45 || this.isLosing(t);
    let pool: ItemKind[] = weak ? ['surge', 'surge', 'comet', 'vortex', 'turbo', 'titan', 'shock'] : ITEM_POOL;
    if (this.cfg.mode === 'race') {
      // race items by position: the back of the pack gets speed and comets, the leader gets defence
      const racers = this.s.tops.filter((x) => !x.drone).length || 1;
      const pos = (t.place || racers) / racers;
      pool = pos <= 0.2 ? ['mine', 'shield', 'shock', 'mine'] : pos < 0.6 ? ['turbo', 'shield', 'mine', 'comet', 'shock', 'surge'] : ['turbo', 'turbo', 'comet', 'comet', 'surge', 'titan', 'vortex'];
    }
    // smart surge odds: the lower your spin, the likelier a Spin Surge; near full spin you won't get one
    const pSurge = Math.max(0, Math.min(0.55, (0.72 - t.spin) * 1.5));
    if (t.spin > 0.85) pool = pool.filter((k) => k !== 'surge');
    t.item = this.rnd() < pSurge ? 'surge' : pool[Math.floor(this.rnd() * pool.length)];
    t.roll = 1.2;
  }

  isLosing(t: TopState) {
    const my = this.s.teamScores[t.team] ?? 0;
    return this.s.teamScores.some((v) => v > my);
  }

  useItem(t: TopState) {
    const it = t.item!;
    t.item = null;
    t.itemCd = 0.3;
    this.ev({ k: 'use', id: t.id, item: it });
    switch (it) {
      case 'turbo': t.fx.turbo = 3.5; break;
      case 'shield': t.fx.shield = 5; break;
      case 'shock': this.shockwave(t, 5, 13, 0.05); break;
      // Spin Surge: rip back up to at least full spin, overcharged up to 135%, and 6s of slow decay + halved clash damage
      case 'surge': t.spin = Math.min(1.35, Math.max(1, t.spin + 0.55)); t.fx.surge = 6; break;
      case 'vortex': t.fx.vortex = 4; break;
      case 'titan': t.fx.titan = 6; break;
      case 'comet': {
        const e = this.nearestEnemy(t);
        let dx = t.vx, dz = t.vz;
        if (e) { dx = e.x - t.x; dz = e.z - t.z; }
        const d = Math.hypot(dx, dz) || 1;
        this.s.projs.push({ id: this.s.nextId++, kind: 'comet', x: t.x, y: t.y + 0.8, z: t.z, vx: (dx / d) * 12, vy: 3, vz: (dz / d) * 12, owner: t.id, t: 0 });
        break;
      }
      case 'mine':
        this.s.mines.push({ id: this.s.nextId++, x: t.x - t.vx * 0.15, y: t.y, z: t.z - t.vz * 0.15, owner: t.id, t: 0 });
        break;
    }
  }

  useSpecial(t: TopState) {
    t.special = 0;
    this.ev({ k: 'special', id: t.id });
    const names = { rush: 'METEOR RUSH', fortress: 'IRON FORTRESS', vortex: 'ETERNAL VORTEX', skydive: 'SKY DIVE' };
    this.ev({ k: 'announce', text: names[t.specialKind], sub: t.name, color: t.color });
    switch (t.specialKind) {
      case 'rush': t.fx.special = 1.2; break;
      case 'fortress': t.fx.special = 3.5; t.fx.shield = Math.max(t.fx.shield, 3.5); break;
      case 'vortex': t.fx.special = 3; t.spin = Math.max(t.spin, Math.min(1.1, t.spin + 0.2)); break;
      case 'skydive': t.fx.special = 3; t.vy = 13; t.grounded = false; break;
    }
  }

  shockwave(src: TopState, R: number, power: number, dmg: number) {
    this.ev({ k: 'shock', x: src.x, y: src.y + 0.2, z: src.z, r: R, c: src.color });
    for (const o of this.s.tops) {
      if (o === src || !o.alive) continue;
      const dx = o.x - src.x, dz = o.z - src.z, d = Math.hypot(dx, dz);
      if (d > R || d < 0.01) continue;
      const f = 1 - d / R;
      const k = o.fx.shield > 0 ? 0.3 : 1;
      o.vx += (dx / d) * power * f * k; o.vz += (dz / d) * power * f * k; o.vy += 5 * f * k;
      o.spin -= dmg * f * k;
      o.lastHit = src.id; o.lastHitT = this.s.t;
      if (o.flag >= 0) this.dropFlag(o);
      if (this.cfg.mode === 'rush') this.spillCrystals(o, Math.min(o.crystals, 2));
    }
  }

  nearestEnemy(t: TopState) {
    let best: TopState | null = null, bd = 1e9;
    for (const o of this.s.tops) {
      if (!o.alive || o.team === t.team) continue;
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  // ---------------- world objects ----------------
  updateObjects(dt: number) {
    const s = this.s;
    // item boxes
    for (const b of s.boxes) {
      if (b.t > 0) { b.t -= dt; continue; }
      for (const t of s.tops) {
        if (!t.alive || t.item || t.roll > 0 || t.drone) continue;
        if (Math.hypot(t.x - b.x, t.z - b.z) < this.radius(t) + 0.6 && Math.abs(t.y - b.y - 0.6) < 1.5) {
          b.t = 6;
          this.rollItem(t);
          this.ev({ k: 'pickup', id: t.id, what: 'box', x: b.x, y: b.y + 0.6, z: b.z });
          break;
        }
      }
    }
    // projectiles
    for (const p of s.projs) {
      p.t += dt;
      const owner = s.tops[p.owner];
      const e = owner ? this.nearestEnemy(owner) : null;
      if (e) {
        const dx = e.x - p.x, dy = e.y + 0.4 - p.y, dz = e.z - p.z, d = Math.hypot(dx, dy, dz) || 1;
        p.vx += (dx / d) * 30 * dt; p.vy += (dy / d) * 30 * dt; p.vz += (dz / d) * 30 * dt;
        const sp = Math.hypot(p.vx, p.vy, p.vz);
        if (sp > 15) { p.vx *= 15 / sp; p.vy *= 15 / sp; p.vz *= 15 / sp; }
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const g = this.terrain.height(p.x, p.z);
      if (g > VOID && p.y < g + 0.3) { p.y = g + 0.3; p.vy = Math.abs(p.vy) * 0.5; }
      for (const t of s.tops) {
        if (!t.alive || t.team === owner?.team) continue;
        if (Math.hypot(t.x - p.x, t.y + 0.4 - p.y, t.z - p.z) < this.radius(t) + 0.4) {
          const d = Math.hypot(p.vx, p.vz) || 1;
          const k = t.fx.shield > 0 ? 0.2 : 1;
          t.vx += (p.vx / d) * 11 * k; t.vz += (p.vz / d) * 11 * k; t.vy += 6 * k;
          t.spin -= 0.12 * k;
          t.lastHit = p.owner; t.lastHitT = s.t;
          if (t.flag >= 0) this.dropFlag(t);
          this.ev({ k: 'shock', x: p.x, y: p.y, z: p.z, r: 2.5, c: '#ff9e3d' });
          p.t = 99;
        }
      }
    }
    s.projs = s.projs.filter((p) => p.t < 4.5);
    // mines
    for (const m of s.mines) {
      m.t += dt;
      if (m.t < 0.6) continue;
      for (const t of s.tops) {
        if (!t.alive || (t.id === m.owner && m.t < 3)) continue;
        if (Math.hypot(t.x - m.x, t.z - m.z) < this.radius(t) + 0.5 && Math.abs(t.y - m.y) < 1) {
          t.fx.frozen = t.fx.shield > 0 ? 0.3 : 1.6;
          t.vy += 6; t.spin -= 0.04;
          t.lastHit = m.owner; t.lastHitT = s.t;
          this.ev({ k: 'shock', x: m.x, y: m.y + 0.3, z: m.z, r: 2, c: '#9fe8ff' });
          m.t = 99;
          break;
        }
      }
    }
    s.mines = s.mines.filter((m) => m.t < 30);
    // crystals: ballistic arcs and bounce
    for (const c of s.crystals) {
      c.t += dt;
      c.vy -= G * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      const g = this.terrain.height(c.x, c.z);
      if (g > VOID && c.y < g + 0.35) { c.y = g + 0.35; c.vy = Math.abs(c.vy) * 0.35; c.vx *= 0.7; c.vz *= 0.7; }
      if (c.t < 0.5) continue;
      for (const t of s.tops) {
        if (!t.alive || t.drone) continue;
        if (Math.hypot(t.x - c.x, t.z - c.z) < this.radius(t) + 0.45 && Math.abs(t.y - c.y) < 1.3) {
          t.crystals++;
          if (this.cfg.mode === 'rush') s.teamScores[t.team] = this.teamCrystals(t.team);
          this.ev({ k: 'pickup', id: t.id, what: 'crystal', x: c.x, y: c.y, z: c.z });
          c.t = -99;
          break;
        }
      }
    }
    s.crystals = s.crystals.filter((c) => c.t >= 0 && c.y > -6);
  }

  teamCrystals(team: number) {
    return this.s.tops.filter((t) => t.team === team).reduce((a, t) => a + t.crystals, 0);
  }

  spillCrystals(t: TopState, n: number) {
    n = Math.min(n, t.crystals);
    if (n <= 0) return;
    t.crystals -= n;
    this.s.teamScores[t.team] = this.teamCrystals(t.team);
    for (let k = 0; k < n; k++) {
      const a = this.rnd() * Math.PI * 2, sp = 3 + this.rnd() * 4;
      this.s.crystals.push({ id: this.s.nextId++, x: t.x, y: t.y + 0.6, z: t.z, vx: Math.cos(a) * sp, vy: 6 + this.rnd() * 4, vz: Math.sin(a) * sp, t: 0 });
    }
  }

  spawnCrystal() {
    const p = this.terrain.randomSafePoint(this.rnd);
    this.s.crystals.push({ id: this.s.nextId++, x: p.x, y: this.ground(p.x, p.z) + 6, z: p.z, vx: 0, vy: 0, vz: 0, t: 0.5 });
  }

  spawnGem() {
    const p = this.terrain.randomSafePoint(this.rnd);
    this.s.gems.push({ id: this.s.nextId++, x: p.x, y: this.ground(p.x, p.z) + 0.6, z: p.z });
  }

  dropFlag(t: TopState) {
    const f = this.s.flags.find((f) => f.carrier === t.id);
    t.flag = -1;
    if (!f) return;
    f.carrier = -1;
    f.home = false;
    f.t = 0;
    f.x = t.x; f.y = this.ground(t.x, t.z); f.z = t.z;
    this.ev({ k: 'announce', text: 'CORE DROPPED', sub: t.name, color: '#fff' });
  }

  moveZone(first = false) {
    const zm = this.markers.filter((m) => m.kind === 'zone');
    let p: { x: number; z: number };
    if (first && zm.length) p = zm[0];
    else p = this.terrain.randomSafePoint(this.rnd, { x: 0, z: 0, r: this.terrain.size * 0.6 });
    const r = zm[0]?.r ?? 2.6;
    this.s.zone = { x: p.x, y: this.ground(p.x, p.z), z: p.z, r, owner: -1, t: 0 };
    if (!first) this.ev({ k: 'announce', text: 'ZONE MOVED', color: '#ffd23a' });
  }

  // ---------------- mode rules ----------------
  modeUpdate(dt: number) {
    const s = this.s;
    const mode = this.cfg.mode;
    if (this.rounds) {
      const alive = new Set(s.tops.filter((t) => t.alive).map((t) => t.team));
      const timeUp = s.timeLeft <= 0;
      if (alive.size <= 1 || timeUp) {
        let roundWinner = alive.size === 1 ? [...alive][0] : -1;
        if (timeUp && alive.size > 1) {
          // highest total spin wins the round
          let best = -1, bv = -1;
          for (const team of alive) {
            const v = s.tops.filter((t) => t.team === team && t.alive).reduce((a, t) => a + t.spin, 0);
            if (v > bv) { bv = v; best = team; }
          }
          roundWinner = best;
          s.teamScores[best] += 1;
          this.ev({ k: 'announce', text: 'TIME UP', sub: `${this.teamLabel(best)} wins on spin! +1` });
        }
        if (mode === 'ffa' && alive.size === 1 && roundWinner >= 0) s.teamScores[roundWinner] += 1;
        s.phase = 'roundEnd';
        s.phaseT = 0;
        const max = Math.max(...s.teamScores);
        if (max >= this.cfg.target) {
          const leaders = s.teamScores.map((v, i) => [v, i]).filter(([v]) => v === max);
          s.winner = leaders.length === 1 ? leaders[0][1] : -2;
        }
        if (roundWinner >= 0 && s.winner === -1) this.ev({ k: 'announce', text: `${this.teamLabel(roundWinner)} TAKES THE ROUND`, sub: s.lastFinish });
      }
      return;
    }

    // continuous modes
    if (mode === 'ctf') {
      for (const f of s.flags) {
        if (f.carrier >= 0) {
          const c = s.tops[f.carrier];
          f.x = c.x; f.y = c.y + 1.2; f.z = c.z;
          // capture: carrier reaches own home flag while it's home
          const own = s.flags.find((o) => o.team === c.team);
          if (own && own.home && Math.hypot(c.x - own.hx, c.z - own.hz) < 2.0) {
            s.teamScores[c.team]++;
            c.score++;
            c.flag = -1;
            f.carrier = -1; f.home = true; f.x = f.hx; f.y = f.hy; f.z = f.hz;
            this.ev({ k: 'announce', text: 'CAPTURE!', sub: `${c.name} scores for ${this.teamLabel(c.team)}`, color: c.color });
            this.ev({ k: 'shock', x: c.x, y: c.y, z: c.z, r: 4, c: c.color });
          }
          continue;
        }
        if (!f.home) { f.t += dt; if (f.t > 15) { f.home = true; f.x = f.hx; f.y = f.hy; f.z = f.hz; } }
        for (const t of s.tops) {
          if (!t.alive || t.flag >= 0) continue;
          if (Math.hypot(t.x - f.x, t.z - f.z) > this.radius(t) + 0.9 || Math.abs(t.y - f.y) > 2) continue;
          if (t.team === f.team) {
            if (!f.home) { f.home = true; f.x = f.hx; f.y = f.hy; f.z = f.hz; this.ev({ k: 'announce', text: 'CORE RETURNED', sub: t.name }); }
          } else {
            f.carrier = t.id; f.home = false; t.flag = f.team;
            this.ev({ k: 'announce', text: 'CORE TAKEN!', sub: t.name, color: t.color });
            this.ev({ k: 'pickup', id: t.id, what: 'flag', x: f.x, y: f.y, z: f.z });
            break;
          }
        }
      }
    } else if (mode === 'rush') {
      if (s.crystals.length < 14 && this.rnd() < dt * 2.2) this.spawnCrystal();
    } else if (mode === 'koth' && s.zone) {
      const z = s.zone;
      z.t += dt;
      const inside = new Set(s.tops.filter((t) => t.alive && Math.hypot(t.x - z.x, t.z - z.z) < z.r).map((t) => t.team));
      z.owner = inside.size === 1 ? [...inside][0] : inside.size > 1 ? -2 : -1;
      if (z.owner >= 0) {
        s.teamScores[z.owner] += dt;
        for (const t of s.tops) if (t.team === z.owner && t.alive) t.special = Math.min(1, t.special + dt * 0.05);
      }
      if (z.t > 25) this.moveZone();
    } else if (mode === 'pinball') {
      if (!s.tops.some((t) => !t.drone && (t.alive || t.respawnT > 0))) return this.endMatch(0, `FINAL SCORE ${s.teamScores[0] | 0}`);
    } else if (mode === 'race') {
      return this.raceUpdate();
    } else if (mode === 'quest') {
      return this.questUpdate(dt);
    } else if (mode === 'gauntlet') {
      for (const g of s.gems) {
        for (const t of s.tops) {
          if (!t.alive || t.drone) continue;
          if (Math.hypot(t.x - g.x, t.z - g.z) < this.radius(t) + 0.6 && Math.abs(t.y - g.y) < 1.5) {
            g.id = -1;
            t.score++;
            s.teamScores[0]++;
            s.gemsLeft--;
            t.spin = Math.max(t.spin, Math.min(1.05, t.spin + 0.06));
            this.ev({ k: 'pickup', id: t.id, what: 'gem', x: g.x, y: g.y, z: g.z });
            if (s.teamScores[0] % 4 === 0) this.spawnDrone();
            break;
          }
        }
      }
      s.gems = s.gems.filter((g) => g.id >= 0);
      const active = s.gems.length;
      if (active < 3 && s.gemsLeft - active > 0) this.spawnGem();
      if (s.gemsLeft <= 0) return this.endMatch(0, `CLEARED IN ${(this.cfg.timeLimit - s.timeLeft).toFixed(1)}s`);
      const humansAlive = s.tops.some((t) => !t.drone && (t.alive || t.respawnT > 0));
      if (!humansAlive) return this.endMatch(-2, 'OUT OF SPIN');
      if (s.timeLeft <= 0) return this.endMatch(-2, 'TIME UP');
      return;
    }
    const target = this.cfg.target;
    const max = Math.max(...s.teamScores);
    if ((target > 0 && max >= target) || s.timeLeft <= 0) {
      const leaders = s.teamScores.map((v, i) => [v, i]).filter(([v]) => v === max);
      this.endMatch(leaders.length === 1 ? leaders[0][1] : -2, s.timeLeft <= 0 ? 'TIME UP' : 'TARGET REACHED');
    }
  }

  raceUpdate() {
    const s = this.s;
    const S = this.terrain.track;
    if (!S) return;
    const laps = this.cfg.target || 3;
    for (const t of s.tops) {
      if (t.finishT >= 0 || !t.alive) continue;
      const prev = t.prog;
      const ns = nearestSample(S, t.x, t.z, t.prog);
      const halfW = S.width / 2 + 1;
      let idx = ns.i;
      if (ns.d > halfW) {
        // left our own stretch of road: are we on a DIFFERENT segment (took a crossing / cut across)?
        const g = globalNearest(S, t.x, t.z);
        const gd = Math.hypot(S.x[g] - t.x, S.z[g] - t.z);
        const sep = Math.min(Math.abs(g - t.prog), S.n - Math.abs(g - t.prog));
        // a jumped corner / cut-across that lands a little further along, heading the right way, is a shortcut —
        // that's progress, not off course (crossings land far away on the lap, so they still count as wrong turns)
        const fwd = (g - t.prog + S.n) % S.n;
        const along = t.vx * S.tx[g] + t.vz * S.tz[g];
        if (gd <= halfW && fwd > 0 && fwd <= S.n * 0.2 && along > 1) idx = g;
        else if (gd <= halfW && sep > 40 && t.grounded) {
          if (t.off === 0) this.ev({ k: 'announce', text: 'OFF COURSE', sub: `${t.name} — turn back!`, color: '#ff2244' });
          t.off += 1 / 120;
          if (t.off > 5) {
            // gave up finding the way back: reset onto our own line (time penalty is the respawn)
            t.off = 0;
            this.respawn(t, t.id);
            this.ev({ k: 'announce', text: 'BACK ON TRACK', sub: t.name });
          }
          continue;
        } else continue;
      }
      if (t.off > 0) t.off = 0;
      t.prog = idx;
      // edge riding: carving the outer lane / rail line at speed rips spin back up (sparks fly)
      {
        const sp = Math.hypot(t.vx, t.vz), edge = ns.d / (S.width / 2);
        if (t.grounded && edge > 0.62 && edge < 1.15 && sp > 7 && t.spin < 1) {
          t.spin = Math.min(1, t.spin + (0.06 + Math.min(0.05, (sp - 7) * 0.004)) / 120);
          if (Math.random() < 0.15) this.ev({ k: 'grind', x: t.x, y: t.y, z: t.z, id: t.id });
        }
      }
      const q = Math.floor((t.prog / S.n) * 4);
      if (q === t.cp + 1) t.cp = q;
      if (prev > S.n * 0.85 && t.prog < S.n * 0.15) {
        if (t.cp >= 3) {
          t.lap++;
          t.cp = 0;
          if (t.lap >= laps) {
            t.finishT = s.t;
            this.finishers++;
            t.score = this.finishers;
            this.ev({ k: 'announce', text: this.finishers === 1 ? `${t.name} WINS!` : `${t.name} FINISHED`, sub: `P${this.finishers}`, color: t.color });
            if (this.finishers === 1) this.endT = s.t + 20;
          } else if (!t.cpu) this.ev({ k: 'announce', text: t.lap === laps - 1 ? 'FINAL LAP' : `LAP ${t.lap + 1}`, sub: t.name, color: t.color });
        }
      } else if (prev < S.n * 0.15 && t.prog > S.n * 0.85) {
        // crossed the line backwards
        t.cp = -1;
      }
    }
    // slipstream: within 8m directly behind another racer at speed
    for (const t of s.tops) {
      this.draft[t.id] = false;
      const sp = Math.hypot(t.vx, t.vz);
      if (!t.alive || !t.grounded || sp < 7) continue;
      const fx = t.vx / sp, fz = t.vz / sp;
      for (const o of s.tops) {
        if (o === t || !o.alive) continue;
        const rx = o.x - t.x, rz = o.z - t.z;
        const ahead = rx * fx + rz * fz, side = Math.abs(rx * fz - rz * fx);
        if (ahead > 1 && ahead < 8 && side < 1.4) { this.draft[t.id] = true; break; }
      }
    }
    // catch-up: CPUs behind the best human speed up, CPUs far ahead ease off (Mario Kart style)
    const strength = [0, 1, 1.7][this.cfg.rubber ?? 0] ?? 0;
    const humans = s.tops.filter((t) => !t.cpu && !t.drone);
    if (strength > 0 && humans.length) {
      const best = Math.max(...humans.map((t) => (t.finishT >= 0 ? 1e9 : t.lap * S.n + t.prog)));
      for (const t of s.tops) {
        if (!t.cpu) { this.rubber[t.id] = 1; continue; }
        const gap = ((best - (t.lap * S.n + t.prog)) * 0.5); // metres the CPU is behind (+) or ahead (-)
        const g = Math.max(-1, Math.min(1, gap / 45));
        this.rubber[t.id] = 1 + g * (g > 0 ? 0.28 : 0.22) * strength;
      }
    } else this.rubber.length = 0;
    const order = s.tops.filter((t) => !t.drone).sort((a, b) => {
      if (a.finishT >= 0 || b.finishT >= 0) return (a.finishT < 0 ? 1e9 : a.finishT) - (b.finishT < 0 ? 1e9 : b.finishT);
      return b.lap * S.n + b.prog - (a.lap * S.n + a.prog);
    });
    order.forEach((t, i) => (t.place = i + 1));
    for (let k = 0; k < s.teamScores.length; k++) s.teamScores[k] = Math.max(0, ...s.tops.filter((t) => t.team === k).map((t) => t.lap));
    const humansDone = s.tops.filter((t) => !t.cpu).every((t) => t.finishT >= 0);
    if ((this.finishers > 0 && (humansDone || s.t > this.endT)) || s.timeLeft <= 0) {
      const first = order[0];
      this.endMatch(first ? first.team : -2, first ? `${first.name} takes the Grand Prix` : 'TIME UP');
    }
  }

  hiveCool: number[] = [];

  /** Blade Quest: gems, checkpoints, the goal, and drone hives that guard their zone */
  questUpdate(dt: number) {
    const s = this.s;
    const players = s.tops.filter((t) => !t.drone);
    // track adventures: keep each blade's position along the path (chase camera, wrong-way, CPU driving)
    const TS = this.terrain.track;
    if (TS) for (const t of s.tops) if (t.alive) { const ns = nearestSample(TS, t.x, t.z, t.prog); if (ns.d < TS.width) t.prog = ns.i; }
    // gems
    for (const g of s.gems) {
      for (const t of players) {
        if (!t.alive) continue;
        if (Math.hypot(t.x - g.x, t.z - g.z) < this.radius(t) + 0.7 && Math.abs(t.y - g.y) < 1.8) {
          g.id = -1; t.score++; s.teamScores[0]++;
          t.spin = Math.max(t.spin, Math.min(1.05, t.spin + 0.05));
          this.ev({ k: 'pickup', id: t.id, what: 'gem', x: g.x, y: g.y, z: g.z });
          break;
        }
      }
    }
    s.gems = s.gems.filter((g) => g.id >= 0);
    this.markers.forEach((m, mi) => {
      if (m.kind === 'checkpoint') {
        for (const t of players) {
          if (!t.alive || (t.qcp ?? -1) === mi) continue;
          if (Math.hypot(t.x - m.x, t.z - m.z) < (m.r ?? 2.2) + this.radius(t) && Math.abs(t.y - this.ground(m.x, m.z)) < 2.5) {
            // only move forward through the level (array order = level order)
            if ((t.qcp ?? -1) > mi) continue;
            t.qcp = mi;
            t.spin = Math.max(t.spin, 1);
            const n = this.markers.slice(0, mi + 1).filter((x) => x.kind === 'checkpoint').length;
            this.ev({ k: 'announce', text: 'CHECKPOINT', sub: `${t.name} · ${n}/${this.markers.filter((x) => x.kind === 'checkpoint').length} · spin refilled`, color: '#38ffb0' });
            this.ev({ k: 'pickup', id: t.id, what: 'flag', x: m.x, y: t.y, z: m.z });
          }
        }
      } else if (m.kind === 'goal') {
        for (const t of players) {
          if (t.alive && Math.hypot(t.x - m.x, t.z - m.z) < (m.r ?? 2.6) + this.radius(t) && Math.abs(t.y - this.ground(m.x, m.z)) < 3) {
            t.finishT = s.t;
            const tm = fmtTime(s.t - (s.t0 ?? 0));
            const total = this.markers.filter((x) => x.kind === 'gem').length;
            return this.endMatch(0, `${t.name} reached the goal in ${tm} · gems ${s.teamScores[0]}/${total}`);
          }
        }
      } else if (m.kind === 'hive') {
        // keep the hive stocked: up to `len` drones, one every few seconds
        const mine = s.tops.filter((d) => d.drone && d.home === mi && d.alive).length;
        this.hiveCool[mi] = (this.hiveCool[mi] ?? 0) - dt;
        if (mine < (m.len ?? 2) && this.hiveCool[mi] <= 0) {
          this.hiveCool[mi] = 7;
          const blade = { ...this.cfg.players[0].blade, id: 'drone' + s.nextId++, name: 'Drone', primary: '#333', secondary: '#111', glow: '#ff2244', spinDir: -1 as const, tip: 'flat' as const };
          const d = this.addTop('Drone', 9, blade, 2, 0, true);
          d.home = mi;
          d.spin = 0.85;
          this.placeTop(d, m.x + (this.rnd() - 0.5) * 2, m.z + (this.rnd() - 0.5) * 2, 3);
        }
      }
    });
    if (s.phase !== 'battle') return;
    const anyLeft = players.some((t) => t.alive || t.respawnT > 0);
    if (!anyLeft) return this.endMatch(-2, 'OUT OF LIVES');
    if (s.timeLeft <= 0) return this.endMatch(-2, 'TIME UP');
  }

  spawnDrone() {
    const p = this.terrain.randomSafePoint(this.rnd);
    const blade = { ...this.cfg.players[0].blade, id: 'drone' + this.s.nextId++, name: 'Drone', primary: '#444', glow: '#ff2244', spinDir: -1 as const, tip: 'flat' as const };
    const t = this.addTop('Drone', 9, blade, 2, 0, true);
    this.placeTop(t, p.x, p.z, 4);
    this.ev({ k: 'announce', text: 'DRONE INCOMING', color: '#ff2244' });
  }

  endMatch(winner: number, msg: string) {
    this.s.winner = winner;
    this.s.phase = 'matchEnd';
    this.s.phaseT = 0;
    this.s.lastFinish = msg;
    if (this.cfg.mode === 'pinball') { this.ev({ k: 'announce', text: 'GAME OVER', sub: msg }); return; }
    this.ev({ k: 'announce', text: winner === -2 ? (this.cfg.mode === 'gauntlet' || this.cfg.mode === 'quest' ? 'FAILED' : 'DRAW') : winner >= 0 && this.cfg.mode === 'gauntlet' ? 'GAUNTLET CLEAR!' : winner >= 0 && this.cfg.mode === 'quest' ? 'QUEST CLEAR!' : 'MATCH OVER', sub: msg });
  }
}
