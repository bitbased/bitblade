// Living 3D backdrop behind menus: CPUs battling with an orbiting camera. The lobby pins it to the
// selected arena + mode so the background previews what you're about to play.
import { Sim } from '../game/sim';
import { GameView } from '../game/render';
import { BUILTIN_ARENAS, findArena, type ArenaDef } from '../game/terrain';
import { PRESETS } from '../core/blade';
import type { MatchConfig, ModeId } from '../game/types';

let view: GameView | null = null;
let sim: Sim | null = null;
let visible = false;
let canvasRef: HTMLCanvasElement | null = null;
let arenaIdx = 0;
let pinned: { arena: ArenaDef; mode: ModeId } | null = null;

function start(canvas: HTMLCanvasElement) {
  let arena: ArenaDef;
  let mode: ModeId = 'ffa';
  if (pinned) {
    arena = pinned.arena;
    mode = pinned.mode;
  } else {
    const arenas = BUILTIN_ARENAS.filter((a) => a.id !== 'gauntlet-works' && !a.track);
    arena = arenas[arenaIdx++ % arenas.length];
  }
  // pick a CPU-friendly variant of the mode for the preview
  let simMode: ModeId = 'ffa';
  if (arena.track) simMode = 'race';
  else if (mode === 'ctf' && arena.markers.some((m) => m.kind === 'flag')) simMode = 'ctf';
  else if (mode === 'rush' || mode === 'koth') simMode = mode;
  const n = simMode === 'race' ? 6 : simMode === 'ctf' ? 4 : 4;
  const picks = [...PRESETS].sort(() => Math.random() - 0.5).slice(0, n);
  const cfg: MatchConfig = {
    mode: simMode, arena, items: true, target: simMode === 'race' ? 99 : 999, timeLimit: 9999, seed: (Math.random() * 1e9) | 0,
    players: picks.map((b, i) => ({ slot: i, name: b.name, team: simMode === 'ctf' ? i % 2 : i, blade: b, ctrl: { type: 'cpu', level: 3 } })),
  };
  view?.dispose();
  view = new GameView(canvas, cfg);
  view.attract = !arena.track;
  sim = new Sim(cfg);
}

export function setBackdropVisible(v: boolean, canvas?: HTMLCanvasElement) {
  if (canvas) canvasRef = canvas;
  visible = v;
  if (!v) pinned = null;
  if (v && !view && canvasRef) start(canvasRef);
  if (!v && view) { view.dispose(); view = null; sim = null; }
}

/** Show a specific arena/mode behind the menus (lobby preview). */
export function setBackdropArena(arena: string | ArenaDef, mode: ModeId) {
  const def = typeof arena === 'string' ? findArena(arena) : arena;
  if (pinned && pinned.arena.id === def.id && pinned.mode === mode) return;
  pinned = { arena: def, mode };
  if (visible && canvasRef) start(canvasRef);
}

/** Return to the rotating showcase. */
export function unpinBackdrop() {
  if (!pinned) return;
  pinned = null;
  if (visible && canvasRef) start(canvasRef);
}

export function updateBackdrop(dt: number) {
  if (!visible || !view || !sim) return;
  const s = sim.s;
  for (let k = 0; k < 2; k++) sim.step(1 / 120);
  if (s.phase === 'launch' && s.phaseT > 0.5) s.phaseT = Math.max(s.phaseT, 2.95);
  view.handleEvents(s.events.splice(0), s);
  view.update(s, dt, 0);
  view.render();
  if (s.phase === 'roundEnd' || s.phase === 'matchEnd' || (s.phase === 'battle' && s.phaseT > (sim.cfg.mode === 'race' ? 120 : 45))) {
    if (s.phaseT > 2.5 || s.phase === 'battle') start(canvasRef!);
  }
}

export function resizeBackdrop() { view?.onResize(); }
