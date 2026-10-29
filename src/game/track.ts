// Race tracks: closed Catmull-Rom splines turned into floating, banked F-Zero-style ribbons.

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
}

export interface TrackSamples {
  n: number;
  x: Float32Array; z: Float32Array; y: Float32Array;
  tx: Float32Array; tz: Float32Array; // unit tangent
  curv: Float32Array; // signed curvature
  cum: Float32Array; // distance from start
  total: number;
  width: number;
}

const VOID = -1000;
const STEP = 0.5;

function cr(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function sampleTrack(def: TrackDef): TrackSamples {
  const P = def.pts;
  const dense: [number, number, number][] = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[(i - 1 + P.length) % P.length], b = P[i], c = P[(i + 1) % P.length], d = P[(i + 2) % P.length];
    for (let k = 0; k < 40; k++) {
      const t = k / 40;
      dense.push([cr(a[0], b[0], c[0], d[0], t), cr(a[1], b[1], c[1], d[1], t), cr(a[2], b[2], c[2], d[2], t)]);
    }
  }
  // resample at uniform spacing
  const out: [number, number, number][] = [dense[0]];
  let acc = 0;
  for (let i = 1; i <= dense.length; i++) {
    const p = dense[i - 1], q = dense[i % dense.length];
    let seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    let s0 = 0;
    while (acc + seg - s0 >= STEP) {
      const need = STEP - acc;
      s0 += need;
      const f = s0 / seg;
      out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f]);
      acc = 0;
    }
    acc += seg - s0;
    void seg;
  }
  if (out.length > 2 && Math.hypot(out[out.length - 1][0] - out[0][0], out[out.length - 1][1] - out[0][1]) < STEP * 0.5) out.pop();
  const n = out.length;
  const S: TrackSamples = {
    n, x: new Float32Array(n), z: new Float32Array(n), y: new Float32Array(n), tx: new Float32Array(n), tz: new Float32Array(n),
    curv: new Float32Array(n), cum: new Float32Array(n), total: n * STEP, width: def.width,
  };
  for (let i = 0; i < n; i++) { S.x[i] = out[i][0]; S.z[i] = out[i][1]; S.y[i] = out[i][2]; S.cum[i] = i * STEP; }
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let dx = S.x[b] - S.x[a], dz = S.z[b] - S.z[a];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    S.tx[i] = dx; S.tz[i] = dz;
  }
  for (let i = 0; i < n; i++) {
    const a = (i - 4 + n) % n, b = (i + 4) % n;
    const cross = S.tx[a] * S.tz[b] - S.tz[a] * S.tx[b];
    S.curv[i] = cross / (8 * STEP);
  }
  // smooth curvature for banking
  const c2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -10; k <= 10; k++) s += S.curv[(i + k + n) % n]; c2[i] = s / 21; }
  S.curv = c2;
  return S;
}

const inRanges = (f: number, r: [number, number][]) => r.some(([a, b]) => (a <= b ? f >= a && f <= b : f >= a || f <= b));

/** Fill a heightfield for a track. Uses a bucket grid to find the nearest centerline sample quickly. */
export function fillTrackHeights(def: TrackDef, S: TrackSamples, minX: number, minZ: number, cell: number, nx: number, nz: number, out: Float32Array) {
  const B = 4;
  const bx0 = minX, bz0 = minZ;
  const bnx = Math.ceil((nx * cell) / B) + 1, bnz = Math.ceil((nz * cell) / B) + 1;
  const buckets: number[][] = Array.from({ length: bnx * bnz }, () => []);
  for (let i = 0; i < S.n; i++) {
    const bi = Math.floor((S.x[i] - bx0) / B), bj = Math.floor((S.z[i] - bz0) / B);
    if (bi >= 0 && bj >= 0 && bi < bnx && bj < bnz) buckets[bj * bnx + bi].push(i);
  }
  const half = def.width / 2;
  const reach = Math.ceil((half + 1.5) / B);
  // gap kickers: the 7m before every gap ramps up
  const gapStarts = def.gaps.map(([a]) => a * S.total);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell, z = minZ + j * cell;
      const bi = Math.floor((x - bx0) / B), bj = Math.floor((z - bz0) / B);
      let best = -1, bd = 1e9;
      for (let dj = -reach; dj <= reach; dj++)
        for (let di = -reach; di <= reach; di++) {
          const ii = bi + di, jj = bj + dj;
          if (ii < 0 || jj < 0 || ii >= bnx || jj >= bnz) continue;
          for (const s of buckets[jj * bnx + ii]) {
            const d = (S.x[s] - x) ** 2 + (S.z[s] - z) ** 2;
            if (d < bd) { bd = d; best = s; }
          }
        }
      let h = VOID;
      if (best >= 0) {
        const d = Math.sqrt(bd);
        // signed lateral offset (left of tangent positive)
        const side = (x - S.x[best]) * -S.tz[best] + (z - S.z[best]) * S.tx[best];
        const f = S.cum[best] / S.total;
        const base = S.y[best] + Math.max(-1.2, Math.min(1.2, -S.curv[best] * side * 6)) * 0.5;
        let kick = 0;
        for (const g of gapStarts) {
          let ds = g - S.cum[best];
          if (ds < 0) ds += S.total;
          if (ds < 7) kick = Math.max(kick, 1.5 * Math.pow(1 - ds / 7, 1.6));
        }
        if (def.profile === 'pipe') {
          // U-shaped pipe; banking leans the whole cross-section (curvature + a twisting wave along the lap)
          const D = def.depth ?? 3;
          const bank = Math.max(-0.6, Math.min(0.6, -S.curv[best] * 14 + (def.twist ?? 0) * Math.sin(f * Math.PI * 2 * (def.twistWaves ?? 4))));
          const y0 = S.y[best] + kick;
          if (d <= half) {
            const u = d / half;
            h = inRanges(f, def.gaps) ? VOID : y0 + D * (1 - Math.sqrt(Math.max(0, 1 - u * u * 0.96))) + bank * side;
          } else if (d <= half + 0.7 && !inRanges(f, def.gaps)) {
            h = y0 + D * 0.8 + bank * side; // the rim: go over it and you're out
          }
        } else if (d <= half) {
          h = inRanges(f, def.gaps) ? VOID : base + Math.pow(d / half, 4) * 0.9 + kick;
        } else if (d <= half + 0.8 && inRanges(f, def.rails) && !inRanges(f, def.gaps)) {
          const t = (d - half) / 0.5;
          h = base + 0.9 + 1.1 * Math.min(1, t * t * (3 - 2 * t));
        }
      }
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
    const i = (((hint + k) % S.n) + S.n) % S.n;
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
