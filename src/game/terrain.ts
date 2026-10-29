import { fillTrackHeights, sampleTrack, trackBounds, type TrackDef, type TrackSamples } from './track';

// Arena terrain: everything is a heightfield. Classic stadiums are procedural; skate-park courses are built from tiles.

export type PieceKind = 'flat' | 'bowl' | 'quarter' | 'half' | 'corner' | 'kicker' | 'spine' | 'hump' | 'ramp' | 'pit' | 'wall' | 'dome' | 'cradle'
  | 'bank' | 'pyramid' | 'volcano' | 'bumps' | 'stairs';

export const PIECES: Record<PieceKind, { label: string; desc: string }> = {
  flat: { label: 'Flat', desc: 'Plain deck' },
  bowl: { label: 'Bowl', desc: 'Round deep pool' },
  quarter: { label: 'Quarter Pipe', desc: 'Curved wall on one edge' },
  half: { label: 'Half Pipe', desc: 'Curved walls on two edges' },
  corner: { label: 'Corner', desc: 'Rounded pool corner' },
  kicker: { label: 'Kicker', desc: 'Launch ramp — get air!' },
  spine: { label: 'Spine', desc: 'Back-to-back transition' },
  hump: { label: 'Funbox', desc: 'Raised box with ramps' },
  ramp: { label: 'Ramp', desc: 'Connects to next level up' },
  pit: { label: 'Pit', desc: 'Hole — fall = ring out' },
  wall: { label: 'Rail Wall', desc: 'Low wall on one edge' },
  dome: { label: 'Dome', desc: 'Center bump' },
  cradle: { label: 'Cradle', desc: 'Shallow dish' },
  bank: { label: 'Bank', desc: 'Steep straight slope up to one edge' },
  pyramid: { label: 'Pyramid', desc: 'Four-sided launch box' },
  volcano: { label: 'Volcano', desc: 'Ring rim around a crater' },
  bumps: { label: 'Bumps', desc: 'Rolling waves — pump for speed' },
  stairs: { label: 'Stairs', desc: 'Three stepped ramps up to the next level' },
};

export interface Piece { kind: PieceKind; x: number; y: number; rot: number; level: number }

export type MarkerKind = 'spawn' | 'item' | 'bumper' | 'arm' | 'saw' | 'boost' | 'pillar' | 'spinpad' | 'flag' | 'gem' | 'zone' | 'checkpoint' | 'goal' | 'hive';
export interface Marker { kind: MarkerKind; x: number; z: number; rot?: number; team?: number; r?: number; len?: number; speed?: number }

export interface Theme { floor: string; wall: string; glow: string; sky1: string; sky2: string; grid: string }

export interface StadiumParams { radius: number; depth: number; wall: number; pockets: number; pocketWidth: number; sides: number; dome?: number }

export interface CourseDef { tile: number; w: number; h: number; pieces: Piece[] }

export interface ArenaDef {
  id: string;
  name: string;
  desc: string;
  theme: Theme;
  stadium?: StadiumParams;
  course?: CourseDef;
  track?: TrackDef;
  markers: Marker[];
  custom?: boolean;
}

export const VOID = -1000;

export class Terrain {
  minX: number; minZ: number; cell: number; nx: number; nz: number;
  h: Float32Array;
  def: ArenaDef;
  size: number; // rough span for camera
  track: TrackSamples | null = null;
  constructor(def: ArenaDef) {
    this.def = def;
    let extentX: number, extentZ: number;
    if (def.stadium) {
      const e = def.stadium.radius + 2.2;
      extentX = extentZ = e;
      this.cell = 0.18;
      this.minX = -e; this.minZ = -e;
    } else if (def.track) {
      const S = (this.track = sampleTrack(def.track));
      const b = trackBounds(S);
      this.cell = 0.3;
      this.minX = b.x0; this.minZ = b.z0;
      extentX = (b.x1 - b.x0) / 2; extentZ = (b.z1 - b.z0) / 2;
    } else {
      const c = def.course!;
      extentX = (c.w * c.tile) / 2 + 1;
      extentZ = (c.h * c.tile) / 2 + 1;
      this.cell = 0.22;
      this.minX = -extentX; this.minZ = -extentZ;
    }
    this.nx = Math.ceil((extentX * 2) / this.cell) + 1;
    this.nz = Math.ceil((extentZ * 2) / this.cell) + 1;
    this.size = Math.max(extentX, extentZ);
    this.h = new Float32Array(this.nx * this.nz);
    if (this.track) { fillTrackHeights(def.track!, this.track, this.minX, this.minZ, this.cell, this.nx, this.nz, this.h); return; }
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const x = this.minX + i * this.cell, z = this.minZ + j * this.cell;
        this.h[j * this.nx + i] = def.stadium ? stadiumHeight(def.stadium, x, z) : courseHeight(def.course!, x, z);
      }
  }

  raw(i: number, j: number) {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return VOID;
    return this.h[j * this.nx + i];
  }

  /** Bilinear height; returns VOID if any corner is void. */
  height(x: number, z: number): number {
    const fx = (x - this.minX) / this.cell, fz = (z - this.minZ) / this.cell;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = this.raw(i, j), b = this.raw(i + 1, j), c = this.raw(i, j + 1), d = this.raw(i + 1, j + 1);
    if (a <= VOID || b <= VOID || c <= VOID || d <= VOID) return VOID;
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  }

  /** Surface gradient (dh/dx, dh/dz). */
  gradient(x: number, z: number, out: { gx: number; gz: number }) {
    const e = this.cell * 0.75;
    const hx1 = this.height(x + e, z), hx0 = this.height(x - e, z);
    const hz1 = this.height(x, z + e), hz0 = this.height(x, z - e);
    const h0 = this.height(x, z);
    const fx1 = hx1 <= VOID ? h0 : hx1, fx0 = hx0 <= VOID ? h0 : hx0;
    const fz1 = hz1 <= VOID ? h0 : hz1, fz0 = hz0 <= VOID ? h0 : hz0;
    out.gx = (fx1 - fx0) / (2 * e);
    out.gz = (fz1 - fz0) / (2 * e);
    return out;
  }

  isSafe(x: number, z: number, margin = 1.2) {
    const h = this.height(x, z);
    if (h <= VOID) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const hh = this.height(x + Math.cos(a) * margin, z + Math.sin(a) * margin);
      if (hh <= VOID || Math.abs(hh - h) > 0.8) return false;
    }
    return true;
  }

  randomSafePoint(rnd: () => number, near?: { x: number; z: number; r: number }) {
    for (let k = 0; k < 400; k++) {
      let x: number, z: number;
      if (near) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * near.r;
        x = near.x + Math.cos(a) * r; z = near.z + Math.sin(a) * r;
      } else {
        x = this.minX + rnd() * (this.nx - 1) * this.cell;
        z = this.minZ + rnd() * (this.nz - 1) * this.cell;
      }
      if (this.isSafe(x, z)) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  /** Lowest-ish center to aim AI at for "stay safe" behaviour */
  center() {
    return { x: 0, z: 0 };
  }
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function polyRadius(R: number, sides: number, th: number) {
  if (sides < 3) return R;
  const seg = (Math.PI * 2) / sides;
  const a = ((th % seg) + seg) % seg - seg / 2;
  return (R * Math.cos(Math.PI / sides)) / Math.cos(a);
}

export function stadiumHeight(p: StadiumParams, x: number, z: number) {
  const th = Math.atan2(z, x);
  const R = polyRadius(p.radius, p.sides, th);
  const r = Math.hypot(x, z);
  const u = r / R;
  let floor = p.depth * (u * u * 0.85 + u * u * u * u * 0.15) - p.depth;
  if (p.dome && r < p.dome) floor += 0.35 * smooth(1 - r / p.dome) ;
  if (r <= R) return floor;
  // pockets
  if (p.pockets > 0) {
    const seg = (Math.PI * 2) / p.pockets;
    const a = (((th + seg / 2) % seg) + seg) % seg - seg / 2;
    if (Math.abs(a) * R < p.pocketWidth / 2) {
      if (r > R + 0.35) return VOID;
      return 0 - (r - R) * 0.6;
    }
  }
  const d = r - R;
  if (d < 0.55) return smooth(d / 0.55) * p.wall;
  if (d < 1.3) return p.wall;
  return VOID;
}

// ---- course tiles ----
const LEVEL_H = 1.6;

function arc(d: number, rho: number) {
  // circular transition: d in [0, rho] -> height
  const dd = Math.min(Math.max(d, 0), rho * 0.97);
  return rho - Math.sqrt(rho * rho - dd * dd);
}

/** height of a piece in local coords u,v in [0,1] (already rotated), tile size T */
function pieceHeight(kind: PieceKind, u: number, v: number, T: number): number {
  const rho = T * 0.42;
  switch (kind) {
    case 'flat': return 0;
    case 'quarter': return arc(v * T - (T - rho), rho) + (v > 0.985 ? 0.1 : 0);
    case 'half': return arc(v * T - (T - rho), rho) + arc((1 - v) * T - (T - rho), rho);
    case 'corner': {
      const px = Math.max(0, u * T - (T - rho)), pz = Math.max(0, v * T - (T - rho));
      return arc(Math.hypot(px, pz), rho);
    }
    case 'bowl': {
      const r = Math.hypot(u - 0.5, v - 0.5) * T;
      const inner = T * 0.5 - rho;
      return arc(r - inner, rho) - 0.6 * smooth(1 - r / inner);
    }
    case 'kicker': {
      if (v < 0.15 || v > 0.78) return 0;
      const t = (v - 0.15) / 0.63;
      return 1.5 * t * t;
    }
    case 'spine': {
      const t = 1 - Math.abs(v - 0.5) * 2;
      return 2.0 * t * t * t;
    }
    case 'hump': {
      const m = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
      return 1.1 * smooth((0.42 - m) / 0.2);
    }
    case 'dome': {
      const r = Math.hypot(u - 0.5, v - 0.5);
      return 0.9 * smooth(1 - r / 0.42);
    }
    case 'cradle': {
      const r = Math.hypot(u - 0.5, v - 0.5);
      return -0.8 * smooth(1 - r / 0.55);
    }
    case 'ramp': return LEVEL_H * smooth(v);
    case 'pit': return Math.hypot(u - 0.5, v - 0.5) < 0.24 ? VOID : 0;
    case 'wall': return v > 0.88 ? 1.4 * smooth((v - 0.88) / 0.08) : 0;
    case 'bank': return 2.4 * v; // ~22° straight slope, high edge at v=1
    case 'pyramid': {
      const m = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
      return 1.4 * Math.max(0, Math.min(1, (0.45 - m) / 0.3));
    }
    case 'volcano': {
      const r = Math.hypot(u - 0.5, v - 0.5);
      if (r < 0.26) return 0.35 + 1.15 * smooth(r / 0.26);
      if (r < 0.5) return 1.5 * smooth(1 - (r - 0.26) / 0.24);
      return 0;
    }
    case 'bumps': return 0.6 * (0.5 - 0.5 * Math.cos(v * Math.PI * 4));
    case 'stairs': {
      const t = Math.min(v * 3, 2.9999);
      const k = Math.floor(t);
      return (LEVEL_H / 3) * (k + smooth((t - k - 0.55) / 0.4));
    }
  }
}

export function courseHeight(c: CourseDef, x: number, z: number) {
  const T = c.tile;
  const gx = (x + (c.w * T) / 2) / T, gz = (z + (c.h * T) / 2) / T;
  const i = Math.floor(gx), j = Math.floor(gz);
  const p = pieceAt(c, i, j);
  if (!p) return VOID;
  let u = gx - i, v = gz - j;
  // rotate local coords; rot r means the "v=1 edge" faces +z rotated r*90deg
  for (let k = 0; k < (p.rot & 3); k++) {
    const nu = v, nv = 1 - u;
    u = nu; v = nv;
  }
  const h = pieceHeight(p.kind, u, v, T);
  if (h <= VOID) return VOID;
  return h + p.level * LEVEL_H;
}

export function pieceAt(c: CourseDef, i: number, j: number) {
  for (const p of c.pieces) if (p.x === i && p.y === j) return p;
  return undefined;
}

export function tileCenter(c: CourseDef, i: number, j: number) {
  return { x: (i + 0.5) * c.tile - (c.w * c.tile) / 2, z: (j + 0.5) * c.tile - (c.h * c.tile) / 2 };
}

// ---- themes & built-in arenas ----
export const THEMES: Record<string, Theme> = {
  neon: { floor: '#1b2340', wall: '#2c3b74', glow: '#3cf2ff', sky1: '#05060f', sky2: '#1a0b3a', grid: '#5f7bff' },
  inferno: { floor: '#2b1410', wall: '#5a1d10', glow: '#ff6a1f', sky1: '#0d0303', sky2: '#3a0f05', grid: '#ff9b4a' },
  toxic: { floor: '#13261a', wall: '#1f4a2a', glow: '#74ff5a', sky1: '#020a05', sky2: '#0b2a14', grid: '#9cff7a' },
  ice: { floor: '#2c6390', wall: '#163a5c', glow: '#7fe6ff', sky1: '#050d1a', sky2: '#1b3a5e', grid: '#bfefff' },
  concrete: { floor: '#4f525b', wall: '#3a3d45', glow: '#ff3db4', sky1: '#0f1018', sky2: '#3a2448', grid: '#c9cbd6' },
  sunset: { floor: '#3a1f3d', wall: '#5c2a4f', glow: '#ffb347', sky1: '#120617', sky2: '#5a1f3a', grid: '#ff9fd1' },
  tube: { floor: '#1b2a44', wall: '#2c4f7c', glow: '#ff8a1f', sky1: '#04060c', sky2: '#16223d', grid: '#7fa8ff' },
  royal: { floor: '#241433', wall: '#3d1f5c', glow: '#ffcc33', sky1: '#07030d', sky2: '#2a0d3d', grid: '#d6a2ff' },
};

const pc = (kind: PieceKind, x: number, y: number, rot = 0, level = 0): Piece => ({ kind, x, y, rot, level });

function ring(n: number, r: number, kind: MarkerKind, extra: Partial<Marker> = {}, phase = 0): Marker[] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * Math.PI * 2;
    return { kind, x: Math.cos(a) * r, z: Math.sin(a) * r, ...extra };
  });
}

/** Skate pool with walls all around: interior flat, quarters at edges, corners at corners */
function poolCourse(w: number, h: number, fill: (i: number, j: number) => Piece | null = () => null): Piece[] {
  const out: Piece[] = [];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const f = fill(i, j);
      if (f) { out.push(f); continue; }
      const L = i === 0, R = i === w - 1, T = j === 0, B = j === h - 1;
      // rot mapping: rot0 -> wall at +z (v=1), rot1 -> wall at -x? computed via rotation in courseHeight
      if (B && R) out.push(pc('corner', i, j, 0));
      else if (B && L) out.push(pc('corner', i, j, 1));
      else if (T && L) out.push(pc('corner', i, j, 2));
      else if (T && R) out.push(pc('corner', i, j, 3));
      else if (B) out.push(pc('quarter', i, j, 0));
      else if (L) out.push(pc('quarter', i, j, 1));
      else if (T) out.push(pc('quarter', i, j, 2));
      else if (R) out.push(pc('quarter', i, j, 3));
      else out.push(pc('flat', i, j));
    }
  return out;
}

export const BUILTIN_ARENAS: ArenaDef[] = [
  {
    id: 'neon-stadium', name: 'Neon Stadium', desc: 'Classic battle bowl with 3 ring-out pockets.', theme: THEMES.neon,
    stadium: { radius: 8.5, depth: 1.8, wall: 1.3, pockets: 3, pocketWidth: 3.2, sides: 0 },
    markers: [...ring(3, 4.5, 'item', {}, Math.PI / 3)],
  },
  {
    id: 'hex-colosseum', name: 'Hex Colosseum', desc: 'Six-sided arena, six pockets, bumpers and a center dome.', theme: THEMES.royal,
    stadium: { radius: 10.5, depth: 2.0, wall: 1.4, pockets: 6, pocketWidth: 2.4, sides: 6, dome: 2.2 },
    markers: [...ring(3, 6.2, 'bumper', { r: 0.7 }, Math.PI / 6), ...ring(3, 6.2, 'item', {}, Math.PI / 2), { kind: 'zone', x: 0, z: 0, r: 2.6 }],
  },
  {
    id: 'crater', name: 'Molten Crater', desc: 'Huge shallow crater with lava pillars. Great for free-for-alls.', theme: THEMES.inferno,
    stadium: { radius: 13, depth: 1.4, wall: 1.6, pockets: 4, pocketWidth: 2.6, sides: 0 },
    markers: [...ring(5, 7.5, 'pillar', { r: 0.8 }), ...ring(5, 4, 'item', {}, 0.6), ...ring(4, 10, 'spinpad', { r: 1.1 }, Math.PI / 4), { kind: 'zone', x: 0, z: 0, r: 3 }],
  },
  {
    id: 'kidney-pool', name: 'Kidney Pool', desc: 'Skate pool with deep transitions — ride the walls and catch air.', theme: THEMES.concrete,
    course: {
      tile: 6, w: 4, h: 3,
      pieces: poolCourse(4, 3, (i, j) => (i === 1 && j === 1 ? pc('cradle', i, j) : i === 2 && j === 1 ? pc('dome', i, j) : null)),
    },
    markers: [{ kind: 'item', x: -3, z: 0 }, { kind: 'item', x: 3, z: 0 }, { kind: 'zone', x: 0, z: 0, r: 2.5 }],
  },
  {
    id: 'ramp-park', name: 'Ramp Park', desc: 'Kickers, spine and funbox. Open edges — watch the drop!', theme: THEMES.neon,
    course: {
      tile: 6, w: 5, h: 4,
      pieces: [
        pc('corner', 0, 0, 2), pc('quarter', 1, 0, 2), pc('quarter', 2, 0, 2), pc('quarter', 3, 0, 2), pc('corner', 4, 0, 3),
        pc('quarter', 0, 1, 1), pc('kicker', 1, 1, 1), pc('flat', 2, 1), pc('kicker', 3, 1, 3), pc('quarter', 4, 1, 3),
        pc('quarter', 0, 2, 1), pc('flat', 1, 2), pc('spine', 2, 2, 1), pc('hump', 3, 2), pc('pit', 4, 2),
        pc('corner', 0, 3, 1), pc('flat', 1, 3), pc('flat', 2, 3), pc('kicker', 3, 3, 2), pc('flat', 4, 3),
      ],
    },
    markers: [{ kind: 'item', x: 0, z: -6 }, { kind: 'item', x: -9, z: 3 }, { kind: 'item', x: 9, z: 3 }, { kind: 'boost', x: -3, z: 9, rot: 0 }, { kind: 'zone', x: 0, z: 0, r: 2.5 }],
  },
  {
    id: 'twin-forts', name: 'Twin Forts', desc: 'Symmetric CTF course: two walled bases joined by a half-pipe.', theme: THEMES.toxic,
    course: {
      tile: 6, w: 6, h: 3,
      pieces: [
        pc('corner', 0, 0, 2), pc('quarter', 1, 0, 2), pc('quarter', 2, 0, 2), pc('quarter', 3, 0, 2), pc('quarter', 4, 0, 2), pc('corner', 5, 0, 3),
        pc('quarter', 0, 1, 1), pc('flat', 1, 1), pc('hump', 2, 1), pc('hump', 3, 1), pc('flat', 4, 1), pc('quarter', 5, 1, 3),
        pc('corner', 0, 2, 1), pc('quarter', 1, 2, 0), pc('pit', 2, 2), pc('pit', 3, 2), pc('quarter', 4, 2, 0), pc('corner', 5, 2, 0),
      ],
    },
    markers: [
      { kind: 'flag', x: -15, z: 0, team: 0 }, { kind: 'flag', x: 15, z: 0, team: 1 },
      { kind: 'spawn', x: -13, z: -3, team: 0 }, { kind: 'spawn', x: -13, z: 3, team: 0 },
      { kind: 'spawn', x: 13, z: -3, team: 1 }, { kind: 'spawn', x: 13, z: 3, team: 1 },
      { kind: 'item', x: 0, z: -4 }, { kind: 'item', x: -6, z: 0 }, { kind: 'item', x: 6, z: 0 },
      { kind: 'boost', x: -6, z: -4, rot: Math.PI / 2 }, { kind: 'boost', x: 6, z: -4, rot: -Math.PI / 2 },
    ],
  },
  {
    id: 'gauntlet-works', name: 'Gauntlet Works', desc: 'Automated factory floor: sweeping arms, saws, bumpers and pits.', theme: THEMES.inferno,
    course: {
      tile: 6, w: 5, h: 5,
      pieces: poolCourse(5, 5, (i, j) => (i === 2 && j === 2 ? pc('dome', i, j) : (i === 1 && j === 3) || (i === 3 && j === 1) ? pc('pit', i, j) : null)),
    },
    markers: [
      { kind: 'arm', x: -6, z: -6, len: 4.2, speed: 1.1 }, { kind: 'arm', x: 6, z: 6, len: 4.2, speed: -1.3 },
      { kind: 'saw', x: 0, z: 0, r: 5.5, speed: 0.6 }, { kind: 'saw', x: 0, z: 0, r: 9, speed: -0.4 },
      { kind: 'bumper', x: -6, z: 6, r: 0.9 }, { kind: 'bumper', x: 6, z: -6, r: 0.9 },
      { kind: 'boost', x: 0, z: 9, rot: 0 }, { kind: 'boost', x: 0, z: -9, rot: Math.PI },
      { kind: 'spinpad', x: -9, z: 0, r: 1.2 }, { kind: 'spinpad', x: 9, z: 0, r: 1.2 },
      { kind: 'item', x: 0, z: 4 }, { kind: 'item', x: 0, z: -4 },
      { kind: 'spawn', x: 0, z: 11 },
    ],
  },
];

/** obstacle placed along a race track: f = lap fraction, lat = -1..1 across the road (left..right) */
export interface TrackObstacle { f: number; kind: 'arm' | 'saw' | 'bumper' | 'pillar' | 'spinpad'; lat?: number; speed?: number; size?: number }

function trackArena(id: string, name: string, desc: string, theme: Theme, track: TrackDef, obstacles: TrackObstacle[] = []): ArenaDef {
  const S = sampleTrack(track);
  const markers: Marker[] = [];
  const at = (f: number) => Math.floor((((f % 1) + 1) % 1) * S.n);
  // boost strips span most of the road so they're easy to hit (narrower down the bottom of a pipe)
  for (const f of track.boosts) { const i = at(f); markers.push({ kind: 'boost', x: S.x[i], z: S.z[i], rot: Math.atan2(S.tx[i], S.tz[i]), r: track.width * (track.profile === 'pipe' ? 0.2 : 0.36) }); }
  for (const f of track.items) {
    const i = at(f);
    for (const o of [-0.3, 0, 0.3]) markers.push({ kind: 'item', x: S.x[i] - S.tz[i] * o * track.width, z: S.z[i] + S.tx[i] * o * track.width });
  }
  // obstacles: positions are relative to the road so they always sit on the ribbon
  const half = track.width / 2;
  // every track gets spin pads in the edge lanes (or the pipe floor), clear of boosts, item rows and jumps
  const havePads = obstacles.filter((o) => o.kind === 'spinpad').length;
  if (havePads < 3) {
    const busy = [...track.boosts, ...track.items, ...track.gaps.flat(), ...obstacles.map((o) => o.f)];
    const near = (f: number) => busy.some((b) => Math.min(Math.abs(b - f), 1 - Math.abs(b - f)) < 0.035);
    [0.2, 0.52, 0.84].slice(0, 3 - havePads).forEach((f0, k) => {
      let f = f0;
      for (let n = 0; n < 12 && near(f); n++) f = (f + 0.02) % 1;
      obstacles = [...obstacles, { f, kind: 'spinpad', lat: track.profile === 'pipe' ? 0 : k % 2 ? -0.55 : 0.55, size: 1.4 }];
    });
  }
  for (const o of obstacles) {
    const i = at(o.f);
    const lat = (o.lat ?? 0) * half;
    const x = S.x[i] - S.tz[i] * lat, z = S.z[i] + S.tx[i] * lat;
    switch (o.kind) {
      case 'arm': {
        // pivot just inside one edge, sweeping across the road
        const side = (o.lat ?? 1) >= 0 ? 1 : -1;
        const px = S.x[i] - S.tz[i] * (half - 0.5) * side, pz = S.z[i] + S.tx[i] * (half - 0.5) * side;
        markers.push({ kind: 'arm', x: px, z: pz, len: o.size ?? track.width * 0.8, speed: o.speed ?? 1.2, rot: Math.atan2(-S.tx[i] * side, S.tz[i] * side) });
        break;
      }
      case 'saw': markers.push({ kind: 'saw', x, z, r: o.size ?? track.width * 0.28, speed: o.speed ?? 1.1 }); break;
      case 'bumper': markers.push({ kind: 'bumper', x, z, r: o.size ?? 0.8 }); break;
      case 'pillar': markers.push({ kind: 'pillar', x, z, r: o.size ?? 0.7 }); break;
      case 'spinpad': markers.push({ kind: 'spinpad', x, z, r: o.size ?? 1.4 }); break;
    }
  }
  // starting grid behind the line
  for (let k = 0; k < 8; k++) {
    const i = (S.n - 6 - Math.floor(k / 2) * 6) % S.n;
    const o = (k % 2 ? 0.22 : -0.22) * track.width;
    markers.push({ kind: 'spawn', x: S.x[i] - S.tz[i] * o, z: S.z[i] + S.tx[i] * o });
  }
  return { id, name, desc, theme, track, markers };
}

BUILTIN_ARENAS.push(
  trackArena('neon-circuit', 'Neon Circuit', 'Floating speedway: banked sweepers, a hill jump and boost strips.', THEMES.neon, {
    width: 10,
    pts: [[0, -32, 0], [26, -32, 0], [42, -22, 1], [44, 0, 3], [34, 16, 4], [16, 19, 2], [6, 31, 1], [-16, 34, 0], [-36, 24, 0], [-42, 2, 1.5], [-32, -18, 0.5], [-16, -31, 0]],
    rails: [[0.08, 0.28], [0.4, 0.64], [0.72, 0.94]],
    gaps: [[0.335, 0.348]],
    boosts: [0.04, 0.31, 0.68, 0.95],
    items: [0.18, 0.52, 0.82],
  }),
  trackArena('sky-serpent', 'Sky Serpent', 'Twisting sky road with hairpins, two jumps and very few rails.', THEMES.royal, {
    width: 9,
    pts: [[0, -40, 0], [30, -38, 1], [48, -20, 3], [42, 4, 5], [22, 10, 4], [10, -4, 3], [-6, 6, 2], [0, 25, 1], [24, 32, 2], [30, 48, 1], [6, 56, 0], [-24, 48, 1], [-45, 26, 2.5], [-46, 0, 1.5], [-34, -26, 0]],
    rails: [[0.18, 0.32], [0.36, 0.46], [0.53, 0.64], [0.8, 0.88]],
    gaps: [[0.13, 0.139], [0.7, 0.709]],
    boosts: [0.03, 0.12, 0.4, 0.69, 0.9],
    items: [0.22, 0.48, 0.78],
  }),
);

// ---- large arenas ----
function tc(w: number, h: number, i: number, j: number, T = 6) {
  return { x: (i + 0.5) * T - (w * T) / 2, z: (j + 0.5) * T - (h * T) / 2 };
}
const at = (kind: MarkerKind, w: number, h: number, i: number, j: number, extra: Partial<Marker> = {}): Marker => ({ kind, ...tc(w, h, i, j), ...extra });

BUILTIN_ARENAS.push(
  {
    id: 'mega-bowl', name: 'Mega Bowl Complex', desc: 'Huge walled pool: sunken bowls, domes, a spine and kickers.', theme: THEMES.concrete,
    course: {
      tile: 6, w: 7, h: 5,
      pieces: poolCourse(7, 5, (i, j) => {
        const m: Record<string, Piece> = {
          '1,1': pc('bowl', 1, 1), '5,1': pc('bowl', 5, 1), '3,2': pc('dome', 3, 2), '3,1': pc('cradle', 3, 1),
          '2,3': pc('hump', 2, 3), '4,3': pc('hump', 4, 3), '4,1': pc('spine', 4, 1, 1), '2,1': pc('spine', 2, 1, 1),
          '1,3': pc('kicker', 1, 3, 3), '5,3': pc('kicker', 5, 3, 1),
        };
        return m[`${i},${j}`] ?? null;
      }),
    },
    markers: [at('item', 7, 5, 2, 2), at('item', 7, 5, 4, 2), at('item', 7, 5, 3, 3), at('item', 7, 5, 3, 0, { z: -10 }), { kind: 'zone', x: 0, z: 0, r: 3 }, at('spinpad', 7, 5, 1, 2, { r: 1.2 }), at('spinpad', 7, 5, 5, 2, { r: 1.2 })],
  },
  {
    id: 'ramp-park-xl', name: 'Ramp Park XL', desc: 'Giant park with a raised plateau, ramps up, cliffs down, kickers and pits.', theme: THEMES.neon,
    course: {
      tile: 6, w: 8, h: 6,
      pieces: [
        pc('corner', 0, 0, 2), pc('quarter', 1, 0, 2), pc('quarter', 2, 0, 2), pc('quarter', 3, 0, 2), pc('quarter', 4, 0, 2, 1), pc('quarter', 5, 0, 2, 1), pc('quarter', 6, 0, 2, 1), pc('corner', 7, 0, 3, 1),
        pc('quarter', 0, 1, 1), pc('flat', 1, 1), pc('dome', 2, 1), pc('flat', 3, 1), pc('flat', 4, 1, 0, 1), pc('hump', 5, 1, 0, 1), pc('flat', 6, 1, 0, 1), pc('quarter', 7, 1, 3, 1),
        pc('quarter', 0, 2, 1), pc('kicker', 1, 2, 0), pc('spine', 2, 2, 0), pc('flat', 3, 2), pc('flat', 4, 2, 0, 1), pc('flat', 5, 2, 0, 1), pc('kicker', 6, 2, 0, 1), pc('quarter', 7, 2, 3, 1),
        pc('quarter', 0, 3, 1), pc('flat', 1, 3), pc('flat', 2, 3), pc('pit', 3, 3), pc('ramp', 4, 3, 2), pc('ramp', 5, 3, 2), pc('flat', 6, 3), pc('quarter', 7, 3, 3),
        pc('quarter', 0, 4, 1), pc('hump', 1, 4), pc('kicker', 2, 4, 1), pc('flat', 3, 4), pc('flat', 4, 4), pc('cradle', 5, 4), pc('bowl', 6, 4), pc('quarter', 7, 4, 3),
        pc('corner', 0, 5, 1), pc('quarter', 1, 5, 0), pc('quarter', 2, 5, 0), pc('flat', 3, 5), pc('quarter', 4, 5, 0), pc('quarter', 5, 5, 0), pc('quarter', 6, 5, 0), pc('corner', 7, 5, 0),
      ],
    },
    markers: [at('item', 8, 6, 5, 2), at('item', 8, 6, 1, 1), at('item', 8, 6, 3, 4), at('item', 8, 6, 6, 3), at('boost', 8, 6, 3, 2, { rot: Math.PI }), at('boost', 8, 6, 1, 3, { rot: 0 }), { kind: 'zone', ...tc(8, 6, 5, 1), r: 3 }],
  },
  {
    id: 'twin-forts-xl', name: 'Twin Forts XL', desc: 'Long CTF battlefield: walled bases, mid-field humps, pits and a spine.', theme: THEMES.toxic,
    course: {
      tile: 6, w: 10, h: 4,
      pieces: poolCourse(10, 4, (i, j) => {
        if ((i === 3 || i === 6) && (j === 1 || j === 2)) return pc('hump', i, j);
        if ((i === 4 || i === 5) && j === 1) return pc('pit', i, j);
        if ((i === 4 || i === 5) && j === 2) return pc('spine', i, j, 1);
        if (i === 2 && j === 2) return pc('kicker', i, j, 1);
        if (i === 7 && j === 1) return pc('kicker', i, j, 3);
        return null;
      }),
    },
    markers: [
      { kind: 'flag', ...tc(10, 4, 1, 1), z: 0, team: 0 }, { kind: 'flag', ...tc(10, 4, 8, 1), z: 0, team: 1 },
      at('spawn', 10, 4, 1, 1, { team: 0 }), at('spawn', 10, 4, 1, 2, { team: 0 }), at('spawn', 10, 4, 2, 1, { team: 0 }), at('spawn', 10, 4, 2, 2, { team: 0 }),
      at('spawn', 10, 4, 8, 1, { team: 1 }), at('spawn', 10, 4, 8, 2, { team: 1 }), at('spawn', 10, 4, 7, 1, { team: 1 }), at('spawn', 10, 4, 7, 2, { team: 1 }),
      { kind: 'item', x: 0, z: 9 }, { kind: 'item', x: -9, z: -9 }, { kind: 'item', x: 9, z: -9 }, { kind: 'item', x: 0, z: -9 },
      { kind: 'boost', x: -12, z: 9, rot: Math.PI / 2 }, { kind: 'boost', x: 12, z: 9, rot: -Math.PI / 2 },
    ],
  },
  {
    id: 'gauntlet-mega', name: 'Gauntlet Megaworks', desc: 'Massive automated factory: four sweepers, orbiting saws, bumper fields and pits.', theme: THEMES.inferno,
    course: {
      tile: 6, w: 7, h: 7,
      pieces: poolCourse(7, 7, (i, j) => (i === 3 && j === 3 ? pc('dome', i, j) : (i + j) % 4 === 0 && i > 0 && j > 0 && i < 6 && j < 6 && !(i === 3 && j === 3) ? pc('pit', i, j) : null)),
    },
    markers: [
      { kind: 'arm', x: -9, z: -9, len: 5, speed: 1.0 }, { kind: 'arm', x: 9, z: 9, len: 5, speed: -1.2 }, { kind: 'arm', x: 9, z: -9, len: 5, speed: 0.9 }, { kind: 'arm', x: -9, z: 9, len: 5, speed: -0.8 },
      { kind: 'saw', x: 0, z: 0, r: 6, speed: 0.6 }, { kind: 'saw', x: 0, z: 0, r: 12, speed: -0.35 }, { kind: 'saw', x: 0, z: 0, r: 12, speed: -0.35, rot: Math.PI },
      ...ring(6, 15, 'bumper', { r: 0.9 }, 0.3), ...ring(4, 4, 'spinpad', { r: 1.1 }, Math.PI / 4),
      { kind: 'boost', x: 0, z: 16, rot: Math.PI / 2 }, { kind: 'boost', x: 0, z: -16, rot: -Math.PI / 2 },
      { kind: 'item', x: 6, z: 0 }, { kind: 'item', x: -6, z: 0 }, { kind: 'item', x: 0, z: 9 },
      { kind: 'spawn', x: 0, z: 17 },
    ],
  },
  {
    id: 'titan-colosseum', name: 'Titan Colosseum', desc: 'Enormous eight-sided bowl for 8-player brawls: pillars, bumpers and spin pads.', theme: THEMES.royal,
    stadium: { radius: 19.5, depth: 2.6, wall: 1.7, pockets: 8, pocketWidth: 3, sides: 8, dome: 3 },
    markers: [...ring(8, 11, 'pillar', { r: 0.9 }, Math.PI / 8), ...ring(4, 6, 'bumper', { r: 0.8 }), ...ring(4, 15, 'spinpad', { r: 1.2 }), ...ring(6, 8.5, 'item', {}, 0.4), { kind: 'zone', x: 0, z: 0, r: 3.5 }],
  },
);

BUILTIN_ARENAS.push(
  trackArena('crystal-canyon', 'Crystal Canyon', 'Long canyon run: pillar chicane, bumper field, a big hill jump and a spin-recharge pit pad.', THEMES.toxic, {
    width: 9,
    pts: [[0, -45, 0], [35, -48, 1], [60, -30, 2], [62, 0, 4], [45, 20, 5], [20, 15, 3], [5, 30, 2], [15, 50, 1], [-10, 62, 0], [-40, 55, 1], [-55, 30, 2], [-40, 10, 3], [-55, -15, 2], [-35, -38, 0]],
    rails: [[0.1, 0.2], [0.33, 0.42], [0.52, 0.6], [0.7, 0.8]],
    gaps: [[0.265, 0.275]],
    boosts: [0.03, 0.25, 0.62, 0.9],
    items: [0.15, 0.47, 0.75],
  }, [
    { f: 0.44, kind: 'pillar', lat: 0.45 }, { f: 0.46, kind: 'pillar', lat: -0.45 }, { f: 0.48, kind: 'pillar', lat: 0.45 },
    { f: 0.66, kind: 'bumper', lat: -0.5 }, { f: 0.675, kind: 'bumper', lat: 0.4 }, { f: 0.69, kind: 'bumper', lat: -0.2 },
    { f: 0.85, kind: 'spinpad', lat: 0.5 },
  ]),
  trackArena('inferno-gauntlet', 'Inferno Gauntlet', 'Obstacle course on rails: sweeping arms, saws on the racing line, bumpers and a final jump.', THEMES.inferno, {
    width: 10,
    pts: [[0, -40, 0], [40, -40, 0], [55, -20, 1], [50, 10, 2], [25, 20, 2], [0, 15, 1], [-25, 25, 2], [-45, 10, 1], [-50, -20, 0], [-30, -38, 0]],
    rails: [[0.0, 0.1], [0.11, 0.3], [0.33, 0.6], [0.6, 0.82]],
    gaps: [[0.865, 0.875]],
    boosts: [0.05, 0.5, 0.84],
    items: [0.24, 0.62],
  }, [
    { f: 0.14, kind: 'arm', lat: 1, speed: 1.3 }, { f: 0.35, kind: 'saw', speed: 1.2 }, { f: 0.4, kind: 'arm', lat: -1, speed: -1.1 },
    { f: 0.55, kind: 'saw', speed: -1.0 }, { f: 0.505, kind: 'bumper', lat: 0.4 }, { f: 0.51, kind: 'bumper', lat: -0.4 },
    { f: 0.72, kind: 'arm', lat: 1, speed: 1.5 }, { f: 0.97, kind: 'spinpad', lat: -0.4 },
  ]),
  trackArena('frost-byte', 'Frost Byte', 'Fast frozen oval: three jumps, boost strips into every one, bumpers on the straights.', THEMES.ice, {
    width: 9,
    pts: [[0, -30, 0], [50, -30, 0], [70, -10, 1], [70, 15, 2], [50, 35, 3], [0, 35, 3], [-50, 35, 2], [-70, 15, 1], [-70, -10, 0], [-50, -30, 0]],
    rails: [[0.13, 0.42], [0.62, 0.9]],
    gaps: [[0.075, 0.083], [0.45, 0.458], [0.93, 0.938]],
    boosts: [0.055, 0.43, 0.91],
    items: [0.2, 0.55, 0.75],
  }, [
    { f: 0.37, kind: 'bumper', lat: 0.4 }, { f: 0.39, kind: 'bumper', lat: -0.4 }, { f: 0.87, kind: 'bumper', lat: 0 },
  ]),
);

/**
 * Trefoil knot: three lobes, three flat X-crossings, roller-coaster hills in between.
 * Crossings are found numerically; the road dips to the same height at each one, and rails skip them.
 */
function trefoilTrack(): ArenaDef {
  const Rk = 17, N = 720, CTRL = 54, H = 6.5;
  const pos = (t: number): [number, number] => [Rk * (Math.sin(t) + 2 * Math.sin(2 * t)), Rk * (Math.cos(t) - 2 * Math.cos(2 * t))];
  // crossing parameters: pairs far apart along the curve but (almost) touching in space
  const crossT: number[] = [];
  for (let i = 0; i < N; i++) for (let j = i + 60; j < N; j++) {
    if (N - (j - i) < 60) continue;
    const a = pos((i / N) * Math.PI * 2), b = pos((j / N) * Math.PI * 2);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.9) for (const k of [i, j]) { const t = (k / N) * Math.PI * 2; if (!crossT.some((c) => Math.abs(c - t) < 0.2)) crossT.push(t); }
  }
  const dT = (a: number, b: number) => { const d = Math.abs(a - b) % (Math.PI * 2); return Math.min(d, Math.PI * 2 - d); };
  const flat = (t: number) => Math.min(1, ...crossT.map((c) => { const x = Math.max(0, Math.min(1, (dT(t, c) - 0.1) / 0.45)); return x * x * (3 - 2 * x); }));
  const elev = (t: number) => H * flat(t) * (0.55 + 0.45 * Math.sin(t * 3 + 0.6) ** 2);
  const t0 = crossT.length ? crossT[0] + 0.55 : 0; // start between crossings
  const pts: [number, number, number][] = [];
  for (let k = 0; k < CTRL; k++) { const t = t0 + (k / CTRL) * Math.PI * 2; const [x, z] = pos(t); pts.push([x, z, elev(t)]); }
  // rails everywhere except near crossings (as lap fractions)
  const rails: [number, number][] = [];
  let open = -1;
  for (let k = 0; k <= 200; k++) {
    const f = k / 200, t = t0 + f * Math.PI * 2;
    const nearX = crossT.some((c) => dT(t, c) < 0.3);
    if (!nearX && open < 0) open = f;
    if ((nearX || k === 200) && open >= 0) { if (f - open > 0.02) rails.push([open, f]); open = -1; }
  }
  return trackArena('trefoil', 'Trefoil Twister', 'Three-lobed knot: roller-coaster hills, three flat X-crossings where traffic collides.', THEMES.sunset, {
    width: 9, pts, rails, gaps: [], boosts: [0.08, 0.41, 0.74], items: [0.2, 0.53, 0.86],
  });
}

/** Figure-8 control points: both lobes cross flat at the origin (same height) so racers can T-bone each other. */
function figure8(rx: number, rz: number, n: number, elev: (t: number) => number, skew = 0): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let k = 0; k < n; k++) {
    const t = Math.PI / 4 + (k / n) * Math.PI * 2; // start mid-lobe, away from the crossing
    out.push([rx * Math.sin(t), rz * Math.sin(2 * t) + skew * Math.sin(t), elev(t)]);
  }
  return out;
}

BUILTIN_ARENAS.push(
  trackArena('hyper-tube', 'Hyper Tube', 'A twisting half-pipe: the floor banks hard left and right all lap long. Ride the walls — but not over the rim.', THEMES.tube, {
    width: 12, profile: 'pipe', depth: 3.2, twist: 0.42, twistWaves: 5,
    pts: [[0, -50, 0], [40, -55, 2], [70, -35, 4], [75, 0, 6], [55, 30, 5], [25, 25, 3], [10, 45, 2], [-20, 60, 1], [-55, 50, 2], [-70, 20, 3], [-50, -5, 2], [-65, -35, 1], [-35, -55, 0]],
    rails: [],
    gaps: [[0.585, 0.595]],
    boosts: [0.04, 0.3, 0.55, 0.8],
    items: [0.17, 0.45, 0.7],
  }),
  trackArena('crossfire-8', 'Crossfire 8', 'Figure-eight with a flat X-crossing mid-lap — time it right or get T-boned.', THEMES.royal, {
    width: 9,
    pts: figure8(58, 34, 16, (t) => 4 * Math.sin(t) ** 2),
    rails: [[0.03, 0.26], [0.53, 0.76]], // lobes only: the X-crossing stays wide open
    gaps: [],
    boosts: [0.2, 0.7],
    items: [0.1, 0.45, 0.6, 0.95],
  }),
  trefoilTrack(),
);

/**
 * Make sure every built-in arena has spin pads to fight over (S: 2, M: 3, L: 4). Pads go on flat, solid ground,
 * clear of spawns, item boxes, the KOTH zone and each other.
 */
function ensureSpinPads(a: ArenaDef) {
  if (a.track) return;
  const want = arenaSize(a) === 'S' ? 2 : arenaSize(a) === 'M' ? 3 : 4;
  const have = a.markers.filter((m) => m.kind === 'spinpad').length;
  if (have >= want) return;
  const hAt = (x: number, z: number) => (a.stadium ? stadiumHeight(a.stadium, x, z) : courseHeight(a.course!, x, z));
  const half = a.stadium ? a.stadium.radius : (Math.max(a.course!.w, a.course!.h) * a.course!.tile) / 2;
  let tol = 0.35; // relaxed for all-bowl arenas that have no truly flat ground
  const flat = (x: number, z: number) => {
    const h0 = hAt(x, z);
    if (h0 <= VOID) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const h1 = hAt(x + dx * 1.3, z + dz * 1.3); if (h1 <= VOID || Math.abs(h1 - h0) > tol) return false; }
    return true;
  };
  const taken = a.markers.filter((m) => m.kind !== 'gem');
  const clear = (x: number, z: number) => taken.every((m) => Math.hypot(m.x - x, m.z - z) > (m.kind === 'zone' ? (m.r ?? 3) + 2 : 3.2));
  const cands: { x: number; z: number; score: number }[] = [];
  for (let pass = 0; pass < 3 && cands.length < want; pass++, tol += 0.3) for (const f of [0.42, 0.55, 0.68, 0.3, 0.8]) {
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2 + f;
      const x = Math.cos(ang) * half * f, z = Math.sin(ang) * half * f;
      if (flat(x, z) && clear(x, z)) cands.push({ x, z, score: 0 });
    }
  }
  // spread them out: greedily take the candidate farthest from every pad so far
  const placed = a.markers.filter((m) => m.kind === 'spinpad').map((m) => ({ x: m.x, z: m.z }));
  while (placed.length < want && cands.length) {
    let best = -1, bd = -1;
    cands.forEach((c, i) => { const d = placed.length ? Math.min(...placed.map((p) => Math.hypot(p.x - c.x, p.z - c.z))) : Math.hypot(c.x, c.z); if (d > bd) { bd = d; best = i; } });
    if (best < 0 || (placed.length && bd < 5)) break;
    const c = cands.splice(best, 1)[0];
    placed.push(c);
    a.markers.push({ kind: 'spinpad', x: +c.x.toFixed(2), z: +c.z.toFixed(2), r: 1.2 });
  }
}
for (const a of BUILTIN_ARENAS) ensureSpinPads(a);

// ------------------------------------------------------------------ Blade Quest levels
/**
 * Quest levels are drawn as text grids (one char per 6m tile, rows run along +z, columns along +x):
 *   .  flat         (space) gap / nothing
 *   >  kicker launching toward +x   <  toward -x   ^ toward -z   v toward +z
 *   /  ramp up toward +x (next tile is one level higher)   \  ramp up toward -x   n ramp up toward -z   u toward +z
 *   s  stairs up toward +x   b bumps   p pit   d dome   h funbox   o bowl   c cradle   y pyramid
 *   =  rail wall on the outer edge (auto-faces the nearest outside)
 * A second grid of digits gives each tile's level (0-9). Markers are placed by tile coordinates.
 */
type QuestMark = [kind: MarkerKind, i: number, j: number, extra?: Partial<Marker>];
function questLevel(id: string, name: string, desc: string, theme: Theme, rows: string[], levels: string[], marks: QuestMark[]): ArenaDef {
  const T = 6, h = rows.length, w = Math.max(...rows.map((r) => r.length));
  const c: CourseDef = { tile: T, w, h, pieces: [] };
  const KIND: Record<string, PieceKind> = { '.': 'flat', '>': 'kicker', '<': 'kicker', '^': 'kicker', v: 'kicker', '/': 'ramp', '\\': 'ramp', n: 'ramp', u: 'ramp', s: 'stairs', b: 'bumps', p: 'pit', d: 'dome', h: 'hump', o: 'bowl', c: 'cradle', y: 'pyramid', '=': 'wall' };
  const DIR: Record<string, [number, number]> = { '>': [1, 0], '<': [-1, 0], '^': [0, -1], v: [0, 1], '/': [1, 0], '\\': [-1, 0], n: [0, -1], u: [0, 1], s: [1, 0] };
  // which rotation makes this piece rise toward a world direction (sampled, so it can't be wrong)
  const faceRot = (kind: PieceKind, dx: number, dz: number) => {
    let best = 0, bv = -Infinity;
    for (let r = 0; r < 4; r++) {
      const at = (fu: number, fv: number) => { let u = fu, v = fv; for (let k = 0; k < r; k++) { const nu = v, nv = 1 - u; u = nu; v = nv; } return pieceHeight(kind, u, v, T); };
      const val = at(0.5 + dx * 0.3, 0.5 + dz * 0.3) - at(0.5 - dx * 0.3, 0.5 - dz * 0.3) + (kind === 'wall' ? at(0.5 + dx * 0.47, 0.5 + dz * 0.47) : 0);
      if (val > bv) { bv = val; best = r; }
    }
    return best;
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const ch = rows[j][i] ?? ' ';
    if (ch === ' ') continue;
    const kind = KIND[ch] ?? 'flat';
    const level = Number(levels[j]?.[i] ?? 0) || 0;
    let rot = 0;
    const d = DIR[ch];
    if (d) rot = faceRot(kind, d[0], d[1]);
    else if (kind === 'wall') {
      // face the nearest outside edge (or gap)
      const out = ([[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]).find(([dx, dz]) => (rows[j + dz]?.[i + dx] ?? ' ') === ' ') ?? [0, 1]; // sides first, so walls never block a gap landing
      rot = faceRot('wall', out[0], out[1]);
    }
    c.pieces.push({ kind, x: i, y: j, rot, level });
  }
  const tx = (i: number) => (i + 0.5) * T - (w * T) / 2, tz = (j: number) => (j + 0.5) * T - (h * T) / 2;
  const markers: Marker[] = marks.map(([kind, i, j, extra]) => ({ kind, x: tx(i), z: tz(j), ...extra }));
  return { id, name, desc, theme, course: c, markers };
}

const R0 = '0', LV = (s: string) => s; // readability helpers for level grids
void R0; void LV;

BUILTIN_ARENAS.push(
  // 1. a Mario-style left-to-right run: kicker jumps over gaps, a climb, a drone hive, pits and a final leap
  questLevel('quest-neon-run', 'Neon Run', 'Linear run: jump the gaps, climb the ramps, slip past the drone hive and reach the goal.', THEMES.neon,
    [
      '==...>. ../...=.... >. .bb...ppp..==',
      '==...>. ../........ >. .bb...ppp..==',
    ],
    [
      '000000000111111111111111110000001111',
      '000000000111111111111111110000001111',
    ],
    [
      ['spawn', 1, 0], ['spawn', 1, 1], ['spawn', 2, 0], ['spawn', 2, 1],
      ['gem', 4, 0], ['gem', 8, 1], ['item', 11, 0], ['gem', 13, 1],
      ['checkpoint', 12, 1, { r: 2.2 }],
      ['hive', 16, 0, { r: 9, len: 2 }],
      ['gem', 17, 1], ['spinpad', 18, 0, { r: 1.3 }],
      ['checkpoint', 23, 0, { r: 2.2 }], ['gem', 24, 1], ['gem', 25, 0],
      ['gem', 28, 1], ['item', 31, 0],
      ['checkpoint', 32, 1, { r: 2.2 }],
      ['goal', 34, 0, { r: 2.6 }],
    ]),
  // 2. a climb: stairs and ramps up five levels, kicker jumps between ledges, a hive on the middle shelf
  questLevel('quest-sky-steps', 'Sky Steps', 'Climb five levels of floating ledges: stairs, ramps and kicker jumps. Fall and you drop back to your checkpoint.', THEMES.sunset,
    ['.==s==> .=/==bs==> .=/==y=> ..', '.==s==> .=/==bs==> .=/==y=> ..'],
    ['000011111111222233333334444444', '000011111111222233333334444444'],
    [
      ['spawn', 0, 0], ['spawn', 0, 1], ['spawn', 1, 0], ['spawn', 1, 1],
      ['gem', 5, 1], ['item', 4, 0], ['checkpoint', 9, 0, { r: 2.2 }], ['gem', 12, 0],
      ['hive', 12, 1, { r: 7, len: 2 }], ['checkpoint', 16, 1, { r: 2.2 }], ['gem', 16, 0], ['item', 19, 1],
      ['checkpoint', 20, 0, { r: 2.2 }], ['spinpad', 22, 1, { r: 1.3 }], ['gem', 23, 0], ['gem', 25, 1],
      ['goal', 29, 0, { r: 2.6, z: 0 }],
    ]),
  // 3. an open world: circle the valley floor, climb to the middle tier, jump the north gap, ramp up to the summit
  questLevel('quest-hive-valley', 'Hive Valley', 'Open world: work round the valley, up through three tiers to the summit goal. Two drone hives hunt anyone in their zones.', THEMES.toxic,
    [
      '==========',
      '=........=',
      '=.d.. <..=',
      '=...u....=',
      '=........=',
      '=..h.....=',
      '=.....b..=',
      '=......p.=',
      '=....n...=',
      '==========',
    ],
    [
      '0000000000',
      '0000000000',
      '0011111100',
      '0011111100',
      '0011221100',
      '0011221100',
      '0011111100',
      '0011111100',
      '0000000000',
      '0000000000',
    ],
    [
      ['spawn', 1, 8], ['spawn', 2, 8], ['spawn', 3, 8], ['spawn', 1, 7],
      ['gem', 8, 1], ['gem', 1, 1], ['gem', 7, 8], ['gem', 6, 4], ['gem', 2, 5], ['gem', 5, 5],
      ['item', 8, 8], ['item', 3, 6], ['spinpad', 8, 4, { r: 1.3 }], ['spinpad', 2, 3, { r: 1.3 }],
      ['hive', 7, 8, { r: 6, len: 2 }],
      ['checkpoint', 5, 9, { r: 2.2 }],
      ['checkpoint', 5, 6, { r: 2.2 }],
      ['checkpoint', 7, 6, { r: 2.2 }],
      ['hive', 5, 3, { r: 6, len: 2 }],
      ['checkpoint', 7, 2, { r: 2.2 }],
      ['checkpoint', 4, 2, { r: 2.2 }],
      ['goal', 4, 4, { r: 2.6, x: 0, z: 0 }],
    ]),
)


export type ArenaSize = 'S' | 'M' | 'L' | 'TRACK';
export const SIZE_LABEL: Record<ArenaSize, string> = { S: 'SMALL', M: 'MEDIUM', L: 'LARGE', TRACK: 'TRACK' };
export function arenaSize(a: ArenaDef): ArenaSize {
  if (a.track) return 'TRACK';
  const half = a.stadium ? a.stadium.radius : (Math.max(a.course!.w, a.course!.h) * a.course!.tile) / 2;
  return half < 13 ? 'S' : half < 19 ? 'M' : 'L';
}

const LS_KEY = 'bitblade.courses.v1';
export function loadCustomArenas(): ArenaDef[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
export function saveCustomArenas(list: ArenaDef[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export function allArenas(): ArenaDef[] {
  return [...BUILTIN_ARENAS, ...loadCustomArenas()];
}
export function findArena(id: string) {
  return allArenas().find((a) => a.id === id) ?? BUILTIN_ARENAS[0];
}
