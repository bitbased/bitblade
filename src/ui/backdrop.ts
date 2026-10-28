// Living 3D backdrop behind menus: an endless CPU free-for-all with an orbiting camera.
import { Sim } from '../game/sim';
import { GameView } from '../game/render';
import { BUILTIN_ARENAS } from '../game/terrain';
import { PRESETS } from '../core/blade';
import type { MatchConfig } from '../game/types';

let view: GameView | null = null;
let sim: Sim | null = null;
let visible = false;
let canvasRef: HTMLCanvasElement | null = null;
let arenaIdx = 0;

function start(canvas: HTMLCanvasElement) {
  const arenas = BUILTIN_ARENAS.filter((a) => a.id !== 'gauntlet-works');
  const arena = arenas[arenaIdx++ % arenas.length];
  const picks = [...PRESETS].sort(() => Math.random() - 0.5).slice(0, 4);
  const cfg: MatchConfig = {
    mode: 'ffa', arena, items: true, target: 999, timeLimit: 9999, seed: (Math.random() * 1e9) | 0,
    players: picks.map((b, i) => ({ slot: i, name: b.name, team: i, blade: b, ctrl: { type: 'cpu', level: 3 } })),
  };
  view?.dispose();
  view = new GameView(canvas, cfg);
  view.attract = true;
  sim = new Sim(cfg);
}

export function setBackdropVisible(v: boolean, canvas?: HTMLCanvasElement) {
  if (canvas) canvasRef = canvas;
  visible = v;
  if (v && !view && canvasRef) start(canvasRef);
  if (!v && view) { view.dispose(); view = null; sim = null; }
}

export function updateBackdrop(dt: number) {
  if (!visible || !view || !sim) return;
  const s = sim.s;
  for (let k = 0; k < 2; k++) sim.step(1 / 120);
  // keep the launch snappy and auto-restart when a round ends
  if (s.phase === 'launch' && s.phaseT > 0.5) s.phaseT = Math.max(s.phaseT, 2.95);
  view.handleEvents(s.events.splice(0), s);
  view.update(s, dt, 0);
  view.render();
  if (s.phase === 'roundEnd' || s.phase === 'matchEnd' || (s.phase === 'battle' && s.phaseT > 45)) {
    if (s.phaseT > 2.5 || s.phase === 'battle') start(canvasRef!);
  }
}

export function resizeBackdrop() { view?.onResize(); }
