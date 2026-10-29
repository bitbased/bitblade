// CPU opponents: objective selection + steering with edge/hazard avoidance.
import type { Sim } from './sim';
import type { Control, TopState } from './types';
import { VOID } from './terrain';
import { hazardPose } from './hazards';

export interface AIState {
  level: 1 | 2 | 3;
  think: number;
  tx: number; tz: number; // current goal
  target: number; // enemy id or -1
  aimErr: number;
  wander: number;
}

export function newAI(level: number, rnd: () => number): AIState {
  return { level: Math.max(1, Math.min(3, level)) as 1 | 2 | 3, think: 0, tx: 0, tz: 0, target: -1, aimErr: rnd() * Math.PI * 2, wander: rnd() * 100 };
}

export function aiControl(sim: Sim, t: TopState, ai: AIState, dt: number): Control {
  const s = sim.s;
  const c: Control = { mx: 0, mz: 0, dash: false, jump: false, item: false, special: false };
  ai.think -= dt;
  const reaction = [0, 0.7, 0.35, 0.12][ai.level] * (sim.cfg.mode === 'quest' && !t.drone ? 0.5 : 1);
  if (ai.think <= 0) {
    ai.think = reaction * (0.6 + Math.random() * 0.8);
    chooseGoal(sim, t, ai);
  }
  if (sim.terrain.track && sim.cfg.mode === 'race') return raceControl(sim, t, ai, dt, c);
  if (sim.cfg.mode === 'quest' && !t.drone) return questControl(sim, t, ai, dt, c);
  // steering toward goal (with lead on moving enemy)
  let gx = ai.tx, gz = ai.tz;
  const raceBrake = 0;
  const enemy = ai.target >= 0 ? s.tops[ai.target] : null;
  if (enemy && enemy.alive) {
    const lead = 0.25 * ai.level;
    gx = enemy.x + enemy.vx * lead; gz = enemy.z + enemy.vz * lead;
  }
  let dx = gx - t.x, dz = gz - t.z;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d; dz /= d;
  // aim wobble for weaker AI
  const err = (3 - ai.level) * 0.25 * Math.sin(s.t * 1.3 + ai.aimErr);
  const ce = Math.cos(err), se = Math.sin(err);
  let mx = dx * ce - dz * se, mz = dx * se + dz * ce;
  // counteract current velocity a bit so we actually arrive
  mx -= t.vx * 0.04 * ai.level; mz -= t.vz * 0.04 * ai.level;

  // edge avoidance: look ahead along velocity
  const look = 0.5 + ai.level * 0.15;
  const fx = t.x + t.vx * look, fz = t.z + t.vz * look;
  const here = sim.terrain.height(t.x, t.z);
  const ahead = sim.terrain.height(fx, fz);
  if (ahead <= VOID || (here > VOID && ahead < here - 1.2)) {
    // steer back toward safety (opposite of velocity + toward arena center)
    const vl = Math.hypot(t.vx, t.vz) || 1;
    mx = -t.vx / vl * 1.4 - t.x * 0.05;
    mz = -t.vz / vl * 1.4 - t.z * 0.05;
  }
  // hazard avoidance
  for (const m of sim.markers) {
    const hp = hazardPose(m, s.t + 0.3);
    if (!hp || hp.kind === 'pillar' || hp.kind === 'bumper') continue;
    const hx = hp.kind === 'arm' ? (hp.ax + hp.bx) / 2 : hp.ax, hz = hp.kind === 'arm' ? (hp.az + hp.bz) / 2 : hp.az;
    const rr = hp.kind === 'arm' ? (m.len ?? 4) * 0.6 : 2.2;
    const ex = t.x - hx, ez = t.z - hz, ed = Math.hypot(ex, ez);
    if (ed < rr + 1.5 && ed > 0.01) {
      const k = ((rr + 1.5 - ed) / (rr + 1.5)) * 1.6 * (ai.level / 3);
      mx += (ex / ed) * k; mz += (ez / ed) * k;
      if (ai.level >= 2 && ed < rr && t.grounded && Math.random() < dt * 3) c.jump = true;
    }
  }
  if (raceBrake > 0) {
    const vl = Math.hypot(t.vx, t.vz) || 1;
    mx = mx * (1 - raceBrake) - (t.vx / vl) * raceBrake;
    mz = mz * (1 - raceBrake) - (t.vz / vl) * raceBrake;
  }
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  // stamina-type tops orbit lazily
  const intensity = [0, 0.6, 0.85, 1][ai.level];
  c.mx = mx * intensity; c.mz = mz * intensity;

  // attacks
  if (enemy && enemy.alive) {
    const ed = Math.hypot(enemy.x - t.x, enemy.z - t.z);
    if (ed < 4.5 && t.dashCd <= 0 && Math.random() < dt * [0, 0.8, 2, 4][ai.level]) c.dash = true;
    if (ed < 3.5 && t.special >= 1 && Math.random() < dt * 2) c.special = true;
    if (Math.abs(enemy.y - t.y) > 1 && ed < 2.5 && t.grounded && Math.random() < dt * ai.level) c.jump = true;
  }
  if (t.special >= 1 && (t.specialKind === 'vortex' || t.specialKind === 'fortress') && t.spin < 0.5) c.special = true;
  // items
  if (t.item && t.roll <= 0) {
    const near = enemy && Math.hypot(enemy.x - t.x, enemy.z - t.z);
    switch (t.item) {
      case 'surge': if (t.spin < 0.6) c.item = true; break;
      case 'shield': if (near && near < 3) c.item = true; break;
      case 'shock': if (near && near < 3.5) c.item = true; break;
      case 'mine': if (Math.random() < dt * 0.5) c.item = true; break;
      default: if (near && near < 8 && Math.random() < dt * 1.5) c.item = true;
    }
  }
  return c;
}

function chooseGoal(sim: Sim, t: TopState, ai: AIState) {
  const s = sim.s;
  ai.target = -1;
  const enemies = s.tops.filter((o) => o.alive && o.team !== t.team);
  const nearest = (pts: { x: number; z: number }[]) => {
    let best: { x: number; z: number } | null = null, bd = 1e9;
    for (const p of pts) { const d = Math.hypot(p.x - t.x, p.z - t.z); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  const pickEnemy = () => {
    if (!enemies.length) return;
    // prefer weak & near
    let best = enemies[0], bv = -1e9;
    for (const e of enemies) {
      const v = -Math.hypot(e.x - t.x, e.z - t.z) - e.spin * 6 + (e.flag >= 0 ? 20 : 0);
      if (v > bv) { bv = v; best = e; }
    }
    ai.target = best.id;
  };
  const wanderAround = (cx: number, cz: number, r: number) => {
    ai.wander += 1;
    ai.tx = cx + Math.cos(ai.wander) * r; ai.tz = cz + Math.sin(ai.wander) * r;
  };

  switch (sim.cfg.mode) {
    case 'ctf': {
      const own = s.flags.find((f) => f.team === t.team);
      const theirs = s.flags.find((f) => f.team !== t.team);
      if (t.flag >= 0 && own) { ai.tx = own.hx; ai.tz = own.hz; return; }
      if (own && own.carrier >= 0) { ai.target = own.carrier; return; }
      if (own && !own.home && t.id % 2 === 0) { ai.tx = own.x; ai.tz = own.z; return; }
      if (theirs) {
        if (theirs.carrier >= 0 && s.tops[theirs.carrier]?.team === t.team) { pickEnemy(); return; }
        ai.tx = theirs.x; ai.tz = theirs.z;
      }
      return;
    }
    case 'rush': {
      const c = nearest(s.crystals.filter((c) => c.t > 0.3));
      const box = !t.item ? nearest(s.boxes.filter((b) => b.t <= 0)) : null;
      const rich = enemies.find((e) => e.crystals >= 3 && Math.hypot(e.x - t.x, e.z - t.z) < 5);
      if (rich && ai.level >= 2) { ai.target = rich.id; return; }
      const p = box && (!c || Math.hypot(box.x - t.x, box.z - t.z) < Math.hypot(c.x - t.x, c.z - t.z) * 0.6) ? box : c;
      if (p) { ai.tx = p.x; ai.tz = p.z; } else pickEnemy();
      return;
    }
    case 'koth': {
      const z = s.zone;
      if (!z) return pickEnemy();
      const intruder = enemies.find((e) => Math.hypot(e.x - z.x, e.z - z.z) < z.r + 1);
      if (intruder && Math.hypot(t.x - z.x, t.z - z.z) < z.r + 3) { ai.target = intruder.id; return; }
      wanderAround(z.x, z.z, z.r * 0.4);
      return;
    }
    case 'race': return;
    case 'quest': {
      if (t.drone) {
        const hv = sim.markers[t.home ?? -1];
        if (!hv) return pickEnemy();
        // chase whoever is inside the zone; otherwise drift back and patrol around the hive
        const intruders = enemies.filter((e) => !e.drone && Math.hypot(e.x - hv.x, e.z - hv.z) < (hv.r ?? 8));
        const tgt = intruders.sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z))[0];
        if (tgt) { ai.target = tgt.id; return; }
        ai.target = -1;
        wanderAround(hv.x, hv.z, (hv.r ?? 8) * 0.4);
        return;
      }
      ai.target = -1;
      const g = nearest(s.gems.filter((g) => Math.abs(g.y - t.y) < 1.5 && Math.hypot(g.x - t.x, g.z - t.z) < 7));
      const wp = questWaypoint(sim, t);
      if (g && wp && Math.hypot(g.x - wp.x, g.z - wp.z) < Math.hypot(t.x - wp.x, t.z - wp.z) + 2) { ai.tx = g.x; ai.tz = g.z; return; }
      if (wp) {
        // follow the tile route (ramps, around cliffs, over kicker gaps); aim at the tile after next when close
        const route = questRoute(sim, t.x, t.z, wp.x, wp.z);
        const step = route ? (route.length > 1 && Math.hypot(route[0].x - t.x, route[0].z - t.z) < sim.terrain.def.course!.tile * 0.45 ? route[1] : route[0]) : wp;
        ai.tx = step.x; ai.tz = step.z;
      }
      return;
    }
    case 'gauntlet': {
      if (t.drone) { pickEnemy(); return; }
      const g = nearest(s.gems);
      if (g) { ai.tx = g.x; ai.tz = g.z; }
      return;
    }
    default: {
      // stamina types sometimes hold the center and let attackers come
      const st = sim.st[t.id];
      if (st.stamina > st.attack + 0.15 && t.spin > 0.4 && Math.random() < 0.6) { wanderAround(0, 0, 1.5); return; }
      if (!t.item && sim.cfg.items) {
        const box = nearest(s.boxes.filter((b) => b.t <= 0));
        if (box && Math.hypot(box.x - t.x, box.z - t.z) < 5) { ai.tx = box.x; ai.tz = box.z; return; }
      }
      pickEnemy();
    }
  }
}

/**
 * Quest navigation graph over course tiles: you can roll to a neighbour whose surface meets yours at the shared
 * edge (or drop down to a lower one), and jump a one-tile gap from a kicker. Built once per sim.
 */
interface QuestNav { T: number; w: number; h: number; ox: number; oz: number; next: number[][] }
const navCache = new WeakMap<object, QuestNav | null>();
function questNav(sim: Sim): QuestNav | null {
  if (navCache.has(sim)) return navCache.get(sim)!;
  const c = sim.terrain.def.course;
  if (!c) { navCache.set(sim, null); return null; }
  const T = c.tile, w = c.w, h = c.h, ox = -(w * T) / 2, oz = -(h * T) / 2;
  const ter = sim.terrain;
  const has = new Set(c.pieces.map((p) => p.y * w + p.x));
  const kick = new Set(c.pieces.filter((p) => p.kind === 'kicker').map((p) => p.y * w + p.x));
  // ramps / stairs / kickers are only entered and left head-on (their sides are a lip, not a way on)
  const sloped = new Set(c.pieces.filter((p) => p.kind === 'ramp' || p.kind === 'stairs' || p.kind === 'kicker').map((p) => p.y * w + p.x));
  const next: number[][] = Array.from({ length: w * h }, () => []);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const a = j * w + i;
    if (!has.has(a)) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj, b = nj * w + ni;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      if (has.has(b)) {
        // compare the surfaces either side of the shared edge (centre and two offsets: ramps vary across)
        let ok = false;
        for (const f of sloped.has(a) || sloped.has(b) ? [0] : [0, -0.25, 0.25]) {
          const ex = ox + (i + 0.5 + di * 0.5) * T + (dj ? f * T : 0), ez = oz + (j + 0.5 + dj * 0.5) * T + (di ? f * T : 0);
          const ha = ter.height(ex - di * 0.25, ez - dj * 0.25), hb = ter.height(ex + di * 0.25, ez + dj * 0.25);
          if (ha > VOID && hb > VOID && hb - ha < 0.55) { ok = true; break; } // level, gently up, or any drop down
        }
        if (ok) next[a].push(b);
      } else if (kick.has(a)) {
        const fi = i + di * 2, fj = j + dj * 2, f = fj * w + fi;
        if (fi >= 0 && fj >= 0 && fi < w && fj < h && has.has(f)) next[a].push(f);
      }
    }
  }
  const nav = { T, w, h, ox, oz, next };
  navCache.set(sim, nav);
  return nav;
}

/** breadth-first route over the tile graph; returns the tile centres to roll through (excluding the start) */
function questRoute(sim: Sim, fx: number, fz: number, tx: number, tz: number): { x: number; z: number }[] | null {
  const nav = questNav(sim);
  if (!nav) return null;
  const tile = (x: number, z: number) => {
    const i = Math.floor((x - nav.ox) / nav.T), j = Math.floor((z - nav.oz) / nav.T);
    return i < 0 || j < 0 || i >= nav.w || j >= nav.h ? -1 : j * nav.w + i;
  };
  const s0 = tile(fx, fz), goal = tile(tx, tz);
  if (s0 < 0 || goal < 0) return null;
  if (s0 === goal) return [{ x: tx, z: tz }];
  const prev = new Int32Array(nav.w * nav.h).fill(-2);
  prev[s0] = -1;
  const q = [s0];
  for (let k = 0; k < q.length; k++) {
    const a = q[k];
    if (a === goal) break;
    for (const b of nav.next[a]) if (prev[b] === -2) { prev[b] = a; q.push(b); }
  }
  if (prev[goal] === -2) return null;
  const path: { x: number; z: number }[] = [];
  for (let a = goal; a !== s0 && a >= 0; a = prev[a]) path.push({ x: nav.ox + ((a % nav.w) + 0.5) * nav.T, z: nav.oz + (Math.floor(a / nav.w) + 0.5) * nav.T });
  path.reverse();
  path[path.length - 1] = { x: tx, z: tz };
  return path;
}

/** the next thing a quest runner should head for: the next checkpoint after the last one touched, else the goal */
export function questWaypoint(sim: Sim, t: TopState) {
  const ms = sim.markers;
  const from = t.qcp ?? -1;
  for (let i = from + 1; i < ms.length; i++) if (ms[i].kind === 'checkpoint') return ms[i];
  return ms.find((m) => m.kind === 'goal') ?? null;
}

/**
 * Quest runner: velocity-matched steering toward the waypoint, a speed-up before gaps and ramps,
 * jumps over gaps and up small ledges, brakes at drop-offs it can't clear.
 */
function questControl(sim: Sim, t: TopState, ai: AIState, dt: number, c: Control): Control {
  const ter = sim.terrain;
  let dx = ai.tx - t.x, dz = ai.tz - t.z;
  const dist = Math.hypot(dx, dz) || 1;
  dx /= dist; dz /= dist;
  const speed = Math.hypot(t.vx, t.vz);
  const here = ter.height(t.x, t.z);
  // what's ahead along where we want to go
  let gapAt = -1, wallAt = -1;
  for (let k = 1; k <= 8; k++) {
    const d = k * 0.9;
    const h = ter.height(t.x + dx * d, t.z + dz * d);
    if (h <= VOID) { if (gapAt < 0) gapAt = d; }
    else if (here > VOID && h > here + 1.1 && wallAt < 0 && gapAt < 0) wallAt = d;
  }
  // landing on the far side of a gap?
  let land = false;
  if (gapAt > 0) for (let d = gapAt; d < gapAt + 12; d += 0.6) if (ter.height(t.x + dx * d, t.z + dz * d) > VOID) { land = true; break; }
  const want = gapAt > 0 && land ? 13 : dist < 4 ? 5 : 10;
  const pace = [0, 0.85, 0.95, 1][ai.level];
  let mx = (dx * want * pace - t.vx) * 0.35, mz = (dz * want * pace - t.vz) * 0.35;
  // a gap with no landing: stop and back off
  if (gapAt > 0 && gapAt < 3 && !land) { mx = -t.vx * 0.5; mz = -t.vz * 0.5; }
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  c.mx = mx; c.mz = mz;
  const along = (t.vx * dx + t.vz * dz);
  if (t.grounded && gapAt > 0 && gapAt < 2.2 + speed * 0.12 && land && along > 5) c.jump = true;
  if (t.grounded && wallAt > 0 && wallAt < 1.6 && along > 2) c.jump = true;
  if (t.dashCd <= 0 && along > 2 && (gapAt > 0 && land && gapAt < 4 + speed * 0.3) && t.spin > 0.2) c.dash = true;
  if (t.dashCd <= 0 && gapAt < 0 && dist > 14 && along > 3 && along < 8 && t.spin > 0.5 && Math.random() < dt * 1.5) c.dash = true;
  // fight drones that get close
  const drone = sim.s.tops.find((o) => o.drone && o.alive && Math.hypot(o.x - t.x, o.z - t.z) < 3);
  if (drone && t.dashCd <= 0 && Math.random() < dt * 3) { const ex = drone.x - t.x, ez = drone.z - t.z, el = Math.hypot(ex, ez) || 1; c.mx = ex / el; c.mz = ez / el; c.dash = true; }
  if (t.item && t.roll <= 0 && (t.item !== 'surge' || t.spin < 0.6) && Math.random() < dt) c.item = true;
  return c;
}

/**
 * Race driver: velocity-matching steering along a racing line.
 * Picks a target speed from the curvature ahead (v = sqrt(grip / curvature)), aims for the inside of bends,
 * brakes early, dashes on straights and into jumps, and uses items situationally. Level scales pace and polish.
 */
function raceControl(sim: Sim, t: TopState, ai: AIState, dt: number, c: Control): Control {
  const T = sim.terrain.track!;
  const s = sim.s;
  const lv = ai.level;
  const pace = [0, 0.8, 0.9, 1][lv];
  const speed = Math.hypot(t.vx, t.vz);
  const at = (k: number) => (((t.prog + k) % T.n) + T.n) % T.n;
  // scan ahead: the tightest bend inside our braking window, and any jump gap
  const window = Math.round((8 + speed * 1.4) / 0.5);
  let worst = 0, worstSigned = 0, worstK = 0, gapK = -1;
  for (let k = 4; k < window; k += 2) {
    const q = at(k);
    const cv = Math.abs(T.curv[q]);
    // nearer bends matter more (we have less room to brake for them)
    const w = cv * (1 - (k / window) * 0.45);
    if (w > worst) { worst = w; worstSigned = T.curv[q]; worstK = k; }
    if (gapK < 0 && k < 40 && sim.terrain.height(T.x[q], T.z[q]) <= VOID) gapK = k;
  }
  const grip = 8.5 + sim.st[t.id].tipFriction * 2.5;
  let want = Math.min(17, Math.sqrt(grip / Math.max(0.004, worst))) * pace;
  if (gapK >= 0) want = 99; // carry speed into jumps
  // racing line: drift to the inside of the coming bend, back to center on straights
  const lane = worst > 0.01 && worstK < window * 0.8 ? Math.sign(worstSigned) * Math.min(0.32, worst * 9) * T.width : 0;
  let laneAdj = lane;
  // obstacles on the road ahead: pick the side away from them, hop over sweeping arms
  for (const m of sim.markers) {
    if (m.kind !== 'pillar' && m.kind !== 'bumper' && m.kind !== 'saw' && m.kind !== 'arm') continue;
    const hp = hazardPose(m, s.t + 0.25);
    if (!hp) continue;
    const ox = hp.kind === 'arm' ? (hp.ax + hp.bx) / 2 : hp.ax, oz = hp.kind === 'arm' ? (hp.az + hp.bz) / 2 : hp.az;
    const rx = ox - t.x, rz = oz - t.z;
    const ahead = rx * T.tx[t.prog] + rz * T.tz[t.prog];
    if (ahead < -1 || ahead > 9 + speed * 0.6) continue;
    const oLat = -(ox - T.x[t.prog]) * T.tz[t.prog] + (oz - T.z[t.prog]) * T.tx[t.prog];
    if (hp.kind === 'arm') {
      if (ahead < 3.5 + speed * 0.12 && t.grounded && t.jumpCd <= 0 && lv >= 2) c.jump = true;
      continue;
    }
    const clear = hp.r + 1.4;
    if (Math.abs(oLat - laneAdj) < clear) laneAdj = oLat + (oLat > 0 ? -clear : clear);
  }
  laneAdj = Math.max(-T.width * 0.36, Math.min(T.width * 0.36, laneAdj));
  const look = Math.max(6, Math.round((3 + speed * 0.55) / 0.5));
  const k = at(look);
  const gx = T.x[k] - T.tz[k] * laneAdj, gz = T.z[k] + T.tx[k] * laneAdj;
  let dx = gx - t.x, dz = gz - t.z;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl; dz /= dl;
  // desired velocity along the line; steer by velocity error (handles drift and slides naturally)
  const target = Math.min(want, 17) * (sim.rubber[t.id] ?? 1);
  let ex = dx * target - t.vx, ez = dz * target - t.vz;
  // stay on the ribbon: pull hard back toward center when drifting wide
  const q0 = t.prog;
  const lat = -(t.x - T.x[q0]) * T.tz[q0] + (t.z - T.z[q0]) * T.tx[q0];
  const half = T.width / 2;
  if (Math.abs(lat) > half * 0.62) { const pull = (Math.abs(lat) - half * 0.62) * 3; ex += T.tz[q0] * Math.sign(lat) * pull; ez -= T.tx[q0] * Math.sign(lat) * pull; }
  const el = Math.hypot(ex, ez);
  if (el > 0.05) { const m = Math.min(1, el / 2.5); c.mx = (ex / el) * m; c.mz = (ez / el) * m; }
  // weaker drivers are a bit sloppy
  if (lv < 3) { const wob = (3 - lv) * 0.12 * Math.sin(s.t * 2.1 + ai.aimErr); const cx = c.mx, cz = c.mz; c.mx = cx * Math.cos(wob) - cz * Math.sin(wob); c.mz = cx * Math.sin(wob) + cz * Math.cos(wob); }
  // dash: on straights when slower than we could be, and right before jumps
  const straight = worst < 0.012;
  if (t.dashCd <= 0 && t.grounded) {
    if (gapK >= 0 && gapK < 14 && speed < 15) c.dash = true;
    else if (straight && speed < target - 1 && t.spin > 0.5 && Math.random() < dt * [0, 0.6, 1.5, 3][lv]) c.dash = true;
  }
  // items
  if (t.item && t.roll <= 0) {
    const prog = (o: TopState) => o.lap * T.n + o.prog;
    const me = prog(t);
    const rivals = s.tops.filter((o) => o !== t && o.alive && !o.drone);
    const aheadNear = rivals.some((o) => prog(o) > me && prog(o) - me < 60);
    const behindNear = rivals.some((o) => prog(o) < me && me - prog(o) < 20);
    const close = rivals.some((o) => Math.hypot(o.x - t.x, o.z - t.z) < 3);
    const r = Math.random() < dt * [0, 0.8, 2, 4][lv];
    switch (t.item) {
      case 'turbo': if (straight && gapK < 0) c.item = true; break;
      case 'surge': if (t.spin < 0.65) c.item = true; break;
      case 'comet': if (aheadNear && r) c.item = true; break;
      case 'mine': case 'shield': if (behindNear && r) c.item = true; break;
      case 'shock': case 'vortex': case 'titan': if (close) c.item = true; break;
    }
  }
  if (t.special >= 1 && (t.specialKind === 'rush' ? straight : t.specialKind !== 'skydive') && Math.random() < dt) c.special = true;
  return c;
}
