import type { BladeDesign } from '../core/blade';
import type { ArenaDef } from './terrain';

export type ModeId = 'duel' | 'tag' | 'ffa' | 'ctf' | 'rush' | 'koth' | 'gauntlet' | 'race' | 'quest' | 'pinball';
export type ItemKind = 'turbo' | 'shield' | 'shock' | 'surge' | 'vortex' | 'titan' | 'comet' | 'mine' | 'fist';
export type FinishType = 'spin' | 'over' | 'burst' | 'xtreme';

export interface ModeInfo { id: ModeId; name: string; tag: string; desc: string; minPlayers: number; maxPlayers: number; teams: number; rounds: boolean; target: number; time: number; arenas: string[]; /** not offered in the mode pickers (rules used by other modes) */ hidden?: boolean }

export const MODES: ModeInfo[] = [
  { id: 'duel', name: 'Battle', tag: '1v1 · free-for-all', desc: '1v1: spin finish 1pt, Over & Burst 2pt, Xtreme 3pt — first to 4. With 3+ blades it\'s a free-for-all: KOs score, last spinner gets a bonus.', minPlayers: 2, maxPlayers: 8, teams: 2, rounds: true, target: 4, time: 90, arenas: ['neon-stadium', 'hex-colosseum', 'kidney-pool', 'crater', 'mega-bowl', 'titan-colosseum', 'ramp-park', 'ramp-park-xl'] },
  { id: 'tag', name: 'Tag Team', tag: 'Teams', desc: 'Two teams (2v2 up to 4v4). Last team spinning takes the round.', minPlayers: 4, maxPlayers: 8, teams: 2, rounds: true, target: 5, time: 100, arenas: ['hex-colosseum', 'crater', 'kidney-pool', 'mega-bowl', 'titan-colosseum'] },
  { id: 'ffa', name: 'Battle', tag: 'Free-for-all', hidden: true, desc: 'Everyone for themselves. KOs score, last spinner gets a bonus.', minPlayers: 2, maxPlayers: 8, teams: 0, rounds: true, target: 6, time: 100, arenas: ['crater', 'hex-colosseum', 'ramp-park', 'kidney-pool', 'titan-colosseum', 'mega-bowl', 'ramp-park-xl'] },
  { id: 'ctf', name: 'Capture the Flag', tag: 'Teams', desc: 'Grab the enemy core and bring it home. Hard hits make carriers drop it.', minPlayers: 2, maxPlayers: 8, teams: 2, rounds: false, target: 3, time: 240, arenas: ['twin-forts', 'twin-forts-xl', 'ramp-park', 'ramp-park-xl', 'crater'] },
  { id: 'rush', name: 'Crystal Rush', tag: 'Items', desc: 'Collect crystals, smash rivals to make them spill. Item boxes everywhere.', minPlayers: 1, maxPlayers: 8, teams: 0, rounds: false, target: 0, time: 150, arenas: ['ramp-park', 'ramp-park-xl', 'crater', 'mega-bowl', 'kidney-pool', 'twin-forts'] },
  { id: 'koth', name: 'King of the Hill', tag: 'Zone', desc: 'Stay in the zone to score — everyone inside banks time (or only a lone holder, with SHARED TIME off). The zone moves!', minPlayers: 2, maxPlayers: 8, teams: 0, rounds: false, target: 45, time: 180, arenas: ['hex-colosseum', 'crater', 'kidney-pool', 'ramp-park', 'titan-colosseum', 'mega-bowl'] },
  { id: 'race', name: 'Grand Prix', tag: 'Race', desc: 'F-Zero style laps on floating sky tracks. Boost strips, jumps, items. Fall off and you respawn behind.', minPlayers: 1, maxPlayers: 8, teams: 0, rounds: false, target: 3, time: 300, arenas: ['neon-circuit', 'sky-serpent', 'crystal-canyon', 'inferno-gauntlet', 'frost-byte', 'hyper-tube', 'crossfire-8', 'trefoil'] },
  { id: 'gauntlet', name: 'Gauntlet', tag: 'Solo / Co-op', desc: 'Collect 15 gems through automated hazards and drones before your spin dies.', minPlayers: 1, maxPlayers: 4, teams: 1, rounds: false, target: 15, time: 300, arenas: ['gauntlet-works', 'gauntlet-mega', 'ramp-park', 'kidney-pool'] },
  { id: 'quest', name: 'Blade Quest', tag: 'Adventure', desc: 'Platforming adventure: jump gaps, climb levels, dodge drone hives, grab gems and reach the goal. Checkpoints respawn you and refill your spin.', minPlayers: 1, maxPlayers: 4, teams: 1, rounds: false, target: 0, time: 600, arenas: ['quest-neon-run', 'quest-coaster', 'quest-sky-steps', 'quest-glacier', 'quest-hive-valley', 'quest-gauntlet-peak'] },
  { id: 'pinball', name: 'Pinball', tag: 'Table', desc: 'Your blade is the ball. Flippers: Left / Right Shift, Ctrl, Tab / Enter, Z / slash, or LB / RB. Hold ↓ to pull the plunger. Steering nudges the table — overdo it and it TILTs. Pop bumpers, slingshots, spin pads; light every target for MULTIBALL. 3 balls. With 2+ players it’s a PINBALL PARTY: a free-for-all on the table — the flippers play themselves, slots refill your spin (DASH fires you out where you steer).', minPlayers: 1, maxPlayers: 8, teams: 1, rounds: false, target: 0, time: 3600, arenas: ['pin-star-cadet', 'pin-swarm-protocol', 'pin-neon-classic', 'pin-synth-cathedral'] },
];
/** the modes you can pick (All For One is Battle with 3+ blades now — its rules stay for that and Pinball Party) */
export const PICK_MODES = MODES.filter((m) => !m.hidden);

export const ITEMS: Record<ItemKind, { name: string; icon: string; color: string }> = {
  turbo: { name: 'Turbo', icon: 'flame', color: '#ff7b1c' },
  shield: { name: 'Shield', icon: 'shield', color: '#47b6ff' },
  shock: { name: 'Shockwave', icon: 'burst', color: '#ffe23a' },
  surge: { name: 'Spin Surge', icon: 'swirl', color: '#38ffb0' },
  vortex: { name: 'Vortex', icon: 'tornado', color: '#b46bff' },
  titan: { name: 'Titan', icon: 'arrowUp', color: '#ff4466' },
  comet: { name: 'Comet', icon: 'comet', color: '#ff9e3d' },
  mine: { name: 'Ice Mine', icon: 'snowflake', color: '#9fe8ff' },
  fist: { name: 'Power Fist', icon: 'fist', color: '#ff3b6b' },
};

export type ControllerSpec =
  /** the keyboard, both layouts (WASD and arrows) — a lone keyboard player */
  | { type: 'kb' }
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
  /** pinball: steering nudges the table (default on); off = flippers only */
  nudge?: boolean;
  /** king of the hill: every top in the zone banks time, not only one holding it alone (default on; false = alone only) */
  kothShare?: boolean;
  /** online rooms: the room's chosen song (whole song, so guests without it hear it too) */
  song?: import('./music').Song;
}

export interface Control { mx: number; mz: number; dash: boolean; jump: boolean; item: boolean; special: boolean; /** dash button held down (overdrive) */ hold?: boolean; /** pinball: left / right flipper buttons held */ flipL?: boolean; flipR?: boolean }
export const NO_CONTROL: Control = { mx: 0, mz: 0, dash: false, jump: false, item: false, special: false };

export interface TopFx { turbo: number; shield: number; titan: number; vortex: number; frozen: number; special: number; dash: number; /** Spin Surge overcharge time left */ surge: number;
  /** Power Fist: the charge's time left — the first top hit in it takes double knockback (and spends it) */ fist: number }

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
  /** seconds of respawn grace left: obstacles pass through you (no knock-off-the-edge loops) */
  graceT?: number;
  /** overdrive: dash held past the burst — faster (and climbs harder) at the cost of spin, steers wider */
  od?: boolean; holdT?: number;
  /** where the current dash (or Power Fist charge) started: a dash's extra punch grows with the run-up */
  dashX?: number; dashZ?: number;
  /** how long it's been at full spin: after a moment there, burst health slowly comes back */
  fullT?: number;
  /** fired by a swinging flipper this long ago: it hits like a dash (attack bonus, scaled by the run from the flipper) */
  flipT?: number;
  /** pinball: this ball has had its launch — rolling back into the plunger lane fires it out again by itself */
  plunged?: boolean; plungeWait?: number;
  /** pinball: aim of the lock this ball sits in · battling in an arena bowl (normal top physics there) */
  aimA?: number; duel?: boolean;
  launch: number; launchLocked: boolean;
  drone?: boolean; scale: number;
  /** quest: index (into the arena's markers) of the last checkpoint touched, -1 = start; drones: their hive marker */
  qcp?: number; home?: number;
  lap: number;
  /** pinball: a multiball ball (no lives, no respawn) / portal cooldown */
  extra?: boolean; portalT?: number;
  /** pinball: held in a capture saucer (marker index) and for how much longer */
  held?: number; heldT?: number; rollT?: number;
  /** saucer catches in a row without touching a flipper, and how long saucers ignore this ball (loop breaker) */
  capN?: number; noCapT?: number; prog: number; cp: number; place: number; finishT: number;
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
  | { k: 'fist'; id: number; x: number; y: number; z: number }
  | { k: 'special'; id: number }
  | { k: 'dash'; id: number }
  | { k: 'jump'; id: number }
  | { k: 'hazard'; x: number; y: number; z: number; id: number }
  | { k: 'announce'; text: string; sub?: string; color?: string }
  | { k: 'go' }
  | { k: 'pin'; what: 'flip' | 'bumper' | 'sling' | 'target' | 'plunge' | 'portal' | 'tilt' | 'danger' | 'multiball' | 'capture' | 'kickout' | 'rollover' | 'drop' | 'bank' | 'kickback' | 'post' | 'group' | 'wormhole' | 'lock' | 'fire' | 'swarm' | 'drone' | 'zap' | 'unlock' | 'duel' | 'duelwin' | 'duellose'; x: number; y: number; z: number; pts?: number }
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
  /** pinball table state: flipper angles (by marker index), lit targets, plunger charge, multiball count */
  pin?: { flip: number[]; lit: boolean[]; charge: number; mult: number; litT: number; /** tilt meter 0..1 (steering fills it) */ tilt: number; tilted: boolean; warned: boolean;
    /** per-marker timers (kickback recharge, drop-target / group reset) and the ball-save time left (center post up) */
    tm: number[]; save: number;
    /** a drone swarm out of a hive (flying drones: smash them fast — slow balls get zapped) */
    swarm: { x: number; z: number; vx: number; vz: number; hp: number; zap: number; ph: number }[]; swarmT: number; swarmHive: number;
    /** an arena duel under way (marker, ball, time left) and the guardian blade's top id (-1 = none yet) */
    duel: { mi: number; ball: number; t: number; game: 'duel' | 'koth'; hold: [number, number] } | null; foe: number;
    /** link channels that are lit (by channel number): their shooters work until used */
    armed?: boolean[];
    /** every link's shot was open at once last frame (the ALL LIT jackpot pays once per time) */
    allLit?: boolean;
    /** the skill shot: the lane (marker) lit by the last launch, and how long it stays lit */
    skill?: { mi: number; t: number; best?: number } | null };
}
