// CPU opponents: objective selection + steering with edge/hazard avoidance.
import type { Sim } from './sim';
import type { Control, TopState } from './types';
import { VOID } from './terrain';
import { hazardPose } from './hazards';
import { arenaRing, flipperPose, flipperSide, segDist } from './pinball';

export interface AIState {
  level: 1 | 2 | 3;
  think: number;
  tx: number; tz: number; // current goal
  target: number; // enemy id or -1
  aimErr: number;
  wander: number;
  /** stuck watch: where we were a moment ago, and a short break-out manoeuvre (side alternates per try) */
  sx?: number; sz?: number; st?: number; unstuck?: number; unSide?: number;
  /** pinball: how long the plunger has been held */
  plungeT?: number; aimGoal?: number;
  /** battles: a run-up — swinging out round the enemy at speed — and the charge in after it */
  runup?: { side: number; t: number }; runCd?: number; charge?: number;
  /** 3+ tops: a spell spent hunting the rival with the most burst health left (so nobody coasts untouched) */
  hunt?: { id: number; until: number }; nextHunt?: number;
  /** low on spin: heading for a spin source (a spin pad, or a slot in a pinball party) until it's topped up */
  recharge?: boolean;
  /** badly hurt: staying at full spin on a spin source to heal burst health, until this time at the latest */
  healUntil?: number; healAgain?: number;
  /** pinball party: a short errand to light something on the table (like a crystal in Crystal Rush) */
  errand?: { x: number; z: number; mi: number; until: number; kind?: 'flip' | 'boost' }; nextErrand?: number;
  /** pinball: how long each side has been held up (a CPU lets go to re-flip instead of cradling forever) */
  holdL?: number; holdR?: number; restL?: number; restR?: number;
  /** races: holding overdrive down a straight / into a jump (kept until a bend comes or the spin runs low) */
  od?: boolean;
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
  if (sim.cfg.mode === 'pinball' && !t.drone && !t.duel) return pinballControl(sim, t, ai, dt, c);
  // pinball party: sitting in a slot — aim at the nearest rival and fire out once the spin's back up
  if (sim.party && t.held !== undefined) {
    let best: TopState | null = null, bd = 1e9;
    for (const o of s.tops) { if (!o.alive || o.team === t.team || o.held !== undefined) continue; const d = Math.hypot(o.x - t.x, o.z - t.z); if (d < bd) { bd = d; best = o; } }
    if (best) { const l = bd || 1; c.mx = (best.x - t.x) / l; c.mz = (best.z - t.z) / l; }
    // (healing: stay in until the slot lets go — it heals burst health while you sit there)
    c.dash = !ai.healUntil && (t.heldT ?? 0) < 4 - [0, 1.6, 1.1, 0.7][ai.level] && (t.spin > 0.95 || (t.heldT ?? 0) < 1.5);
    return c;
  }
  // steering toward goal (with lead on moving enemy)
  let gx = ai.tx, gz = ai.tz;
  const raceBrake = 0;
  const enemy = ai.target >= 0 ? s.tops[ai.target] : null;
  if (enemy && enemy.alive) {
    const lead = 0.25 * ai.level;
    gx = enemy.x + enemy.vx * lead; gz = enemy.z + enemy.vz * lead;
  }
  // run-ups: rather than just chasing, now and then swing out round the enemy (no boost: overdrive barely steers)
  // and cut in with it held. Circling keeps the speed — backing straight off and turning round loses it.
  // Not when holding a king-of-the-hill zone
  ai.runCd = (ai.runCd ?? 2) - dt; ai.charge = Math.max(0, (ai.charge ?? 0) - dt);
  const bowlR = arenaRadius(sim, t);
  if (enemy && enemy.alive && !ai.runup && ai.runCd <= 0 && bowlR && !s.zone && t.spin > 0.4) {
    const ed = Math.hypot(enemy.x - t.x, enemy.z - t.z);
    if (ed < 4 && Math.random() < dt * [0, 0.4, 1.2, 1.8][ai.level]) ai.runup = { side: Math.random() < 0.5 ? -1 : 1, t: 0.8 + Math.random() * 0.7 };
  }
  if (ai.runup) {
    ai.runup.t -= dt;
    if (!enemy?.alive || ai.runup.t <= 0 || t.spin < 0.35) { ai.runup = undefined; ai.runCd = 2.5 + Math.random() * 2.5; ai.charge = 1.5; }
    else {
      // a point ahead round a ~4m circle about the enemy (kept inside the bowl)
      const home = arenaHome(sim, t), a = Math.atan2(t.z - enemy!.z, t.x - enemy!.x) + ai.runup.side * 0.9;
      gx = enemy!.x + Math.cos(a) * 4; gz = enemy!.z + Math.sin(a) * 4;
      const pr = Math.hypot(gx - home.x, gz - home.z), lim = bowlR! * 0.7;
      if (pr > lim) { gx = home.x + ((gx - home.x) * lim) / pr; gz = home.z + ((gz - home.z) * lim) / pr; }
    }
  }
  // courses with levels: take the route (ramps, round walls) when the goal isn't straight ahead on our level
  let climbing = false;
  if (sim.terrain.def.course && !t.duel) { // (a pinball arena duel: the bowl is the whole stadium)
    const T = sim.terrain.def.course.tile;
    const route = questRoute(sim, t.x, t.z, gx, gz);
    if (route && route.length > 1) {
      const wp = Math.hypot(route[0].x - t.x, route[0].z - t.z) < T * 0.45 ? route[1] : route[0];
      climbing = sim.terrain.height(wp.x, wp.z) > sim.terrain.height(t.x, t.z) + 0.6;
      gx = wp.x; gz = wp.z;
    }
  }
  let dx = gx - t.x, dz = gz - t.z;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d; dz /= d;
  // aim wobble for weaker AI
  const err = (3 - ai.level) * 0.25 * Math.sin(s.t * 1.3 + ai.aimErr);
  const ce = Math.cos(err), se = Math.sin(err);
  let mx = dx * ce - dz * se, mz = dx * se + dz * ce;
  // counteract current velocity a bit so we actually arrive (charging in: only the drift sideways, keep the speed)
  if (ai.charge && !ai.runup) { const along = t.vx * dx + t.vz * dz; mx -= (t.vx - dx * along) * 0.04 * ai.level; mz -= (t.vz - dz * along) * 0.04 * ai.level; }
  else { mx -= t.vx * 0.04 * ai.level; mz -= t.vz * 0.04 * ai.level; }

  // edge avoidance: look ahead along velocity
  const look = 0.5 + ai.level * 0.15;
  const fx = t.x + t.vx * look, fz = t.z + t.vz * look;
  const here = sim.terrain.height(t.x, t.z);
  const ahead = sim.terrain.height(fx, fz);
  if (ahead <= VOID || (here > VOID && ahead < here - 1.2)) {
    // steer back toward safety (opposite of velocity + toward arena center)
    const vl = Math.hypot(t.vx, t.vz) || 1;
    const home = arenaHome(sim, t);
    mx = -t.vx / vl * 1.4 - (t.x - home.x) * 0.05;
    mz = -t.vz / vl * 1.4 - (t.z - home.z) * 0.05;
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
  // stamina-type tops orbit lazily (but always take a ramp at full power)
  const intensity = climbing ? 1 : [0, 0.6, 0.85, 1][ai.level];
  c.mx = mx * intensity; c.mz = mz * intensity;
  if (climbing && t.grounded && t.dashCd <= 0 && Math.hypot(t.vx, t.vz) < 9 && (t.vx * dx + t.vz * dz) > 0) c.dash = true;
  unstick(t, ai, dt, c, d);

  // attacks
  if (enemy && enemy.alive) {
    const ed = Math.hypot(enemy.x - t.x, enemy.z - t.z);
    // (the charge in after a run-up: boost held down the straight (overdrive hits harder, but barely steers), dash just before contact)
    if (ai.charge && ai.charge > 0 && !ai.runup && t.spin > 0.35) c.hold = true;
    // dash: aimed. The boost adds to the speed we already have, so point it to cancel our sideways drift and lead the
    // enemy — the result heads straight at where it will be. Too much drift to line up: wait for a better moment
    // (no wasted dashes). Easy CPUs aim sloppier.
    if (!ai.runup && ed < 5 && ed > 0.8 && t.dashCd <= 0 && (ai.charge ? ed < 3.2 : Math.random() < dt * [0, 1, 3, 6][ai.level])) {
      const dashV = 9 * sim.rpmK(t), sp = Math.hypot(t.vx, t.vz);
      const lead = (ed / (sp + dashV)) * [0, 0.4, 0.8, 1][ai.level];
      let Tx = enemy.x + enemy.vx * lead - t.x, Tz = enemy.z + enemy.vz * lead - t.z;
      const Tl = Math.hypot(Tx, Tz) || 1; Tx /= Tl; Tz /= Tl;
      const va = t.vx * Tx + t.vz * Tz, px = t.vx - Tx * va, pz = t.vz - Tz * va, vp = Math.hypot(px, pz);
      if (vp < dashV * 0.85) {
        const fwd = Math.sqrt(1 - (vp / dashV) ** 2);
        if (va + dashV * fwd > 2) {
          let dx = -px / dashV + Tx * fwd, dz = -pz / dashV + Tz * fwd;
          const e = (3 - ai.level) * 0.22 * (Math.random() - 0.5), ce = Math.cos(e), se = Math.sin(e); // (sloppier when easy)
          [dx, dz] = [dx * ce - dz * se, dx * se + dz * ce];
          c.mx = dx; c.mz = dz; c.dash = true;
        }
      }
    }
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

/**
 * Pinball CPU: pull the plunger back a moment and let go; flip a side when a ball is about to cross that
 * flipper (a short look ahead along its velocity — weaker CPUs look less far, so they're late more often).
 */
function pinballControl(sim: Sim, t: TopState, ai: AIState, dt: number, c: Control): Control {
  if (t.extra) return c;
  if (sim.inPlunger(t)) {
    ai.plungeT = (ai.plungeT ?? 0) + dt;
    if (ai.plungeT < 0.5 + ai.level * 0.25) c.mz = 1; else ai.plungeT = 0;
    return c;
  }
  ai.plungeT = 0;
  // an aim lock: swing toward a drone (or the lock's own line, give or take) and fire when lined up
  if (t.held !== undefined && sim.markers[t.held]?.aim) {
    const m = sim.markers[t.held];
    if (ai.aimGoal === undefined) {
      // drones first, then an open arena bowl's gate, then a bank that's still up, else roughly the lock's own line
      const pin = sim.s.pin!, ms = sim.markers, inArc = (x: number, z: number) => Math.abs(Math.atan2(Math.sin(Math.atan2(z - m.z, x - m.x) - (m.rot ?? 0)), Math.cos(Math.atan2(z - m.z, x - m.x) - (m.rot ?? 0)))) <= m.aim!;
      const dr = pin.swarm.find((d) => d.hp > 0 && inArc(d.x, d.z));
      const gates = ms.map((a, ai) => ({ a, ai })).filter(({ a, ai }) => a.kind === 'arena' && pin.lit[ai]).map(({ a }) => { const { R, g } = arenaRing(a); return { x: a.x + Math.cos(g) * R, z: a.z + Math.sin(g) * R }; });
      const drop = ms.map((q, qi) => ({ q, qi })).find(({ q, qi }) => q.kind === 'drop' && !pin.lit[qi] && inArc(q.x, q.z))?.q;
      const goal = dr ?? gates.find((g) => inArc(g.x, g.z)) ?? drop;
      ai.aimGoal = goal ? Math.atan2(goal.z - m.z, goal.x - m.x) : (m.rot ?? 0) + (sim.rnd() - 0.5) * (m.aim ?? 0);
      ai.aimGoal = Math.max((m.rot ?? 0) - m.aim!, Math.min((m.rot ?? 0) + m.aim!, ai.aimGoal));
    }
    const a = t.aimA ?? m.rot ?? 0, diff = ai.aimGoal - a;
    if (Math.abs(diff) < 0.06) { c.dash = true; ai.aimGoal = undefined; return c; }
    const turn = Math.sign(diff) * (Math.sin(a) >= 0 ? 1 : -1);
    c.flipL = turn > 0; c.flipR = turn < 0;
    return c;
  }
  ai.aimGoal = undefined;
  const look = [0, 0.03, 0.06, 0.09][ai.level];
  let wantL = false, wantR = false;
  for (const m of sim.markers) {
    if (m.kind !== 'flipper') continue;
    const P = flipperPose(m, m.rot ?? 0);
    for (const b of sim.s.tops) {
      if (!b.alive || b.drone) continue;
      const fx = b.x + b.vx * look, fz = b.z + b.vz * look;
      const near = segDist(P, fx, fz).d < 1.7 || segDist(P, b.x, b.z).d < 1.5;
      // only when the ball is on the playfield side of the flipper (above its line), not behind it
      if (near && b.z < Math.max(P.az, P.bz) + 0.4) { if (flipperSide(m) === 'L') wantL = true; else wantR = true; }
    }
  }
  // a flip is a short press: hold at most ~0.3s, then let the flipper drop before flipping again
  const side = (want: boolean, hold: number, rest: number) => {
    if (rest > 0) return { up: false, hold: 0, rest: rest - dt };
    if (!want) return { up: false, hold: 0, rest: 0 };
    if (hold > 0.3) return { up: false, hold: 0, rest: 0.22 };
    return { up: true, hold: hold + dt, rest: 0 };
  };
  const l = side(wantL, ai.holdL ?? 0, ai.restL ?? 0), r = side(wantR, ai.holdR ?? 0, ai.restR ?? 0);
  ai.holdL = l.hold; ai.restL = l.rest; ai.holdR = r.hold; ai.restR = r.rest;
  c.flipL = l.up; c.flipR = r.up;
  return c;
}

/**
 * Stuck watch (every mode): wanted to go somewhere but barely moved for 1.5s → a short break-out: steer 70° off
 * to one side (a diagonal, so walls and ramp lips are taken at an angle), dash and hop. The side alternates.
 */
function unstick(t: TopState, ai: AIState, dt: number, c: Control, goalD: number) {
  if (!t.alive) { ai.st = undefined; return; }
  if ((ai.unstuck ?? 0) > 0) {
    ai.unstuck! -= dt;
    const a = (ai.unSide ?? 1) * 1.2, mx = c.mx, mz = c.mz, ml = Math.hypot(mx, mz) || 1;
    c.mx = ((mx * Math.cos(a) - mz * Math.sin(a)) / ml); c.mz = ((mx * Math.sin(a) + mz * Math.cos(a)) / ml);
    if (t.dashCd <= 0) c.dash = true;
    if (t.grounded && ai.unstuck! < 0.5) c.jump = true;
    return;
  }
  if (ai.st === undefined || ai.sx === undefined) { ai.sx = t.x; ai.sz = t.z; ai.st = 0; return; }
  ai.st += dt;
  if (Math.hypot(t.x - ai.sx, t.z - ai.sz!) > 1.5) { ai.sx = t.x; ai.sz = t.z; ai.st = 0; return; }
  if (ai.st > 1.5 && goalD > 3 && Math.hypot(c.mx, c.mz) > 0.3) {
    ai.unstuck = 0.9; ai.unSide = -(ai.unSide ?? -1); ai.st = 0;
  }
}

/** the middle of the stadium you're fighting in: a pinball arena bowl in a duel, else the arena's centre */
/** the battle bowl's radius round arenaHome (null off a stadium: courses) */
function arenaRadius(sim: Sim, t: TopState) {
  const d = sim.s.pin?.duel;
  if (t.duel && d) return sim.markers[d.mi].r ?? 6;
  return sim.terrain.def.course ? null : sim.terrain.def.stadium?.radius ?? null;
}

function arenaHome(sim: Sim, t: TopState) {
  const d = sim.s.pin?.duel;
  if (t.duel && d) { const m = sim.markers[d.mi]; return { x: m.x, z: m.z }; }
  return { x: 0, z: 0 };
}

function chooseGoal(sim: Sim, t: TopState, ai: AIState) {
  const s = sim.s;
  ai.target = -1;
  // (in a pinball arena duel the only enemy is the one in the bowl with you)
  const enemies = s.tops.filter((o) => o.alive && o.team !== t.team && (!t.duel || o.duel));
  const nearest = (pts: { x: number; z: number }[]) => {
    let best: { x: number; z: number } | null = null, bd = 1e9;
    for (const p of pts) { const d = Math.hypot(p.x - t.x, p.z - t.z); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  const pickEnemy = () => {
    if (!enemies.length) return;
    // 3+ tops: now and then go after whoever has the most burst health left, for a few seconds
    const now = s.t;
    if (ai.hunt && now < ai.hunt.until && enemies.some((e) => e.id === ai.hunt!.id)) { ai.target = ai.hunt.id; return; }
    if (enemies.length >= 2 && now >= (ai.nextHunt ??= now + 4 + Math.random() * 8)) {
      const fresh = enemies.reduce((a, e) => (e.burst < a.burst - 0.02 || (Math.abs(e.burst - a.burst) <= 0.02 && e.spin > a.spin) ? e : a));
      ai.hunt = { id: fresh.id, until: now + 4 };
      ai.nextHunt = now + 8 + Math.random() * 6;
      ai.target = fresh.id;
      return;
    }
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

  // low on spin: go and top up at the nearest spin source — a spin pad, or (pinball party) an open slot — and stay
  // until it's back up, unless a rival is right on top of us. (Not in races / quests, which steer their own way.)
  const mode = sim.cfg.mode;
  if (!t.drone && mode !== 'race' && mode !== 'quest' && !t.held) {
    const srcs = sim.markers.filter((m) => m.kind === 'spinpad' || (sim.party && m.kind === 'saucer' && sim.linkOn(m)));
    if (srcs.length) {
      // (badly hurt: go and sit at full spin — that's what heals burst health — until it's back up, or 12s at most)
      if (t.burst > 0.5 && !ai.healUntil && s.t >= (ai.healAgain ?? 0)) ai.healUntil = s.t + 12;
      if (ai.healUntil && (t.burst < 0.35 || s.t > ai.healUntil)) { ai.healUntil = undefined; ai.healAgain = s.t + 10; }
      if (t.spin < 0.4 || ai.healUntil) ai.recharge = true;
      else if (t.spin > 0.85) ai.recharge = false;
      const close = enemies.some((e) => Math.hypot(e.x - t.x, e.z - t.z) < 2.2);
      if (ai.recharge && !close) {
        const src = nearest(srcs)!;
        ai.tx = src.x; ai.tz = src.z;
        return;
      }
    }
  }

  // pinball party: play the table too — go light the nearest unlit rollover / target / standing drop target (they
  // light shots, open bowls and win power-ups), like crystals in Crystal Rush — between fights: only with no rival
  // near, and a break between errands (the fight comes first)
  const pin = s.pin;
  if (sim.party && pin && !t.drone && t.held === undefined) {
    const lit = (mi: number) => pin.lit[mi];
    const done = ai.errand && (ai.errand.kind === 'flip' ? (t.flipT ?? 0) > 0 : lit(ai.errand.mi) || Math.hypot(ai.errand.x - t.x, ai.errand.z - t.z) < 0.8);
    if (ai.errand && (s.t > ai.errand.until || done)) { ai.errand = undefined; ai.nextErrand = s.t + 5 + Math.random() * 4; }
    const nearFoe = enemies.some((e) => Math.hypot(e.x - t.x, e.z - t.z) < 7);
    if (!ai.errand && !nearFoe && s.t >= (ai.nextErrand ?? 0)) {
      const goals = sim.markers.map((m, mi) => ({ m, mi })).filter(({ m, mi }) => !lit(mi) && (m.kind === 'rollover' || m.kind === 'target' || m.kind === 'drop') && !m.fly)
        .map(({ m, mi }) => (m.kind === 'drop' ? { x: m.x + Math.cos(m.rot ?? 0) * 1.4, z: m.z + Math.sin(m.rot ?? 0) * 1.4, mi } : { x: m.x, z: m.z, mi })); // (a drop target from its face)
      // (targets and drop targets open things up: they count as nearer than a rollover)
      let best: (typeof goals)[number] | null = null, bd = 14;
      for (const g of goals) { const d = Math.hypot(g.x - t.x, g.z - t.z) * (sim.markers[g.mi].kind === 'rollover' ? 1.6 : 1); if (d < bd) { bd = d; best = g; } }
      if (best) ai.errand = { ...best, until: s.t + 4 };
      // or now and then: roll onto a flipper and let it fire you at a rival up the table (a flipper shot hits harder)
      const upTable = enemies.some((e) => e.z < t.z - 6);
      if (upTable && Math.random() < 0.3) {
        let fb: { x: number; z: number; mi: number } | null = null, fd = 16;
        sim.markers.forEach((m, mi) => {
          if (m.kind !== 'flipper') return;
          const P = flipperPose(m, m.rot ?? 0), ux = P.bx - P.ax, uz = P.bz - P.az, ul = Math.hypot(ux, uz) || 1;
          let nx = -uz / ul, nz = ux / ul; if (nz > 0) { nx = -nx; nz = -nz; } // (the side facing up the table)
          const x = P.ax + ux * 0.55 + nx * 0.9, z = P.az + uz * 0.55 + nz * 0.9, d = Math.hypot(x - t.x, z - t.z);
          if (d < fd) { fd = d; fb = { x, z, mi }; }
        });
        if (fb) ai.errand = { ...(fb as { x: number; z: number; mi: number }), until: s.t + 4, kind: 'flip' };
      }
    }
    if (ai.errand && !nearFoe) { ai.tx = ai.errand.x; ai.tz = ai.errand.z; return; }
  }

  // battle arenas with boost pads: now and then, with the rival well away, run over a pad that points at them — you
  // arrive fast (like going for an item, but only when it's on the way)
  if (!sim.party && mode !== 'race' && mode !== 'quest' && mode !== 'pinball' && !t.drone && !ai.recharge) {
    if (ai.errand && (s.t > ai.errand.until || Math.hypot(ai.errand.x - t.x, ai.errand.z - t.z) < 0.9)) { ai.errand = undefined; ai.nextErrand = s.t + 6 + Math.random() * 4; }
    const foe = enemies.length ? enemies.reduce((a, e) => (Math.hypot(e.x - t.x, e.z - t.z) < Math.hypot(a.x - t.x, a.z - t.z) ? e : a)) : null;
    if (!ai.errand && foe && Math.hypot(foe.x - t.x, foe.z - t.z) > 6 && s.t >= (ai.nextErrand ?? 0)) {
      let pad: { x: number; z: number; mi: number } | null = null, pd = 12;
      sim.markers.forEach((m, mi) => {
        if (m.kind !== 'boost') return;
        const a = m.rot ?? 0, fx = Math.sin(a), fz = Math.cos(a), ex = foe.x - m.x, ez = foe.z - m.z, el = Math.hypot(ex, ez) || 1;
        const d = Math.hypot(m.x - t.x, m.z - t.z);
        if ((ex * fx + ez * fz) / el > 0.75 && d < pd) { pd = d; pad = { x: m.x, z: m.z, mi }; }
      });
      if (pad) ai.errand = { ...(pad as { x: number; z: number; mi: number }), until: s.t + 3, kind: 'boost' };
      else ai.nextErrand = s.t + 2;
    }
    if (ai.errand?.kind === 'boost') { ai.tx = ai.errand.x; ai.tz = ai.errand.z; return; }
  }

  switch (t.duel ? (s.pin?.duel?.game === 'koth' ? 'koth' : 'duel') : sim.cfg.mode) {
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
      // track adventures: drive the road — aim a little ahead along the path (further when fast)
      const TS = sim.terrain.track;
      if (TS) {
        const sp = Math.hypot(t.vx, t.vz);
        const k = Math.min(TS.n - 1, t.prog + Math.round((5 + sp * 0.6) / 0.5));
        ai.tx = TS.x[k]; ai.tz = TS.z[k];
        return;
      }
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
      // stamina types sometimes hold the center and let attackers come (while they are still coming: close up, fight)
      const st = sim.st[t.id];
      const close = enemies.some((e) => Math.hypot(e.x - t.x, e.z - t.z) < 6);
      if (!close && st.stamina > st.attack + 0.15 && t.spin > 0.4 && Math.random() < 0.6) { const home = arenaHome(sim, t); wanderAround(home.x, home.z, 1.5); return; }
      if (!t.item && (sim.cfg.items || t.duel)) { // (a pinball arena bowl has its own power-up)
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
function questNav(sim: { terrain: Sim['terrain'] }): QuestNav | null {
  if (navCache.has(sim.terrain)) return navCache.get(sim.terrain)!;
  const c = sim.terrain.def.course;
  if (!c) { navCache.set(sim.terrain, null); return null; }
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
        // ...and nowhere between the two tile centres is a climb steeper than a ramp (no routes up and over a
        // quarter-pipe wall: its lip is fine to drop off, not to ride over)
        if (ok) {
          let prevH = ter.height(ox + (i + 0.5) * T, oz + (j + 0.5) * T);
          for (let k = 1; k <= 12 && ok; k++) {
            const f = k / 12, hh = ter.height(ox + (i + 0.5 + di * f) * T, oz + (j + 0.5 + dj * f) * T);
            if (hh > VOID && prevH > VOID && hh - prevH > 0.45) ok = false;
            if (hh > VOID) prevH = hh;
          }
        }
        if (ok) next[a].push(b);
      } else if (kick.has(a)) {
        const fi = i + di * 2, fj = j + dj * 2, f = fj * w + fi;
        if (fi >= 0 && fj >= 0 && fi < w && fj < h && has.has(f)) next[a].push(f);
      }
    }
  }
  const nav = { T, w, h, ox, oz, next };
  navCache.set(sim.terrain, nav);
  return nav;
}

/** breadth-first route over the tile graph; returns the tile centres to roll through (excluding the start) */
export function questRoute(sim: { terrain: Sim['terrain'] }, fx: number, fz: number, tx: number, tz: number): { x: number; z: number }[] | null {
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
  // the gauntlet: steer around sweepers / saws / pillars / bumpers, hop arms that are about to hit
  for (const m of sim.markers) {
    const hp = hazardPose(m, sim.s.t + 0.25);
    if (!hp) continue;
    const solid = hp.kind === 'pillar' || hp.kind === 'bumper';
    const hx = hp.kind === 'arm' ? (hp.ax + hp.bx) / 2 : hp.ax, hz = hp.kind === 'arm' ? (hp.az + hp.bz) / 2 : hp.az;
    const rr = hp.kind === 'arm' ? (m.len ?? 4) * 0.55 : solid ? (m.r ?? 0.8) + 0.6 : 1.8;
    const ex = t.x - hx, ez = t.z - hz, ed = Math.hypot(ex, ez);
    if (ed < rr + 1.4 && ed > 0.01) {
      const push = ((rr + 1.4 - ed) / (rr + 1.4)) * (solid ? 0.9 : 1.4);
      c.mx += (ex / ed) * push; c.mz += (ez / ed) * push;
      if (!solid && t.grounded && ed < rr && t.jumpCd <= 0) c.jump = true;
    }
  }
  {
    const l = Math.hypot(c.mx, c.mz);
    if (l > 1) { c.mx /= l; c.mz /= l; }
  }
  // fight drones that get close
  const drone = sim.s.tops.find((o) => o.drone && o.alive && Math.hypot(o.x - t.x, o.z - t.z) < 3);
  if (drone && t.dashCd <= 0 && Math.random() < dt * 3) { const ex = drone.x - t.x, ez = drone.z - t.z, el = Math.hypot(ex, ez) || 1; c.mx = ex / el; c.mz = ez / el; c.dash = true; }
  if (t.item && t.roll <= 0 && (t.item !== 'surge' || t.spin < 0.6) && Math.random() < dt) c.item = true;
  if (!sim.terrain.track) unstick(t, ai, dt, c, Math.hypot(ai.tx - t.x, ai.tz - t.z));
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
  const target = Math.min(want, ai.od ? 22 : 17) * (sim.rubber[t.id] ?? 1); // (overdrive: don't hold it back)
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
  // overdrive (hold dash): long boosts down straights, up climbs and into jumps — more of them when behind, when
  // there's spin banked, and on the last lap (nothing to save it for). Let go before a bend (overdrive turns wide).
  const climb = T.y[(t.prog + 24) % T.n] - T.y[t.prog];
  let runK = 0; // how far the road stays near-straight ahead
  for (let k = 2; k < 90; k += 2) { if (Math.abs(T.curv[at(k)]) > 0.02) break; runK = k; }
  const runM = runK * 0.5, need = 6 + speed * 1.1; // (room for the 0.35s wind-up and a good stretch at speed)
  const rivals0 = s.tops.filter((o) => o !== t && o.alive && !o.drone);
  const behind = rivals0.length > 0 && t.place > Math.max(1, Math.ceil((rivals0.length + 1) / 3));
  const lastLap = t.lap >= sim.cfg.target - 1;
  const banked = t.spin > 0.95;
  const floor = lastLap ? 0.16 : behind ? 0.32 : banked ? 0.45 : 0.5; // (spin we keep in reserve)
  const lead = !behind && t.place === 1 && !lastLap; // (the leader saves some for the fight)
  const roadOk = runM > need || (gapK >= 0 && gapK < 50) || (climb > 2.5 && straight);
  const keen = gapK >= 0 || climb > 2.5 || behind || banked || lastLap || (!lead && runM > need * 1.6);
  const bendNear = worst > 0.03 && worstK * 0.5 < 5 + speed * 0.7;
  if (ai.od) { if (bendNear || t.spin < floor - 0.08 || (!roadOk && gapK < 0)) ai.od = false; }
  else if (lv >= 2 || (lv === 1 && behind)) ai.od = t.grounded && roadOk && keen && !bendNear && t.spin > floor && Math.random() < dt * [0, 1.5, 4, 8][lv];
  c.hold = !!ai.od;
  if (c.hold && !t.od && t.dashCd <= 0 && t.grounded) c.dash = true;
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
