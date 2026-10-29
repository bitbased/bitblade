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
export interface RailSeg { ax: number; az: number; bx: number; bz: number; h: number; half: number; kick: number; kx: number; kz: number }
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
    for (let i = 0; i + 1 < pl.length; i++) out.push({ ax: pl[i][0], az: pl[i][1], bx: pl[i + 1][0], bz: pl[i + 1][1], h: r.h ?? 1.3, half: (r.t ?? 0.45) / 2, kick: r.kick ?? 0, kx: nx, kz: nz });
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

// ------------------------------------------------------------------ flippers
/** flipper marker: x,z pivot · len · rot = rest angle (rad, 0 = +x, π/2 = +z) · r = swing to the up position (signed) */
export const FLIP_UP_SPEED = 9; // rad/s (a 3.5m flipper's tip: ~31 m/s)
export const FLIP_DOWN_SPEED = 7;
export function flipperPose(m: Marker, ang: number) {
  const len = m.len ?? 3.4;
  return { ax: m.x, az: m.z, bx: m.x + Math.cos(ang) * len, bz: m.z + Math.sin(ang) * len, len };
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
export function lowerPlayfield(o: { wallL: number; wallR: number; zF: number; flip?: number; lane?: number; gap?: number }) {
  const len = o.flip ?? 3.5, lane = o.lane ?? 2.8, gap = o.gap ?? 2.4, rest = 0.48;
  const xc = (o.wallL + o.wallR) / 2;
  const off = gap / 2 + Math.cos(rest) * len; // pivot distance from the middle so the tips leave `gap`
  const rails: Rail[] = [], markers: Marker[] = [], problems: string[] = [];
  const corner: Record<string, [number, number]> = {};
  for (const sd of [-1, 1] as const) {
    const wallX = sd < 0 ? o.wallL : o.wallR;
    const px = xc + sd * off, pz = o.zF;
    // inlane guide: side wall → just outside the flipper pivot
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

export function pinballTables(): ArenaDef[] { return [neonClassic(), synthCathedral()]; }
export const PINBALL_IDS = ['pin-neon-classic', 'pin-synth-cathedral'];
