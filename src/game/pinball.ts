// Pinball: tilted playfields, smooth curved rails (walls), flippers, plungers, targets, portals.
// Rails and flippers are general arena features (any course can have them); a pinball table is a course with a
// tilt (gravity pulls toward the drain at the bottom, +z), rails forming the cabinet, and flipper markers.
import type { ArenaDef, Marker } from './terrain';

/** a wall along a smooth curve through `pts` (Catmull-Rom); kick > 0 makes it a slingshot that fires the ball off */
export interface Rail {
  pts: [number, number][];
  /** wall height (m) above the floor; default 1.3 */
  h?: number;
  /** wall thickness (m); default 0.45 */
  t?: number;
  closed?: boolean;
  /** slingshot: extra speed (m/s) added straight off the wall on contact */
  kick?: number;
  /** which face kicks: 1 / -1 = left / right of the drawing direction; default: the face toward the table's middle */
  kickSide?: 1 | -1;
  /** a one-way gate: balls moving toward this side (1 / -1 = left / right of the drawing direction) pass through */
  oneWay?: 1 | -1;
  /** (built, not saved) a flyover ramp's side wall: it stands on that ramp's deck, not the floor */
  deck?: PinRamp;
  /** (built, not saved) an arena gate: open while that arena marker is lit */
  gate?: number;
  /** (built, not saved) a flyover's underside skirt: stops balls rolling in under the low end (not balls on it) */
  below?: boolean;
}

const RAIL_STEP = 0.35;

/** sample a rail's smooth curve into a polyline */
export function railPolyline(r: Rail): [number, number][] {
  const P = r.pts;
  if (P.length < 2) return P.slice();
  const n = P.length, closed = !!r.closed && n > 2;
  const at = (i: number) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
  const out: [number, number][] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = at(i - 1), b = at(i), c = at(i + 1), d = at(i + 2);
    const len = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const K = Math.max(2, Math.ceil(len / RAIL_STEP));
    for (let k = 0; k < K; k++) {
      const t = k / K, t2 = t * t, t3 = t2 * t;
      const f = (p0: number, p1: number, p2: number, p3: number) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      out.push([f(a[0], b[0], c[0], d[0]), f(a[1], b[1], c[1], d[1])]);
    }
  }
  out.push(closed ? out[0] : P[n - 1]);
  return out;
}

/** a rail baked for fast distance queries */
/** (kx, kz): unit normal of the face that kicks (slingshots only kick from their front, like the rubber on a real one) */
export interface RailSeg { ax: number; az: number; bx: number; bz: number; h: number; half: number; kick: number; kx: number; kz: number; /** one-way gate: the direction balls may pass (0,0 = a normal wall) */ ox: number; oz: number; deck?: PinRamp; gate?: number; below?: boolean }
export function railSegments(rails: Rail[] | undefined): RailSeg[] {
  const out: RailSeg[] = [];
  for (const r of rails ?? []) {
    const pl = railPolyline(r);
    // the kicking face: chosen once per rail (its middle), toward the table's middle unless set
    const mid = pl[Math.floor(pl.length / 2)], a0 = pl[0], a1 = pl[pl.length - 1];
    let nx = -(a1[1] - a0[1]), nz = a1[0] - a0[0];
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const side = r.kickSide ?? (nx * -mid[0] + nz * -mid[1] >= 0 ? 1 : -1);
    nx *= side; nz *= side;
    for (let i = 0; i + 1 < pl.length; i++) {
      let ox = 0, oz = 0;
      if (r.oneWay) { const dx = pl[i + 1][0] - pl[i][0], dz = pl[i + 1][1] - pl[i][1], l = Math.hypot(dx, dz) || 1; ox = (-dz / l) * r.oneWay; oz = (dx / l) * r.oneWay; }
      out.push({ ax: pl[i][0], az: pl[i][1], bx: pl[i + 1][0], bz: pl[i + 1][1], h: r.h ?? 1.3, half: (r.t ?? 0.45) / 2, kick: r.kick ?? 0, kx: nx, kz: nz, ox, oz, deck: r.deck, gate: r.gate, below: r.below });
    }
  }
  return out;
}

export function segDist(s: { ax: number; az: number; bx: number; bz: number }, x: number, z: number) {
  const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz || 1;
  const u = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
  const cx = s.ax + dx * u, cz = s.az + dz * u;
  return { d: Math.hypot(x - cx, z - cz), cx, cz };
}

/** how much the rails raise the floor at (x, z): a wall with steep sides and a rounded top */
export function railHeightAt(segs: RailSeg[], x: number, z: number) {
  let h = 0;
  for (const s of segs) {
    const { d } = segDist(s, x, z);
    const edge = s.half + 0.1;
    if (d >= edge) continue;
    const v = d <= s.half ? s.h : s.h * smooth(1 - (d - s.half) / 0.1);
    if (v > h) h = v;
  }
  return h;
}
const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** the playfield's tilt: how much higher the floor is at z than at the bottom edge (zBottom) */
export function tiltLift(def: ArenaDef, z: number) {
  if (!def.tilt || !def.course) return 0;
  const zBottom = (def.course.h * def.course.tile) / 2;
  return def.tilt * (zBottom - z);
}

// ------------------------------------------------------------------ ramps
/**
 * A ramp: a smooth raised path that climbs `rise` metres from its start to a flat pad at its end, `w` wide, with
 * walls generated along both sides and round the pad (open only at the bottom). Lives in the floor itself (no
 * overlap needed): ride it up with enough speed, and whatever sits on the pad (a kickout, a rollover) is the prize.
 */
export interface PinRamp {
  pts: [number, number][]; w?: number; rise?: number;
  /**
   * a FLYOVER: an elevated deck on posts instead of a raised floor — balls roll underneath it (and under each
   * other: give crossing flyovers rises ≥1.8m apart). It climbs from the floor to `rise` over its first ~9m and
   * eases down to `end` over its last ~8m, then the ball drops off the end (aim the end over an inlane).
   */
  fly?: boolean;
  /** flyover: how high its far end is (default 1.8: high enough that balls pass under it) */
  end?: number;
  /** flyover: the speed it hands the ball off at its end, like a wire ramp's exit curve (default 7 m/s) */
  exit?: number;
  /** flyover: where (0..1 along it) the deck peaks — from there it eases all the way down to `end`, so a ball never
   * stops on a level stretch (a return ramp: peak at its U-turn) */
  peak?: number;
}

type RampGeo = { pl: [number, number][]; cum: number[]; total: number; x0: number; x1: number; z0: number; z1: number };
const rampCache = new WeakMap<PinRamp, RampGeo>();
function rampGeo(r: PinRamp): RampGeo {
  let c = rampCache.get(r);
  if (!c) {
    const pl = railPolyline({ pts: r.pts });
    let total = 0;
    const cum = [0];
    for (let i = 1; i < pl.length; i++) { total += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); cum.push(total); }
    const xs = pl.map((p) => p[0]), zs = pl.map((p) => p[1]);
    c = { pl, cum, total, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    rampCache.set(r, c);
  }
  return c;
}
/** nearest point on a ramp's path: distance from it and how far along (m) */
function rampNear(c: RampGeo, x: number, z: number) {
  let bd = Infinity, bs = 0;
  for (let i = 0; i + 1 < c.pl.length; i++) {
    const sg = { ax: c.pl[i][0], az: c.pl[i][1], bx: c.pl[i + 1][0], bz: c.pl[i + 1][1] };
    const { d, cx, cz } = segDist(sg, x, z);
    if (d < bd) { bd = d; bs = c.cum[i] + Math.hypot(cx - sg.ax, cz - sg.az); }
  }
  return { d: bd, s: bs };
}
/** a flyover's height above the floor `s` metres along it */
export function flyProfile(r: PinRamp, s: number, total: number) {
  const rise = r.rise ?? 3, end = r.end ?? 1.8;
  const up = Math.min(9, total * 0.3), dn = Math.min(8, total * 0.25);
  if (s < up) return rise * smooth(s / up);
  if (r.peak !== undefined) { const p = Math.max(up, r.peak * total); return s <= p ? rise : rise + (end - rise) * ((s - p) / Math.max(1e-3, total - p)); }
  if (s > total - dn) return rise + (end - rise) * smooth((s - (total - dn)) / dn);
  return rise;
}
/** a flyover's deck height above the floor at (x, z), or -1 when (x, z) isn't on its deck */
export function flyLift(r: PinRamp, x: number, z: number, slack = 0.45) {
  const c = rampGeo(r), half = (r.w ?? 3) / 2 + slack;
  if (x < c.x0 - half || x > c.x1 + half || z < c.z0 - half || z > c.z1 + half) return -1;
  const { d, s } = rampNear(c, x, z);
  return d <= half ? flyProfile(r, s, c.total) : -1;
}
/** a flyover's deck height at the point of its path nearest (x, z) (for its walls) */
export function flyLiftAlong(r: PinRamp, x: number, z: number) {
  const c = rampGeo(r);
  return flyProfile(r, rampNear(c, x, z).s, c.total);
}
/** a flyover's end: where it is, which way it points, and how long the ramp is */
export function flyEnd(r: PinRamp) {
  const c = rampGeo(r), b = c.pl[c.pl.length - 1], a = c.pl[Math.max(0, c.pl.length - 4)];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { x: b[0], z: b[1], dx: (b[0] - a[0]) / l, dz: (b[1] - a[1]) / l, total: c.total };
}

/** how far along a flyover (0..1) the point nearest (x, z) is */
export function flyAlong(r: PinRamp, x: number, z: number) {
  const c = rampGeo(r);
  return rampNear(c, x, z).s / (c.total || 1);
}
/** how much the ramps raise the floor at (x, z) */
export function rampLiftAt(ramps: PinRamp[] | undefined, x: number, z: number) {
  let best = 0;
  for (const r of ramps ?? []) {
    if (r.fly) continue; // (flyovers aren't part of the floor)
    const c = rampGeo(r);
    const { pl, cum, total } = c;
    const half = (r.w ?? 3) / 2, rise = r.rise ?? 1.8;
    // quick reject: nowhere near this ramp
    if (!pl.some((p) => Math.abs(p[0] - x) < half + 1 && Math.abs(p[1] - z) < half + 1)) continue;
    let bd = Infinity, bu = 0;
    for (let i = 0; i + 1 < pl.length; i++) {
      const sg = { ax: pl[i][0], az: pl[i][1], bx: pl[i + 1][0], bz: pl[i + 1][1] };
      const { d, cx, cz } = segDist(sg, x, z);
      if (d < bd) { bd = d; bu = (cum[i] + Math.hypot(cx - sg.ax, cz - sg.az)) / (total || 1); }
    }
    const end = pl[pl.length - 1];
    const pad = Math.hypot(x - end[0], z - end[1]) <= half + 0.6;
    if (bd <= half || pad) best = Math.max(best, pad ? rise : rise * smooth(Math.min(1, bu / 0.85)));
  }
  return best;
}

/** the walls along a ramp's sides and round its pad (tall enough to stand above the raised floor) */
export function rampRails(r: PinRamp): Rail[] {
  const pl = railPolyline({ pts: r.pts });
  const half = (r.w ?? 3) / 2 + 0.3, h = r.fly ? 1.3 : (r.rise ?? 1.8) + 1.3;
  const side = (sd: 1 | -1) => {
    const out: [number, number][] = [];
    for (let i = 0; i < pl.length; i += 3) {
      const a = pl[Math.max(0, i - 1)], b = pl[Math.min(pl.length - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      out.push([pl[i][0] - tz * half * sd, pl[i][1] + tx * half * sd]);
    }
    return out;
  };
  const L = side(1), R = side(-1);
  // a flyover: two walls standing on the deck, open at both ends (the ball drops off the far end)
  if (r.fly) {
    // where the climb reaches ball-clearance height, a skirt closes the underside (a ball rolling under the deck
    // would otherwise wedge into the low end)
    const c = rampGeo(r);
    let s = 0;
    while (s < c.total && flyProfile(r, s, c.total) < 1.9) s += 0.1;
    let i = c.cum.findIndex((v) => v >= s);
    if (i < 1) i = 1;
    const sk = [pl[i - 1], pl[Math.min(pl.length - 1, i + 1)]];
    let tx = sk[1][0] - sk[0][0], tz = sk[1][1] - sk[0][1];
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    // (a V pointing up the ramp, not a flat shelf, whose arms reach out past the side walls: a ball rolling down
    // underneath slides off it and out onto open floor, never into a corner)
    const p = pl[i], ap: [number, number] = [p[0] + tx * 1.6, p[1] + tz * 1.6], wide = half + 0.4;
    const skirt: Rail = { pts: [[p[0] - tz * wide - tx * 0.8, p[1] + tx * wide - tz * 0.8], ap, [p[0] + tz * wide - tx * 0.8, p[1] - tx * wide - tz * 0.8]], t: 0.3, deck: r, below: true };
    return [{ pts: [...L, edgeAt(pl, half, 1)], h, t: 0.35, deck: r }, { pts: [...R, edgeAt(pl, half, -1)], h, t: 0.35, deck: r }, skirt];
  }
  // close round the pad: a half circle from the left wall's end to the right wall's end, beyond the end point
  const end = pl[pl.length - 1], prev = pl[Math.max(0, pl.length - 4)];
  const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]), rad = half + 0.6;
  const cap: [number, number][] = [];
  for (let k = 0; k <= 6; k++) { const a = ang + Math.PI / 2 - (k / 6) * Math.PI; cap.push([end[0] + Math.cos(a) * rad, end[1] + Math.sin(a) * rad]); }
  return [{ pts: [...L, ...cap, ...R.reverse()], h, t: 0.4 }];
}

/**
 * An arena bowl's wall: a ring round the dish with an opening facing `rot` (default: down-table, toward the
 * flippers), closed by a gate that opens when the arena is unlocked. Light its drop bank (team) to open it; roll in
 * and a guardian blade drops in for a 1v1 battle.
 */
/** an arena bowl's ring: its radius (outside the stadium's curved wall), the gate's direction and half-angle */
/** link colours mean the same on every table: channels 1-4 cyan · orange · violet (kickbacks) · green, then a battle
 *  bowl's link pink and a drone hive's yellow */
export const LINK_COLORS = ['#3bd8ff', '#ff9a2b', '#c86bff', '#7dff5a'];
export const ARENA_LINK = '#ff4f8b', HIVE_LINK = '#ffe14a';
export interface PinLink { color: string; name: string; sources: number[]; targets: number[]; /** a link channel (else an arena / hive link) */ ch?: number }
/** what lights what on a table: link channels (arms → need), drop banks → their arena bowl, lane groups → their hive */
export function pinLinks(ms: Marker[]): PinLink[] {
  const idx = (f: (m: Marker) => boolean) => ms.map((m, i) => (f(m) ? i : -1)).filter((i) => i >= 0);
  const links: PinLink[] = [];
  const chans = [...new Set(ms.filter((m) => m.need !== undefined).map((m) => m.need!))].sort((a, b) => a - b);
  for (const ch of chans) {
    const targets = idx((m) => m.need === ch);
    links.push({ ch, color: LINK_COLORS[(ch + LINK_COLORS.length - 1) % LINK_COLORS.length], name: targets.length ? linkName(ms, ms[targets[0]]) : '', sources: idx((m) => m.arms === ch), targets });
  }
  ms.forEach((m, i) => {
    if (m.kind === 'arena') links.push({ color: ARENA_LINK, name: m.name ?? 'ARENA', sources: idx((q) => q.kind === 'drop' && (q.team ?? 0) === (m.team ?? 0)), targets: [i] });
    if (m.kind === 'hive') links.push({ color: HIVE_LINK, name: m.name ?? 'SWARM', sources: idx((q) => q.kind === 'rollover' && q.team === m.team), targets: [i] });
  });
  return links.filter((l) => l.sources.length && l.targets.length);
}
/** what a link shot is called when it lights */
export function linkName(ms: Marker[], m: Marker) {
  if (m.name) return m.name;
  if (m.kind === 'kickback') return 'KICKBACK';
  if (m.kind === 'portal') return 'PORTAL';
  return m.team !== undefined && ms.some((q) => q !== m && q.kind === 'saucer' && q.team === m.team) ? 'WORMHOLE' : 'LOCK';
}

export function arenaRing(m: Marker) {
  const R = (m.r ?? 6) + ARENA_WALL_W + 0.3;
  return { R, g: m.rot ?? Math.PI / 2, gap: 1.4 / R };
}
/** the width of an arena bowl's curved outer wall (the same as a stadium's) */
export const ARENA_WALL_W = 1.3;
/** the height of an arena bowl's lip above its rim (a stadium's curved wall, kept low so the ring round it is low) */
export const ARENA_LIP = 0.9;
export function arenaRails(m: Marker, mi: number): Rail[] {
  const { R, g, gap } = arenaRing(m);
  const ring: [number, number][] = [];
  for (let k = 0; k <= 16; k++) { const a = g + gap + (k / 16) * (Math.PI * 2 - 2 * gap); ring.push([m.x + Math.cos(a) * R, m.z + Math.sin(a) * R]); }
  const e = (a: number): [number, number] => [m.x + Math.cos(a) * R, m.z + Math.sin(a) * R];
  // (lip + the glass's 1.15m + a margin: no top can ever hop it)
  const h = ARENA_LIP + 1.35;
  return [{ pts: ring, h, t: 0.45 }, { pts: [e(g - gap), e(g + gap)], h, t: 0.3, gate: mi }];
}

/** the point `half` to one side of a polyline's last point */
function edgeAt(pl: [number, number][], half: number, sd: 1 | -1): [number, number] {
  const b = pl[pl.length - 1], a = pl[pl.length - 2];
  let tx = b[0] - a[0], tz = b[1] - a[1];
  const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
  return [b[0] - tz * half * sd, b[1] + tx * half * sd];
}

// ------------------------------------------------------------------ flippers
/** flipper marker: x,z pivot · len · rot = rest angle (rad, 0 = +x, π/2 = +z) · r = swing to the up position (signed) */
export const FLIP_UP_SPEED = 9; // rad/s (a 3.5m flipper's tip: ~31 m/s)
export const FLIP_DOWN_SPEED = 7;
export function flipperPose(m: Marker, ang: number) {
  const len = m.len ?? 3.4;
  return { ax: m.x, az: m.z, bx: m.x + Math.cos(ang) * len, bz: m.z + Math.sin(ang) * len, len };
}
/** is (x, z) inside the wedge a flipper sweeps from rest to fully up (widened by `margin`, e.g. a ball's radius)? */
export function inFlipperSweep(m: Marker, x: number, z: number, margin = 0.8) {
  const dx = x - m.x, dz = z - m.z, d = Math.hypot(dx, dz), len = m.len ?? 3.4;
  if (d > len + margin || d < 0.2) return false;
  const rest = m.rot ?? 0, sweep = m.r ?? -1, tol = Math.min(0.6, margin / d);
  const da = Math.atan2(Math.sin(Math.atan2(dz, dx) - rest), Math.cos(Math.atan2(dz, dx) - rest)); // (angle from the rest line)
  return sweep >= 0 ? da >= -tol && da <= sweep + tol : da <= tol && da >= sweep - tol;
}
/** half-thickness of a flipper at fraction u along it (fat at the pivot, slim at the tip) */
export const flipperHalf = (u: number) => 0.42 - 0.22 * u;
/** which flipper button works this flipper: left ones (pointing right, r < 0) vs right ones */
export const flipperSide = (m: Marker): 'L' | 'R' => ((m.r ?? -1) < 0 ? 'L' : 'R');

// ------------------------------------------------------------------ built-in tables
/**
 * A slingshot like a real one: a closed triangle — the kicking rubber face a→b toward the playfield, and two plain
 * walls b→c→a behind it so the ball can't get round the back.
 */
export function slingshot(a: [number, number], b: [number, number], c: [number, number], kick = 10): Rail[] {
  return [{ pts: [a, b], kick, t: 0.5 }, { pts: [b, c], t: 0.4 }, { pts: [c, a], t: 0.4 }];
}

const flat = (w: number, h: number) => {
  const pieces = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) pieces.push({ kind: 'flat' as const, x: i, y: j, rot: 0, level: 0 });
  return { tile: 6, w, h, pieces };
};
const NEON = { floor: '#120a2a', wall: '#3d1f6e', glow: '#3cf2ff', sky1: '#05030f', sky2: '#170a33', grid: '#5b3cff' };
const SYNTH = { floor: '#1b0820', wall: '#5c1a4a', glow: '#ff5cf4', sky1: '#090211', sky2: '#24061f', grid: '#ff2a8a' };

/**
 * The lower playfield, built mirror-symmetric about the playfield's REAL middle `xc` (the plunger lane takes the
 * right edge, so it isn't x = 0): on each side an inlane guide from the side wall down to its flipper, a closed
 * slingshot triangle above the guide with an inlane of `lane` metres between them (fed from above along the side
 * wall), and the flipper. `wallL` / `wallR` are the side walls' centre lines; `zF` the flipper pivots' row.
 */
export function lowerPlayfield(o: { wallL: number; wallR: number; zF: number; flip?: number; lane?: number; gap?: number; outlanes?: boolean | 'L' | 'R'; kickback?: 'L' | 'R' | 'both' }) {
  const len = o.flip ?? 3.5, lane = o.lane ?? 2.8, gap = o.gap ?? 2.4, rest = 0.48;
  const xc = (o.wallL + o.wallR) / 2;
  const off = gap / 2 + Math.cos(rest) * len; // pivot distance from the middle so the tips leave `gap`
  const rails: Rail[] = [], markers: Marker[] = [], problems: string[] = [];
  const corner: Record<string, [number, number]> = {};
  for (const sd of [-1, 1] as const) {
    const sideWall = sd < 0 ? o.wallL : o.wallR;
    const px = xc + sd * off, pz = o.zF;
    // outlanes: an outlane runs down beside the side wall to the drain; a divider separates it from the inlane
    const OUT = 2.3;
    const hasOut = o.outlanes === true || o.outlanes === (sd < 0 ? 'L' : 'R');
    const wallX = hasOut ? sideWall - sd * OUT : sideWall;
    if (hasOut) {
      rails.push({ pts: [[wallX, pz - 11], [wallX, pz - 7.2]], t: 0.4 });
      if (o.kickback === 'both' || o.kickback === (sd < 0 ? 'L' : 'R')) markers.push({ kind: 'kickback', x: sideWall - sd * OUT / 2, z: pz + 1.2, r: 0.9, rot: -Math.PI / 2, len: 30 });
    }
    // inlane guide: side wall (or the divider) → just outside the flipper pivot
    const g0: [number, number] = [wallX, pz - 7.2], g1: [number, number] = [px + sd * 0.15, pz - 0.15];
    rails.push({ pts: [g0, g1] });
    const slope = (g1[1] - g0[1]) / (g1[0] - g0[0]);
    const zg = (x: number) => g0[1] + (x - g0[0]) * slope;
    // the slingshot's corners sit at fixed x (3m in from the wall; 1m OUTSIDE the flipper pivot) and are lifted
    // straight up-table until the inlane between them and the guide is `lane` wide — they never drift inward
    const lift = (lane + 0.45) / Math.cos(Math.atan(Math.abs(slope)));
    const cx = wallX - sd * 3.0, bx = px + sd * 1.0;
    const c: [number, number] = [cx, zg(cx) - lift];
    const b: [number, number] = [bx, zg(bx) - lift];
    const a: [number, number] = [cx, c[1] - 4.6];
    rails.push(...slingshot(a, b, c));
    markers.push({ kind: 'flipper', x: px, z: pz, len, rot: sd < 0 ? rest : Math.PI - rest, r: sd < 0 ? -0.98 : 0.98 });
    corner[sd < 0 ? 'L' : 'R'] = b;
    const entry = Math.abs(cx - wallX) - 0.35 - 0.2;
    if (entry < 1.8) problems.push(`${sd < 0 ? 'left' : 'right'} inlane entrance only ${entry.toFixed(2)}m`);
  }
  const middle = corner.R[0] - corner.L[0] - 0.5;
  if (middle < 6) problems.push(`middle between the slingshots only ${middle.toFixed(2)}m`);
  return { rails, markers, xc, problems };
}

/** mirror a list of points left↔right */
const mx = (pts: [number, number][]) => pts.map(([x, z]) => [-x, z] as [number, number]);

/**
 * Neon Classic: 24 x 42 m (x -12..12, z -21 top .. +21 bottom). Arched top, plunger lane on the right, inlane
 * guides to the flippers, slingshots, three pop bumpers, a sweeping left orbit rail, a target bank, a spin pad.
 */
function neonClassic(): ArenaDef {
  const outer: [number, number][] = [[-11.5, 21], [-11.5, 6], [-11.5, -10], [-10.3, -16], [-6.4, -19.4], [0, -20.3], [6.4, -19.4], [10.3, -16], [11.5, -10], [11.5, 6], [11.5, 21]];
  const laneWall: [number, number][] = [[9.25, 20.8], [9.25, 4], [9.25, -9.5]];
  const low = lowerPlayfield({ wallL: -11.5, wallR: 9.25, zF: 16.5, flip: 3.5 });
  const xc = low.xc;
  const orbit: [number, number][] = [[-7.8, 4.5], [-8.3, -4], [-7.3, -11], [-4.6, -15.3]];
  return {
    id: 'pin-neon-classic', name: 'Neon Classic', desc: 'A classic table: plunger lane, slingshots, three pop bumpers, an orbit and a target bank. Light all targets for MULTIBALL.',
    theme: NEON, custom: false, pinball: true, tilt: 0.16,
    course: flat(4, 7),
    rails: [
      { pts: outer, h: 3, t: 0.7 },
      { pts: laneWall, h: 1.6 },
      { pts: [[9.25, 20.4], [11.5, 20.4]], h: 1.6 }, // plunger lane floor stop
      ...low.rails,
      { pts: orbit, h: 1.1 },
    ],
    markers: [
      { kind: 'spawn', x: 10.42, z: 18.6 },
      { kind: 'plunger', x: 10.42, z: 18.6, r: 1.1, len: 1 },
      ...low.markers,
      { kind: 'bumper', x: xc - 3.4, z: -8.2, r: 1.05 },
      { kind: 'bumper', x: xc + 3.4, z: -8.2, r: 1.05 },
      { kind: 'bumper', x: xc, z: -12.6, r: 1.05 },
      // (well clear of the arch: a ball must never be able to rest between a target and a wall)
      // targets stand alone: ≥3.3m from each other, the bumpers and the walls (a gap narrower than a ball is a
      // notch it settles into)
      { kind: 'target', x: 3.0, z: -14.0, r: 0.8, rot: 0.6 },
      { kind: 'target', x: 6.4, z: -11.0, r: 0.8, rot: 1.0 },
      { kind: 'target', x: -4.0, z: -11.6, r: 0.8, rot: -1.0 },
      { kind: 'target', x: -5.2, z: 2.6, r: 0.8, rot: -1.3 },
      // spin on a table comes from saucers (catch, spin up, kick out) and rollovers, not pads
      { kind: 'saucer', x: 7.3, z: -7.4, r: 1.1, rot: 2.4, len: 17 },
      { kind: 'rollover', x: -9.9, z: -2, r: 0.9 },
      { kind: 'rollover', x: 10.4, z: -6, r: 0.9 },
      { kind: 'rollover', x: 0, z: -17.6, r: 0.9 },
      { kind: 'item', x: xc, z: -2.6 },
    ],
  } as ArenaDef;
}

/**
 * Synth Cathedral: a wider 30 x 48 table with two flippers a side (an upper left flipper feeding the top), a
 * portal pair, a bumper triangle in the middle and a long right orbit.
 */
function synthCathedral(): ArenaDef {
  const outer: [number, number][] = [[-14.5, 24], [-14.5, 6], [-14.5, -12], [-13, -19], [-8, -22.4], [0, -23.3], [8, -22.4], [13, -19], [14.5, -12], [14.5, 6], [14.5, 24]];
  const laneWall: [number, number][] = [[12.3, 23.8], [12.3, 4], [12.3, -12]];
  const low = lowerPlayfield({ wallL: -14.5, wallR: 12.3, zF: 19.6, flip: 4.0 });
  const xc = low.xc;
  return {
    id: 'pin-synth-cathedral', name: 'Synth Cathedral', desc: 'A big table: an upper flipper, a portal pair, a bumper triangle and a long orbit. Light the targets for MULTIBALL.',
    theme: SYNTH, custom: false, pinball: true, tilt: 0.15,
    course: flat(5, 8),
    rails: [
      { pts: outer, h: 3, t: 0.7 },
      { pts: laneWall, h: 1.6 },
      { pts: [[12.3, 23.4], [14.5, 23.4]], h: 1.6 },
      ...low.rails,
      // right orbit: a long sweeping rail from the bottom right up around behind the bumpers
      { pts: [[8.6, 6], [9.2, -6], [8.2, -14.6], [4.4, -18.8]], h: 1.1 },
      // a short shelf under the upper-left flipper
      { pts: [[-14.6, -2], [-11.2, -0.4]] },
    ],
    markers: [
      { kind: 'spawn', x: 13.45, z: 21.6 },
      { kind: 'plunger', x: 13.45, z: 21.6, r: 1.1, len: 1.05 },
      ...low.markers,
      { kind: 'flipper', x: -11, z: -0.2, len: 3, rot: 0.3, r: -0.95 },
      { kind: 'bumper', x: xc - 3.6, z: -9.4, r: 1.1 },
      { kind: 'bumper', x: xc + 3.6, z: -9.4, r: 1.1 },
      { kind: 'bumper', x: xc, z: -14.2, r: 1.1 },
      { kind: 'portal', x: -10.5, z: -16.5, r: 1.1, team: 0 },
      { kind: 'portal', x: 0, z: 4, r: 1.1, team: 0, rot: Math.PI / 2 },
      { kind: 'target', x: -6.4, z: -19.6, r: 0.8, rot: -0.6 },
      { kind: 'target', x: -3.4, z: -21.2, r: 0.8, rot: -0.2 },
      { kind: 'target', x: 9.2, z: 2.6, r: 0.8, rot: 1.4 },
      { kind: 'target', x: -9.6, z: 6.8, r: 0.8, rot: -1.4 },
      { kind: 'saucer', x: -6.5, z: -4, r: 1.1, rot: 0.9, len: 17 },
      { kind: 'saucer', x: 6.5, z: -1, r: 1.1, rot: 2.3, len: 17 },
      { kind: 'rollover', x: 10.8, z: -4, r: 0.9 },
      { kind: 'rollover', x: 13.4, z: -9, r: 0.9 },
      { kind: 'rollover', x: 0, z: -20.6, r: 0.9 },
      { kind: 'item', x: 0, z: -4.5 },
    ],
  } as ArenaDef;
}

const COSMOS = { floor: '#0b1030', wall: '#1d2a6e', glow: '#62c8ff', sky1: '#02030a', sky2: '#0a1233', grid: '#3a6bff' };

/**
 * Star Cadet — the general shape of a classic space table, built from generic pieces:
 *  · plunger lane up the right, leaving through a one-way gate (a ball rarely gets back into the lane)
 *  · three re-entry lanes across the top (a rollover group) over a nest of three pop bumpers, a lone bumper left
 *  · a launch ramp centre-left climbing to a kickout; a hyperspace chute up the left; a fuel chute up the right
 *  · a booster drop-target bank on the right, a linked wormhole pair, a black-hole kickout on the left
 *  · flag rollovers above the drain, a center post that rises during ball save, outlanes with a left kickback
 */
function starCadet(): ArenaDef {
  const outer: [number, number][] = [[-14.5, 24], [-14.5, 6], [-14.5, -12], [-13, -19], [-8, -22.4], [0, -23.3], [8, -22.4], [13, -19], [14.5, -12], [14.5, 6], [14.5, 24]];
  const low = lowerPlayfield({ wallL: -14.5, wallR: 12.3, zF: 19.6, flip: 4.0, outlanes: 'L', kickback: 'L' }); // (the right side is an inlane: the fuel chute feeds the right flipper)
  const xc = low.xc;
  const lane = (x: number): Rail => ({ pts: [[x, -21.2], [x, -18.4]], t: 0.3, h: 1.1 }); // (a ~1.6-1.9m gap under the arch: a ball crossing the top can glance off their tops into the lanes)
  return {
    id: 'pin-star-cadet', name: 'Star Cadet', desc: 'A space table: re-entry lanes over the bumper nest, a launch ramp, hyperspace and fuel chutes, booster drop targets, linked wormholes, a kickback and a center post.',
    theme: COSMOS, custom: false, pinball: true, tilt: 0.15, inserts: [-2.6, 8.9],
    course: flat(5, 8),
    rails: [
      { pts: outer, h: 3, t: 0.7 },
      // plunger lane, and the one-way gate where it opens into the top (balls pass leftward only)
      { pts: [[12.3, 23.8], [12.3, 4], [12.3, -10], [11.6, -15.2]], h: 1.6 },
      { pts: [[12.3, 23.4], [14.5, 23.4]], h: 1.6 },
      { pts: [[11.6, -15.2], [12.5, -19.6]], h: 1.0, t: 0.3, oneWay: -1 },
      // three re-entry lanes across the top
      lane(xc - 3.3), lane(xc - 1.1), lane(xc + 1.1), lane(xc + 3.3),
      // hyperspace chute up the left (a corridor along the outer wall), fuel chute up the right (beside the lane)
      { pts: [[-10.6, 3], [-11.2, -6], [-10.4, -13.6], [-7.6, -18.4]], h: 1.2 },
      { pts: [[9.0, 4.5], [9.3, -5], [8.4, -11.6]], h: 1.2 },
      ...low.rails,
    ],
    ramps: [{ pts: [[xc - 2.0, 3.4], [xc - 3.4, -2.2], [xc - 5.0, -6.8]], w: 3, rise: 1.8 }],
    markers: [
      { kind: 'spawn', x: 13.45, z: 21.6 },
      { kind: 'plunger', x: 13.45, z: 21.6, r: 1.1, len: 1.05 },
      // (links: the re-entry lanes open the wormholes, the booster bank the black hole, the flag lanes the kickback)
      ...low.markers.map((m) => (m.kind === 'kickback' ? { ...m, need: 3 } : m)),
      { kind: 'post', x: xc, z: 22.2, r: 0.45 },
      // re-entry lanes (group 1) and the bumper nest below them
      { kind: 'rollover', x: xc - 2.2, z: -19.7, r: 0.8, team: 1, arms: 1, laneChange: true },
      { kind: 'rollover', x: xc, z: -19.7, r: 0.8, team: 1, arms: 1, laneChange: true },
      { kind: 'rollover', x: xc + 2.2, z: -19.7, r: 0.8, team: 1, arms: 1, laneChange: true },
      { kind: 'bumper', x: xc - 2.5, z: -14.8, r: 1.05 },
      { kind: 'bumper', x: xc + 2.5, z: -14.8, r: 1.05 },
      { kind: 'bumper', x: xc, z: -11.2, r: 1.05 },
      { kind: 'bumper', x: xc - 7.0, z: -12.2, r: 0.95 },
      // hyperspace chute lights (group 2), fuel chute lights (group 3)
      { kind: 'rollover', x: -12.8, z: -3, r: 0.85, team: 2 },
      { kind: 'rollover', x: -12.4, z: -11, r: 0.85, team: 2 },
      { kind: 'rollover', x: 10.75, z: -1, r: 0.8, team: 3 },
      { kind: 'rollover', x: 10.6, z: -8, r: 0.8, team: 3 },
      // the launch ramp's kickout (sends the ball back down the ramp)
      { kind: 'saucer', x: xc - 5.0, z: -6.8, r: 1.0, rot: 1.25, len: 13 },
      // booster drop targets (bank 0) on the right, facing the left flipper
      { kind: 'drop', x: 4.0, z: -0.6, r: 0.8, rot: 2.55, team: 0, arms: 2 },
      { kind: 'drop', x: 4.9, z: -2.0, r: 0.8, rot: 2.55, team: 0, arms: 2 },
      { kind: 'drop', x: 5.8, z: -3.4, r: 0.8, rot: 2.55, team: 0, arms: 2 },
      // wormholes: in one, out of the other
      { kind: 'saucer', x: 5.6, z: -9.6, r: 1.0, rot: 2.4, len: 15, team: 1, need: 1 },
      { kind: 'saucer', x: xc + 2.6, z: 6.6, r: 1.0, rot: -1.62, len: 15, team: 1, need: 1 }, // (straight up the middle, clear of the ramp)
      // black hole kickout on the left
      { kind: 'saucer', x: -8.2, z: 2.6, r: 1.0, rot: 1.05, len: 14, need: 2, name: 'BLACK HOLE' }, // (down toward the flippers, clear of the ramp wall)
      // flag rollovers above the drain (group 4)
      { kind: 'rollover', x: xc - 2.0, z: 11.0, r: 0.75, team: 4, arms: 3 },
      { kind: 'rollover', x: xc, z: 10.6, r: 0.75, team: 4, arms: 3 },
      { kind: 'rollover', x: xc + 2.0, z: 11.0, r: 0.75, team: 4, arms: 3 },
      { kind: 'item', x: xc + 1.6, z: -4.6 },
    ],
  } as ArenaDef;
}

const CYBER = { floor: '#03120e', wall: '#0b3a2c', glow: '#39ff9c', sky1: '#010605', sky2: '#04221a', grid: '#00e08f' };

/**
 * Swarm Protocol — laid out like a classic three-flipper machine (shots first, theme second):
 *  · SKILL LADDER: the launch runs across the top past three rollovers (low · mid · high). Each launch lights one;
 *    plunge so the ball gets exactly that far. Weak launches fall down the right orbit to the upper flipper, strong
 *    ones run on round the top-left
 *  · UPLINK (the right flipper's up-left shot): one smooth sweep up the left side, curving right over the
 *    top-left to drop the ball into the bumper nest
 *  · the CORE (center shot): knock down the FIREWALL in front of its gate, roll in, battle the guardian
 *  · UPPER RIGHT FLIPPER a third of the way up the right side, fed by the right orbit, with the TARGET LOCK right
 *    above it: flip into the lock, then aim across into the core gate, the firewall or the ramp
 *  · bumper nest under the top arch, drone bay, flag rollovers, kickback, center post
 */
function swarmProtocol(): ArenaDef {
  const outer: [number, number][] = [[-14.5, 24], [-14.5, 6], [-14.5, -12], [-13, -19], [-8, -22.4], [0, -23.3], [8, -22.4], [13, -19], [14.5, -12], [14.5, 6], [14.5, 24]];
  const low = lowerPlayfield({ wallL: -14.5, wallR: 12.3, zF: 19.6, flip: 4.0, outlanes: 'L', kickback: 'L' });
  const xc = low.xc;
  const C = { x: 1.6, z: -9.0 }, CORE_R = 3.6; // (with its lip and ring the core is ~10.4m across)
  return {
    id: 'pin-swarm-protocol', name: 'Swarm Protocol', desc: 'A cyber three-flipper table: a skill-ladder launch, a return ramp, an upper flipper feeding an aimable lock, a battle core behind a firewall and a drone swarm.',
    theme: CYBER, custom: false, pinball: true, tilt: 0.15, inserts: [-1.1, 6.2],
    course: flat(5, 8),
    rails: [
      { pts: outer, h: 3, t: 0.7 },
      { pts: [[12.3, 23.8], [12.3, 4], [12.3, -10], [11.6, -15.2]], h: 1.6 },
      { pts: [[12.3, 23.4], [14.5, 23.4]], h: 1.6 },
      { pts: [[11.6, -15.2], [12.5, -19.6]], h: 1.0, t: 0.3, oneWay: -1 },
      // right orbit: the lane down the right side onto the upper flipper
      { pts: [[8.9, -15.6], [9.2, -9.5], [9.0, -6.6]], h: 1.1, t: 0.35 },
      // the upper flipper's guide: off the wall onto the flipper (nothing wedges behind its pivot)
      { pts: [[12.1, -5.6], [11.2, -1.8]], h: 1.3, t: 0.4 },
      ...low.rails,
    ],
    ramps: [
      // UPLINK: mouth on the right flipper's up-left shot (≈-115°, x≈-7); one smooth sweep up the left side that
      // curves right over the top-left and drops the ball into the bumper nest (no hairpin)
      { pts: [[-7.0, 2.8], [-8.6, -3.5], [-9.4, -10], [-9.4, -15.0], [-8.0, -18.4], [-5.4, -19.8]], w: 1.7, rise: 3.5, fly: true, end: 1.8, exit: 6 },
    ],
    markers: [
      { kind: 'spawn', x: 13.45, z: 21.6 },
      { kind: 'plunger', x: 13.45, z: 21.6, r: 1.1, len: 0.54, speed: 17 },
      ...low.markers.map((m) => (m.kind === 'kickback' ? { ...m, need: 3 } : m)), // (the flag lanes light it, as on every table)
      { kind: 'post', x: xc, z: 22.2, r: 0.45 },
      // the skill ladder: three rollovers along the launch's run across the top
      { kind: 'rollover', x: 9.9, z: -19.4, r: 1.0, skill: 1 },
      { kind: 'rollover', x: 6.2, z: -21.3, r: 1.0, skill: 2 },
      { kind: 'rollover', x: 2.0, z: -22.1, r: 1.0, skill: 3 },
      // upper right flipper, a third of the way up the right side; the target lock right above it
      { kind: 'flipper', x: 11.0, z: -1.6, len: 3.2, rot: Math.PI - 0.5, r: 0.95 },
      { kind: 'saucer', x: 7.3, z: -5.6, r: 1.0, rot: 2.6, len: 22, aim: 0.45, hold: 7 },
      // bumper nest under the top arch
      { kind: 'bumper', x: -2.6, z: -17.6, r: 1.0 },
      { kind: 'bumper', x: 0.9, z: -18.4, r: 1.0 },
      { kind: 'bumper', x: C.x, z: C.z - CORE_R - 2.75, r: 0.9 }, // (on the core's rim: nothing rests up there)
      { kind: 'hive', x: -4.6, z: -20.6, r: 12, len: 5, team: 2, name: 'SWARM' },
      // the swarm: the ramp's rollover + the right orbit's (group 2)
      { kind: 'rollover', x: -9.4, z: -12.5, r: 1.0, team: 2, fly: true },
      { kind: 'rollover', x: 10.6, z: -10, r: 1.0, team: 2 },
      // the CORE (center shot) and its firewall bank (team 1) in front of the gate
      { kind: 'arena', x: C.x, z: C.z, r: CORE_R, rot: Math.PI / 2, team: 1, len: 1.8, game: 'random', name: 'CORE' },
      { kind: 'spinpad', x: C.x + 1.8, z: C.z, r: 0.85 },
      { kind: 'item', x: C.x - 1.8, z: C.z },
      { kind: 'drop', x: C.x - 1.6, z: -0.6, r: 0.75, rot: Math.PI / 2, team: 1 },
      { kind: 'drop', x: C.x, z: -0.6, r: 0.75, rot: Math.PI / 2, team: 1 },
      { kind: 'drop', x: C.x + 1.6, z: -0.6, r: 0.75, rot: Math.PI / 2, team: 1 },
      // flag rollovers above the drain (group 4)
      { kind: 'rollover', x: xc - 2.0, z: 11.0, r: 0.75, team: 4, arms: 3 },
      { kind: 'rollover', x: xc, z: 10.6, r: 0.75, team: 4, arms: 3 },
      { kind: 'rollover', x: xc + 2.0, z: 11.0, r: 0.75, team: 4, arms: 3 },
    ],
  } as ArenaDef;
}


/**
 * A starter table for the Course Builder: the cabinet, plunger lane and exit gate, the lower playfield (flippers,
 * slingshots, inlanes, outlanes with a kickback) and a few bumpers — the rest is yours to build.
 */
export function pinballStarter(): Pick<ArenaDef, 'course' | 'rails' | 'markers' | 'tilt' | 'pinball'> {
  const outer: [number, number][] = [[-11.5, 21], [-11.5, 6], [-11.5, -10], [-10.3, -16], [-6.4, -19.4], [0, -20.3], [6.4, -19.4], [10.3, -16], [11.5, -10], [11.5, 6], [11.5, 21]];
  const low = lowerPlayfield({ wallL: -11.5, wallR: 9.25, zF: 16.5, flip: 3.5, outlanes: true, kickback: 'L' });
  return {
    course: flat(4, 7), tilt: 0.15, pinball: true,
    rails: [
      { pts: outer, h: 3, t: 0.7 },
      { pts: [[9.25, 20.8], [9.25, 4], [9.25, -9.5]], h: 1.6 },
      { pts: [[9.25, 20.4], [11.5, 20.4]], h: 1.6 },
      ...low.rails,
    ],
    markers: [
      { kind: 'spawn', x: 10.42, z: 18.6 },
      { kind: 'plunger', x: 10.42, z: 18.6, r: 1.1, len: 1 },
      ...low.markers,
      { kind: 'post', x: low.xc, z: 19.2, r: 0.45 },
      { kind: 'bumper', x: low.xc - 3.2, z: -9, r: 1.0 },
      { kind: 'bumper', x: low.xc + 3.2, z: -9, r: 1.0 },
      { kind: 'bumper', x: low.xc, z: -13, r: 1.0 },
    ],
  };
}

export function pinballTables(): ArenaDef[] { return [starCadet(), swarmProtocol(), neonClassic(), synthCathedral()]; }
export const PINBALL_IDS = ['pin-star-cadet', 'pin-swarm-protocol', 'pin-neon-classic', 'pin-synth-cathedral'];
