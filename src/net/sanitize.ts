// What a party leader sends members (the match config, lobby state, custom arenas) brought within what the game can
// make, before anything uses it. The leader is trusted to run the match — not to decide how big things are: a
// patched leader could otherwise send a course the size of a city, 10⁶ markers or a blade with 10⁹ wings and freeze
// every member's browser. (Blades: core/blade.ts sanitizeBlade. Songs: roomMusic.ts acceptSong.)
import { sanitizeBlade, PRESETS } from '../core/blade';
import { findArena, BUILTIN_ARENAS, type ArenaDef } from '../game/terrain';
import { MODES, type MatchConfig, type ControllerSpec, type PlayerSetup } from '../game/types';
import { acceptSong } from '../ui/roomMusic';
import { safeColor } from '../core/safe';

const LIMITS = {
  /** course builder: tiles across / down, and a tile's size */
  courseW: 64, courseTile: 24, pieces: 4096,
  /** track studio: control points, and anything listed along the lap */
  trackPts: 400, trackSpans: 200, trackWidth: 60,
  markers: 600, rails: 200, railPts: 400, ramps: 60,
  /** any coordinate / size (metres) */
  coord: 5000,
};

/** a JSON value cleaned: numbers finite and bounded, strings short, arrays capped, no deep nesting or prototype keys */
function clean(v: unknown, depth = 0, maxArr = 400): unknown {
  if (depth > 8) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(-LIMITS.coord, Math.min(LIMITS.coord, v)) : 0;
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, maxArr).map((x) => clean(x, depth + 1, maxArr));
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') o[k] = clean(x, depth + 1, maxArr);
    return o;
  }
  return undefined;
}
const arr = <T,>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
const int = (v: unknown, lo: number, hi: number, d: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };

/** an arena from the leader: a built-in one is ours (by id — whatever was sent with it is ignored); a custom course /
 *  track is size-checked */
export function sanitizeArena(raw: unknown): ArenaDef {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const builtin = BUILTIN_ARENAS.find((a) => a.id === r.id);
  if (builtin && !r.custom) return builtin;
  const a = clean(r, 0, Math.max(LIMITS.pieces, LIMITS.markers)) as Record<string, any>;
  const out: any = { ...a, id: String(a.id ?? 'custom').replace(/[^\w-]/g, '').slice(0, 64) || 'custom', name: String(a.name ?? 'Custom').slice(0, 40), desc: String(a.desc ?? '').slice(0, 200), custom: true };
  const t = a.theme ?? {};
  out.theme = { floor: safeColor(t.floor, '#334'), wall: safeColor(t.wall, '#556'), glow: safeColor(t.glow, '#3cf2ff'), sky1: safeColor(t.sky1, '#001'), sky2: safeColor(t.sky2, '#112'), grid: safeColor(t.grid, '#3cf2ff') };
  out.markers = arr(a.markers, LIMITS.markers);
  if (a.course) out.course = { tile: Math.max(1, Math.min(LIMITS.courseTile, Number(a.course.tile) || 6)), w: int(a.course.w, 1, LIMITS.courseW, 8), h: int(a.course.h, 1, LIMITS.courseW, 8), pieces: arr(a.course.pieces, LIMITS.pieces) };
  if (a.track) {
    const tr = a.track;
    out.track = { ...tr, pts: arr(tr.pts, LIMITS.trackPts), width: Math.max(2, Math.min(LIMITS.trackWidth, Number(tr.width) || 10)),
      rails: arr(tr.rails, LIMITS.trackSpans), gaps: arr(tr.gaps, LIMITS.trackSpans), boosts: arr(tr.boosts, LIMITS.trackSpans), items: arr(tr.items, LIMITS.trackSpans) };
    if (out.track.pts.length < 3) return findArena('neon-circuit');
  }
  if (a.rails) out.rails = arr<any>(a.rails, LIMITS.rails).map((x) => ({ ...x, pts: arr(x?.pts, LIMITS.railPts) }));
  if (a.ramps) out.ramps = arr(a.ramps, LIMITS.ramps);
  if (a.stadium) out.stadium = { ...a.stadium, sides: int(a.stadium.sides, 0, 64, 0), pockets: int(a.stadium.pockets, 0, 32, 0) };
  if (!out.course && !out.track && !out.stadium) return findArena('crater');
  return out as ArenaDef;
}

const CTRL = new Set(['kb', 'kb1', 'kb2', 'mouse', 'touch', 'pad', 'cpu', 'remote']);
function sanitizeCtrl(raw: unknown): ControllerSpec {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  if (!CTRL.has(c.type)) return { type: 'remote', peer: -1 };
  if (c.type === 'cpu') return { type: 'cpu', level: int(c.level, 1, 3, 2) as 1 | 2 | 3 };
  if (c.type === 'pad') return { type: 'pad', index: int(c.index, 0, 15, 0) };
  if (c.type === 'remote') return { type: 'remote', peer: int(c.peer, -1, 1e6, -1) };
  return { type: c.type } as ControllerSpec;
}

/** the leader's match config, as a member's game will use it */
export function sanitizeMatchConfig(raw: unknown): MatchConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const mode = MODES.some((m) => m.id === r.mode) ? r.mode : 'ffa';
  const players: PlayerSetup[] = arr<any>(r.players, 8).map((p, i) => ({
    slot: int(p?.slot, 0, 15, i), name: String(p?.name ?? `Player ${i + 1}`).slice(0, 24), team: int(p?.team, 0, 7, 0),
    blade: sanitizeBlade(p?.blade) ?? PRESETS[i % PRESETS.length], ctrl: sanitizeCtrl(p?.ctrl),
  }));
  const cfg: MatchConfig = {
    mode, arena: sanitizeArena(r.arena), players, items: !!r.items,
    target: int(r.target, 0, 9999, 3), timeLimit: int(r.timeLimit, 0, 36000, 120), seed: int(r.seed, 0, 2 ** 31 - 1, 1),
  };
  if (r.rubber !== undefined) cfg.rubber = int(r.rubber, 0, 2, 1);
  if (r.nudge !== undefined) cfg.nudge = !!r.nudge;
  if (r.kothShare !== undefined) cfg.kothShare = !!r.kothShare;
  const song = r.song ? acceptSong(r.song) : null;
  if (song) cfg.song = song;
  return cfg;
}
