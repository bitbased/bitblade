// Race tracks: Catmull-Rom splines turned into floating, banked F-Zero-style ribbons. Closed loops for racing;
// open (start → end) paths for track adventures.

export interface TrackDef {
  pts: [number, number, number][]; // x, z, elevation control points (closed loop)
  width: number;
  rails: [number, number][]; // fractions of lap with guard rails
  gaps: [number, number][]; // fractions with no floor (jump them!)
  boosts: number[]; // fractions with boost pads
  items: number[]; // fractions with item box rows
  /** cross-section: flat ribbon (default) or a U-shaped half-pipe you can ride up */
  profile?: 'flat' | 'pipe';
  depth?: number; // pipe wall height
  twist?: number; // extra left/right banking that waves along the lap (slope, ~0..0.6)
  twistWaves?: number; // how many bank flips per lap
  /** start → end path instead of a loop (track adventures) */
  open?: boolean;
  /** extra sideways tilt per control point (slope; + raises the left edge) */
  banks?: number[];
  /** road width per control point (narrowing / widening sections); defaults to `width` */
  widths?: number[];
  /** jump ramps on the road: rise `h` metres over the `len` metres before fraction `f` (the lip) */
  ramps?: { f: number; len: number; h: number }[];
  /** fractions of the lap that are a half-pipe (on an otherwise flat road) */
  pipes?: [number, number][];
  /** false: no automatic 1.5m kicker before gaps (use explicit ramps instead) */
  autoKick?: boolean;
}

export interface TrackSamples {
  n: number;
  x: Float32Array; z: Float32Array; y: Float32Array;
  tx: Float32Array; tz: Float32Array; // unit tangent
  curv: Float32Array; // signed curvature
  cum: Float32Array; // distance from start
  total: number;
  width: number;
  /** per-sample extra tilt (slope) from TrackDef.banks */
  bank: Float32Array;
  /** per-sample road width (TrackDef.widths), `width` is the widest */
  w: Float32Array;
  open: boolean;
}

const VOID = -1000;
const STEP = 0.5;

function cr(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function sampleTrack(def: TrackDef): TrackSamples {
  const P = def.pts;
  const open = !!def.open;
  const B = def.banks ?? [];
  const Wd = def.widths ?? [];
  const wAt = (i: number) => Wd[i] ?? def.width;
  const N = P.length;
  const idx = (i: number) => (open ? Math.max(0, Math.min(N - 1, i)) : (i + N) % N);
  const dense: [number, number, number, number, number][] = [];
  const segs = open ? N - 1 : N;
  for (let i = 0; i < segs; i++) {
    const a = P[idx(i - 1)], b = P[i], c = P[idx(i + 1)], d = P[idx(i + 2)];
    const ba = B[i] ?? 0, bc = B[idx(i + 1)] ?? 0, wa = wAt(i), wc = wAt(idx(i + 1));
    // pieces by length, not a fixed 40 per span: on a long span 40 straight pieces left a kink every couple of
    // metres (a washboard on long slopes). ~0.25m pieces follow the true curve.
    const K = Math.max(40, Math.ceil(Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]) / 0.25));
    for (let k = 0; k < K; k++) {
      const t = k / K;
      const sm = t * t * (3 - 2 * t);
      dense.push([cr(a[0], b[0], c[0], d[0], t), cr(a[1], b[1], c[1], d[1], t), cr(a[2], b[2], c[2], d[2], t), ba + (bc - ba) * sm, wa + (wc - wa) * sm]);
    }
  }
  if (open) dense.push([P[N - 1][0], P[N - 1][1], P[N - 1][2], B[N - 1] ?? 0, wAt(N - 1)]);
  // resample at uniform spacing
  const out: [number, number, number, number, number][] = [dense[0]];
  let acc = 0;
  const last = open ? dense.length - 1 : dense.length;
  for (let i = 1; i <= last; i++) {
    const p = dense[i - 1], q = dense[i % dense.length];
    let seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    let s0 = 0;
    while (acc + seg - s0 >= STEP) {
      const need = STEP - acc;
      s0 += need;
      const f = s0 / seg;
      out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f, p[3] + (q[3] - p[3]) * f, p[4] + (q[4] - p[4]) * f]);
      acc = 0;
    }
    acc += seg - s0;
    void seg;
  }
  if (!open && out.length > 2 && Math.hypot(out[out.length - 1][0] - out[0][0], out[out.length - 1][1] - out[0][1]) < STEP * 0.5) out.pop();
  const n = out.length;
  const S: TrackSamples = {
    n, x: new Float32Array(n), z: new Float32Array(n), y: new Float32Array(n), tx: new Float32Array(n), tz: new Float32Array(n),
    curv: new Float32Array(n), cum: new Float32Array(n), total: n * STEP, width: Math.max(def.width, ...Wd), bank: new Float32Array(n), w: new Float32Array(n), open,
  };
  const w = (i: number) => (open ? Math.max(0, Math.min(n - 1, i)) : (i + n) % n);
  for (let i = 0; i < n; i++) { S.x[i] = out[i][0]; S.z[i] = out[i][1]; S.y[i] = out[i][2]; S.bank[i] = out[i][3]; S.w[i] = out[i][4]; S.cum[i] = i * STEP; }
  for (let i = 0; i < n; i++) {
    const a = w(i - 1), b = w(i + 1);
    let dx = S.x[b] - S.x[a], dz = S.z[b] - S.z[a];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    S.tx[i] = dx; S.tz[i] = dz;
  }
  for (let i = 0; i < n; i++) {
    const a = w(i - 4), b = w(i + 4);
    const cross = S.tx[a] * S.tz[b] - S.tz[a] * S.tx[b];
    S.curv[i] = cross / (8 * STEP);
  }
  // smooth curvature for banking
  const c2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -10; k <= 10; k++) s += S.curv[w(i + k)]; c2[i] = s / 21; }
  S.curv = c2;
  return S;
}

const inRanges = (f: number, r: [number, number][]) => r.some(([a, b]) => (a <= b ? f >= a && f <= b : f >= a || f <= b));

/** per-track precomputed bits for surface queries */
/** (flat: per sample, 1 = the normal road, fading to 0 at a level crossing — where it's flat and edge-to-edge) */
export interface SurfaceCtx { gapStarts: number[]; ramps: { end: number; len: number; h: number }[]; flat: Float32Array }
export function surfaceCtx(def: TrackDef, S: TrackSamples): SurfaceCtx {
  return {
    gapStarts: def.autoKick === false ? [] : def.gaps.map(([a]) => a * S.total),
    ramps: (def.ramps ?? []).map((r) => ({ end: r.f * S.total, len: r.len, h: r.h })),
    flat: crossingFlat(S),
  };
}

const flatCache = new WeakMap<TrackSamples, Float32Array>();
/**
 * Level crossings (a figure-8's X, a knot's crossings): where another stretch of road passes through at the same
 * height, both roads must be one flat surface — no raised edge lip and no curve banking, or each road's edges are
 * ramps across the other. Returns, per sample, 1 = normal, easing to 0 over the crossing and ~5m either side.
 */
function crossingFlat(S: TrackSamples) {
  let f = flatCache.get(S);
  if (f) return f;
  f = new Float32Array(S.n).fill(1);
  const near = new Float32Array(S.n).fill(1e9); // distance (m along the road) to the nearest crossing
  for (let i = 0; i < S.n; i += 2) for (let j = i + 40; j < S.n; j += 2) {
    if (!S.open && S.n - (j - i) < 40) continue;
    const reach = (S.w[i] + S.w[j]) / 2; // (the roads actually overlap)
    if (Math.abs(S.x[i] - S.x[j]) > reach || Math.abs(S.z[i] - S.z[j]) > reach) continue;
    if (Math.hypot(S.x[i] - S.x[j], S.z[i] - S.z[j]) < reach && Math.abs(S.y[i] - S.y[j]) < 1.5) { near[i] = 0; near[j] = 0; }
  }
  // spread: distance along the road from each sample to the nearest crossing sample
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < 2 * S.n; k++) {
    const i = pass ? S.n - 1 - (k % S.n) : k % S.n, prev = pass ? (i + 1) % S.n : (i - 1 + S.n) % S.n;
    if (S.open && (pass ? i === S.n - 1 : i === 0)) continue;
    near[i] = Math.min(near[i], near[prev] + STEP);
  }
  for (let i = 0; i < S.n; i++) { const u = Math.min(1, near[i] / 5); f[i] = u * u * (3 - 2 * u); }
  flatCache.set(S, f);
  return f;
}

/**
 * Height of the road surface at (x, z) near centre-line sample `best` (VOID if off this road).
 * Continuous along the road: the centre line, height, tilt and width are interpolated between `best` and its
 * neighbour by how far along (x, z) is, so the surface is the smooth road you see. (Taking them straight from
 * the nearest sample made a 0.5m staircase on every slope: bumpy, bouncy downhills.)
 */
export function trackSurface(def: TrackDef, S: TrackSamples, best: number, x: number, z: number, ctx: SurfaceCtx) {
  // where along the road is (x, z)? Solve for the spot on the segment between `best` and its neighbour where the
  // line to (x, z) is square to the (interpolated) road direction — the same answer whichever sample we start from,
  // so on curves the surface has no seams between samples, even far from the centre line.
  const along0 = (x - S.x[best]) * S.tx[best] + (z - S.z[best]) * S.tz[best];
  const nb = (i: number) => (S.open ? Math.max(0, Math.min(S.n - 1, i)) : (i + S.n) % S.n);
  let a = along0 >= 0 ? best : nb(best - 1), b = nb(a + 1);
  let w = 0;
  for (let pass = 0; pass < 2; pass++) {
    const dx = S.x[b] - S.x[a], dz = S.z[b] - S.z[a], ex = S.tx[b] - S.tx[a], ez = S.tz[b] - S.tz[a];
    const px = x - S.x[a], pz = z - S.z[a];
    w = Math.max(-0.5, Math.min(1.5, (px * S.tx[a] + pz * S.tz[a]) / STEP));
    for (let it = 0; it < 4; it++) {
      const rx = px - w * dx, rz = pz - w * dz, tx = S.tx[a] + w * ex, tz = S.tz[a] + w * ez;
      const fv = rx * tx + rz * tz, fd = -(dx * tx + dz * tz) + (rx * ex + rz * ez);
      if (Math.abs(fd) < 1e-9) break;
      w -= fv / fd;
    }
    // landed past either end: it belongs to the neighbouring segment (open tracks: clamp at the ends)
    if (w < 0 && (S.open ? a > 0 : true) && pass === 0) { b = a; a = nb(a - 1); continue; }
    if (w > 1 && (S.open ? b < S.n - 1 : true) && pass === 0) { a = b; b = nb(b + 1); continue; }
    break;
  }
  w = Math.max(0, Math.min(1, w));
  const L = (arr: Float32Array) => arr[a] + (arr[b] - arr[a]) * w;
  const cx = L(S.x), cz = L(S.z);
  let ttx = L(S.tx), ttz = L(S.tz);
  const tl = Math.hypot(ttx, ttz) || 1; ttx /= tl; ttz /= tl;
  const d = Math.hypot(cx - x, cz - z);
  const half = L(S.w) / 2 + 1e-3; // this stretch's width (narrowing sections); the epsilon keeps the exact edge on the road (no sawtooth rim)
  // signed lateral offset (left of tangent positive)
  const side = (x - cx) * -ttz + (z - cz) * ttx;
  const cum = S.cum[a] + w * STEP; // (a loop's last→first segment wraps; f below is only used for range tests)
  const f = cum / S.total;
  const curv = L(S.curv), y0c = L(S.y), fl = ctx.flat[a] + (ctx.flat[b] - ctx.flat[a]) * w;
  // curvature banking + any explicit tilt (positive raises the left edge) — none at a level crossing
  const base = y0c + (Math.max(-1.2, Math.min(1.2, -curv * side * 6)) * 0.5 + L(S.bank) * side) * fl;
  let kick = 0;
  for (const g of ctx.gapStarts) {
    let ds = g - cum;
    if (ds < 0 && !S.open) ds += S.total;
    if (ds >= 0 && ds < 7) kick = Math.max(kick, 1.5 * Math.pow(1 - ds / 7, 1.6));
  }
  // explicit jump ramps: steepest at the lip
  for (const r of ctx.ramps) {
    const ds = r.end - cum;
    if (ds >= 0 && ds < r.len) { const u = 1 - ds / r.len; kick = Math.max(kick, r.h * u * u); }
  }
  if (def.profile === 'pipe' || (def.pipes && inRanges(f, def.pipes))) {
    // U-shaped pipe; banking leans the whole cross-section (curvature + a twisting wave along the lap)
    const D = def.depth ?? 3;
    const bank = Math.max(-0.6, Math.min(0.6, -curv * 14 + (def.twist ?? 0) * Math.sin(f * Math.PI * 2 * (def.twistWaves ?? 4))));
    const y0 = y0c + kick;
    if (d <= half) { const u = d / half; return inRanges(f, def.gaps) ? VOID : y0 + D * (1 - Math.sqrt(Math.max(0, 1 - u * u * 0.96))) + bank * side; }
    if (d <= half + 0.7 && !inRanges(f, def.gaps)) return y0 + D * 0.8 + bank * side; // the rim: go over it and you're out
    return VOID;
  }
  if (d <= half) return inRanges(f, def.gaps) ? VOID : base + Math.pow(d / half, 4) * 0.9 * fl + kick; // (the edge lip, flat at a crossing)
  if (d <= half + 0.8 && inRanges(f, def.rails) && !inRanges(f, def.gaps)) {
    const t = (d - half) / 0.5;
    return base + 0.9 + 1.1 * Math.min(1, t * t * (3 - 2 * t));
  }
  return VOID;
}

/** does the road pass over itself (bridges / overpasses)? then one heightfield can't hold it */
export function trackOverlaps(S: TrackSamples) {
  for (let i = 0; i < S.n; i += 4) for (let j = i + 40; j < S.n; j += 4) {
    if (!S.open && S.n - (j - i) < 40) continue;
    if (Math.hypot(S.x[i] - S.x[j], S.z[i] - S.z[j]) < (S.w[i] + S.w[j]) / 2 + 2 && Math.abs(S.y[i] - S.y[j]) > 0.4) return true;
  }
  return false;
}

/** a bucket grid of centre-line samples for fast nearest lookups */
export class SampleGrid {
  B = 4; x0: number; z0: number; nx: number; nz: number; cells: number[][];
  constructor(public S: TrackSamples, x0: number, z0: number, x1: number, z1: number) {
    this.x0 = x0; this.z0 = z0;
    this.nx = Math.ceil((x1 - x0) / this.B) + 1; this.nz = Math.ceil((z1 - z0) / this.B) + 1;
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
    for (let i = 0; i < S.n; i++) {
      const bi = Math.floor((S.x[i] - x0) / this.B), bj = Math.floor((S.z[i] - z0) / this.B);
      if (bi >= 0 && bj >= 0 && bi < this.nx && bj < this.nz) this.cells[bj * this.nx + bi].push(i);
    }
  }
  /** for each separate stretch of road near (x,z), its nearest sample (stretches = runs of nearby indices) */
  nearestPerStretch(x: number, z: number, reachM: number) {
    const r = Math.ceil(reachM / this.B);
    const bi = Math.floor((x - this.x0) / this.B), bj = Math.floor((z - this.z0) / this.B);
    const cand: { i: number; d: number }[] = [];
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const ii = bi + di, jj = bj + dj;
      if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) continue;
      for (const s of this.cells[jj * this.nx + ii]) { const d = (this.S.x[s] - x) ** 2 + (this.S.z[s] - z) ** 2; if (d <= reachM * reachM) cand.push({ i: s, d }); }
    }
    cand.sort((a, b) => a.i - b.i);
    const out: number[] = [];
    let grp: { i: number; d: number } | null = null, lastI = -1e9;
    const n = this.S.n;
    for (const c of cand) {
      if (grp && c.i - lastI <= 30) { if (c.d < grp.d) grp = c; }
      else { if (grp) out.push(grp.i); grp = c; }
      lastI = c.i;
    }
    if (grp) out.push(grp.i);
    // a loop's first and last stretches are the same road
    if (!this.S.open && out.length > 1 && out[0] < 30 && n - 1 - out[out.length - 1] < 30) {
      const a = out[0], b = out.pop()!;
      if ((this.S.x[b] - x) ** 2 + (this.S.z[b] - z) ** 2 < (this.S.x[a] - x) ** 2 + (this.S.z[a] - z) ** 2) out[0] = b;
    }
    return out;
  }
}

/** Fill a heightfield for a track (the highest road wherever stretches overlap). */
export function fillTrackHeights(def: TrackDef, S: TrackSamples, minX: number, minZ: number, cell: number, nx: number, nz: number, out: Float32Array) {
  const grid = new SampleGrid(S, minX, minZ, minX + nx * cell, minZ + nz * cell);
  const ctx = surfaceCtx(def, S);
  const reach = S.width / 2 + 1.5;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell, z = minZ + j * cell;
      let h = VOID;
      for (const best of grid.nearestPerStretch(x, z, reach)) { const v = trackSurface(def, S, best, x, z, ctx); if (v > h) h = v; }
      out[j * nx + i] = h;
    }
}

export function trackBounds(S: TrackSamples) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < S.n; i++) { x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); z0 = Math.min(z0, S.z[i]); z1 = Math.max(z1, S.z[i]); }
  const m = S.width + 3;
  return { x0: x0 - m, x1: x1 + m, z0: z0 - m, z1: z1 + m };
}

/** nearest sample to (x,z), searching a window around a hint index */
export function nearestSample(S: TrackSamples, x: number, z: number, hint: number, back = 20, fwd = 50) {
  let best = hint, bd = 1e9;
  for (let k = -back; k <= fwd; k++) {
    const i = S.open ? Math.max(0, Math.min(S.n - 1, hint + k)) : (((hint + k) % S.n) + S.n) % S.n;
    const d = (S.x[i] - x) ** 2 + (S.z[i] - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return { i: best, d: Math.sqrt(bd) };
}

export function globalNearest(S: TrackSamples, x: number, z: number) {
  let best = 0, bd = 1e9;
  for (let i = 0; i < S.n; i++) { const d = (S.x[i] - x) ** 2 + (S.z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}
