import type { BladeDesign } from '../core/blade';
import type { ArenaDef } from './terrain';

export type ModeId = 'duel' | 'tag' | 'ffa' | 'ctf' | 'rush' | 'koth' | 'gauntlet' | 'race' | 'quest';
export type ItemKind = 'turbo' | 'shield' | 'shock' | 'surge' | 'vortex' | 'titan' | 'comet' | 'mine';
export type FinishType = 'spin' | 'over' | 'burst' | 'xtreme';

export interface ModeInfo { id: ModeId; name: string; tag: string; desc: string; minPlayers: number; maxPlayers: number; teams: number; rounds: boolean; target: number; time: number; arenas: string[] }

export const MODES: ModeInfo[] = [
  { id: 'duel', name: 'Duel', tag: '1 v 1', desc: 'Classic battle. Spin finish 1pt, Over & Burst 2pt, Xtreme 3pt. First to 4.', minPlayers: 2, maxPlayers: 2, teams: 2, rounds: true, target: 4, time: 90, arenas: ['neon-stadium', 'hex-colosseum', 'kidney-pool', 'crater', 'mega-bowl'] },
  { id: 'tag', name: 'Tag Team', tag: '2 v 2', desc: 'Two teams of two. Last team spinning takes the round.', minPlayers: 4, maxPlayers: 4, teams: 2, rounds: true, target: 5, time: 100, arenas: ['hex-colosseum', 'crater', 'kidney-pool', 'mega-bowl', 'titan-colosseum'] },
  { id: 'ffa', name: 'All For One', tag: 'Free-for-all', desc: 'Everyone for themselves. KOs score, last spinner gets a bonus.', minPlayers: 2, maxPlayers: 8, teams: 0, rounds: true, target: 6, time: 100, arenas: ['crater', 'hex-colosseum', 'ramp-park', 'kidney-pool', 'titan-colosseum', 'mega-bowl', 'ramp-park-xl'] },
  { id: 'ctf', name: 'Capture the Flag', tag: 'Teams', desc: 'Grab the enemy core and bring it home. Hard hits make carriers drop it.', minPlayers: 2, maxPlayers: 8, teams: 2, rounds: false, target: 3, time: 240, arenas: ['twin-forts', 'twin-forts-xl', 'ramp-park', 'ramp-park-xl', 'crater'] },
  { id: 'rush', name: 'Crystal Rush', tag: 'Items', desc: 'Collect crystals, smash rivals to make them spill. Item boxes everywhere.', minPlayers: 1, maxPlayers: 8, teams: 0, rounds: false, target: 0, time: 150, arenas: ['ramp-park', 'ramp-park-xl', 'crater', 'mega-bowl', 'kidney-pool', 'twin-forts'] },
  { id: 'koth', name: 'King of the Hill', tag: 'Zone', desc: 'Hold the zone alone to score. The zone moves!', minPlayers: 2, maxPlayers: 8, teams: 0, rounds: false, target: 45, time: 180, arenas: ['hex-colosseum', 'crater', 'kidney-pool', 'ramp-park', 'titan-colosseum', 'mega-bowl'] },
  { id: 'race', name: 'Grand Prix', tag: 'Race', desc: 'F-Zero style laps on floating sky tracks. Boost strips, jumps, items. Fall off and you respawn behind.', minPlayers: 1, maxPlayers: 8, teams: 0, rounds: false, target: 3, time: 300, arenas: ['neon-circuit', 'sky-serpent', 'crystal-canyon', 'inferno-gauntlet', 'frost-byte', 'hyper-tube', 'crossfire-8', 'trefoil'] },
  { id: 'gauntlet', name: 'Gauntlet', tag: 'Solo / Co-op', desc: 'Collect 15 gems through automated hazards and drones before your spin dies.', minPlayers: 1, maxPlayers: 4, teams: 1, rounds: false, target: 15, time: 300, arenas: ['gauntlet-works', 'gauntlet-mega', 'ramp-park', 'kidney-pool'] },
  { id: 'quest', name: 'Blade Quest', tag: 'Adventure', desc: 'Platforming adventure: jump gaps, climb levels, dodge drone hives, grab gems and reach the goal. Checkpoints respawn you and refill your spin.', minPlayers: 1, maxPlayers: 4, teams: 1, rounds: false, target: 0, time: 600, arenas: ['quest-neon-run', 'quest-coaster', 'quest-sky-steps', 'quest-glacier', 'quest-hive-valley', 'quest-titan-peak'] },
];

export const ITEMS: Record<ItemKind, { name: string; icon: string; color: string }> = {
  turbo: { name: 'Turbo', icon: 'flame', color: '#ff7b1c' },
  shield: { name: 'Shield', icon: 'shield', color: '#47b6ff' },
  shock: { name: 'Shockwave', icon: 'burst', color: '#ffe23a' },
  surge: { name: 'Spin Surge', icon: 'swirl', color: '#38ffb0' },
  vortex: { name: 'Vortex', icon: 'tornado', color: '#b46bff' },
  titan: { name: 'Titan', icon: 'arrowUp', color: '#ff4466' },
  comet: { name: 'Comet', icon: 'comet', color: '#ff9e3d' },
  mine: { name: 'Ice Mine', icon: 'snowflake', color: '#9fe8ff' },
};

export type ControllerSpec =
  | { type: 'kb1' }
  | { type: 'kb2' }
  | { type: 'mouse' }
  | { type: 'touch'; gyro?: boolean }
  | { type: 'pad'; index: number }
  | { type: 'cpu'; level: 1 | 2 | 3 }
  | { type: 'remote'; peer: number };

export interface PlayerSetup { slot: number; name: string; team: number; blade: BladeDesign; ctrl: ControllerSpec }

export interface MatchConfig {
  mode: ModeId;
  arena: ArenaDef;
  players: PlayerSetup[];
  items: boolean;
  target: number;
  timeLimit: number;
  seed: number;
  /** race only: CPU catch-up (0 off, 1 normal, 2 strong) */
  rubber?: number;
}

export interface Control { mx: number; mz: number; dash: boolean; jump: boolean; item: boolean; special: boolean }
export const NO_CONTROL: Control = { mx: 0, mz: 0, dash: false, jump: false, item: false, special: false };

export interface TopFx { turbo: number; shield: number; titan: number; vortex: number; frozen: number; special: number; dash: number; /** Spin Surge overcharge time left */ surge: number }

export interface TopState {
  id: number; team: number; name: string; color: string; cpu: boolean;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  spin: number; dir: 1 | -1; angle: number; tx: number; tz: number; // tilt vector
  grounded: boolean; air: number;
  alive: boolean; out: '' | FinishType; outT: number;
  burst: number; special: number; specialKind: 'rush' | 'fortress' | 'vortex' | 'skydive';
  dashCd: number; jumpCd: number; itemCd: number;
  item: ItemKind | null; roll: number; // roll>0 = item roulette spinning
  fx: TopFx;
  flag: number; crystals: number; score: number; kos: number; dmg: number; lives: number;
  respawnT: number; lastHit: number; lastHitT: number;
  launch: number; launchLocked: boolean;
  drone?: boolean; scale: number;
  /** quest: index (into the arena's markers) of the last checkpoint touched, -1 = start; drones: their hive marker */
  qcp?: number; home?: number;
  lap: number; prog: number; cp: number; place: number; finishT: number;
  /** race: seconds spent on the wrong segment of the track (took a crossing); 0 = on course */
  off: number;
}

export interface Crystal { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }
export interface Box { x: number; y: number; z: number; t: number }
export interface Flag { team: number; hx: number; hy: number; hz: number; x: number; y: number; z: number; carrier: number; home: boolean; t: number }
export interface Proj { id: number; kind: 'comet'; x: number; y: number; z: number; vx: number; vy: number; vz: number; owner: number; t: number }
export interface Mine { id: number; x: number; y: number; z: number; owner: number; t: number }
export interface Zone { x: number; y: number; z: number; r: number; owner: number; t: number }
export interface Gem { id: number; x: number; y: number; z: number }

export type GameEvent =
  | { k: 'clash'; x: number; y: number; z: number; s: number; a: number; b: number }
  | { k: 'land'; x: number; y: number; z: number; s: number; id: number }
  | { k: 'grind'; x: number; y: number; z: number; id: number }
  | { k: 'finish'; id: number; type: FinishType; by: number }
  | { k: 'burst'; id: number; x: number; y: number; z: number }
  | { k: 'shock'; x: number; y: number; z: number; r: number; c: string }
  | { k: 'pickup'; id: number; what: string; x: number; y: number; z: number }
  | { k: 'use'; id: number; item: ItemKind }
  | { k: 'special'; id: number }
  | { k: 'dash'; id: number }
  | { k: 'jump'; id: number }
  | { k: 'hazard'; x: number; y: number; z: number; id: number }
  | { k: 'announce'; text: string; sub?: string; color?: string }
  | { k: 'go' }
  | { k: 'count'; n: number };

export interface GameState {
  t: number;
  phase: 'launch' | 'battle' | 'roundEnd' | 'matchEnd';
  phaseT: number;
  round: number;
  timeLeft: number;
  /** sim time the current battle started (after the launch countdown) — finish times are measured from here */
  t0?: number;
  tops: TopState[];
  teamScores: number[];
  boxes: Box[];
  crystals: Crystal[];
  flags: Flag[];
  projs: Proj[];
  mines: Mine[];
  gems: Gem[];
  gemsLeft: number;
  zone: Zone | null;
  events: GameEvent[];
  winner: number; // team, -1 none, -2 draw
  lastFinish: string;
  nextId: number;
}
