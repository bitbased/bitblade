// Segment courses: a course is a chain of track pieces (straight, curve, climb, drop, jump, tilt…) with things
// attached along them. The chain compiles to an ordinary TrackDef + markers, so physics, rendering, the chase
// camera and the AI all just work. Closed chains are race tracks; open chains (start → goal) are track adventures.
import { sampleTrack, type TrackDef, type TrackSamples } from './track';
import type { ArenaDef, Marker, MarkerKind, Theme } from './terrain';

export type SegAttachKind = 'arm' | 'saw' | 'bumper' | 'pillar' | 'spinpad' | 'gem' | 'checkpoint' | 'hive' | 'item' | 'boost';
export interface SegAttach {
  /** 0..1 along the segment */
  at: number;
  kind: SegAttachKind;
  /** -1..1 across the road (left negative) */
  lat?: number;
  size?: number;
  speed?: number;
}

export interface Seg {
  /** palette label, for the editor */
  kind?: string;
  /** metres along the ground */
  len: number;
  /** heading change over the segment, degrees (+ = left) */
  turn?: number;
  /** metres up (+) or down (-) over the segment */
  climb?: number;
  /** sideways tilt reached by the end of the segment (slope -0.5..0.5, + raises the left edge) */
  bank?: number;
  /** metres with no floor at the end of the segment — a jump */
  gap?: number;
  /** jump ramp height at the end of the segment (m); before a gap it launches you over it */
  lip?: number;
  rails?: boolean;
  boost?: boolean;
  items?: boolean;
  att?: SegAttach[];
}

export interface SegCourse {
  id: string;
  name: string;
  desc: string;
  theme: Theme;
  width: number;
  /** open = start → goal adventure (Blade Quest); closed = race loop */
  open: boolean;
  profile?: 'flat' | 'pipe';
  segs: Seg[];
}

export interface CompiledCourse { arena: ArenaDef; issues: string[]; length: number; rise: number; /** where each problem is (distance along the track) */ spots?: { d: number; msg: string }[] }

/** walk the chain: control points every ~4m, plus where each segment starts/ends along the path */
function walk(c: SegCourse) {
  const pts: [number, number, number][] = [];
  const banks: number[] = [];
  const marks: { start: number; end: number }[] = [];
  let x = 0, z = 0, y = 4, h = 0, bank = 0, dist = 0;
  pts.push([x, z, y]); banks.push(0);
  for (const s of c.segs) {
    const start = dist;
    const steps = Math.max(1, Math.ceil(s.len / 4));
    const b0 = bank, b1 = s.bank ?? 0;
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      const dl = s.len / steps;
      // turn at the middle of the step for a symmetric arc
      h += (((s.turn ?? 0) * Math.PI) / 180) / steps / 2;
      x += Math.cos(h) * dl; z -= Math.sin(h) * dl;
      h += (((s.turn ?? 0) * Math.PI) / 180) / steps / 2;
      // ease climbs in and out so crests and dips are smooth, not kinks
      y += (s.climb ?? 0) * ((f * f * (3 - 2 * f)) - (((k - 1) / steps) ** 2 * (3 - 2 * ((k - 1) / steps))));
      dist += dl;
      pts.push([x, z, y]);
      banks.push(b0 + (b1 - b0) * f);
    }
    bank = b1;
    marks.push({ start, end: dist });
  }
  return { pts, banks, marks, total: dist };
}

/** compile a segment course into an arena (track + markers) and report problems */
export function compileCourse(c: SegCourse): CompiledCourse {
  const issues: string[] = [];
  const { pts, banks, marks, total } = walk(c);
  const F = (d: number) => Math.max(0, Math.min(1, d / total));
  const rails: [number, number][] = [], gaps: [number, number][] = [], boosts: number[] = [], items: number[] = [];
  const ramps: { f: number; len: number; h: number }[] = [];
  c.segs.forEach((s, i) => {
    const m = marks[i];
    if (s.rails) rails.push([F(m.start), F(m.end)]);
    if (s.boost) boosts.push(F(m.start + Math.min(4, s.len * 0.2)));
    if (s.items) items.push(F((m.start + m.end) / 2));
    const gap = Math.min(s.gap ?? 0, s.len * 0.8);
    if (gap > 0) gaps.push([F(m.end - gap), F(m.end)]);
    if ((s.lip ?? 0) > 0) ramps.push({ f: F(m.end - gap), len: rampLength(s), h: s.lip! });
  });
  const track: TrackDef = {
    pts, width: c.width, rails, gaps, boosts, items, open: c.open, banks, ramps, autoKick: false,
    profile: c.profile, depth: c.profile === 'pipe' ? 3 : undefined,
  };
  const S = sampleTrack(track);
  const at = (d: number) => Math.max(0, Math.min(S.n - 1, Math.round((F(d) * S.n))));
  const half = c.width / 2;
  const markers: Marker[] = [];
  const pos = (i: number, lat = 0) => ({ x: S.x[i] - S.tz[i] * lat * half, z: S.z[i] + S.tx[i] * lat * half, y: S.y[i] });
  // boost strips and item rows, like race tracks
  for (const f of boosts) { const i = at(f * total); markers.push({ kind: 'boost', ...pos(i), rot: Math.atan2(S.tx[i], S.tz[i]), r: c.width * 0.36 }); }
  for (const f of items) { const i = at(f * total); for (const o of [-0.6, 0, 0.6]) markers.push({ kind: 'item', ...pos(i, o) }); }
  c.segs.forEach((s, si) => {
    const m = marks[si];
    for (const a of s.att ?? []) {
      const i = at(m.start + a.at * (m.end - m.start));
      const p = pos(i, a.lat ?? 0);
      const yaw = Math.atan2(S.tx[i], S.tz[i]);
      switch (a.kind) {
        case 'arm': {
          // pivot just inside one edge, sweeping across the road
          const side = (a.lat ?? 1) >= 0 ? 1 : -1;
          markers.push({ kind: 'arm', ...pos(i, side * 0.85), len: a.size ?? c.width * 0.8, speed: a.speed ?? 1.2, rot: Math.atan2(-S.tx[i] * side, S.tz[i] * side) });
          break;
        }
        case 'saw': markers.push({ kind: 'saw', ...p, r: a.size ?? c.width * 0.28, speed: a.speed ?? 1.1 }); break;
        case 'bumper': markers.push({ kind: 'bumper', ...p, r: a.size ?? 0.85 }); break;
        case 'pillar': markers.push({ kind: 'pillar', ...p, r: a.size ?? 0.7 }); break;
        case 'spinpad': markers.push({ kind: 'spinpad', ...p, r: a.size ?? 1.4 }); break;
        case 'gem': markers.push({ kind: 'gem', ...p }); break;
        case 'item': markers.push({ kind: 'item', ...p }); break;
        case 'boost': markers.push({ kind: 'boost', ...p, rot: yaw, r: a.size ?? c.width * 0.3 }); break;
        case 'checkpoint': markers.push({ kind: 'checkpoint', ...pos(i), rot: yaw, r: Math.max(2.2, half - 0.3) }); break; // rot = travel yaw → posts across the road
        case 'hive': markers.push({ kind: 'hive', ...p, r: a.size ?? Math.max(8, c.width), len: 2 }); break;
      }
    }
  });
  // spawns: a grid behind the line (races) or along the start (adventures); the goal at the far end
  for (let k = 0; k < 8; k++) {
    const i = c.open ? Math.min(S.n - 1, 8 + Math.floor(k / 2) * 6) : (S.n - 6 - Math.floor(k / 2) * 6) % S.n;
    markers.push({ kind: 'spawn', ...pos(i, k % 2 ? 0.45 : -0.45) });
  }
  if (c.open) markers.push({ kind: 'goal', ...pos(S.n - 10), r: Math.max(2.6, half * 0.8), rot: Math.atan2(S.tx[S.n - 10], S.tz[S.n - 10]) }); // ring faces along the road
  // checks: the ground is one height surface, so the path can't pass over itself except as a level crossing
  for (let i = 0; i < S.n; i += 4) for (let j = i + 40; j < S.n; j += 4) {
    if (!c.open && S.n - (j - i) < 40) continue;
    const d = Math.hypot(S.x[i] - S.x[j], S.z[i] - S.z[j]);
    if (d < c.width + 1.5 && Math.abs(S.y[i] - S.y[j]) > 0.4) { issues.push(`passes over itself at ${Math.round(S.cum[i])}m / ${Math.round(S.cum[j])}m (crossings must be level)`); i += 40; break; }
  }
  for (let i = 4; i < S.n; i += 4) {
    const slope = Math.abs(S.y[i] - S.y[i - 4]) / (4 * 0.5);
    if (slope > 0.75) { issues.push(`too steep at ${Math.round(S.cum[i])}m (${Math.round(Math.atan(slope) * 57)}°)`); break; }
  }
  if (!c.open) {
    const gapEnd = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    if (gapEnd > 30) issues.push(`loop doesn't close: the end is ${Math.round(gapEnd)}m from the start`);
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < S.n; i++) { lo = Math.min(lo, S.y[i]); hi = Math.max(hi, S.y[i]); }
  const arena: ArenaDef = { id: c.id, name: c.name, desc: c.desc, theme: c.theme, track, markers };
  (arena as ArenaDef & { segCourse?: SegCourse }).segCourse = c;
  return { arena, issues, length: Math.round(total), rise: +(hi - lo).toFixed(1) };
}

/** slowest speed (m/s) that clears a segment's gap — calibrated against the sim (a blade's width bridges ~1.8m) */
export function jumpSpeed(s: Seg, dropAfter = 0) {
  for (let v = 4; v <= 30; v += 0.25) if (jumpReach(v, s.lip ?? 0, dropAfter, rampLength(s)) >= (s.gap ?? 0) - 1.8) return v;
  return 0;
}

/** the run-up length of a segment's jump ramp */
export function rampLength(s: Seg) { return Math.min(12, Math.max(5, (s.len - Math.min(s.gap ?? 0, s.len * 0.8)) * 0.6)); }

/** the gap a jump has to clear at a given speed (metres), for the editor's jump check */
export function jumpReach(speed: number, lip: number, drop = 0, rampLen = 10) {
  // launch angle = the ramp's slope at the lip (h·u² rises 2h/len there); gravity as in the sim
  const g = 20, ang = Math.atan((2 * lip) / Math.max(1, rampLen));
  const vx = speed * Math.cos(ang), vy = speed * Math.sin(ang);
  const tUp = vy / g, hMax = (vy * vy) / (2 * g);
  // you leave from the top of the lip, so you also fall the lip height back to the road (+ any drop beyond)
  const tDown = Math.sqrt((2 * (hMax + lip + Math.max(0, drop))) / g);
  return vx * (tUp + tDown);
}

export const SEG_MARKER_KINDS: MarkerKind[] = ['arm', 'saw', 'bumper', 'pillar', 'spinpad', 'gem', 'checkpoint', 'hive', 'item', 'boost'];

// ================================================================== node courses (Track Studio)
/**
 * Node courses: the track is a smooth curve through points you place (x, z, height, tilt). Moving a point only
 * bends the curve next to it. Each stretch (point k to k+1) carries its own stuff: a jump at its end, rails,
 * boost, items and obstacles. Closed = race loop (last point joins the first); open = adventure (start to goal).
 */
export interface TrackNode { x: number; z: number; y: number; bank?: number; /** road width here (narrowing / widening); defaults to the course width */ w?: number }
export interface Span { gap?: number; lip?: number; rails?: boolean; boost?: boolean; items?: boolean; /** half-pipe road shape on this stretch */ pipe?: boolean; att?: SegAttach[] }
export interface NodeCourse {
  id: string; name: string; desc: string; theme: Theme; width: number;
  closed: boolean;
  nodes: TrackNode[];
  /** spans[k] runs from node k to node k+1 (and, when closed, the last runs back to node 0) */
  spans: Span[];
}

/** where each node sits along the sampled track (sample index), walking forward so loops stay in order */
export function nodeSampleIndex(S: TrackSamples, nodes: TrackNode[]) {
  const out: number[] = [];
  let from = 0;
  for (let k = 0; k < nodes.length; k++) {
    let best = from, bd = Infinity;
    const to = k === 0 ? Math.min(S.n - 1, 40) : S.n - 1;
    for (let i = from; i <= to; i++) {
      const d = (S.x[i] - nodes[k].x) ** 2 + (S.z[i] - nodes[k].z) ** 2;
      if (d < bd) { bd = d; best = i; }
      if (bd < 0.3 && d > bd + 400) break;
    }
    out.push(best);
    from = best;
  }
  return out;
}

export function nodeTrackDef(c: NodeCourse): TrackDef {
  return { pts: c.nodes.map((n) => [n.x, n.z, n.y] as [number, number, number]), banks: c.nodes.map((n) => n.bank ?? 0), widths: c.nodes.map((n) => n.w ?? c.width), width: c.width, rails: [], gaps: [], boosts: [], items: [], ramps: [], open: !c.closed, autoKick: false };
}

/** the stretches of a node course as distances along the sampled track */
export function spanRanges(c: NodeCourse, S: TrackSamples) {
  const ni = nodeSampleIndex(S, c.nodes);
  const count = c.closed ? c.nodes.length : c.nodes.length - 1;
  const out: { start: number; end: number; i0: number; i1: number }[] = [];
  for (let k = 0; k < count; k++) {
    const i0 = ni[k], i1 = k + 1 < c.nodes.length ? ni[k + 1] : S.n - 1;
    out.push({ start: S.cum[i0], end: Math.max(S.cum[i0] + 1, k + 1 < c.nodes.length ? S.cum[i1] : S.total), i0, i1 });
  }
  return out;
}

/** node course to arena (same output as segment courses, so physics / camera / AI / rendering are shared) */
export function compileNodeCourse(c: NodeCourse, checks = true): CompiledCourse {
  const track = nodeTrackDef(c);
  const S0 = sampleTrack(track);
  const total = S0.total;
  const ranges = spanRanges(c, S0);
  const F = (d: number) => Math.max(0, Math.min(1, d / total));
  ranges.forEach(({ start, end }, k) => {
    const sp = c.spans[k] ?? {};
    const len = end - start;
    if (sp.rails) track.rails.push([F(start), F(end)]);
    if (sp.pipe) (track.pipes ??= []).push([F(start), F(end)]);
    if (sp.boost) track.boosts.push(F(start + Math.min(4, len * 0.2)));
    if (sp.items) track.items.push(F((start + end) / 2));
    const gap = Math.min(sp.gap ?? 0, len * 0.8);
    if (gap > 0) track.gaps.push([F(end - gap), F(end)]);
    if ((sp.lip ?? 0) > 0) track.ramps!.push({ f: F(end - gap), len: Math.min(12, Math.max(5, (len - gap) * 0.6)), h: sp.lip! });
  });
  if (track.pipes) track.depth = 3;
  const S = sampleTrack(track);
  const half = c.width / 2;
  const at = (d: number) => Math.max(0, Math.min(S.n - 1, Math.round(F(d) * S.n)));
  // positions across the road use the local width, so obstacles stay on narrow sections
  const pos = (i: number, lat = 0) => ({ x: S.x[i] - S.tz[i] * lat * (S.w[i] / 2), z: S.z[i] + S.tx[i] * lat * (S.w[i] / 2), y: S.y[i] });
  const markers: Marker[] = [];
  for (const f of track.boosts) { const i = at(f * total); markers.push({ kind: 'boost', ...pos(i), rot: Math.atan2(S.tx[i], S.tz[i]), r: S.w[i] * 0.36 }); }
  for (const f of track.items) { const i = at(f * total); for (const o of [-0.6, 0, 0.6]) markers.push({ kind: 'item', ...pos(i, o) }); }
  ranges.forEach(({ start, end }, k) => {
    for (const a of c.spans[k]?.att ?? []) {
      const i = at(start + a.at * (end - start));
      const p = pos(i, a.lat ?? 0), yaw = Math.atan2(S.tx[i], S.tz[i]);
      switch (a.kind) {
        case 'arm': { const side = (a.lat ?? 1) >= 0 ? 1 : -1; markers.push({ kind: 'arm', ...pos(i, side * 0.85), len: a.size ?? c.width * 0.8, speed: a.speed ?? 1.2, rot: Math.atan2(-S.tx[i] * side, S.tz[i] * side) }); break; }
        case 'saw': markers.push({ kind: 'saw', ...p, r: a.size ?? c.width * 0.28, speed: a.speed ?? 1.1 }); break;
        case 'bumper': markers.push({ kind: 'bumper', ...p, r: a.size ?? 0.85 }); break;
        case 'pillar': markers.push({ kind: 'pillar', ...p, r: a.size ?? 0.7 }); break;
        case 'spinpad': markers.push({ kind: 'spinpad', ...p, r: a.size ?? 1.4 }); break;
        case 'gem': markers.push({ kind: 'gem', ...p }); break;
        case 'item': markers.push({ kind: 'item', ...p }); break;
        case 'boost': markers.push({ kind: 'boost', ...p, rot: yaw, r: a.size ?? c.width * 0.3 }); break;
        case 'checkpoint': markers.push({ kind: 'checkpoint', ...pos(i), rot: yaw, r: Math.max(2.2, half - 0.3) }); break;
        case 'hive': markers.push({ kind: 'hive', ...p, r: a.size ?? Math.max(8, c.width), len: 2 }); break;
      }
    }
  });
  for (let k = 0; k < 8; k++) {
    const i = !c.closed ? Math.min(S.n - 1, 8 + Math.floor(k / 2) * 6) : (S.n - 6 - Math.floor(k / 2) * 6 + S.n) % S.n;
    markers.push({ kind: 'spawn', ...pos(i, k % 2 ? 0.45 : -0.45) });
  }
  if (!c.closed) { const g = Math.max(0, S.n - 10); markers.push({ kind: 'goal', ...pos(g), r: Math.max(2.6, half * 0.8), rot: Math.atan2(S.tx[g], S.tz[g]) }); }
  const issues: string[] = [];
  const spots: { d: number; msg: string }[] = [];
  if (checks) {
    // every place the road passes over itself at a different height (each crossing reported once)
    let lastJ = -1e9;
    for (let i = 0; i < S.n; i += 4) for (let j = i + 40; j < S.n; j += 4) {
      if (c.closed && S.n - (j - i) < 40) continue;
      const dy = Math.abs(S.y[i] - S.y[j]);
      // level crossings are fine; so are bridges with headroom (a blade + road needs ~3.5m)
      if (Math.hypot(S.x[i] - S.x[j], S.z[i] - S.z[j]) < c.width + 1.5 && dy > 0.4 && dy < 3.5) {
        if (Math.abs(S.cum[j] - lastJ) < 30) continue;
        lastJ = S.cum[j];
        const msg = `crossing at ${Math.round(S.cum[i])}m / ${Math.round(S.cum[j])}m is ${dy.toFixed(1)}m apart: make it level, or at least 3.5m apart for a bridge`;
        if (issues.length < 6) issues.push(msg);
        spots.push({ d: S.cum[i], msg: 'crossing' }, { d: S.cum[j], msg: 'crossing' });
        i += 20;
        break;
      }
    }
    let lastS = -1e9;
    for (let i = 4; i < S.n; i += 4) {
      const slope = Math.abs(S.y[i] - S.y[i - 4]) / 2;
      if (slope > 0.75 && S.cum[i] - lastS > 25) { lastS = S.cum[i]; issues.push(`too steep at ${Math.round(S.cum[i])}m (${Math.round(Math.atan(slope) * 57)}°): spread the height change over more distance`); spots.push({ d: S.cum[i], msg: 'too steep' }); }
    }
    let lastB = -1e9;
    for (let i = 0; i < S.n; i++) if (Math.abs(S.curv[i]) > 0.12 && S.cum[i] - lastB > 25) { lastB = S.cum[i]; issues.push(`very tight bend at ${Math.round(S.cum[i])}m: move those points further apart`); spots.push({ d: S.cum[i], msg: 'tight bend' }); }
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < S.n; i++) { lo = Math.min(lo, S.y[i]); hi = Math.max(hi, S.y[i]); }
  const arena: ArenaDef = { id: c.id, name: c.name, desc: c.desc, theme: c.theme, track, markers };
  return { arena, issues, length: Math.round(total), rise: +(hi - lo).toFixed(1), spots };
}

/** convert a segment course (e.g. Rollercoaster Run) into editable points: one at each segment end, more on big curves */
export function segToNodes(c: SegCourse): NodeCourse {
  const nodes: TrackNode[] = [{ x: 0, z: 0, y: 4, bank: 0 }];
  const spans: Span[] = [];
  let x = 0, z = 0, y = 4, h = 0;
  for (const s of c.segs) {
    const parts = Math.max(1, Math.ceil(Math.abs(s.turn ?? 0) / 50), Math.ceil(s.len / 60));
    for (let p = 0; p < parts; p++) {
      const steps = 8;
      for (let k = 0; k < steps; k++) {
        const dl = s.len / parts / steps;
        h += (((s.turn ?? 0) * Math.PI) / 180) / parts / steps;
        x += Math.cos(h) * dl; z -= Math.sin(h) * dl;
      }
      y += (s.climb ?? 0) / parts;
      nodes.push({ x: +x.toFixed(2), z: +z.toFixed(2), y: +y.toFixed(2), bank: s.bank ?? 0 });
      const last = p === parts - 1;
      spans.push({
        rails: s.rails, boost: p === 0 ? s.boost : undefined, items: p === Math.floor(parts / 2) ? s.items : undefined,
        gap: last ? s.gap : undefined, lip: last ? s.lip : undefined,
        att: (s.att ?? []).filter((a) => Math.min(parts - 1, Math.floor(a.at * parts)) === p).map((a) => ({ ...a, at: a.at * parts - p })),
      });
    }
  }
  return { id: c.id, name: c.name, desc: c.desc, theme: c.theme, width: c.width, closed: !c.open, nodes, spans };
}
