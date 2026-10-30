// Course Lab: build skate-park courses by connecting pool pieces on a tile grid, then place hazards/markers.
// Tools: Paint · Level · Erase · Place · Select · Eyedropper. Live ghost preview of the exact piece geometry,
// auto-orienting walls, drag-to-aim/size markers, brush + rectangle fill, mirror symmetry, templates.
import * as THREE from 'three';
import { testRide } from './testRide';
import { allSongs, songById } from '../game/music';
import { PadCursor } from './padCursor';
import './courseDesigner.css';
import { h, type App, type Screen } from './app';
import { icon } from './icons';
import { getRenderer, buildArenaMesh, buildSky, buildRailMeshes } from '../game/render';
import { arenaRails, pinballStarter, railPolyline, rampRails, segDist, tiltLift, type Rail } from '../game/pinball';
import { hazardPose } from '../game/hazards';
import {
  Terrain, VOID, PIECES, THEMES, BUILTIN_ARENAS, loadCustomArenas, saveCustomArenas, courseHeight, pieceAt,
  type ArenaDef, type Marker, type MarkerKind, type PieceKind, type Piece, type CourseDef,
} from '../game/terrain';

const LEVEL_H = 1.6;
const MAX_GRID = 40;
const TEAM_COL = ['#ff3b4a', '#3b8bff'];

type Tool = 'paint' | 'level' | 'erase' | 'place' | 'select' | 'pick' | 'wall';
const TOOLS: { id: Tool; icon: string; label: string; key: string; tip: string }[] = [
  { id: 'paint', icon: 'ramp', label: 'Paint', key: 'B', tip: 'Paint pieces (B) — Shift-drag fills a rectangle, wheel / Q / E rotates' },
  { id: 'level', icon: 'arrowUp', label: 'Level', key: 'L', tip: 'Raise (click) / lower (right-click) tile level (L)' },
  { id: 'erase', icon: 'close', label: 'Erase', key: 'X', tip: 'Erase tiles or markers (X) — Shift-drag erases a rectangle' },
  { id: 'place', icon: 'star', label: 'Place', key: 'P', tip: 'Place items & hazards (P) — click to place, drag to aim / size' },
  { id: 'select', icon: 'target', label: 'Select', key: 'V', tip: 'Select & move markers (V) — drag handles to resize / aim' },
  { id: 'pick', icon: 'eye', label: 'Pick', key: 'I', tip: 'Eyedropper (I) — copy a tile or marker type' },
  { id: 'wall', icon: 'road', label: 'Walls', key: 'C', tip: 'Curved walls (C) — click points along the wall, click the last point again (or Enter) to finish; Esc cancels. Works on any course. Erase removes walls' },
];

interface MarkerInfo { kind: MarkerKind; label: string; color: string; icon: string; drag: 'none' | 'aim' | 'radius' | 'arm' | 'orbit' | 'kick'; tip: string; pin?: boolean }
const MARKERS: MarkerInfo[] = [
  { kind: 'spawn', label: 'Spawn', color: '#ffffff', icon: 'play', drag: 'none', tip: 'Where blades launch from' },
  { kind: 'item', label: 'Item Box', color: '#b46bff', icon: 'star', drag: 'none', tip: 'Random power-up box' },
  { kind: 'boost', label: 'Boost Pad', color: '#ffe23a', icon: 'bolt', drag: 'aim', tip: 'Drag to aim the push direction' },
  { kind: 'bumper', label: 'Bumper', color: '#ff3db4', icon: 'burst', drag: 'radius', tip: 'Pinball bumper — drag to size' },
  { kind: 'arm', label: 'Sweeper', color: '#ffb000', icon: 'swords', drag: 'arm', tip: 'Rotating arm — drag sets length & start angle' },
  { kind: 'saw', label: 'Saw Orbit', color: '#ff2a2a', icon: 'target', drag: 'orbit', tip: 'Saw circling this point — drag sets orbit radius' },
  { kind: 'pillar', label: 'Pillar', color: '#8a8aa8', icon: 'hex', drag: 'radius', tip: 'Solid pillar — drag to size' },
  { kind: 'spinpad', label: 'Spin Pad', color: '#38ffb0', icon: 'swirl', drag: 'radius', tip: 'Recharges spin — drag to size' },
  { kind: 'flag', label: 'Flag Base', color: '#ff3b4a', icon: 'finish', drag: 'none', tip: 'CTF core base (team)' },
  { kind: 'zone', label: 'Hill Zone', color: '#ffd23a', icon: 'crown', drag: 'radius', tip: 'King-of-the-Hill zone — drag to size' },
  { kind: 'gem', label: 'Gem', color: '#ff5cf4', icon: 'gem', drag: 'none', tip: 'Gem spot (Gauntlet) / collectible gem (Quest)' },
  { kind: 'checkpoint', label: 'Checkpoint', color: '#38ffb0', icon: 'finish', drag: 'aim', tip: 'Quest checkpoint: respawn point + spin refill. Place them in level order; drag to turn the gate' },
  { kind: 'goal', label: 'Goal', color: '#ffd23a', icon: 'trophy', drag: 'radius', tip: 'Quest finish: reaching it clears the level (adds the course to Blade Quest)' },
  { kind: 'hive', label: 'Drone Hive', color: '#ff2244', icon: 'skull', drag: 'radius', tip: 'Spawns drones that guard this zone and chase anyone inside — drag sets the zone. On a pinball table: lighting its rollover group launches the swarm' },
  // pinball pieces (any course can use them: a flipper on a skate course is a trap that fires when you roll onto it)
  { kind: 'flipper', label: 'Flipper', color: '#ffffff', icon: 'arrowUp', drag: 'arm', pin: true, tip: 'Flipper — drag from the pivot to the tip. Pointing right = left button, pointing left = right button. On a regular course it fires by itself' },
  { kind: 'plunger', label: 'Plunger', color: '#ffd23a', icon: 'arrowUp', drag: 'none', pin: true, tip: 'Plunger — where the ball waits; hold ↓ to pull, let go to fire it up the lane' },
  { kind: 'target', label: 'Target', color: '#ffd23a', icon: 'target', drag: 'none', pin: true, tip: 'Stand-up target — light every target for MULTIBALL' },
  { kind: 'drop', label: 'Drop Target', color: '#ff9a2a', icon: 'shield', drag: 'kick', pin: true, tip: 'Drop target — drag to face it. Plates with the same bank number form a bank (all down: bonus, and it opens arenas of that number)' },
  { kind: 'saucer', label: 'Saucer / Lock', color: '#38ffb0', icon: 'swirl', drag: 'kick', pin: true, tip: 'Capture saucer — catches the ball, spins it up, kicks it out the way you drag. Make it an aim lock in its settings. Same number = linked wormholes' },
  { kind: 'rollover', label: 'Rollover', color: '#ffd23a', icon: 'hex', drag: 'none', pin: true, tip: 'Lane rollover — a burst of spin; rollovers with the same group light up together for a bonus' },
  { kind: 'kickback', label: 'Kickback', color: '#38ffb0', icon: 'arrowUp', drag: 'kick', pin: true, tip: 'Kickback — fires the ball back the way you drag (outlane saver), then recharges' },
  { kind: 'post', label: 'Center Post', color: '#3cf2ff', icon: 'hex', drag: 'none', pin: true, tip: 'Center post — rises between the flippers while ball save runs' },
  { kind: 'portal', label: 'Portal', color: '#b46bff', icon: 'swirl', drag: 'kick', pin: true, tip: 'Portal — in one, out of its pair (same number); drag sets the exit direction' },
  { kind: 'arena', label: 'Arena Bowl', color: '#ff2a6d', icon: 'stadium', drag: 'radius', pin: true, tip: 'Battle bowl — a drop bank with the same number unlocks it; roll in for a 1v1 battle or king of the hill. Drag to size' },
];
const MINFO = Object.fromEntries(MARKERS.map((m) => [m.kind, m])) as Record<MarkerKind, MarkerInfo>;

// "high edge" per rot (verified against courseHeight): rot0 +z, rot1 -x, rot2 -z, rot3 +x
const EDGE_DIR: [number, number][] = [[0, 1], [-1, 0], [0, -1], [1, 0]];
const CORNER_DIR: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
// mirror rotation maps (verified numerically for every piece kind)
const MX_EDGE = [0, 3, 2, 1], MZ_EDGE = [2, 1, 0, 3], MX_CORN = [1, 0, 3, 2], MZ_CORN = [3, 2, 1, 0];
const DIRECTIONAL = new Set<PieceKind>(['quarter', 'half', 'corner', 'kicker', 'spine', 'ramp', 'wall', 'bank', 'stairs', 'bumps']);
const PIECE_ABBR: Record<PieceKind, string> = { flat: 'F', bowl: 'B', quarter: 'Q', half: 'H', corner: 'C', kicker: 'K', spine: 'S', hump: 'X', ramp: 'R', pit: 'P', wall: 'W', dome: 'D', cradle: 'U', bank: 'N', pyramid: 'Y', volcano: 'V', bumps: '~', stairs: 'T' };
const PIECE_COL: Record<PieceKind, string> = { flat: '#39405e', bowl: '#2a6f9e', quarter: '#3d7fcf', half: '#4f63d6', corner: '#3b9ec9', kicker: '#d9a326', spine: '#c95c2a', hump: '#7d58c9', ramp: '#3fae6a', pit: '#111', wall: '#8a8aa8', dome: '#a2468f', cradle: '#26897a', bank: '#5a8f3a', pyramid: '#b0607a', volcano: '#c23a1e', bumps: '#3a8f8f', stairs: '#7a9f3a' };
const PIECE_GROUPS: { label: string; kinds: PieceKind[] }[] = [
  // (no separate Corner: a corner is the quarter pipe aimed at a tile corner)
  { label: 'POOL', kinds: ['flat', 'quarter', 'half', 'bowl', 'cradle'] },
  { label: 'STREET', kinds: ['kicker', 'bank', 'hump', 'pyramid', 'wall', 'stairs'] },
  { label: 'FEATURES', kinds: ['spine', 'dome', 'volcano', 'bumps', 'ramp', 'pit'] },
];

type TemplateId = 'empty' | 'pool' | 'halfpipe' | 'bowls' | 'plaza' | 'ctf' | 'questrun' | 'questworld' | 'pinball';
const TEMPLATES: { id: TemplateId; label: string; w: number; h: number }[] = [
  { id: 'pool', label: 'Walled pool', w: 5, h: 4 },
  { id: 'empty', label: 'Empty deck (open edges)', w: 5, h: 5 },
  { id: 'halfpipe', label: 'Half-pipe run', w: 7, h: 2 },
  { id: 'bowls', label: 'Bowl complex', w: 6, h: 5 },
  { id: 'plaza', label: 'Street plaza', w: 6, h: 5 },
  { id: 'ctf', label: 'CTF symmetric', w: 8, h: 4 },
  { id: 'questrun', label: 'Quest: linear run', w: 20, h: 2 },
  { id: 'questworld', label: 'Quest: open world', w: 12, h: 12 },
  { id: 'pinball', label: 'Pinball table', w: 4, h: 7 },
];

const TEST_MODES: { id: string; label: string }[] = [
  { id: 'quest', label: 'Blade Quest' }, { id: 'rush', label: 'Crystal Rush' }, { id: 'ffa', label: 'Free-for-all' }, { id: 'ctf', label: 'Capture the Flag' }, { id: 'koth', label: 'King of the Hill' }, { id: 'gauntlet', label: 'Gauntlet' }, { id: 'duel', label: 'Duel' }, { id: 'pinball', label: 'Pinball' },
];

type SnapMode = 'grid' | 'tile' | 'off';
const SNAP_LABEL: Record<SnapMode, string> = { grid: 'SNAP 0.5m', tile: 'SNAP TILE', off: 'SNAP OFF' };

function pieceIcon(kind: PieceKind, rot = 0, S = 40) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const c: CourseDef = { tile: 6, w: 1, h: 1, pieces: [{ kind, x: 0, y: 0, rot, level: 0 }] };
  const img = ctx.createImageData(S, S);
  for (let py = 0; py < S; py++)
    for (let px = 0; px < S; px++) {
      const x = ((px + 0.5) / S - 0.5) * 6, z = ((py + 0.5) / S - 0.5) * 6;
      const hh = courseHeight(c, x, z);
      const k = (py * S + px) * 4;
      if (hh <= VOID) { img.data[k] = 5; img.data[k + 1] = 6; img.data[k + 2] = 10; }
      else {
        const b = Math.max(0, Math.min(1, 0.3 + hh * 0.3));
        img.data[k] = 30 + b * 40; img.data[k + 1] = 60 + b * 170; img.data[k + 2] = 100 + b * 155;
      }
      img.data[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const mm of list) {
      const anyM = mm as THREE.Material & { map?: THREE.Texture | null; emissiveMap?: THREE.Texture | null };
      anyM.map?.dispose();
      anyM.emissiveMap?.dispose();
      mm.dispose();
    }
  });
}

function themeKey(t: ArenaDef['theme']) {
  for (const [k, v] of Object.entries(THEMES)) if (JSON.stringify(v) === JSON.stringify(t)) return k;
  return '';
}

const pcs = (kind: PieceKind, x: number, y: number, rot = 0, level = 0): Piece => ({ kind, x, y, rot, level });
const newId = () => 'course-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

/** outward-facing walls around a set of pieces (shared by templates and "Wrap with walls") */
function wrapWalls(c: CourseDef) {
  for (const p of c.pieces) {
    const outs = outsideDirs(c, p.x, p.y);
    if (!outs.length) continue;
    const o = orientFromOuts(outs, 'quarter');
    if (o) { p.kind = o.kind; p.rot = o.rot; }
  }
}

function outsideDirs(c: CourseDef, i: number, j: number) {
  const out: number[] = [];
  for (let d = 0; d < 4; d++) {
    const [dx, dz] = EDGE_DIR[d];
    if (!pieceAt(c, i + dx, j + dz)) out.push(d);
  }
  return out;
}

/** quarter-ish orientation from outside edges: 1 → quarter, 2 adjacent → corner, 2 opposite → half */
function orientFromOuts(outs: number[], kind: PieceKind): { kind: PieceKind; rot: number } | null {
  if (!outs.length) return null;
  if (outs.length === 1) return { kind, rot: outs[0] };
  if (outs.length === 2) {
    const [a, b] = outs;
    if ((a + 2) % 4 === b) return kind === 'quarter' ? { kind: 'half', rot: a % 2 === 0 ? 0 : 1 } : { kind, rot: a };
    if (kind !== 'quarter' && kind !== 'corner') return { kind, rot: a };
    const dx = EDGE_DIR[a][0] + EDGE_DIR[b][0], dz = EDGE_DIR[a][1] + EDGE_DIR[b][1];
    const rot = CORNER_DIR.findIndex(([x, z]) => x === dx && z === dz);
    return { kind: 'corner', rot: Math.max(0, rot) };
  }
  // 3+ open sides: face the side opposite the only neighbour if any, else first
  const closed = [0, 1, 2, 3].find((d) => !outs.includes(d));
  return { kind, rot: closed !== undefined ? (closed + 2) % 4 : outs[0] };
}

function templateCourse(id: TemplateId, w: number, hh: number): { course: CourseDef; markers: Marker[] } {
  const c: CourseDef = { tile: 6, w, h: hh, pieces: [] };
  const fill = (kind: PieceKind = 'flat') => { for (let j = 0; j < hh; j++) for (let i = 0; i < w; i++) c.pieces.push(pcs(kind, i, j)); };
  const set = (kind: PieceKind, i: number, j: number, rot = 0, level = 0) => {
    const p = pieceAt(c, i, j);
    if (p) { p.kind = kind; p.rot = rot; p.level = level; }
  };
  const tcx = (i: number) => (i + 0.5) * 6 - (w * 6) / 2, tcz = (j: number) => (j + 0.5) * 6 - (hh * 6) / 2;
  const markers: Marker[] = [];
  switch (id) {
    case 'empty': fill(); markers.push({ kind: 'item', x: 0, z: 0 }); break;
    case 'pool': fill(); wrapWalls(c); markers.push({ kind: 'item', x: 0, z: 0 }); break;
    case 'halfpipe': fill(); wrapWalls(c); markers.push({ kind: 'item', x: tcx(1), z: 0 }, { kind: 'item', x: tcx(w - 2), z: 0 }, { kind: 'boost', x: 0, z: tcz(0) + 1, rot: Math.PI / 2 }); break;
    case 'bowls':
      fill(); wrapWalls(c);
      for (let j = 1; j < hh - 1; j++) for (let i = 1; i < w - 1; i++) if ((i + j) % 2 === 0) set(i % 4 === 1 ? 'bowl' : 'cradle', i, j);
      markers.push({ kind: 'zone', x: 0, z: 0, r: 2.6 }, { kind: 'item', x: tcx(1), z: tcz(1) }, { kind: 'item', x: tcx(w - 2), z: tcz(hh - 2) });
      break;
    case 'plaza':
      fill();
      if (w >= 4 && hh >= 4) {
        set('bank', 0, 1, 1); set('bank', w - 1, hh - 2, 3); set('stairs', 1, hh - 1, 0); set('pyramid', Math.floor(w / 2), Math.floor(hh / 2));
        set('hump', 1, 1); set('wall', w - 2, 0, 2); set('kicker', w - 2, hh - 2, 2); set('bumps', Math.floor(w / 2) - 1, 0, 1);
      }
      markers.push({ kind: 'item', x: tcx(1), z: tcz(2) }, { kind: 'item', x: tcx(w - 2), z: tcz(1) }, { kind: 'spinpad', x: 0, z: tcz(hh - 1), r: 1.1 });
      break;
    case 'questrun': {
      // a walled corridor with a kicker + gap in the middle, start on the left, goal on the right
      fill(); wrapWalls(c);
      const mid = Math.floor(w / 2);
      if (w >= 8) {
        for (let j = 0; j < hh; j++) { const p = pieceAt(c, mid, j); if (p) c.pieces.splice(c.pieces.indexOf(p), 1); set('kicker', mid - 1, j, 3); } // rot 3 launches +x, over the gap
      }
      for (let j = 0; j < hh; j++) markers.push({ kind: 'spawn', x: tcx(0), z: tcz(j) });
      markers.push({ kind: 'checkpoint', x: tcx(Math.min(w - 2, mid + 2)), z: tcz(0), r: 2.2 }, { kind: 'gem', x: tcx(2), z: tcz(0) }, { kind: 'gem', x: tcx(mid + 1), z: tcz(hh - 1) }, { kind: 'goal', x: tcx(w - 1), z: 0, r: 2.6 });
      break;
    }
    case 'questworld': {
      // open plaza with a raised middle reached by ramps, a drone hive guarding it, goal in the far corner
      fill(); wrapWalls(c);
      const ci = Math.floor(w / 2), cj = Math.floor(hh / 2);
      if (w >= 6 && hh >= 6) {
        for (let j = cj - 1; j <= cj; j++) for (let i = ci - 1; i <= ci; i++) set('flat', i, j, 0, 1);
        set('ramp', ci - 2, cj, 3, 0); set('ramp', ci, cj - 2, 0, 0); // rot 3 rises +x, rot 0 rises +z: both onto the plateau
      }
      markers.push({ kind: 'spawn', x: tcx(1), z: tcz(1) }, { kind: 'spawn', x: tcx(2), z: tcz(1) },
        { kind: 'hive', x: tcx(ci), z: tcz(cj), r: 8, len: 2 }, { kind: 'gem', x: tcx(ci), z: tcz(cj) - 2 }, { kind: 'gem', x: tcx(1), z: tcz(hh - 2) }, { kind: 'gem', x: tcx(w - 2), z: tcz(1) },
        { kind: 'checkpoint', x: tcx(w - 2), z: tcz(2), r: 2.2 }, { kind: 'goal', x: tcx(w - 2), z: tcz(hh - 2), r: 2.6 });
      break;
    }
    case 'ctf': {
      fill(); wrapWalls(c);
      const mid = Math.floor(w / 2);
      for (let j = 1; j < hh - 1; j++) { set('hump', mid - 1, j); set('hump', w - mid, j); }
      if (w >= 8 && hh >= 4) { set('pit', 2, 1); set('pit', w - 3, 1); set('bank', 2, hh - 2, 0); set('bank', w - 3, hh - 2, 0); }
      const fx = tcx(1);
      markers.push({ kind: 'flag', x: fx, z: 0, team: 0 }, { kind: 'flag', x: -fx, z: 0, team: 1 },
        { kind: 'spawn', x: fx, z: -2.5, team: 0 }, { kind: 'spawn', x: fx, z: 2.5, team: 0 }, { kind: 'spawn', x: -fx, z: -2.5, team: 1 }, { kind: 'spawn', x: -fx, z: 2.5, team: 1 },
        { kind: 'item', x: 0, z: 0 }, { kind: 'boost', x: fx * 0.5, z: tcz(0) + 1.5, rot: -Math.PI / 2 }, { kind: 'boost', x: -fx * 0.5, z: tcz(0) + 1.5, rot: Math.PI / 2 });
      break;
    }
  }
  return { course: c, markers };
}

export function mirrorMarker(m: Marker, axis: 'x' | 'z'): Marker {
  const n: Marker = { ...m };
  if (axis === 'x') n.x = -m.x; else n.z = -m.z;
  if (m.kind === 'boost') { const r = m.rot ?? 0; n.rot = axis === 'x' ? -r : Math.PI - r; }
  if (m.kind === 'arm' || m.kind === 'saw') {
    const a = m.rot ?? 0;
    n.rot = axis === 'x' ? Math.PI - a : -a;
    n.speed = -(m.speed ?? (m.kind === 'arm' ? 1 : 0.5));
  }
  if ((m.kind === 'spawn' || m.kind === 'flag') && m.team !== undefined) n.team = 1 - m.team;
  return n;
}

interface DragState {
  kind: 'paint' | 'rect' | 'place' | 'move' | 'handle';
  startCell?: { i: number; j: number };
  start?: { x: number; z: number };
  offset?: { x: number; z: number };
  moved?: boolean;
}

class CourseEditor {
  app: App;
  root: HTMLDivElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 800);
  arena: THREE.Group | null = null;
  sky: THREE.Group | null = null;
  markerGroup = new THREE.Group();
  markerObjs: THREE.Group[] = [];
  overlay = new THREE.Group(); // ghosts, outlines, arrows
  selRing: THREE.Mesh;
  handle: THREE.Mesh;
  aim: THREE.Group;
  terrain!: Terrain;
  custom: ArenaDef[] = [];
  def!: ArenaDef;
  tool: Tool = 'paint';
  pieceKind: PieceKind = 'quarter';
  paintRot = 0;
  paintLevel = 0;
  brush = 1;
  autoOrient = true;
  /** single-tile placement: the edge / corner of the tile under the cursor sets the rotation (no R needed) */
  aimCursor = true;
  symX = false;
  symZ = false;
  snap: SnapMode = 'grid';
  markerKind: MarkerKind = 'item';
  team: number | undefined = undefined;
  testMode = 'rush';
  hover: { i: number; j: number } | null = null;
  hoverPt: { x: number; z: number } | null = null;
  hoverMarker = -1;
  selected = -1;
  undo: string[] = [];
  redo: string[] = [];
  yaw = 0; pitch = 0.95; dist = 40;
  pad: PadCursor | null = null;
  padHint: HTMLElement | null = null;
  target = new THREE.Vector3();
  time = 0;
  rebuildT = -1;
  saveT = -1;
  drag: DragState | null = null;
  rightDown: { x: number; y: number; moved: boolean } | null = null;
  midDown: { x: number; y: number } | null = null;
  shift = false;
  delArmed = false;
  drawerOpen = false;
  overlayKey = '';
  ray = new THREE.Raycaster();
  mouse = { x: 0, y: 0 };
  el: Record<string, HTMLElement> = {};
  mini: HTMLCanvasElement | null = null;
  iconCache = new Map<string, HTMLCanvasElement>();

  constructor(app: App) {
    this.app = app;
    this.renderer = getRenderer(app.canvas).renderer;
    this.scene.environment = getRenderer(app.canvas).env;
    this.scene.environmentIntensity = 0.6;
    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#20140a', 0.8));
    const sun = new THREE.DirectionalLight('#ffffff', 2.0);
    sun.position.set(20, 50, 25);
    this.scene.add(sun, this.markerGroup, this.overlay);
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.15, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false, transparent: true, side: THREE.DoubleSide }));
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.renderOrder = 22;
    this.handle = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffd23a', toneMapped: false, depthTest: false }));
    this.handle.renderOrder = 23;
    this.aim = this.makeArrow('#ffd23a');
    this.aim.visible = false;
    this.scene.add(this.selRing, this.handle, this.aim);

    this.custom = loadCustomArenas().filter((a) => a.course);
    this.root = this.buildDom();
    this.pad = new PadCursor(app, this.root);
    this.padHint = h('div.cd-padhint', null, ...['Ⓐ use tool / click', 'Ⓧ erase', 'Ⓑ back', 'Ⓨ courses', 'LB RB rotate', '✚ ◀▶ tool · ▲▼ level', 'LT RT zoom', 'R-stick orbit', 'L3 frame', 'SELECT undo', 'START test'].map((t) => h('span', null, t)));
    this.root.append(this.padHint);
    app.root.appendChild(this.root);
    const back = testRide.from === 'courses' ? this.custom.find((a) => a.id === testRide.id) : undefined;
    testRide.from = null;
    const first = back ?? this.custom[0] ?? BUILTIN_ARENAS.find((a) => a.course)!;
    this.select(first);
    this.resize();
  }

  // ============================================================ DOM
  buildDom() {
    const view = h('div.cd-view', {
      onpointerdown: (e: PointerEvent) => this.onDown(e),
      onpointermove: (e: PointerEvent) => this.onMove(e),
      onpointerup: (e: PointerEvent) => this.onUp(e),
      onpointerleave: () => { this.hover = null; this.hoverPt = null; this.hoverMarker = -1; this.refreshOverlay(); },
      onwheel: (e: WheelEvent) => this.onWheel(e),
      oncontextmenu: (e: Event) => e.preventDefault(),
    });
    const tools = h('div.cd-tools');
    const drawer = h('div.cd-panel.cd-drawer.cd-hidden');
    const right = h('div.cd-panel.cd-right');
    const top = h('div.cd-top');
    const hint = h('div.cd-hint');
    const card = h('div.cd-card.cd-hidden');
    const tip = h('div.cd-tip.cd-hidden');
    this.el = { view, tools, drawer, right, top, hint, card, tip };
    const root = h<HTMLDivElement>('div.cd-root', null, view, tools, drawer, right, top, hint, card, tip);
    return root;
  }

  renderAll() {
    this.renderTools();
    this.renderDrawer();
    this.renderRight();
    this.renderTop();
    this.renderCard();
  }

  renderTools() {
    const T = this.el.tools;
    T.innerHTML = '';
    T.append(h('button.cd-tool' + (this.drawerOpen ? '.cd-on' : ''), { title: 'Courses & file (Tab)', onclick: () => this.toggleDrawer() }, icon('stadium'), h('span', null, 'Courses')));
    T.append(h('div.cd-sep'));
    for (const t of TOOLS)
      T.append(h('button.cd-tool' + (this.tool === t.id ? '.cd-on' : ''), { title: t.tip, onclick: () => this.setTool(t.id) }, icon(t.icon), h('span', null, t.label), h('kbd', null, t.key)));
    T.append(h('div.cd-sep'),
      h('button.cd-tool', { title: 'Undo (Ctrl+Z)', onclick: () => this.doUndo() }, icon('back'), h('span', null, 'Undo')),
      h('button.cd-tool', { title: 'Redo (Ctrl+Y)', onclick: () => this.doRedo() }, h('span.cd-flip', null, icon('back')), h('span', null, 'Redo')),
      h('div.cd-sep'),
      h('button.cd-tool', { title: 'Back to menu (Esc)', onclick: () => this.app.back() }, icon('close'), h('span', null, 'Exit')));
  }

  toggleDrawer() {
    this.drawerOpen = !this.drawerOpen;
    this.el.drawer.classList.toggle('cd-hidden', !this.drawerOpen);
    this.renderTools();
  }

  renderTop() {
    const T = this.el.top;
    T.innerHTML = '';
    const c = this.def.course!;
    const modeSel = h<HTMLSelectElement>('select.cd-input', { onchange: (e: Event) => { this.testMode = (e.target as HTMLSelectElement).value; } },
      ...TEST_MODES.map((m) => h('option', { value: m.id, selected: m.id === this.testMode }, m.label)));
    T.append(
      h('div.cd-top-name', { onclick: () => { if (!this.drawerOpen) this.toggleDrawer(); } },
        h('b', null, this.def.name), h('span', null, `${c.w}×${c.h} · ${this.def.custom ? 'auto-saved' : 'template — edits make your copy'}`)),
      modeSel,
      h('button.btn.cd-go', { title: 'Save and try it in the lobby', onclick: () => this.testRide() }, icon('play'), ' TEST'),
    );
  }

  renderDrawer() {
    const L = this.el.drawer;
    L.innerHTML = '';
    const lib = h('div.cd-lib');
    const templates = BUILTIN_ARENAS.filter((a) => a.course);
    const item = (a: ArenaDef, tag: string) =>
      h('div.cd-lib-item' + (this.def?.id === a.id ? '.cd-active' : ''), { onclick: () => this.select(a) },
        h('span.cd-lib-name', null, a.name), h('span.cd-tag', null, tag));
    lib.append(h('div.cd-sub', null, 'MY COURSES'));
    if (!this.custom.length) lib.append(h('div.cd-muted', null, 'None yet — start from a template below.'));
    for (const a of this.custom) lib.append(item(a, `${a.course!.w}×${a.course!.h}`));
    lib.append(h('div.cd-sub', null, 'BUILT-IN'));
    for (const a of templates) lib.append(item(a, `${a.course!.w}×${a.course!.h}`));

    // new course
    const tSel = h<HTMLSelectElement>('select.cd-input', null, ...TEMPLATES.map((t) => h('option', { value: t.id }, t.label)));
    const num = (v: number) => h<HTMLInputElement>('input.cd-input.cd-num', { type: 'number', min: 2, max: MAX_GRID, value: v });
    const wIn = num(TEMPLATES[0].w), hIn = num(TEMPLATES[0].h);
    tSel.addEventListener('change', () => { const t = TEMPLATES.find((x) => x.id === tSel.value)!; wIn.value = String(t.w); hIn.value = String(t.h); });
    const newBox = h('div.cd-new', null,
      h('div.cd-sub', null, 'NEW COURSE'), tSel,
      h('div.cd-row', null, h('label', null, 'Width'), wIn, h('label', null, 'Depth'), hIn),
      h('button.btn', { onclick: () => this.createNew(tSel.value as TemplateId, +wIn.value, +hIn.value) }, 'Create'));

    const del = h<HTMLButtonElement>('button.btn.cd-danger', {
      onclick: () => {
        if (!this.def.custom) return this.app.toast('Built-in courses cannot be deleted');
        if (!this.delArmed) { this.delArmed = true; del.textContent = 'Confirm?'; setTimeout(() => { this.delArmed = false; del.textContent = 'Delete'; }, 2500); return; }
        this.delArmed = false;
        this.custom = this.custom.filter((a) => a.id !== this.def.id);
        this.persist();
        this.select(this.custom[0] ?? templates[0]);
      },
    }, 'Delete');
    const fileIn = h<HTMLInputElement>('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onchange: (e: Event) => this.importFile(e) });
    const name = h<HTMLInputElement>('input.cd-input', { value: this.def?.name ?? '', placeholder: 'Course name', oninput: (e: Event) => { if (this.ensureEditable()) { this.def.name = (e.target as HTMLInputElement).value; this.scheduleSave(); this.renderTop(); } } });
    const desc = h<HTMLTextAreaElement>('textarea.cd-input', { rows: 2, placeholder: 'Description', oninput: (e: Event) => { if (this.ensureEditable()) { this.def.desc = (e.target as HTMLTextAreaElement).value; this.scheduleSave(); } } });
    desc.value = this.def?.desc ?? '';
    const tk = this.def ? themeKey(this.def.theme) : '';
    const theme = h<HTMLSelectElement>('select.cd-input', {
      onchange: (e: Event) => {
        if (!this.ensureEditable()) return;
        this.def.theme = { ...THEMES[(e.target as HTMLSelectElement).value] };
        this.rebuildSky();
        this.rebuildT = 0.01;
        this.scheduleSave();
      },
    }, ...Object.keys(THEMES).map((k) => h('option', { value: k, selected: k === tk }, k[0].toUpperCase() + k.slice(1))));
    L.append(
      h('h2.cd-title', null, 'COURSES'),
      lib,
      newBox,
      h('div.cd-sub', null, 'THIS COURSE'),
      name, desc,
      h('div.cd-row', null, h('label', null, 'Theme'), theme),
      h('div.cd-row', null, h('label', null, 'Music'), h<HTMLSelectElement>('select.cd-input', {
        onchange: (e: Event) => { if (!this.ensureEditable()) return; const v = (e.target as HTMLSelectElement).value; this.def.song = v || undefined; this.scheduleSave(); if (v) this.app.sfx.playSong(songById(v)); else this.app.sfx.useMusic('menu'); },
      }, h('option', { value: '' }, 'Auto (a fitting preset)'), ...allSongs().map((s) => h('option', { value: s.id, selected: this.def?.song === s.id }, `♪ ${s.name}${s.custom ? '' : ' ★'}`)))),
      h('div.cd-row', null,
        h('button.btn', { onclick: () => this.duplicate() }, 'Duplicate'),
        del),
      h('div.cd-row', null,
        h('button.btn', { onclick: () => this.exportJson() }, 'Export'),
        h('button.btn', { onclick: () => fileIn.click() }, 'Import'),
        fileIn),
    );
  }

  toggleBtn(label: string, on: boolean, fn: () => void, tip = '') {
    const b = h('button.cd-toggle' + (on ? '.cd-on' : ''), { title: tip, onclick: fn }, h('i'), label);
    return b;
  }

  renderRight() {
    const R = this.el.right;
    R.innerHTML = '';
    const t = TOOLS.find((x) => x.id === this.tool)!;
    R.append(h('h2.cd-title', null, t.label.toUpperCase()), h('div.cd-muted', null, t.tip));
    const brushRow = () => h('div.cd-row', null, h('label', null, 'Brush'),
      ...[1, 2, 3].map((n) => h('button.cd-chip' + (this.brush === n ? '.cd-on' : ''), { title: `Brush ${n}×${n} (${n})`, onclick: () => { this.brush = n; this.renderRight(); this.refreshOverlay(true); } }, `${n}×${n}`)));
    const symRow = () => h('div.cd-row', null,
      this.toggleBtn('Mirror ⇆', this.symX, () => { this.symX = !this.symX; this.renderRight(); this.refreshOverlay(true); }, 'Mirror left ↔ right while editing'),
      this.toggleBtn('Mirror ⇅', this.symZ, () => { this.symZ = !this.symZ; this.renderRight(); this.refreshOverlay(true); }, 'Mirror front ↔ back while editing'));

    if (this.tool === 'paint') {
      for (const g of PIECE_GROUPS) {
        const pal = h('div.cd-palette');
        for (const k of g.kinds) {
          const pk = k === this.pieceKind ? this.paintPiece() : { kind: k, rot: DIRECTIONAL.has(k) ? this.paintRot % 4 : 0 };
          const key = pk.kind + ':' + pk.rot;
          let ic = this.iconCache.get(key);
          if (!ic) { ic = pieceIcon(pk.kind, pk.rot); this.iconCache.set(key, ic); }
          const cv = ic.cloneNode() as HTMLCanvasElement;
          cv.getContext('2d')!.drawImage(ic, 0, 0);
          pal.append(h('button.cd-pal' + (this.pieceKind === k ? '.cd-on' : ''), { title: k === 'quarter' ? 'Curved pool wall — point at a tile edge for a quarter pipe, at a corner for a rounded corner' : PIECES[k].desc, onclick: () => { this.pieceKind = k; if (k !== 'quarter') this.paintRot %= 4; this.renderRight(); this.refreshOverlay(true); } }, cv, h('span', null, k === 'quarter' ? 'Quarter / Corner' : PIECES[k].label)));
        }
        R.append(h('div.cd-sub', null, g.label), pal);
      }
      R.append(
        h('div.cd-row', null,
          h('label', null, 'Rotate'),
          h('button.cd-chip', { title: 'Rotate left (Q)', onclick: () => this.rotatePaint(-1) }, '⟲'),
          h('span.cd-val', null, `${(this.paintRot % 4) * 90}°${this.paintRot >= 4 ? ' corner' : ''}`),
          h('button.cd-chip', { title: 'Rotate right (E / R / wheel)', onclick: () => this.rotatePaint(1) }, '⟳'),
          h('label', null, 'Level'),
          h('button.cd-chip', { title: 'Level down ([)', onclick: () => this.setPaintLevel(this.paintLevel - 1) }, '−'),
          h('span.cd-val', null, String(this.paintLevel)),
          h('button.cd-chip', { title: 'Level up (])', onclick: () => this.setPaintLevel(this.paintLevel + 1) }, '+')),
        h('div.cd-row', null, this.toggleBtn('Aim at cursor', this.aimCursor, () => { this.aimCursor = !this.aimCursor; this.renderRight(); this.refreshOverlay(true); }, 'Point at the edge or corner of the tile you want the wall / lip / high side on — the piece turns to it (centre of the tile: auto-orient decides)')),
        h('div.cd-row', null, this.toggleBtn('Auto-orient walls', this.autoOrient, () => { this.autoOrient = !this.autoOrient; this.renderRight(); this.refreshOverlay(true); }, 'Walls/corners face outward, kickers face open space, ramps face higher tiles')),
        brushRow(), symRow(),
        h('div.cd-row', null,
          h('button.btn', { title: 'Turn the outer ring into outward-facing quarter pipes & corners', onclick: () => this.wrapWithWalls() }, 'Wrap with walls'),
          h('button.btn', { title: 'Copy the left half onto the right half, mirrored (teams swapped)', onclick: () => this.mirrorCopy('x') }, 'Copy L→R')),
      );
    } else if (this.tool === 'level' || this.tool === 'erase') {
      R.append(brushRow(), symRow());
    } else if (this.tool === 'place') {
      const pal = h('div.cd-mpalette'), pinPal = h('div.cd-mpalette');
      for (const m of MARKERS)
        (m.pin ? pinPal : pal).append(h('button.cd-mpal' + (this.markerKind === m.kind ? '.cd-on' : ''), { title: m.tip, onclick: () => { this.markerKind = m.kind; this.renderRight(); } },
          h('span.cd-mico', { style: { color: m.color } }, icon(m.icon)), m.label));
      R.append(pal, h('div.cd-sub', null, 'PINBALL (works on any course)'), pinPal, h('div.cd-muted', null, MINFO[this.markerKind].tip));
      if (this.markerKind === 'spawn' || this.markerKind === 'flag')
        R.append(h('div.cd-row', null, h('label', null, 'Team'),
          ...(this.markerKind === 'flag' ? [0, 1] : [undefined, 0, 1]).map((tm) => h('button.cd-chip' + (this.team === tm ? '.cd-on' : ''), { onclick: () => { this.team = tm; this.renderRight(); } }, tm === undefined ? 'Any' : tm === 0 ? 'Red' : 'Blue'))));
      R.append(h('div.cd-row', null, h('button.cd-chip.cd-wide', { title: 'Snap (G)', onclick: () => this.cycleSnap() }, SNAP_LABEL[this.snap])), symRow());
    } else if (this.tool === 'wall') {
      R.append(
        h('div.cd-row', null, h('label', null, 'Height'),
          ...([[1.1, 'Low'], [1.3, 'Mid'], [3, 'Tall']] as const).map(([v, n]) => h('button.cd-chip' + (this.wallH === v ? '.cd-on' : ''), { onclick: () => { this.wallH = v; this.renderRight(); this.drawWallPreview(); } }, n))),
        h('div.cd-row', null,
          this.toggleBtn('Slingshot', this.wallKick, () => { this.wallKick = !this.wallKick; if (this.wallKick) this.wallOneWay = false; this.renderRight(); this.drawWallPreview(); }, 'The wall kicks the ball off (pinball slingshot)'),
          this.toggleBtn('One-way gate', this.wallOneWay, () => { this.wallOneWay = !this.wallOneWay; if (this.wallOneWay) this.wallKick = false; this.renderRight(); this.drawWallPreview(); }, 'Balls pass through it one way only (toward the left of the drawing direction)')),
        h('div.cd-row', null,
          h('button.btn', { title: 'Finish this wall (Enter / click the last point again)', onclick: () => this.finishWall() }, `Finish wall (${this.wallPts.length} pts)`),
          h('button.btn', { title: 'Remove the last point (right-click)', onclick: () => { this.wallPts.pop(); this.drawWallPreview(); this.renderRight(); } }, 'Undo point')),
        h('div.cd-muted', null, `${(this.def.rails ?? []).length} wall(s) on this course · Erase (X) removes one`),
        h('div.cd-sub', null, 'TABLE'),
        h('div.cd-row', null, this.toggleBtn('Pinball table', !!this.def.pinball, () => this.setPinball(!this.def.pinball), 'Tilt the course into a pinball table: gravity pulls toward the bottom (+z), TEST plays it as Pinball')),
      );
      if (this.def.pinball) {
        const out = h('span.cd-val', null, (this.def.tilt ?? 0.15).toFixed(2));
        const inp = h<HTMLInputElement>('input.cd-range', {
          type: 'range', min: '0.06', max: '0.3', step: '0.01', value: String(this.def.tilt ?? 0.15),
          onpointerdown: () => this.snapshot(),
          oninput: (e: Event) => { this.def.tilt = +(e.target as HTMLInputElement).value; out.textContent = this.def.tilt.toFixed(2); this.rebuildT = 0.25; this.scheduleSave(); },
        });
        R.append(h('div.cd-slider', null, h('label', null, 'Tilt'), inp, out), h('div.cd-muted', null, 'Tip: start from the "Pinball table" template for a ready cabinet, plunger lane and flippers.'));
      }
    } else if (this.tool === 'select') {
      R.append(h('div.cd-row', null, h('button.cd-chip.cd-wide', { title: 'Snap (G)', onclick: () => this.cycleSnap() }, SNAP_LABEL[this.snap])),
        h('div.cd-muted', null, this.selected >= 0 ? 'Drag the marker to move it, the yellow handle to resize/aim. Q/E rotates, Del deletes.' : 'Click a marker to select it.'));
    } else {
      R.append(h('div.cd-muted', null, 'Click a tile to copy its piece (switches to Paint), or a marker to copy its type (switches to Place).'));
    }

    // grid: sizes itself (paint past an edge to grow it; empty edge rows/columns go away when you erase)
    if (this.tool === 'paint' || this.tool === 'erase' || this.tool === 'level') {
      const c = this.def?.course;
      R.append(h('div.cd-sub', null, 'GRID ' + (c ? `${c.w}×${c.h}` : '')), h('div.cd-muted', null, 'Sizes itself: paint past an edge to grow the course; erasing an edge row or column shrinks it.'));
    }
    this.mini = h<HTMLCanvasElement>('canvas.cd-mini', {
      width: 240, height: 150,
      onpointerdown: (e: PointerEvent) => this.miniClick(e),
      onpointermove: (e: PointerEvent) => { if (e.buttons & 1) this.miniClick(e, true); },
      oncontextmenu: (e: Event) => e.preventDefault(),
    });
    R.append(h('div.cd-spacer'), this.mini);
    this.drawMini();
  }

  setTool(t: Tool) {
    if (t !== 'wall') this.wallPts = []; // (a half-drawn wall is dropped)
    this.tool = t;
    this.drawWallPreview();
    if (t !== 'select') this.selected = -1;
    this.renderTools();
    this.renderRight();
    this.renderCard();
    this.refreshOverlay(true);
  }

  rotatePaint(d: number) {
    // the quarter pipe turns through its 4 edges, then its 4 corners
    const n = this.pieceKind === 'quarter' ? 8 : 4;
    this.paintRot = (this.paintRot + d + n) % n;
    if ((this.autoOrient || this.aimCursor) && DIRECTIONAL.has(this.pieceKind)) { this.autoOrient = false; this.aimCursor = false; this.app.toast('Auto-orient and aim-at-cursor off — manual rotation'); }
    this.renderRight();
    this.refreshOverlay(true);
  }

  setPaintLevel(l: number) {
    this.paintLevel = Math.max(0, Math.min(3, l));
    this.renderRight();
    this.refreshOverlay(true);
  }

  cycleSnap() {
    const order: SnapMode[] = ['grid', 'tile', 'off'];
    this.snap = order[(order.indexOf(this.snap) + 1) % 3];
    this.renderRight();
  }

  // ============================================================ floating marker card
  renderCard() {
    const box = this.el.card;
    box.innerHTML = '';
    const m = this.def?.markers[this.selected];
    box.classList.toggle('cd-hidden', !m || this.tool !== 'select');
    if (!m || this.tool !== 'select') return;
    const info = MINFO[m.kind];
    box.append(h('div.cd-card-head', null, h('span', { style: { color: info.color } }, icon(info.icon)), h('b', null, info.label),
      h('button.cd-x', { title: 'Delete (Del)', onclick: () => this.deleteMarker(this.selected) }, icon('close'))));
    const slider = (label: string, key: 'r' | 'len' | 'speed' | 'rot', min: number, max: number, step: number, def: number, deg = false) => {
      const v = m[key] ?? def;
      const out = h('span.cd-val', null, deg ? `${Math.round((((v * 180) / Math.PI) % 360 + 360) % 360)}°` : v.toFixed(1));
      const inp = h<HTMLInputElement>('input', {
        type: 'range', min: deg ? 0 : min, max: deg ? 360 : max, step: deg ? 5 : step, value: deg ? ((((v * 180) / Math.PI) % 360) + 360) % 360 : v,
        onpointerdown: () => this.snapshot(),
        oninput: (e: Event) => {
          let nv = +(e.target as HTMLInputElement).value;
          out.textContent = deg ? `${nv}°` : nv.toFixed(1);
          if (deg) nv = (nv * Math.PI) / 180;
          const mm = this.def.markers[this.selected];
          if (!mm) return;
          mm[key] = nv;
          this.rebuildMarkers();
          this.scheduleSave();
        },
      });
      box.append(h('div.cd-slider', null, h('label', null, label), inp, out));
    };
    switch (m.kind) {
      case 'arm': slider('Length', 'len', 1.5, 9, 0.1, 4); slider('Speed', 'speed', -3, 3, 0.05, 1); slider('Angle', 'rot', 0, 0, 0, 0, true); break;
      case 'saw': slider('Orbit', 'r', 0, 14, 0.1, 5); slider('Speed', 'speed', -2, 2, 0.05, 0.5); slider('Phase', 'rot', 0, 0, 0, 0, true); break;
      case 'boost': slider('Push dir', 'rot', 0, 0, 0, 0, true); break;
      case 'bumper': case 'pillar': slider('Radius', 'r', 0.4, 2.2, 0.05, 0.8); break;
      case 'spinpad': slider('Radius', 'r', 0.6, 2.6, 0.05, 1.1); break;
      case 'zone': slider('Radius', 'r', 1.5, 7, 0.1, 2.6); break;
      case 'hive': slider('Zone', 'r', 3, 20, 0.5, 8); slider('Drones', 'len', 1, 5, 1, 2); break;
      case 'goal': slider('Radius', 'r', 1.5, 5, 0.1, 2.6); break;
      case 'checkpoint': slider('Width', 'r', 1.2, 4, 0.1, 2.2); slider('Turn', 'rot', 0, 0, 0, 0, true); break;
      case 'flipper': slider('Length', 'len', 2, 5, 0.1, 3.5); slider('Rest angle', 'rot', 0, 0, 0, 0, true); break;
      case 'saucer': slider('Kick speed', 'len', 8, 30, 0.5, 18); slider('Kick dir', 'rot', 0, 0, 0, 0, true); break;
      case 'kickback': slider('Power', 'len', 15, 40, 1, 30); slider('Fire dir', 'rot', 0, 0, 0, 0, true); break;
      case 'drop': slider('Width', 'r', 0.5, 1.2, 0.05, 0.75); slider('Facing', 'rot', 0, 0, 0, 0, true); break;
      case 'plunger': slider('Power', 'len', 0.6, 1.4, 0.05, 1); break;
      case 'arena': slider('Bowl radius', 'r', 3, 8, 0.1, 5); slider('Gate', 'rot', 0, 0, 0, 0, true); break;
      case 'portal': case 'rollover': case 'target': case 'post': break;
    }
    /** a row of choice chips on the card: picking one snapshots, applies and refreshes */
    const chips = <V,>(label: string, vals: V[], names: string[], cur: V, set: (mm: Marker, v: V) => void) =>
      box.append(h('div.cd-row', null, h('label', null, label), ...vals.map((v, i) => h('button.cd-chip' + (cur === v ? '.cd-on' : ''), {
        onclick: () => { this.snapshot(); const mm = this.def.markers[this.selected]; if (mm) set(mm, v); this.rebuildMarkers(); this.rebuildRails(); this.scheduleSave(); this.renderCard(); },
      }, names[i]))));
    const groupKinds: MarkerKind[] = ['drop', 'rollover', 'saucer', 'portal', 'arena', 'hive'];
    if (groupKinds.includes(m.kind)) {
      const lbl = m.kind === 'drop' ? 'Bank' : m.kind === 'portal' || m.kind === 'saucer' ? 'Pair' : m.kind === 'arena' ? 'Bank' : 'Group';
      const vals = m.kind === 'portal' || m.kind === 'drop' || m.kind === 'arena' ? [0, 1, 2, 3] : [undefined, 1, 2, 3, 4];
      chips<number | undefined>(lbl, vals, vals.map((v) => (v === undefined ? 'None' : String(v))), m.team, (mm, v) => { mm.team = v; });
    }
    if (m.kind === 'saucer') chips<boolean>('Aim lock', [false, true], ['Off', 'On'], !!m.aim, (mm, v) => { if (v) { mm.aim = 0.7; mm.hold = 7; mm.len = Math.max(mm.len ?? 18, 22); } else { delete mm.aim; delete mm.hold; } });
    if (m.kind === 'arena') chips<'duel' | 'koth' | 'random'>('Game', ['random', 'duel', 'koth'], ['Random', '1v1', 'King'], m.game ?? 'random', (mm, v) => { mm.game = v; });
    if (m.kind === 'spawn' || m.kind === 'flag') {
      const opts = m.kind === 'flag' ? [0, 1] : [undefined, 0, 1];
      box.append(h('div.cd-row', null, h('label', null, 'Team'),
        ...opts.map((t) => h('button.cd-chip' + (m.team === t ? '.cd-on' : ''), {
          onclick: () => { this.snapshot(); const mm = this.def.markers[this.selected]; if (mm) mm.team = t; this.rebuildMarkers(); this.scheduleSave(); this.renderCard(); },
        }, t === undefined ? 'Any' : t === 0 ? 'Red' : 'Blue'))));
    }
  }

  positionCard() {
    const box = this.el.card;
    const m = this.def.markers[this.selected];
    if (!m || box.classList.contains('cd-hidden')) return;
    const p = new THREE.Vector3(m.x, this.groundY(m.x, m.z) + 1.5, m.z).project(this.camera);
    const x = (p.x * 0.5 + 0.5) * innerWidth, y = (-p.y * 0.5 + 0.5) * innerHeight;
    const w = box.offsetWidth || 230, hh = box.offsetHeight || 120;
    box.style.left = `${Math.max(90, Math.min(innerWidth - w - 300, x + 28))}px`;
    box.style.top = `${Math.max(70, Math.min(innerHeight - hh - 60, y - hh / 2))}px`;
  }

  // ============================================================ course management
  select(a: ArenaDef) {
    this.def = a;
    this.selected = -1;
    this.undo = [];
    this.redo = [];
    this.frame();
    this.rebuildSky();
    this.rebuildTerrain();
    this.renderAll();
  }

  frame() {
    const c = this.def.course!;
    this.dist = Math.max(c.w, c.h) * c.tile * 1.1 + 8;
    this.target.set(0, 0, 0);
    this.yaw = 0; this.pitch = 0.95;
  }

  ensureEditable(): boolean {
    if (this.def.custom) return true;
    const copy: ArenaDef = JSON.parse(JSON.stringify(this.def));
    copy.id = newId();
    copy.name = this.def.name + ' Copy';
    copy.custom = true;
    this.custom.push(copy);
    this.def = copy;
    this.persist();
    this.renderDrawer();
    this.renderTop();
    this.app.toast('Built-in course copied — editing your own version');
    return true;
  }

  createNew(t: TemplateId, w: number, hh: number) {
    w = Math.max(2, Math.min(MAX_GRID, Math.round(w) || 4));
    hh = Math.max(2, Math.min(MAX_GRID, Math.round(hh) || 4));
    const { course, markers } = t === 'pinball' ? pinballStarter() : templateCourse(t, w, hh);
    const def: ArenaDef = {
      id: newId(), name: `${TEMPLATES.find((x) => x.id === t)!.label.split(' (')[0]} ${this.custom.length + 1}`, desc: t === 'pinball' ? 'Custom pinball table' : 'Custom skate course', theme: { ...(t === 'ctf' ? THEMES.toxic : t === 'plaza' || t === 'pinball' ? THEMES.neon : THEMES.concrete) },
      course: course!, markers, custom: true,
      ...(t === 'pinball' ? (({ rails, tilt, pinball }) => ({ rails, tilt, pinball }))(pinballStarter()) : {}),
    };
    if (t === 'pinball') this.testMode = 'pinball';
    this.custom.push(def);
    this.persist();
    this.select(def);
    this.app.toast('Course created');
  }

  duplicate() {
    const copy: ArenaDef = JSON.parse(JSON.stringify(this.def));
    copy.id = newId();
    copy.name = this.def.name + ' Copy';
    copy.custom = true;
    this.custom.push(copy);
    this.persist();
    this.select(copy);
  }

  persist() {
    const others = loadCustomArenas().filter((a) => !a.course);
    saveCustomArenas([...others, ...this.custom]);
  }

  scheduleSave() { if (this.def.custom) this.saveT = 0.6; }

  save(explicit = false) {
    if (!this.def.course?.pieces.length) { this.app.toast('Course needs at least one piece'); return false; }
    if (!this.def.custom) { if (explicit) this.ensureEditable(); else return true; }
    this.persist();
    if (explicit && !this.def.markers.some((m) => m.kind === 'spawn')) this.app.toast('Saved — no spawns placed, they will be auto-generated');
    return true;
  }

  testRide() {
    if (!this.save(true)) return;
    testRide.from = 'courses'; testRide.id = this.def.id;
    this.app.go('lobby', { mode: this.def.pinball ? 'pinball' : this.testMode === 'pinball' ? 'duel' : this.testMode, arenaId: this.def.id });
  }

  exportJson() {
    const blob = new Blob([JSON.stringify(this.def, null, 2)], { type: 'application/json' });
    const a = h<HTMLAnchorElement>('a', { href: URL.createObjectURL(blob), download: `${this.def.name.replace(/[^\w-]+/g, '_')}.bitcourse.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text()) as ArenaDef;
      if (!d.course || !Array.isArray(d.course.pieces)) throw new Error('not a course');
      d.id = newId();
      d.custom = true;
      d.markers ??= [];
      d.theme ??= { ...THEMES.concrete };
      d.name ??= 'Imported Course';
      d.desc ??= '';
      this.custom.push(d);
      this.persist();
      this.select(d);
      this.app.toast('Course imported');
    } catch {
      this.app.toast('Import failed — not a BitBlade course file');
    }
  }

  // ============================================================ undo
  state() { return JSON.stringify({ course: this.def.course, markers: this.def.markers, rails: this.def.rails ?? [], ramps: this.def.ramps ?? [], tilt: this.def.tilt ?? 0, pinball: !!this.def.pinball }); }

  snapshot() {
    this.ensureEditable();
    this.undo.push(this.state());
    if (this.undo.length > 80) this.undo.shift();
    this.redo = [];
  }

  restore(s: string) {
    const d = JSON.parse(s);
    this.def.course = d.course;
    this.def.markers = d.markers;
    this.def.rails = d.rails; this.def.ramps = d.ramps; this.def.tilt = d.tilt || undefined; this.def.pinball = d.pinball || undefined;
    this.wallPts = [];
    this.selected = -1;
    this.rebuildTerrain();
    this.renderRight();
    this.renderCard();
    this.renderTop();
    this.scheduleSave();
  }

  doUndo() {
    const s = this.undo.pop();
    if (!s) return this.app.toast('Nothing to undo');
    this.redo.push(this.state());
    this.restore(s);
  }

  doRedo() {
    const s = this.redo.pop();
    if (!s) return this.app.toast('Nothing to redo');
    this.undo.push(this.state());
    this.restore(s);
  }

  // ============================================================ tile edits
  inGrid(i: number, j: number) { const c = this.def.course!; return i >= 0 && j >= 0 && i < c.w && j < c.h; }
  /** painting can reach this far past the edge (the grid grows to fit) */
  static GROW = 3;
  reachable(i: number, j: number) {
    if (this.tool !== 'paint') return this.inGrid(i, j);
    const c = this.def.course!, g = CourseEditor.GROW;
    return i >= -g && j >= -g && i < c.w + g && j < c.h + g && c.w + Math.max(0, -i, i - c.w + 1) * (this.symX ? 2 : 1) <= MAX_GRID && c.h + Math.max(0, -j, j - c.h + 1) * (this.symZ ? 2 : 1) <= MAX_GRID;
  }

  /** brush cells around (i,j) */
  brushCells(i: number, j: number) {
    const out: { i: number; j: number }[] = [];
    const o = Math.floor((this.brush - 1) / 2);
    for (let dj = 0; dj < this.brush; dj++) for (let di = 0; di < this.brush; di++) out.push({ i: i - o + di, j: j - o + dj });
    return out.filter((c) => this.reachable(c.i, c.j));
  }

  rectCells(a: { i: number; j: number }, b: { i: number; j: number }) {
    const out: { i: number; j: number }[] = [];
    for (let j = Math.min(a.j, b.j); j <= Math.max(a.j, b.j); j++) for (let i = Math.min(a.i, b.i); i <= Math.max(a.i, b.i); i++) if (this.reachable(i, j)) out.push({ i, j });
    return out;
  }

  /** a cell plus its mirror images (with the rotation map that applies to each) */
  withMirrors(cells: { i: number; j: number }[]) {
    const c = this.def.course!;
    const out: { i: number; j: number; mx: boolean; mz: boolean }[] = [];
    const seen = new Set<string>();
    const add = (i: number, j: number, mx: boolean, mz: boolean) => { const k = `${i},${j}`; if (!seen.has(k)) { seen.add(k); out.push({ i, j, mx, mz }); } };
    for (const { i, j } of cells) {
      add(i, j, false, false);
      if (this.symX) add(c.w - 1 - i, j, true, false);
      if (this.symZ) add(i, c.h - 1 - j, false, true);
      if (this.symX && this.symZ) add(c.w - 1 - i, c.h - 1 - j, true, true);
    }
    return out;
  }

  static mirrorRot(kind: PieceKind, rot: number, mx: boolean, mz: boolean) {
    if (mx) rot = kind === 'corner' ? MX_CORN[rot] : MX_EDGE[rot];
    if (mz) rot = kind === 'corner' ? MZ_CORN[rot] : MZ_EDGE[rot];
    return rot;
  }

  setPiece(i: number, j: number, kind: PieceKind | null, rot: number, level: number) {
    const c = this.def.course!;
    if (!this.inGrid(i, j)) return false;
    const cur = pieceAt(c, i, j);
    if (kind === null) {
      if (!cur) return false;
      c.pieces = c.pieces.filter((p) => p !== cur);
    } else {
      if (cur && cur.kind === kind && cur.rot === rot && cur.level === level) return false;
      if (cur) { cur.kind = kind; cur.rot = rot; cur.level = level; }
      else c.pieces.push({ kind, x: i, y: j, rot, level });
    }
    return true;
  }

  /**
   * Aim at cursor: where the cursor sits inside the hovered tile picks the rotation. Near an edge → the wall / high
   * side / kicker lip goes on that edge; near a corner → a corner piece (a quarter-pipe becomes one) facing it;
   * the middle of the tile → null (auto-orient / manual rotation decide).
   */
  /** the piece + rotation manual rotation gives (quarter pipe rotations 4-7 are its corners) */
  paintPiece(): { kind: PieceKind; rot: number } {
    if (this.pieceKind === 'quarter' && this.paintRot >= 4) return { kind: 'corner', rot: this.paintRot - 4 };
    return { kind: this.pieceKind, rot: this.paintRot % 4 };
  }

  cursorAim(): { kind: PieceKind; rot: number } | null {
    const k = this.pieceKind, p = this.hoverPt, cell = this.hover, c = this.def.course!;
    if (!this.aimCursor || !p || !cell || !DIRECTIONAL.has(k) || this.brush !== 1 || this.drag?.kind === 'rect') return null;
    const u = (p.x + (c.w * c.tile) / 2) / c.tile - cell.i - 0.5, v = (p.z + (c.h * c.tile) / 2) / c.tile - cell.j - 0.5;
    if (Math.max(Math.abs(u), Math.abs(v)) < 0.17) return null;
    const nearCorner = Math.abs(u) > 0.27 && Math.abs(v) > 0.27;
    if (k === 'corner' || (k === 'quarter' && nearCorner)) {
      // (a corner piece aimed at an edge: the corner of that edge nearest the cursor)
      const sx = u >= 0 ? 1 : -1, sz = v >= 0 ? 1 : -1;
      return { kind: 'corner', rot: Math.max(0, CORNER_DIR.findIndex(([x, z]) => x === sx && z === sz)) };
    }
    // EDGE_DIR: rot0 +z, rot1 -x, rot2 -z, rot3 +x
    const rot = Math.abs(u) > Math.abs(v) ? (u > 0 ? 3 : 1) : v > 0 ? 0 : 2;
    return { kind: k, rot: k === 'half' || k === 'spine' ? rot % 2 : rot };
  }

  /** auto orientation for one placed piece based on its final neighbourhood */
  autoFor(p: Piece): { kind: PieceKind; rot: number } | null {
    const c = this.def.course!;
    const outs = outsideDirs(c, p.x, p.y);
    switch (p.kind) {
      case 'quarter': case 'corner': case 'half': {
        if (!outs.length) return null;
        return orientFromOuts(outs, p.kind === 'half' ? 'quarter' : p.kind);
      }
      case 'wall': case 'bank': return outs.length ? { kind: p.kind, rot: orientFromOuts(outs, p.kind)!.rot } : null;
      case 'ramp': case 'stairs': {
        // climb toward a higher neighbour
        for (let d = 0; d < 4; d++) {
          const n = pieceAt(c, p.x + EDGE_DIR[d][0], p.y + EDGE_DIR[d][1]);
          if (n && n.level > p.level) return { kind: p.kind, rot: d };
        }
        return null;
      }
      case 'kicker': {
        // launch toward the longest open run of tiles
        let best = -1, bl = -1;
        for (let d = 0; d < 4; d++) {
          let L = 0;
          for (let k = 1; k <= 5; k++) { if (pieceAt(c, p.x + EDGE_DIR[d][0] * k, p.y + EDGE_DIR[d][1] * k)) L++; else break; }
          if (L > bl || (L === bl && d === this.paintRot)) { bl = L; best = d; }
        }
        return best >= 0 ? { kind: 'kicker', rot: best } : null;
      }
    }
    return null;
  }

  applyCells(cells: { i: number; j: number }[], op: 'paint' | 'erase' | 'raise' | 'lower') {
    if (op === 'paint') cells = this.growFor(cells);
    else cells = cells.filter((k) => this.inGrid(k.i, k.j));
    const c = this.def.course!;
    const all = this.withMirrors(cells);
    let changed = false;
    const painted: Piece[] = [];
    const aim = op === 'paint' && cells.length === 1 ? this.cursorAim() : null;
    for (const { i, j, mx, mz } of all) {
      if (op === 'paint') {
        const pp = aim ?? this.paintPiece();
        const kind = pp.kind;
        const rot = DIRECTIONAL.has(kind) ? CourseEditor.mirrorRot(kind, pp.rot, mx, mz) : 0;
        if (this.setPiece(i, j, kind, rot, this.paintLevel)) changed = true;
        const p = pieceAt(c, i, j);
        if (p) painted.push(p);
      } else if (op === 'erase') {
        if (this.setPiece(i, j, null, 0, 0)) changed = true;
      } else {
        const p = pieceAt(c, i, j);
        if (!p) continue;
        const nl = Math.max(0, Math.min(3, p.level + (op === 'raise' ? 1 : -1)));
        if (nl !== p.level) { p.level = nl; changed = true; }
      }
    }
    if (op === 'paint' && this.autoOrient && !aim) {
      for (const p of painted) {
        const o = this.autoFor(p);
        if (o && (o.kind !== p.kind || o.rot !== p.rot)) { p.kind = o.kind; p.rot = o.rot; changed = true; }
      }
    }
    if (changed && op === 'erase') this.trimEmptyEdges();
    if (changed) {
      this.rebuildT = 0.1;
      this.scheduleSave();
      this.drawMini();
    }
    return changed;
  }

  /** painting past the edge: grow the grid just enough (both sides while mirroring), return the cells re-indexed */
  growFor(cells: { i: number; j: number }[]) {
    const c = this.def.course!;
    let l = 0, r = 0, t = 0, b = 0;
    for (const { i, j } of cells) { l = Math.max(l, -i); r = Math.max(r, i - (c.w - 1)); t = Math.max(t, -j); b = Math.max(b, j - (c.h - 1)); }
    if (this.symX) l = r = Math.max(l, r);
    if (this.symZ) t = b = Math.max(t, b);
    if (!(l || r || t || b)) return cells;
    if (!this.resizeGrid(l, r, t, b, false)) return cells.filter((k) => this.inGrid(k.i, k.j));
    return cells.map((k) => ({ i: k.i + l, j: k.j + t }));
  }

  /** after erasing: drop empty rows / columns at the edges (not under a marker), so the course stays snug */
  trimEmptyEdges() {
    const c = this.def.course!, T = c.tile;
    const used = (i: number, j: number) => !!pieceAt(c, i, j);
    const markerCol = (i: number) => this.def.markers.some((m) => Math.floor((m.x + (c.w * T) / 2) / T) === i);
    const markerRow = (j: number) => this.def.markers.some((m) => Math.floor((m.z + (c.h * T) / 2) / T) === j);
    const colEmpty = (i: number) => { for (let j = 0; j < c.h; j++) if (used(i, j)) return false; return !markerCol(i); };
    const rowEmpty = (j: number) => { for (let i = 0; i < c.w; i++) if (used(i, j)) return false; return !markerRow(j); };
    let l = 0, r = 0, t = 0, b = 0;
    while (c.w - l - r > 1 && colEmpty(l)) l++;
    while (c.w - l - r > 1 && colEmpty(c.w - 1 - r)) r++;
    while (c.h - t - b > 1 && rowEmpty(t)) t++;
    while (c.h - t - b > 1 && rowEmpty(c.h - 1 - b)) b++;
    if (this.symX) l = r = Math.min(l, r);
    if (this.symZ) t = b = Math.min(t, b);
    if (l || r || t || b) this.resizeGrid(-l, -r, -t, -b, false);
  }

  wrapWithWalls() {
    this.snapshot();
    wrapWalls(this.def.course!);
    this.rebuildTerrain();
    this.scheduleSave();
    this.app.toast('Outer ring turned into walls');
  }

  /** copy one half onto the other, mirrored (pieces + markers, teams swapped) */
  mirrorCopy(axis: 'x' | 'z') {
    this.snapshot();
    const c = this.def.course!;
    if (axis === 'x') {
      const half = Math.floor(c.w / 2);
      c.pieces = c.pieces.filter((p) => p.x < c.w - half);
      for (const p of [...c.pieces]) if (p.x < half) c.pieces.push({ ...p, x: c.w - 1 - p.x, rot: DIRECTIONAL.has(p.kind) ? CourseEditor.mirrorRot(p.kind, p.rot, true, false) : p.rot });
      this.def.markers = this.def.markers.filter((m) => m.x <= 0.01);
      for (const m of [...this.def.markers]) if (m.x < -0.01) this.def.markers.push(mirrorMarker(m, 'x'));
    } else {
      const half = Math.floor(c.h / 2);
      c.pieces = c.pieces.filter((p) => p.y < c.h - half);
      for (const p of [...c.pieces]) if (p.y < half) c.pieces.push({ ...p, y: c.h - 1 - p.y, rot: DIRECTIONAL.has(p.kind) ? CourseEditor.mirrorRot(p.kind, p.rot, false, true) : p.rot });
      this.def.markers = this.def.markers.filter((m) => m.z <= 0.01);
      for (const m of [...this.def.markers]) if (m.z < -0.01) this.def.markers.push(mirrorMarker(m, 'z'));
    }
    this.selected = -1;
    this.rebuildTerrain();
    this.scheduleSave();
    this.app.toast('Mirrored left half onto the right');
  }

  resizeGrid(l: number, r: number, t: number, b: number, undo = true) {
    const c0 = this.def.course!;
    const nw = c0.w + l + r, nh = c0.h + t + b;
    if (nw < 1 || nh < 1 || nw > MAX_GRID || nh > MAX_GRID) { this.app.toast(`Courses can be up to ${MAX_GRID} tiles per side`); return false; }
    if (undo) this.snapshot();
    // the course is centred on the origin: growing one side shifts everything by half a tile — move the view with it
    this.target.x += ((l - r) * c0.tile) / 2; this.target.z += ((t - b) * c0.tile) / 2;
    const c = this.def.course!;
    c.pieces = c.pieces.map((p) => ({ ...p, x: p.x + l, y: p.y + t })).filter((p) => p.x >= 0 && p.y >= 0 && p.x < nw && p.y < nh);
    for (const m of this.def.markers) { m.x += ((l - r) * c.tile) / 2; m.z += ((t - b) * c.tile) / 2; }
    c.w = nw; c.h = nh;
    this.rebuildTerrain();
    this.renderRight();
    this.renderTop();
    this.scheduleSave();
    return true;
  }

  // ============================================================ markers
  snapPt(x: number, z: number) {
    if (this.snap === 'grid') return { x: Math.round(x * 2) / 2, z: Math.round(z * 2) / 2 };
    if (this.snap === 'tile') {
      const c = this.def.course!;
      const T = c.tile;
      const i = Math.floor((x + (c.w * T) / 2) / T), j = Math.floor((z + (c.h * T) / 2) / T);
      return { x: (i + 0.5) * T - (c.w * T) / 2, z: (j + 0.5) * T - (c.h * T) / 2 };
    }
    return { x, z };
  }

  newMarker(x: number, z: number, d?: { x: number; z: number }): Marker {
    const k = this.markerKind;
    const m: Marker = { kind: k, x, z };
    if (k === 'spawn' && this.team !== undefined) m.team = this.team;
    if (k === 'flag') m.team = this.team ?? (this.def.markers.filter((q) => q.kind === 'flag').length % 2);
    if (k === 'arm') { m.len = 4; m.speed = 1; m.rot = 0; }
    if (k === 'saw') { m.r = 4; m.speed = 0.6; m.rot = 0; }
    if (k === 'boost') m.rot = 0;
    if (k === 'bumper' || k === 'pillar') m.r = 0.8;
    if (k === 'spinpad') m.r = 1.1;
    if (k === 'zone') m.r = 2.6;
    if (k === 'flipper') { m.len = 3.5; m.rot = 0.48; m.r = -0.98; }
    if (k === 'plunger') { m.r = 1.1; m.len = 1; }
    if (k === 'target') { m.r = 0.8; }
    if (k === 'drop') { m.r = 0.75; m.rot = Math.PI / 2; m.team = 0; }
    if (k === 'saucer') { m.r = 1.0; m.rot = Math.PI / 2; m.len = 18; }
    if (k === 'rollover') { m.r = 0.85; }
    if (k === 'kickback') { m.r = 0.9; m.rot = -Math.PI / 2; m.len = 30; }
    if (k === 'post') { m.r = 0.45; }
    if (k === 'portal') { m.r = 1.0; m.team = 0; }
    if (k === 'arena') { m.r = 5; m.rot = Math.PI / 2; m.team = 0; m.len = 1.8; m.game = 'random'; }
    if (d) this.applyDrag(m, d.x, d.z);
    return m;
  }

  /** drag vector → marker parameters (aim / size) */
  applyDrag(m: Marker, dx: number, dz: number) {
    const L = Math.hypot(dx, dz);
    if (L < 0.4) return;
    switch (MINFO[m.kind].drag) {
      case 'aim': m.rot = Math.atan2(dx, dz); break; // sim pushes along (sin rot, cos rot)
      case 'arm': m.rot = Math.atan2(dz, dx); m.len = Math.max(1.5, Math.min(9, L)); // arm points along (cos rot, sin rot)
        if (m.kind === 'flipper') { m.len = Math.max(2, Math.min(5, L)); m.r = Math.cos(m.rot) >= 0 ? -0.98 : 0.98; } // (pointing right: a left flipper)
        break;
      case 'orbit': m.rot = Math.atan2(dz, dx); m.r = Math.max(0.5, Math.min(14, L)); break;
      case 'kick': m.rot = Math.atan2(dz, dx); break; // pinball pieces point along (cos rot, sin rot)
      case 'radius': {
        const lim = m.kind === 'zone' ? [1.5, 7] : m.kind === 'spinpad' ? [0.6, 2.6] : m.kind === 'arena' ? [3, 8] : [0.4, 2.2];
        m.r = Math.max(lim[0], Math.min(lim[1], L));
        break;
      }
    }
  }

  addMarkers(m: Marker) {
    this.snapshot();
    const list = [m];
    if (this.symX) list.push(mirrorMarker(m, 'x'));
    if (this.symZ) list.push(mirrorMarker(m, 'z'));
    if (this.symX && this.symZ) list.push(mirrorMarker(mirrorMarker(m, 'x'), 'z'));
    for (const q of list) if (!this.def.markers.some((o) => o.kind === q.kind && Math.hypot(o.x - q.x, o.z - q.z) < 0.05)) this.def.markers.push(q);
    this.rebuildMarkers();
    this.scheduleSave();
  }

  deleteMarker(i: number) {
    if (i < 0 || !this.def.markers[i]) return;
    this.snapshot();
    this.def.markers.splice(i, 1);
    this.selected = -1;
    this.rebuildMarkers();
    this.renderCard();
    this.renderRight();
    this.scheduleSave();
  }

  markerAt(x: number, z: number, radius = 1.1) {
    let best = -1, bd = radius;
    this.def.markers.forEach((m, i) => {
      const d = Math.hypot(m.x - x, m.z - z);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  handlePos(m: Marker): { x: number; z: number } | null {
    switch (MINFO[m.kind].drag) {
      case 'aim': { const r = m.rot ?? 0; return { x: m.x + Math.sin(r) * 2.2, z: m.z + Math.cos(r) * 2.2 }; }
      case 'arm': { const r = m.rot ?? 0, L = m.len ?? 4; return { x: m.x + Math.cos(r) * L, z: m.z + Math.sin(r) * L }; }
      case 'orbit': { const r = m.rot ?? 0, R = m.r ?? 5; return { x: m.x + Math.cos(r) * R, z: m.z + Math.sin(r) * R }; }
      case 'radius': return { x: m.x + (m.r ?? 1), z: m.z };
      case 'kick': { const r = m.rot ?? 0; return { x: m.x + Math.cos(r) * 2.2, z: m.z + Math.sin(r) * 2.2 }; }
    }
    return null;
  }

  rotateSelected(d: number) {
    const m = this.def.markers[this.selected];
    if (!m || !('rot' in m || MINFO[m.kind].drag === 'aim' || MINFO[m.kind].drag === 'arm' || MINFO[m.kind].drag === 'orbit' || MINFO[m.kind].drag === 'kick')) return;
    this.snapshot();
    const mm = this.def.markers[this.selected];
    mm.rot = (mm.rot ?? 0) + (d * Math.PI) / 12;
    this.rebuildMarkers();
    this.renderCard();
    this.scheduleSave();
  }

  // ============================================================ 3D building
  rebuildSky() {
    if (this.sky) { this.scene.remove(this.sky); disposeTree(this.sky); }
    this.sky = buildSky(this.def.theme);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.FogExp2(new THREE.Color(this.def.theme.sky2).getHex(), 0.006);
  }

  rebuildTerrain() {
    this.rebuildT = -1;
    this.terrain = new Terrain(this.def);
    if (this.arena) { this.scene.remove(this.arena); disposeTree(this.arena); }
    this.arena = buildArenaMesh(this.terrain, this.def.theme);
    this.scene.add(this.arena);
    this.rebuildRails();
    this.rebuildMarkers();
    this.refreshOverlay(true);
    this.drawMini();
  }

  // ============================================================ walls (rails)
  railGroup: THREE.Group | null = null;
  wallPts: [number, number][] = [];
  wallH = 1.3; wallKick = false; wallOneWay = false;
  wallPreview: THREE.Group | null = null;

  /** every wall the sim will see: drawn walls, ramp sides, arena rings */
  allRails(): Rail[] {
    return [...(this.def.rails ?? []), ...(this.def.ramps ?? []).flatMap(rampRails), ...this.def.markers.flatMap((m, mi) => (m.kind === 'arena' ? arenaRails(m, mi).filter((r) => r.gate === undefined) : []))];
  }

  rebuildRails() {
    if (this.railGroup) { this.scene.remove(this.railGroup); disposeTree(this.railGroup); this.railGroup = null; }
    const rails = this.allRails();
    if (!rails.length) return;
    this.railGroup = buildRailMeshes(rails, this.def.theme, (x, z) => this.groundY(x, z)).group;
    this.scene.add(this.railGroup);
  }

  /** the drawn wall nearest (x, z), if within reach */
  railAt(x: number, z: number) {
    let best = -1, bd = 0.9;
    (this.def.rails ?? []).forEach((r, ri) => {
      const pl = railPolyline(r);
      for (let i = 0; i + 1 < pl.length; i++) { const d = segDist({ ax: pl[i][0], az: pl[i][1], bx: pl[i + 1][0], bz: pl[i + 1][1] }, x, z).d - (r.t ?? 0.45) / 2; if (d < bd) { bd = d; best = ri; } }
    });
    return best;
  }

  /** the wall being drawn: its points so far, the curve through them and on to the cursor */
  drawWallPreview() {
    if (this.wallPreview) { this.scene.remove(this.wallPreview); disposeTree(this.wallPreview); this.wallPreview = null; }
    if (this.tool !== 'wall') return;
    const g = new THREE.Group();
    const pts = [...this.wallPts];
    if (this.hoverPt) pts.push([this.hoverPt.x, this.hoverPt.z]);
    const col = this.wallKick ? '#ff5cf4' : this.wallOneWay ? '#ffd23a' : '#3cf2ff';
    if (pts.length >= 2) {
      const pl = railPolyline({ pts });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pl.map(([x, z]) => new THREE.Vector3(x, this.groundY(x, z) + this.wallH, z))), new THREE.LineBasicMaterial({ color: col, toneMapped: false, depthTest: false, transparent: true }));
      line.renderOrder = 22;
      g.add(line);
    }
    for (const [x, z] of this.wallPts) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, depthTest: false }));
      dot.position.set(x, this.groundY(x, z) + this.wallH, z); dot.renderOrder = 23;
      g.add(dot);
    }
    this.wallPreview = g;
    this.scene.add(g);
  }

  finishWall() {
    if (this.wallPts.length >= 2) {
      this.snapshot();
      const r: Rail = { pts: this.wallPts.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100] as [number, number]), h: this.wallH };
      if (this.wallKick) { r.kick = 10; r.t = 0.5; }
      if (this.wallOneWay) { r.oneWay = 1; r.t = 0.3; r.h = Math.min(this.wallH, 1.1); }
      (this.def.rails ??= []).push(r);
      this.rebuildRails();
      this.scheduleSave();
    }
    this.wallPts = [];
    this.drawWallPreview();
  }

  setPinball(on: boolean) {
    this.snapshot();
    this.def.pinball = on || undefined;
    this.def.tilt = on ? this.def.tilt || 0.15 : undefined;
    if (on) this.testMode = 'pinball';
    this.rebuildTerrain();
    this.renderRight();
    this.renderTop();
    this.scheduleSave();
  }

  groundY(x: number, z: number) {
    const y = this.terrain.height(x, z);
    return y <= VOID ? 0 : y;
  }

  makeArrow(color: string, len = 1.6) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 });
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 1), mat);
    shaft.name = 'shaft';
    const cone = new THREE.ConeGeometry(0.42, 0.9, 16);
    cone.rotateX(Math.PI / 2);
    const tip = new THREE.Mesh(cone, mat);
    tip.name = 'tip';
    g.add(shaft, tip);
    g.renderOrder = 30;
    shaft.renderOrder = tip.renderOrder = 30;
    this.setArrowLen(g, len);
    return g;
  }

  setArrowLen(g: THREE.Group, len: number) {
    const shaft = g.getObjectByName('shaft')!, tip = g.getObjectByName('tip')!;
    const s = Math.max(0.1, len - 0.9);
    shaft.scale.z = s;
    shaft.position.z = s / 2;
    tip.position.z = s + 0.45;
  }

  makeMarker(m: Marker): THREE.Group {
    const g = new THREE.Group();
    const col = (m.kind === 'spawn' || m.kind === 'flag') && m.team !== undefined ? TEAM_COL[m.team] ?? '#fff' : MINFO[m.kind].color;
    const glowMat = () => new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: 0.85 });
    const solid = () => new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.3 });
    const flatRing = (r0: number, r1: number, op = 0.7) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      return ring;
    };
    switch (m.kind) {
      case 'spawn': {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1, 16), glowMat());
        c.rotation.x = Math.PI; c.position.y = 1.2;
        g.add(c, flatRing(0.6, 0.8));
        break;
      }
      case 'item': {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.75), solid());
        b.position.y = 0.8; b.userData.spin = true;
        g.add(b);
        break;
      }
      case 'bumper': case 'pillar': {
        const r = m.r ?? 0.8, hh = m.kind === 'pillar' ? 2.4 : 0.9;
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, hh, m.kind === 'pillar' ? 8 : 24), solid());
        c.position.y = hh / 2;
        g.add(c);
        break;
      }
      case 'arm': {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.2, 12), new THREE.MeshStandardMaterial({ color: '#333', metalness: 0.8, roughness: 0.3 }));
        post.position.y = 0.6;
        const L = m.len ?? 4;
        const pivot = new THREE.Group();
        const bar = new THREE.Mesh(new THREE.BoxGeometry(L, 0.4, 0.55), solid());
        bar.position.set(L / 2, 0.45, 0);
        pivot.add(bar);
        pivot.userData.arm = true;
        g.add(post, pivot, flatRing(L - 0.05, L + 0.05, 0.25));
        break;
      }
      case 'saw': {
        const R = m.r ?? 5;
        g.add(flatRing(Math.max(0.01, R - 0.06), R + 0.06, 0.45));
        const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.12, 16), new THREE.MeshStandardMaterial({ color: '#d9dde3', metalness: 1, roughness: 0.2, emissive: '#ff1a1a', emissiveIntensity: 0.3 }));
        blade.position.y = 0.35;
        blade.userData.saw = true;
        const hub = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), glowMat());
        hub.position.y = 0.3;
        g.add(blade, hub);
        break;
      }
      case 'boost': {
        // local +z = push direction; rotation.y = rot maps +z to (sin rot, cos rot) — same as the sim
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 2.8), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
        pad.rotation.x = -Math.PI / 2; pad.position.y = 0.05;
        const arrow = this.makeArrow(col, 2.4);
        arrow.position.set(0, 0.25, -1.1);
        g.add(pad, arrow);
        g.rotation.y = m.rot ?? 0;
        break;
      }
      case 'spinpad': g.add(flatRing((m.r ?? 1.1) * 0.6, m.r ?? 1.1)); break;
      case 'flag': {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), new THREE.MeshStandardMaterial({ color: '#ccc' }));
        pole.position.y = 0.8;
        const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), glowMat());
        orb.position.y = 1.7;
        g.add(pole, orb, flatRing(1.6, 2.0));
        break;
      }
      case 'zone': {
        const r = m.r ?? 2.6;
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 2.5, 40, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
        cyl.position.y = 1.25;
        g.add(cyl, flatRing(r - 0.08, r));
        break;
      }
      case 'checkpoint': {
        const r = m.r ?? 2.2;
        for (const sgn of [-1, 1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.4, 6), glowMat()); post.position.set(Math.cos(m.rot ?? 0) * r * sgn, 1.2, -Math.sin(m.rot ?? 0) * r * sgn); g.add(post); }
        g.add(flatRing(r - 0.1, r));
        break;
      }
      case 'goal': {
        const r = m.r ?? 2.6;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.18, 8, 40), glowMat());
        ring.position.y = r + 0.3; ring.rotation.y = Math.PI / 2;
        g.add(ring, flatRing(r - 0.12, r));
        break;
      }
      case 'hive': {
        const r = m.r ?? 8;
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2), glowMat());
        g.add(dome, flatRing(r - 0.15, r));
        break;
      }
      case 'flipper': {
        const L = m.len ?? 3.5;
        const pivot = new THREE.Group();
        const bar = new THREE.Mesh(new THREE.BoxGeometry(L, 0.45, 0.6), solid());
        bar.position.set(L / 2, 0.3, 0);
        pivot.add(bar);
        pivot.rotation.y = -(m.rot ?? 0);
        g.add(pivot);
        break;
      }
      case 'plunger': {
        const rod = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 2), solid());
        rod.position.set(0, 0.3, 1.4);
        g.add(rod, flatRing((m.r ?? 1.1) * 0.6, m.r ?? 1.1));
        break;
      }
      case 'target': case 'post': {
        const r = m.kind === 'post' ? m.r ?? 0.45 : (m.r ?? 0.8) * 0.6;
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.1, 16), solid());
        c.position.y = 0.55;
        g.add(c);
        break;
      }
      case 'drop': {
        const w = (m.r ?? 0.75) * 2;
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.0, w), solid());
        plate.position.y = 0.5; plate.rotation.y = -(m.rot ?? 0);
        g.add(plate);
        break;
      }
      case 'saucer': case 'kickback': case 'portal': case 'rollover': {
        const r = m.r ?? 1;
        g.add(flatRing(r * 0.55, r * (m.kind === 'rollover' ? 0.75 : 0.9)));
        if (m.kind !== 'rollover' && (m.kind !== 'portal' || m.rot !== undefined)) {
          const a = m.rot ?? 0;
          const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 3), glowMat());
          arrow.rotation.order = 'YXZ'; arrow.rotation.y = -a + Math.PI / 2; arrow.rotation.x = Math.PI / 2;
          arrow.position.set(Math.cos(a) * (r + 0.6), 0.15, Math.sin(a) * (r + 0.6));
          g.add(arrow);
        }
        break;
      }
      case 'arena': {
        const R = m.r ?? 5;
        g.add(flatRing(R - 0.12, R + 0.12, 0.8), flatRing(R + 1.45, R + 1.6, 0.5));
        const a = m.rot ?? Math.PI / 2;
        const gate = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 2.8), glowMat());
        gate.position.set(Math.cos(a) * (R + 1.6), 0.6, Math.sin(a) * (R + 1.6)); gate.rotation.y = -a;
        g.add(gate);
        break;
      }
      case 'gem': {
        const gm = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42), glowMat());
        gm.position.y = 0.9; gm.userData.spin = true;
        g.add(gm);
        break;
      }
    }
    g.position.set(m.x, this.groundY(m.x, m.z), m.z);
    return g;
  }

  rebuildMarkers() {
    for (const o of this.markerObjs) { this.markerGroup.remove(o); disposeTree(o); }
    this.markerObjs = this.def.markers.map((m) => {
      const o = this.makeMarker(m);
      this.markerGroup.add(o);
      return o;
    });
    this.drawMini();
  }

  // ============================================================ overlay: ghosts, outlines, arrows
  clearOverlay() {
    for (const o of [...this.overlay.children]) { this.overlay.remove(o); disposeTree(o); }
  }

  ghostMesh(kind: PieceKind, rot: number, level: number, i: number, j: number, color: string, opacity: number) {
    const c = this.def.course!;
    const T = c.tile;
    const one: CourseDef = { tile: T, w: 1, h: 1, pieces: [{ kind, x: 0, y: 0, rot, level }] };
    const cx = (i + 0.5) * T - (c.w * T) / 2, cz = (j + 0.5) * T - (c.h * T) / 2;
    const N = 22;
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    const ok = new Uint8Array((N + 1) * (N + 1));
    let maxY = level * LEVEL_H;
    for (let b = 0; b <= N; b++)
      for (let a = 0; a <= N; a++) {
        const lx = (a / N - 0.5) * T * 0.999, lz = (b / N - 0.5) * T * 0.999;
        const y0 = courseHeight(one, lx, lz), y = y0 > VOID ? y0 + tiltLift(this.def, cz + lz) : y0; // (a tilted table: the ghost sits on the slope)
        const k = b * (N + 1) + a;
        ok[k] = y > VOID ? 1 : 0;
        const yy = y > VOID ? y : level * LEVEL_H + tiltLift(this.def, cz + lz);
        maxY = Math.max(maxY, yy);
        pos[k * 3] = cx + lx; pos[k * 3 + 1] = yy + 0.07; pos[k * 3 + 2] = cz + lz;
      }
    const idx: number[] = [];
    for (let b = 0; b < N; b++)
      for (let a = 0; a < N; a++) {
        const k = b * (N + 1) + a;
        if (ok[k] && ok[k + 1] && ok[k + N + 1] && ok[k + N + 2]) idx.push(k, k + N + 1, k + 1, k + 1, k + N + 1, k + N + 2);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const g = new THREE.Group();
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    const wire = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: Math.min(1, opacity * 0.9), depthWrite: false, toneMapped: false }));
    fill.renderOrder = wire.renderOrder = 15;
    g.add(fill, wire);
    return { g, maxY, cx, cz };
  }

  cellOutline(i: number, j: number, color: string) {
    const c = this.def.course!;
    const T = c.tile;
    const x0 = i * T - (c.w * T) / 2, z0 = j * T - (c.h * T) / 2;
    const pts: THREE.Vector3[] = [];
    const corners = [[x0, z0], [x0 + T, z0], [x0 + T, z0 + T], [x0, z0 + T]];
    for (let e = 0; e < 4; e++) {
      const [ax, az] = corners[e], [bx, bz] = corners[(e + 1) % 4];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const sx = x + (x0 + T / 2 - x) * 0.03, sz = z + (z0 + T / 2 - z) * 0.03;
        const hh = this.terrain.height(sx, sz);
        pts.push(new THREE.Vector3(x, (hh <= VOID ? 0 : hh) + 0.12, z));
      }
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, toneMapped: false, depthTest: false, transparent: true }));
    line.renderOrder = 20;
    return line;
  }

  /** rebuild the hover overlay when something affecting it changed */
  refreshOverlay(force = false) {
    const c = this.def?.course;
    const rect = this.drag?.kind === 'rect' && this.drag.startCell && this.hover ? this.rectCells(this.drag.startCell, this.hover) : null;
    const key = JSON.stringify([this.tool, this.hover, this.tool === 'paint' ? this.cursorAim() : null, this.aimCursor, this.pieceKind, this.paintRot, this.paintLevel, this.brush, this.autoOrient, this.symX, this.symZ, rect?.length, this.drag?.startCell]);
    if (!force && key === this.overlayKey) { this.updateHint(); return; }
    this.overlayKey = key;
    this.clearOverlay();
    this.updateHint();
    if (!c || !this.hover) { this.drawMini(); return; }
    const tileTools = this.tool === 'paint' || this.tool === 'erase' || this.tool === 'level' || this.tool === 'pick';
    if (!tileTools) { this.drawMini(); return; }
    const base = rect ?? (this.tool === 'pick' ? [this.hover] : this.brushCells(this.hover.i, this.hover.j));
    const cells = this.tool === 'pick' ? base.map((b) => ({ ...b, mx: false, mz: false })) : this.withMirrors(base);
    const col = this.tool === 'erase' ? '#ff3b4a' : this.tool === 'level' ? '#38ff7a' : this.tool === 'pick' ? '#ffffff' : '#3cf2ff';
    for (const cell of cells) {
      const cur = pieceAt(c, cell.i, cell.j);
      this.overlay.add(this.cellOutline(cell.i, cell.j, cur && this.tool === 'paint' ? '#ffd23a' : col));
      if (this.tool !== 'paint') continue;
      // ghost of the exact piece that will be placed (after auto-orient)
      const aim = base.length === 1 ? this.cursorAim() : null;
      const pp = aim ?? this.paintPiece();
      let kind = pp.kind, rot = DIRECTIONAL.has(kind) ? CourseEditor.mirrorRot(kind, pp.rot, cell.mx, cell.mz) : 0;
      if (this.autoOrient && !aim && cells.length <= 9) {
        const had = pieceAt(c, cell.i, cell.j);
        const tmp: Piece = { kind, x: cell.i, y: cell.j, rot, level: this.paintLevel };
        if (!had) c.pieces.push(tmp);
        const o = this.autoFor(had ? { ...tmp } : tmp);
        if (!had) c.pieces.pop();
        if (o) { kind = o.kind; rot = o.rot; }
      }
      const { g, maxY, cx, cz } = this.ghostMesh(kind, rot, this.paintLevel, cell.i, cell.j, cur ? '#ffd23a' : '#3cf2ff', 0.33);
      this.overlay.add(g);
      if (DIRECTIONAL.has(kind) && kind !== 'half' && kind !== 'spine' && kind !== 'bumps') {
        const [dx, dz] = kind === 'corner' ? CORNER_DIR[rot] : EDGE_DIR[rot];
        const L = Math.hypot(dx, dz);
        const arrow = this.makeArrow(cur ? '#ffd23a' : '#3cf2ff', 2.4);
        arrow.position.set(cx - (dx / L) * 1.1, maxY + 1.2, cz - (dz / L) * 1.1);
        arrow.rotation.y = Math.atan2(dx, dz);
        arrow.userData.pulse = true;
        this.overlay.add(arrow);
      }
    }
    this.drawMini();
  }

  updateHint() {
    const c = this.def?.course;
    const parts: string[] = [];
    if (c && this.hover && (this.tool === 'paint' || this.tool === 'erase' || this.tool === 'level' || this.tool === 'pick')) {
      const p = pieceAt(c, this.hover.i, this.hover.j);
      parts.push(`Tile ${this.hover.i},${this.hover.j}: ${p ? `${PIECES[p.kind].label}${DIRECTIONAL.has(p.kind) ? ` ${p.rot * 90}°` : ''} · level ${p.level}` : 'empty'}`);
    } else if (this.hoverPt) parts.push(`x ${this.hoverPt.x.toFixed(1)}  z ${this.hoverPt.z.toFixed(1)}`);
    const tips: Record<Tool, string> = {
      paint: 'Click/drag paint · Shift-drag rectangle · Wheel/Q/E rotate · [ ] level · RMB erase',
      level: 'Click raise · RMB lower · Shift-drag rectangle',
      erase: 'Click erase tile or marker · Shift-drag rectangle',
      place: 'Click place · drag to aim / size · RMB delete marker · G snap',
      wall: 'Click points along the wall · click the last point / Enter to finish · RMB undo point · Esc cancel',
      select: 'Click select · drag move · yellow handle resize/aim · Q/E rotate · Del delete',
      pick: 'Click a tile or marker to copy it',
    };
    parts.push(tips[this.tool], 'RMB-drag orbit · MMB pan · Shift+wheel zoom · F frame · Ctrl+Z/Y');
    this.el.hint.textContent = parts.join('   —   ');
  }

  // ============================================================ input
  pick(e: { clientX: number; clientY: number }) {
    const rect = this.app.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const mesh = this.arena?.children[0];
    if (mesh) {
      const hit = this.ray.intersectObject(mesh, false)[0];
      if (hit && hit.point.y > -3) return { x: hit.point.x, z: hit.point.z };
    }
    const p = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.paintLevel * LEVEL_H);
    return this.ray.ray.intersectPlane(plane, p) ? { x: p.x, z: p.z } : null;
  }

  cellOf(x: number, z: number) {
    const c = this.def.course!;
    const i = Math.floor((x + (c.w * c.tile) / 2) / c.tile), j = Math.floor((z + (c.h * c.tile) / 2) / c.tile);
    if (!this.reachable(i, j)) return null;
    return { i, j };
  }

  refreshHover(e: { clientX: number; clientY: number }) {
    const p = this.pick(e);
    this.hoverPt = p;
    if (this.tool === 'wall') this.drawWallPreview();
    const cell = p ? this.cellOf(p.x, p.z) : null;
    const changed = cell?.i !== this.hover?.i || cell?.j !== this.hover?.j;
    this.hover = cell;
    this.hoverMarker = p && (this.tool === 'select' || this.tool === 'place' || this.tool === 'erase' || this.tool === 'pick') ? this.markerAt(p.x, p.z) : -1;
    this.refreshOverlay();
    return changed;
  }

  onDown(e: PointerEvent) {
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic (gamepad cursor) pointer */ }
    this.mouse = { x: e.clientX, y: e.clientY };
    this.refreshHover(e);
    if (e.button === 2 || (e.button === 0 && e.altKey)) { this.rightDown = { x: e.clientX, y: e.clientY, moved: false }; return; }
    if (e.button === 1) { this.midDown = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    const pt = this.hoverPt;
    switch (this.tool) {
      case 'paint': case 'erase': case 'level': {
        if (this.tool === 'erase' && this.hoverMarker >= 0) { this.deleteMarker(this.hoverMarker); return; }
        if (this.tool === 'erase' && pt) { const ri = this.railAt(pt.x, pt.z); if (ri >= 0) { this.snapshot(); this.def.rails!.splice(ri, 1); this.rebuildRails(); this.scheduleSave(); return; } }
        if (!this.hover) return;
        this.snapshot();
        if (e.shiftKey) { this.drag = { kind: 'rect', startCell: { ...this.hover } }; this.refreshOverlay(true); return; }
        this.drag = { kind: 'paint' };
        this.applyCells(this.brushCells(this.hover.i, this.hover.j), this.tool === 'paint' ? 'paint' : this.tool === 'erase' ? 'erase' : 'raise');
        this.refreshOverlay(true);
        break;
      }
      case 'place': {
        if (!pt) return;
        this.drag = { kind: 'place', start: this.snapPt(pt.x, pt.z), moved: false };
        break;
      }
      case 'wall': {
        if (!pt) return;
        const p = this.snapPt(pt.x, pt.z), last = this.wallPts[this.wallPts.length - 1];
        // clicking the last point again (or a double-click) finishes the wall
        if (last && Math.hypot(p.x - last[0], p.z - last[1]) < 0.45) { this.finishWall(); return; }
        this.wallPts.push([p.x, p.z]);
        this.drawWallPreview();
        this.renderRight();
        break;
      }
      case 'select': {
        if (!pt) return;
        const sel = this.def.markers[this.selected];
        const hp = sel ? this.handlePos(sel) : null;
        if (sel && hp && Math.hypot(hp.x - pt.x, hp.z - pt.z) < 0.9) { this.snapshot(); this.drag = { kind: 'handle' }; return; }
        const idx = this.markerAt(pt.x, pt.z);
        if (idx >= 0) {
          this.snapshot();
          this.selected = idx;
          const m = this.def.markers[idx];
          this.drag = { kind: 'move', offset: { x: m.x - pt.x, z: m.z - pt.z } };
        } else this.selected = -1;
        this.renderCard();
        this.renderRight();
        break;
      }
      case 'pick': {
        if (this.hoverMarker >= 0) {
          const m = this.def.markers[this.hoverMarker];
          this.markerKind = m.kind;
          if (m.team !== undefined) this.team = m.team;
          this.setTool('place');
          this.app.toast(`Picked ${MINFO[m.kind].label}`);
        } else if (this.hover) {
          const p = pieceAt(this.def.course!, this.hover.i, this.hover.j);
          if (!p) return;
          if (p.kind === 'corner') { this.pieceKind = 'quarter'; this.paintRot = p.rot + 4; } else { this.pieceKind = p.kind; this.paintRot = p.rot; }
          this.paintLevel = p.level;
          this.setTool('paint');
          this.app.toast(`Picked ${PIECES[p.kind].label}`);
        }
        break;
      }
    }
  }

  onMove(e: PointerEvent) {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (this.rightDown) {
      const dx = e.clientX - this.rightDown.x, dy = e.clientY - this.rightDown.y;
      if (!this.rightDown.moved && Math.hypot(dx, dy) > 4) this.rightDown.moved = true;
      if (this.rightDown.moved) {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(0.12, Math.min(1.48, this.pitch + dy * 0.005));
        this.rightDown.x = e.clientX; this.rightDown.y = e.clientY;
      }
      return;
    }
    if (this.midDown) {
      const dx = e.clientX - this.midDown.x, dy = e.clientY - this.midDown.y;
      this.pan(dx, dy);
      this.midDown.x = e.clientX; this.midDown.y = e.clientY;
      return;
    }
    const changed = this.refreshHover(e);
    const d = this.drag;
    const pt = this.hoverPt;
    if (!d) return;
    if (d.kind === 'paint' && changed && this.hover)
      this.applyCells(this.brushCells(this.hover.i, this.hover.j), this.tool === 'paint' ? 'paint' : this.tool === 'erase' ? 'erase' : 'raise');
    if (d.kind === 'rect' && changed) this.refreshOverlay(true);
    if (d.kind === 'place' && pt && d.start) {
      const dx = pt.x - d.start.x, dz = pt.z - d.start.z;
      if (Math.hypot(dx, dz) > 0.5) d.moved = true;
      this.showAim(d.start, dx, dz);
    }
    if (d.kind === 'move' && pt && d.offset && this.selected >= 0) {
      const m = this.def.markers[this.selected];
      const s = this.snapPt(pt.x + d.offset.x, pt.z + d.offset.z);
      m.x = s.x; m.z = s.z;
      this.markerObjs[this.selected]?.position.set(m.x, this.groundY(m.x, m.z), m.z);
    }
    if (d.kind === 'handle' && pt && this.selected >= 0) {
      const m = this.def.markers[this.selected];
      this.applyDrag(m, pt.x - m.x, pt.z - m.z);
      this.rebuildMarkers();
    }
  }

  showAim(start: { x: number; z: number }, dx: number, dz: number) {
    const info = MINFO[this.markerKind];
    const L = Math.hypot(dx, dz);
    this.aim.visible = info.drag !== 'none' && L > 0.5;
    if (!this.aim.visible) return;
    const y = this.groundY(start.x, start.z) + 0.6;
    this.aim.position.set(start.x, y, start.z);
    this.aim.rotation.y = Math.atan2(dx, dz);
    this.setArrowLen(this.aim, Math.max(1.2, L));
  }

  onUp(e: PointerEvent) {
    if ((e.button === 2 || e.altKey) && this.rightDown) {
      if (!this.rightDown.moved) this.rightClick();
      this.rightDown = null;
      return;
    }
    if (e.button === 1) { this.midDown = null; return; }
    const d = this.drag;
    this.drag = null;
    this.aim.visible = false;
    if (!d) return;
    if (d.kind === 'rect' && d.startCell && this.hover) {
      this.applyCells(this.rectCells(d.startCell, this.hover), this.tool === 'paint' ? 'paint' : this.tool === 'erase' ? 'erase' : 'raise');
      this.refreshOverlay(true);
    }
    if (d.kind === 'place' && d.start) {
      const pt = this.hoverPt;
      if (!d.moved) {
        const near = this.markerAt(d.start.x, d.start.z, 0.8);
        if (near >= 0) { this.selected = near; this.setTool('select'); return; }
      }
      const drag = d.moved && pt ? { x: pt.x - d.start.x, z: pt.z - d.start.z } : undefined;
      this.addMarkers(this.newMarker(d.start.x, d.start.z, drag));
    }
    if (d.kind === 'move' || d.kind === 'handle') {
      this.rebuildMarkers();
      this.renderCard();
      this.scheduleSave();
    }
  }

  rightClick() {
    switch (this.tool) {
      case 'paint': case 'erase': {
        if (this.hoverMarker >= 0 && this.tool === 'erase') { this.deleteMarker(this.hoverMarker); return; }
        if (!this.hover || !pieceAt(this.def.course!, this.hover.i, this.hover.j)) return;
        this.snapshot();
        this.applyCells(this.brushCells(this.hover.i, this.hover.j), 'erase');
        this.refreshOverlay(true);
        break;
      }
      case 'level':
        if (!this.hover) return;
        this.snapshot();
        this.applyCells(this.brushCells(this.hover.i, this.hover.j), 'lower');
        this.refreshOverlay(true);
        break;
      case 'place': case 'select':
        if (this.hoverMarker >= 0) this.deleteMarker(this.hoverMarker);
        break;
      case 'wall':
        this.wallPts.pop();
        this.drawWallPreview();
        this.renderRight();
        break;
    }
  }

  onWheel(e: WheelEvent) {
    e.preventDefault();
    this.refreshHover(e);
    const zoom = e.shiftKey || e.ctrlKey || !(this.tool === 'paint' && this.hover);
    if (!zoom) { this.rotatePaint(e.deltaY > 0 ? 1 : -1); return; }
    this.dist = Math.max(6, Math.min(180, this.dist * Math.pow(1.1, Math.sign(e.deltaY))));
  }

  pan(dx: number, dy: number) {
    const k = this.dist * 0.0016;
    const cs = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    this.target.x += (-dx * cs - dy * sn) * k;
    this.target.z += (dx * sn - dy * cs) * k;
  }

  // ============================================================ minimap
  miniLayout() {
    const c = this.def.course!;
    const W = this.mini!.width, H = this.mini!.height;
    const cs = Math.floor(Math.min((W - 8) / c.w, (H - 8) / c.h));
    const ox = Math.floor((W - cs * c.w) / 2), oy = Math.floor((H - cs * c.h) / 2);
    return { cs, ox, oy };
  }

  miniClick(e: PointerEvent, drag = false) {
    e.preventDefault();
    if (!this.mini) return;
    const c = this.def.course!;
    const r = this.mini.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.mini.width, py = ((e.clientY - r.top) / r.height) * this.mini.height;
    const { cs, ox, oy } = this.miniLayout();
    const i = Math.floor((px - ox) / cs), j = Math.floor((py - oy) / cs);
    if (i < 0 || j < 0 || i >= c.w || j >= c.h) return;
    if (this.tool !== 'paint' && this.tool !== 'erase' && this.tool !== 'level') return;
    if (!drag) this.snapshot();
    const op = e.button === 2 ? (this.tool === 'level' ? 'lower' : 'erase') : this.tool === 'paint' ? 'paint' : this.tool === 'erase' ? 'erase' : 'raise';
    this.applyCells(this.brushCells(i, j), op);
  }

  drawMini() {
    const cv = this.mini;
    if (!cv || !this.def?.course) return;
    const ctx = cv.getContext('2d')!;
    const c = this.def.course;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const { cs, ox, oy } = this.miniLayout();
    ctx.font = `700 ${Math.max(9, cs * 0.36)}px Rajdhani, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let j = 0; j < c.h; j++)
      for (let i = 0; i < c.w; i++) {
        const x = ox + i * cs, y = oy + j * cs;
        const p = pieceAt(c, i, j);
        ctx.fillStyle = p ? PIECE_COL[p.kind] : 'rgba(255,255,255,0.04)';
        ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2);
        if (!p) continue;
        ctx.fillStyle = '#fff';
        ctx.fillText(PIECE_ABBR[p.kind], x + cs / 2, y + cs / 2);
        if (p.level) { ctx.fillStyle = '#ffd23a'; ctx.fillText('·'.repeat(p.level), x + cs / 2, y + cs * 0.8); }
        if (DIRECTIONAL.has(p.kind) && p.kind !== 'half' && p.kind !== 'spine' && p.kind !== 'bumps') {
          const [dx, dz] = p.kind === 'corner' ? CORNER_DIR[p.rot] : EDGE_DIR[p.rot];
          ctx.strokeStyle = '#3cf2ff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          if (p.kind === 'corner') {
            const cx = x + cs / 2 + (dx * cs) / 2 - dx * 3, cy = y + cs / 2 + (dz * cs) / 2 - dz * 3;
            ctx.moveTo(cx - dx * cs * 0.3, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy - dz * cs * 0.3);
          } else if (dx) {
            const ex = x + cs / 2 + (dx * cs) / 2 - dx * 3;
            ctx.moveTo(ex, y + 4); ctx.lineTo(ex, y + cs - 4);
          } else {
            const ey = y + cs / 2 + (dz * cs) / 2 - dz * 3;
            ctx.moveTo(x + 4, ey); ctx.lineTo(x + cs - 4, ey);
          }
          ctx.stroke();
        }
      }
    // mirror axes
    if (this.symX || this.symZ) {
      ctx.strokeStyle = 'rgba(255,61,180,0.8)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (this.symX) { ctx.moveTo(ox + (c.w * cs) / 2, oy); ctx.lineTo(ox + (c.w * cs) / 2, oy + c.h * cs); }
      if (this.symZ) { ctx.moveTo(ox, oy + (c.h * cs) / 2); ctx.lineTo(ox + c.w * cs, oy + (c.h * cs) / 2); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const T = c.tile;
    this.def.markers.forEach((m, k) => {
      const px = ox + ((m.x + (c.w * T) / 2) / T) * cs, py = oy + ((m.z + (c.h * T) / 2) / T) * cs;
      ctx.fillStyle = (m.kind === 'spawn' || m.kind === 'flag') && m.team !== undefined ? TEAM_COL[m.team] : MINFO[m.kind].color;
      ctx.beginPath();
      ctx.arc(px, py, k === this.selected ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (k === this.selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
    });
    if (this.hover && (this.tool === 'paint' || this.tool === 'erase' || this.tool === 'level')) {
      ctx.strokeStyle = '#ffd23a';
      ctx.lineWidth = 2;
      for (const cell of this.withMirrors(this.brushCells(this.hover.i, this.hover.j))) ctx.strokeRect(ox + cell.i * cs + 1, oy + cell.j * cs + 1, cs - 2, cs - 2);
    }
  }

  // ============================================================ frame
  keys() {
    const inp = this.app.input;
    const P = (k: string) => inp.pressed.has(k);
    const ctrl = inp.keys.has('ControlLeft') || inp.keys.has('ControlRight') || inp.keys.has('MetaLeft');
    const shift = inp.keys.has('ShiftLeft') || inp.keys.has('ShiftRight');
    if (ctrl && P('KeyZ')) { if (shift) this.doRedo(); else this.doUndo(); return; }
    if (ctrl && P('KeyY')) { this.doRedo(); return; }
    if (ctrl) return;
    const toolKeys: Record<string, Tool> = { KeyB: 'paint', KeyL: 'level', KeyX: 'erase', KeyP: 'place', KeyV: 'select', KeyI: 'pick', KeyC: 'wall' };
    if (this.tool === 'wall' && P('Enter')) { this.finishWall(); return; }
    if (this.tool === 'wall' && P('Escape') && this.wallPts.length) { this.wallPts = []; this.drawWallPreview(); this.renderRight(); return; }
    for (const [k, t] of Object.entries(toolKeys)) if (P(k)) this.setTool(t);
    if (P('Digit1') || P('Digit2') || P('Digit3')) { this.brush = P('Digit1') ? 1 : P('Digit2') ? 2 : 3; this.renderRight(); this.refreshOverlay(true); }
    const rotL = P('KeyQ'), rotR = P('KeyE') || P('KeyR');
    if (rotL || rotR) {
      if (this.tool === 'select') this.rotateSelected(rotL ? -1 : 1);
      else this.rotatePaint(rotL ? -1 : 1);
    }
    if (P('BracketLeft')) this.setPaintLevel(this.paintLevel - 1);
    if (P('BracketRight')) this.setPaintLevel(this.paintLevel + 1);
    if ((P('Delete') || P('Backspace')) && this.selected >= 0) this.deleteMarker(this.selected);
    if (P('KeyG')) this.cycleSnap();
    if (P('KeyF')) this.frame();
    if (P('Tab')) this.toggleDrawer();
    if (P('Escape')) {
      if (this.selected >= 0) { this.selected = -1; this.renderCard(); this.renderRight(); }
      else if (this.drawerOpen) this.toggleDrawer();
      else this.app.back();
    }
    // keyboard pan
    const kp = (a: string[]) => a.some((k) => inp.keys.has(k));
    const sp = 12;
    let px = 0, py = 0;
    if (kp(['ArrowLeft'])) px += sp;
    if (kp(['ArrowRight'])) px -= sp;
    if (kp(['ArrowUp'])) py += sp;
    if (kp(['ArrowDown'])) py -= sp;
    if (px || py) this.pan(px, py);
  }

  /** controller: cursor + tool shortcuts + camera (see the hint strip) */
  padControls(dt: number) {
    const pc = this.pad;
    if (!pc) return;
    const using = pc.update(dt);
    this.padHint?.classList.toggle('on', using);
    if (!using) return;
    if (pc.edge(1)) this.app.input.pressed.add('Escape');
    if (pc.edge(3)) this.toggleDrawer();
    if (pc.edge(4) || pc.edge(5)) { const d = pc.edge(4) ? -1 : 1; if (this.tool === 'select') this.rotateSelected(d); else this.rotatePaint(d); }
    if (pc.edge(12)) this.setPaintLevel(this.paintLevel + 1);
    if (pc.edge(13)) this.setPaintLevel(this.paintLevel - 1);
    if (pc.edge(14) || pc.edge(15)) { const i = TOOLS.findIndex((t) => t.id === this.tool); this.setTool(TOOLS[(i + (pc.edge(15) ? 1 : -1) + TOOLS.length) % TOOLS.length].id); this.app.sfx.play('tick'); }
    if (pc.edge(8)) this.doUndo();
    if (pc.edge(9)) this.testRide();
    if (pc.edge(10)) this.frame();
    const inp = this.app.input;
    let rx = 0, ry = 0, lt = 0, rt = 0;
    for (let p = 0; p < inp.padAxes.length; p++) {
      const a = inp.padAxes[p] ?? [];
      if (Math.abs(a[2] ?? 0) > Math.abs(rx)) rx = a[2] ?? 0;
      if (Math.abs(a[3] ?? 0) > Math.abs(ry)) ry = a[3] ?? 0;
    }
    if (pc.btn(6)) lt = 1;
    if (pc.btn(7)) rt = 1;
    if (Math.abs(rx) > 0.15) this.yaw -= rx * 2.2 * dt;
    if (Math.abs(ry) > 0.15) this.pitch = Math.max(0.25, Math.min(1.45, this.pitch - ry * 1.6 * dt));
    if (lt || rt) this.dist = Math.max(6, Math.min(180, this.dist * Math.pow(1.9, (lt - rt) * dt)));
  }

  update(dt: number) {
    this.time += dt;
    this.padControls(dt);
    this.keys();
    if (this.rebuildT > 0) { this.rebuildT -= dt; if (this.rebuildT <= 0) this.rebuildTerrain(); }
    if (this.saveT > 0) { this.saveT -= dt; if (this.saveT <= 0) this.persist(); }

    // animate markers
    this.def.markers.forEach((m, k) => {
      const o = this.markerObjs[k];
      if (!o) return;
      for (const ch of o.children) {
        if (ch.userData.spin) ch.rotation.y = this.time * 1.5;
        if (ch.userData.arm) { const p = hazardPose(m, this.time); if (p) ch.rotation.y = -p.angle; }
        if (ch.userData.saw) {
          const p = hazardPose(m, this.time);
          if (p) { ch.position.x = p.ax - m.x; ch.position.z = p.az - m.z; ch.rotation.y = p.angle; }
        }
      }
    });
    for (const o of this.overlay.children) if (o.userData.pulse) o.position.y += Math.sin(this.time * 5) * 0.004;

    const sel = this.def.markers[this.selected];
    const showSel = !!sel && this.tool === 'select';
    this.selRing.visible = showSel;
    const hp = showSel ? this.handlePos(sel!) : null;
    this.handle.visible = !!hp;
    if (sel && showSel) {
      this.selRing.position.set(sel.x, this.groundY(sel.x, sel.z) + 0.12, sel.z);
      this.selRing.scale.setScalar((sel.r && MINFO[sel.kind].drag === 'radius' ? Math.max(1, sel.r * 1.1) : 1) * (1 + Math.sin(this.time * 6) * 0.06));
    }
    if (hp) this.handle.position.set(hp.x, this.groundY(hp.x, hp.z) + 0.5, hp.z);

    // hover tooltip
    const tip = this.el.tip;
    const hm = this.def.markers[this.hoverMarker];
    if (hm && !this.drag) {
      tip.classList.remove('cd-hidden');
      tip.textContent = `${MINFO[hm.kind].label}${hm.team !== undefined ? ` · ${hm.team === 0 ? 'Red' : 'Blue'}` : ''}${this.tool === 'erase' ? ' — click to delete' : this.tool === 'place' ? ' — click to select' : ''}`;
      tip.style.left = `${this.mouse.x + 16}px`;
      tip.style.top = `${this.mouse.y + 14}px`;
    } else tip.classList.add('cd-hidden');

    // camera
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + sp * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(this.target);
    this.positionCard();
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  dispose() {
    if (this.saveT > 0) this.persist();
    this.root.remove();
    disposeTree(this.scene);
    this.scene.clear();
  }
}

let editor: CourseEditor | null = null;

export const courseDesignerScreen: Screen = {
  mount(app: App) {
    editor = new CourseEditor(app);
    if (import.meta.env.DEV) (window as any).__cd = editor; // headless checks
  },
  unmount() {
    editor?.dispose();
    editor = null;
  },
  update(dt: number) {
    editor?.update(dt);
  },
  resize() {
    editor?.resize();
  },
};

// exported for headless tests
export const __courseLab = { templateCourse, wrapWalls, outsideDirs, orientFromOuts, mirrorMarker, MX_EDGE, MZ_EDGE, MX_CORN, MZ_CORN };
