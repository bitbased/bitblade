// Blade design data model, presets and stat derivation.

export type TipType = 'flat' | 'sharp' | 'ball' | 'rubber' | 'needle' | 'wheel';
export type Pattern = 'none' | 'stripes' | 'flames' | 'stars' | 'circuit' | 'camo' | 'carbon' | 'scales' | 'radial' | 'lightning';

export interface Decal {
  glyph: string;
  x: number; // -1..1 across the top face
  y: number;
  size: number; // 0.05..1
  rot: number; // radians
  color: string;
}

export interface BladeDesign {
  id: string;
  name: string;
  spinDir: 1 | -1;
  // attack ring geometry
  wings: number; // 1..8
  wingLength: number; // 0..1
  wingWidth: number; // 0..1
  wingCurve: number; // -1..1 sweep
  wingSharp: number; // 0..1 (round -> spike)
  wingTilt: number; // -1..1 (upper attack vs smash)
  ringRadius: number; // 0..1 core size
  ringThickness: number; // 0..1
  // weight disc
  discSize: number; // 0..1
  discWeight: number; // 0..1
  discNotches: number; // 0..8
  // driver / tip
  tip: TipType;
  tipHeight: number; // 0..1
  // paint
  primary: string;
  secondary: string;
  accent: string;
  glow: string;
  metal: number;
  rough: number;
  pattern: Pattern;
  emblem: string;
  emblemColor: string;
  decals: Decal[];
  /** manual tuning-point allocation; absent = follow the shape (auto) */
  tune?: Tune;
}

export type StatKey = 'attack' | 'defense' | 'stamina' | 'speed' | 'weight' | 'burst';
export type Tune = Record<StatKey, number>;
export const STAT_KEYS: StatKey[] = ['attack', 'defense', 'stamina', 'speed', 'weight', 'burst'];
/** every blade gets the same budget: shapes and tips change HOW points are spread, never how many */
export const TUNE_BUDGET = 30;
export const TUNE_MAX = 10;
export const TUNE_MIN = 2;
export const STAT_INFO: Record<StatKey, { label: string; short: string; color: string; desc: string }> = {
  attack: { label: 'Attack', short: 'ATK', color: '#ff4d4d', desc: 'Harder hits: more spin damage, knockback and burst damage dealt' },
  defense: { label: 'Defense', short: 'DEF', color: '#4da6ff', desc: 'Take less spin damage and get knocked around less' },
  stamina: { label: 'Stamina', short: 'STA', color: '#38ff7a', desc: 'Spin lasts longer — wins the waiting game and races' },
  speed: { label: 'Speed', short: 'SPD', color: '#ffd23a', desc: 'Acceleration and handling — how fast you get where you steer' },
  weight: { label: 'Weight', short: 'WGT', color: '#c77dff', desc: 'Heavier = harder to push around, but a little slower to accelerate' },
  burst: { label: 'Burst Resist', short: 'BRS', color: '#ff9e3d', desc: 'Resists BURST finishes from big hits' },
};

export interface BladeStats {
  points: Tune;
  attack: number; // all 0..1-ish normalised for UI
  defense: number;
  stamina: number;
  speed: number;
  weight: number;
  burstRes: number;
  // physics values
  mass: number;
  radius: number; // world radius
  height: number;
  tipFriction: number; // drift / grip
  spinDecay: number; // per second at full spin
  control: number; // input accel multiplier
}

export const TIPS: Record<TipType, { label: string; friction: number; decay: number; control: number; desc: string }> = {
  flat: { label: 'Flat', friction: 0.85, decay: 1.25, control: 1.2, desc: 'Fast, aggressive, burns spin' },
  sharp: { label: 'Sharp', friction: 0.12, decay: 0.7, control: 0.75, desc: 'Holds the center, long spin' },
  ball: { label: 'Ball', friction: 0.4, decay: 0.9, control: 0.95, desc: 'Balanced, smooth movement' },
  rubber: { label: 'Rubber', friction: 1.0, decay: 1.45, control: 1.3, desc: 'Max grip, wild attack patterns' },
  needle: { label: 'Needle', friction: 0.06, decay: 0.6, control: 0.6, desc: 'Ultimate stamina, low control' },
  wheel: { label: 'Wheel', friction: 0.55, decay: 1.0, control: 1.1, desc: 'Rolls fast, rides walls' },
};

export const PATTERNS: Pattern[] = ['none', 'stripes', 'flames', 'stars', 'circuit', 'camo', 'carbon', 'scales', 'radial', 'lightning'];
export const EMBLEMS = ['', 'star', 'bolt', 'skull', 'crown', 'sparkle', 'yinyang', 'target', 'fang', 'diamond', 'hex', 'spade', 'heart', 'club', 'swords', 'sun', 'moon', 'flame', 'wing', 'eye', 'claw', 'infinity', 'X', 'Ω', 'Δ'];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** What the SHAPE suggests (0..1 each) — used to auto-spread the tuning budget. */
export function rawProfile(d: BladeDesign): Tune {
  const tip = TIPS[d.tip];
  const wingMass = d.wings * (0.2 + d.wingLength * 0.6) * (0.25 + d.wingWidth * 0.75);
  const mass = 0.75 + d.discWeight * 0.55 + d.discSize * 0.2 + d.ringThickness * 0.2 + wingMass * 0.08;
  // fewer, longer, sharper, curved wings = more attack
  const attack = 0.15 + d.wingLength * 0.35 + d.wingSharp * 0.25 + Math.abs(d.wingCurve) * 0.12 + (d.wings <= 3 ? 0.12 : d.wings >= 6 ? -0.08 : 0) + tip.friction * 0.12;
  // many wide wings, thick ring, heavy disc = defense
  const defense = 0.12 + d.wingWidth * 0.2 + d.ringThickness * 0.25 + d.discWeight * 0.25 + (d.wings >= 5 ? 0.1 : 0) - d.wingSharp * 0.08 + (d.tip === 'ball' ? 0.08 : 0);
  // outward weight and low drag = stamina
  const stamina = 0.25 + d.discSize * 0.25 + (1 / tip.decay) * 0.25 - d.wingLength * 0.12 - d.wingSharp * 0.05 - (d.wings > 5 ? 0.06 : 0) + d.discWeight * 0.06;
  const speed = 0.2 + tip.control * 0.4 - (mass - 1) * 0.35 + (1 - d.wingLength) * 0.1;
  const burst = 0.3 + d.ringThickness * 0.3 + (1 - d.wingLength) * 0.15 + d.discWeight * 0.15 + (d.discNotches < 3 ? 0.1 : 0);
  const weight = (mass - 0.75) / 1.1;
  const c = (v: number) => Math.max(0.05, Math.min(1, v));
  return { attack: c(attack), defense: c(defense), stamina: c(stamina), speed: c(speed), weight: c(weight), burst: c(burst) };
}

/** Spread exactly TUNE_BUDGET points in proportion to a profile (each 1..10). */
export function spreadPoints(profile: Tune): Tune {
  // exaggerate differences a little so shapes feel distinct
  const w = STAT_KEYS.map((k) => Math.pow(profile[k], 1.3));
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  // everyone gets the floor; the rest is spread by the shape
  const spare = TUNE_BUDGET - TUNE_MIN * STAT_KEYS.length;
  const pts = w.map((v) => Math.max(TUNE_MIN, Math.min(TUNE_MAX, TUNE_MIN + (v / sum) * spare)));
  const out = pts.map((v) => Math.floor(v));
  let left = TUNE_BUDGET - out.reduce((a, b) => a + b, 0);
  const order = pts.map((v, i) => [v - Math.floor(v), i] as const).sort((x, y) => y[0] - x[0]);
  for (let k = 0; left > 0 && k < 60; k++) { const i = order[k % 6][1]; if (out[i] < TUNE_MAX) { out[i]++; left--; } }
  for (let k = 0; left < 0 && k < 60; k++) { const i = order[5 - (k % 6)][1]; if (out[i] > TUNE_MIN) { out[i]--; left++; } }
  return Object.fromEntries(STAT_KEYS.map((k, i) => [k, out[i]])) as Tune;
}

export function autoTune(d: BladeDesign): Tune { return spreadPoints(rawProfile(d)); }

/** The allocation actually used: the manual tune if valid (never over budget), else auto from the shape. */
export function effectiveTune(d: BladeDesign): Tune {
  const t = d.tune;
  if (!t) return autoTune(d);
  const out = Object.fromEntries(STAT_KEYS.map((k) => [k, Math.max(TUNE_MIN, Math.min(TUNE_MAX, Math.round(t[k] ?? 5)))])) as Tune;
  let over = STAT_KEYS.reduce((a, k) => a + out[k], 0) - TUNE_BUDGET;
  for (let k = 0; over > 0 && k < 200; k++) { const key = STAT_KEYS[k % 6]; if (out[key] > TUNE_MIN) { out[key]--; over--; } }
  return out;
}

export function pointsUsed(t: Tune) { return STAT_KEYS.reduce((a, k) => a + t[k], 0); }

export function computeStats(d: BladeDesign): BladeStats {
  const tip = TIPS[d.tip];
  const p = effectiveTune(d);
  const f = (k: StatKey) => p[k] / TUNE_MAX; // 0.1 .. 1
  const ringR = 0.55 + d.ringRadius * 0.15 + d.wingLength * 0.25;
  const radius = 0.55 + ringR * 0.22;
  return {
    points: p,
    attack: f('attack'), defense: f('defense'), stamina: f('stamina'), speed: f('speed'), weight: f('weight'),
    burstRes: 0.2 + p.burst * 0.07,
    mass: 0.9 + p.weight * 0.09, // 0.99 .. 1.8
    radius,
    height: 0.55 + d.tipHeight * 0.25,
    tipFriction: tip.friction,
    // stamina points set spin life; the tip still matters a bit
    spinDecay: 0.011 * (0.75 + tip.decay * 0.25) * (1.3 - p.stamina * 0.065),
    // speed points set acceleration (~0.85x..1.25x); weight trims it slightly; tip adds a little flavour
    control: (0.82 + p.speed * 0.04 + (tip.control - 0.95) * 0.15) * (1.05 - p.weight * 0.012),
  };
}

let idc = 0;
export function newBladeId() {
  return 'b' + Date.now().toString(36) + (idc++).toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

export function defaultDesign(): BladeDesign {
  return {
    id: newBladeId(), name: 'New Blade', spinDir: 1,
    wings: 3, wingLength: 0.5, wingWidth: 0.5, wingCurve: 0.3, wingSharp: 0.4, wingTilt: 0, ringRadius: 0.5, ringThickness: 0.5,
    discSize: 0.5, discWeight: 0.5, discNotches: 4,
    tip: 'ball', tipHeight: 0.5,
    primary: '#2a7fff', secondary: '#0d1530', accent: '#ffffff', glow: '#4cc9ff', metal: 0.6, rough: 0.3,
    pattern: 'stripes', emblem: 'star', emblemColor: '#ffffff', decals: [],
  };
}

const P = (o: Partial<BladeDesign>): BladeDesign => ({ ...defaultDesign(), ...o });

export const PRESETS: BladeDesign[] = [
  P({ id: 'preset-pyro', tune: { attack: 9, defense: 3, stamina: 3, speed: 6, weight: 5, burst: 4 }, name: 'Pyro Drake', wings: 3, wingLength: 0.85, wingWidth: 0.45, wingCurve: 0.7, wingSharp: 0.8, ringThickness: 0.4, discWeight: 0.6, tip: 'flat', primary: '#ff3b1f', secondary: '#2a0800', accent: '#ffc530', glow: '#ff6a00', pattern: 'flames', emblem: 'sun', metal: 0.5 }),
  P({ id: 'preset-frost', tune: { attack: 3, defense: 8, stamina: 5, speed: 4, weight: 6, burst: 4 }, name: 'Frost Fang', spinDir: -1, wings: 6, wingLength: 0.4, wingWidth: 0.75, wingCurve: -0.3, wingSharp: 0.5, ringThickness: 0.8, discWeight: 0.85, discSize: 0.6, tip: 'ball', primary: '#9fe8ff', secondary: '#0b2a44', accent: '#ffffff', glow: '#5fd6ff', pattern: 'scales', emblem: 'sparkle', metal: 0.85, rough: 0.15 }),
  P({ id: 'preset-volt', tune: { attack: 9, defense: 2, stamina: 3, speed: 8, weight: 4, burst: 4 }, name: 'Volt Viper', wings: 2, wingLength: 1.0, wingWidth: 0.35, wingCurve: 0.9, wingSharp: 1.0, ringThickness: 0.3, discWeight: 0.45, tip: 'rubber', primary: '#ffe600', secondary: '#151515', accent: '#00ffa2', glow: '#e8ff3a', pattern: 'lightning', emblem: 'bolt', metal: 0.3 }),
  P({ id: 'preset-terra', tune: { attack: 3, defense: 9, stamina: 5, speed: 3, weight: 7, burst: 3 }, name: 'Terra Golem', wings: 5, wingLength: 0.3, wingWidth: 0.95, wingCurve: 0.1, wingSharp: 0.1, ringThickness: 1, discWeight: 1, discSize: 0.8, discNotches: 0, tip: 'ball', primary: '#7a5a3a', secondary: '#2b2b2b', accent: '#9cff6b', glow: '#6bff8f', pattern: 'camo', emblem: 'hex', metal: 0.7, rough: 0.6 }),
  P({ id: 'preset-nebula', tune: { attack: 4, defense: 3, stamina: 9, speed: 5, weight: 5, burst: 4 }, name: 'Nebula Wraith', spinDir: -1, wings: 4, wingLength: 0.6, wingWidth: 0.5, wingCurve: -0.8, wingSharp: 0.6, ringThickness: 0.5, discSize: 1, discWeight: 0.7, tip: 'needle', primary: '#7b2cff', secondary: '#10002b', accent: '#ff5cf4', glow: '#c77dff', pattern: 'stars', emblem: 'moon', metal: 0.6 }),
  P({ id: 'preset-kraken', tune: { attack: 5, defense: 5, stamina: 5, speed: 5, weight: 5, burst: 5 }, name: 'Solar Kraken', wings: 8, wingLength: 0.55, wingWidth: 0.3, wingCurve: 0.5, wingSharp: 0.7, ringThickness: 0.6, discWeight: 0.6, tip: 'wheel', primary: '#ff8c00', secondary: '#003049', accent: '#00f5d4', glow: '#ffb703', pattern: 'radial', emblem: 'target', metal: 0.75 }),
  P({ id: 'preset-onyx', tune: { attack: 8, defense: 4, stamina: 5, speed: 4, weight: 5, burst: 4 }, name: 'Onyx Reaper', wings: 3, wingLength: 0.7, wingWidth: 0.55, wingCurve: -0.5, wingSharp: 0.9, ringThickness: 0.7, discWeight: 0.8, tip: 'sharp', primary: '#1a1a1a', secondary: '#000000', accent: '#ff0044', glow: '#ff0044', pattern: 'carbon', emblem: 'skull', metal: 0.9, rough: 0.2 }),
  P({ id: 'preset-circuit', tune: { attack: 8, defense: 3, stamina: 4, speed: 7, weight: 4, burst: 4 }, name: 'Cyber Mantis', spinDir: -1, wings: 4, wingLength: 0.75, wingWidth: 0.4, wingCurve: 0.6, wingSharp: 0.85, ringThickness: 0.45, discWeight: 0.55, tip: 'flat', primary: '#00ff9d', secondary: '#04140c', accent: '#00b3ff', glow: '#00ff9d', pattern: 'circuit', emblem: 'diamond', metal: 0.4 }),
];

const LS_KEY = 'bitblade.blades.v1';

export function loadCustomBlades(): BladeDesign[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as BladeDesign[];
    return arr.map((b) => ({ ...defaultDesign(), ...b }));
  } catch {
    return [];
  }
}

export function saveCustomBlades(list: BladeDesign[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function allBlades(): BladeDesign[] {
  return [...PRESETS, ...loadCustomBlades()];
}

export function findBlade(id: string): BladeDesign {
  return allBlades().find((b) => b.id === id) ?? PRESETS[0];
}

export function randomDesign(): BladeDesign {
  const r = Math.random;
  const tips = Object.keys(TIPS) as TipType[];
  const hue = Math.floor(r() * 360);
  const hsl = (h: number, s: number, l: number) => `hsl(${h % 360}, ${s}%, ${l}%)`;
  return {
    ...defaultDesign(),
    name: ['Neo', 'Hyper', 'Dark', 'Storm', 'Blaze', 'Iron', 'Astro', 'Venom'][Math.floor(r() * 8)] + ' ' + ['Fang', 'Wing', 'Drake', 'Fury', 'Comet', 'Golem', 'Shard', 'Talon'][Math.floor(r() * 8)],
    spinDir: r() < 0.7 ? 1 : -1,
    wings: 2 + Math.floor(r() * 6),
    wingLength: r(), wingWidth: r(), wingCurve: r() * 2 - 1, wingSharp: r(), wingTilt: r() * 2 - 1,
    ringRadius: r(), ringThickness: r(), discSize: r(), discWeight: r(), discNotches: Math.floor(r() * 8),
    tip: tips[Math.floor(r() * tips.length)], tipHeight: r(),
    primary: hslToHex(hue, 85, 55), secondary: hslToHex(hue + 180, 40, 12), accent: hslToHex(hue + 120, 90, 65), glow: hslToHex(hue + 30, 100, 60),
    metal: r(), rough: r() * 0.6,
    pattern: PATTERNS[Math.floor(r() * PATTERNS.length)],
    emblem: EMBLEMS[1 + Math.floor(r() * (EMBLEMS.length - 1))],
  };
  void hsl;
}

export function hslToHex(h: number, s: number, l: number) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + to(f(0)) + to(f(8)) + to(f(4));
}

// ---------------------------------------------------------------- randomizer
export type RandomPart = 'all' | 'tune' | 'shape' | 'core' | 'paint' | 'decals';
export type RandomStyle = 'any' | 'attack' | 'defense' | 'stamina' | 'balance';
export type RandomPalette = 'any' | 'neon' | 'fire' | 'ice' | 'toxic' | 'royal' | 'mono' | 'metal' | 'complement';

const PALETTES: Record<Exclude<RandomPalette, 'any' | 'complement'>, () => [string, string, string, string]> = {
  neon: () => { const h = Math.random() * 360; return [hslToHex(h, 100, 55), '#05060f', hslToHex(h + 150, 100, 65), hslToHex(h + 40, 100, 60)]; },
  fire: () => [hslToHex(Math.random() * 25, 95, 52), '#1a0500', '#ffd23a', hslToHex(25 + Math.random() * 15, 100, 55)],
  ice: () => [hslToHex(185 + Math.random() * 25, 80, 72), '#0a2238', '#ffffff', hslToHex(190, 100, 65)],
  toxic: () => [hslToHex(95 + Math.random() * 30, 90, 50), '#071408', hslToHex(280, 80, 60), hslToHex(110, 100, 60)],
  royal: () => [hslToHex(265 + Math.random() * 20, 75, 45), '#120624', '#ffcc33', hslToHex(285, 100, 70)],
  mono: () => { const h = Math.random() * 360; return [hslToHex(h, 15, 60), hslToHex(h, 10, 10), '#ffffff', hslToHex(h, 90, 60)]; },
  metal: () => ['#b8c0cc', '#1a1d24', hslToHex(Math.random() * 360, 90, 55), hslToHex(Math.random() * 360, 100, 60)],
};

const NAME_A = ['Neo', 'Hyper', 'Dark', 'Storm', 'Blaze', 'Iron', 'Astro', 'Venom', 'Cyber', 'Turbo', 'Phantom', 'Crimson', 'Arc', 'Omega', 'Solar', 'Void'];
const NAME_B = ['Fang', 'Wing', 'Drake', 'Fury', 'Comet', 'Golem', 'Shard', 'Talon', 'Viper', 'Reaper', 'Kraken', 'Mantis', 'Tempest', 'Nova', 'Wraith', 'Pegasus'];

/** Randomize parts of a design in place-style (returns a new object). Style biases the shape toward a battle type. */
export function randomizeDesign(base: BladeDesign, part: RandomPart = 'all', style: RandomStyle = 'any', palette: RandomPalette = 'any', keepName = true): BladeDesign {
  const r = Math.random;
  const lerp = (a: number, b: number) => a + (b - a) * r();
  const d: BladeDesign = JSON.parse(JSON.stringify(base));
  const tipsFor: Record<RandomStyle, TipType[]> = {
    any: Object.keys(TIPS) as TipType[], attack: ['flat', 'rubber', 'wheel'], defense: ['ball', 'wheel', 'sharp'], stamina: ['sharp', 'needle', 'ball'], balance: ['ball', 'wheel', 'flat'],
  };
  if (part === 'all' || part === 'shape') {
    switch (style) {
      case 'attack': Object.assign(d, { wings: 2 + Math.floor(r() * 3), wingLength: lerp(0.65, 1), wingWidth: lerp(0.25, 0.55), wingCurve: lerp(0.4, 1) * (r() < 0.5 ? -1 : 1), wingSharp: lerp(0.7, 1), wingTilt: lerp(0, 0.8), ringThickness: lerp(0.2, 0.5) }); break;
      case 'defense': Object.assign(d, { wings: 5 + Math.floor(r() * 4), wingLength: lerp(0.15, 0.45), wingWidth: lerp(0.7, 1), wingCurve: lerp(-0.3, 0.3), wingSharp: lerp(0, 0.3), wingTilt: lerp(-0.5, 0), ringThickness: lerp(0.75, 1) }); break;
      case 'stamina': Object.assign(d, { wings: 3 + Math.floor(r() * 4), wingLength: lerp(0.2, 0.5), wingWidth: lerp(0.4, 0.7), wingCurve: lerp(-0.6, 0.6), wingSharp: lerp(0.2, 0.5), wingTilt: lerp(-0.2, 0.2), ringThickness: lerp(0.4, 0.7) }); break;
      case 'balance': Object.assign(d, { wings: 3 + Math.floor(r() * 3), wingLength: lerp(0.4, 0.7), wingWidth: lerp(0.4, 0.7), wingCurve: lerp(-0.6, 0.6), wingSharp: lerp(0.4, 0.7), wingTilt: lerp(-0.3, 0.4), ringThickness: lerp(0.4, 0.7) }); break;
      default: Object.assign(d, { wings: 1 + Math.floor(r() * 8), wingLength: r(), wingWidth: r(), wingCurve: r() * 2 - 1, wingSharp: r(), wingTilt: r() * 2 - 1, ringThickness: r() });
    }
    d.ringRadius = r();
    if (r() < 0.3) d.spinDir = d.spinDir === 1 ? -1 : 1;
  }
  if (part === 'all' || part === 'shape' || part === 'core') delete d.tune;
  if (part === 'all' || part === 'core') {
    const tips = tipsFor[style];
    d.tip = tips[Math.floor(r() * tips.length)];
    d.tipHeight = r();
    d.discSize = style === 'stamina' ? lerp(0.7, 1) : r();
    d.discWeight = style === 'defense' ? lerp(0.75, 1) : style === 'attack' ? lerp(0.3, 0.7) : r();
    d.discNotches = Math.floor(r() * 9);
  }
  if (part === 'all' || part === 'paint') {
    const pal = palette === 'any' ? (['neon', 'fire', 'ice', 'toxic', 'royal', 'mono', 'metal', 'complement'] as const)[Math.floor(r() * 8)] : palette;
    if (pal === 'complement') {
      const h = r() * 360;
      [d.primary, d.secondary, d.accent, d.glow] = [hslToHex(h, 85, 55), hslToHex(h + 180, 40, 12), hslToHex(h + 180, 90, 65), hslToHex(h + 30, 100, 60)];
    } else [d.primary, d.secondary, d.accent, d.glow] = PALETTES[pal]();
    d.emblemColor = r() < 0.5 ? '#ffffff' : d.accent;
    d.metal = pal === 'metal' ? lerp(0.8, 1) : r();
    d.rough = lerp(0.05, 0.6);
    d.pattern = PATTERNS[Math.floor(r() * PATTERNS.length)];
    d.emblem = EMBLEMS[1 + Math.floor(r() * (EMBLEMS.length - 1))];
  }
  if (part === 'all' || part === 'decals') {
    const n = part === 'decals' ? 1 + Math.floor(r() * 5) : Math.floor(r() * 4);
    const sym = r() < 0.6 ? 1 + Math.floor(r() * 3) : 1; // radial symmetry copies
    const glyph = EMBLEMS[1 + Math.floor(r() * (EMBLEMS.length - 1))];
    d.decals = [];
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, rad = lerp(0.35, 0.8), size = lerp(0.1, 0.3);
      const g = r() < 0.5 ? glyph : EMBLEMS[1 + Math.floor(r() * (EMBLEMS.length - 1))];
      const color = [d.accent, d.glow, '#ffffff', d.secondary][Math.floor(r() * 4)];
      for (let k = 0; k < sym; k++) {
        const aa = a + (k / sym) * Math.PI * 2;
        d.decals.push({ glyph: g, x: Math.cos(aa) * rad, y: Math.sin(aa) * rad, size, rot: aa + Math.PI / 2, color });
      }
    }
  }
  if (part === 'tune') {
    // random spread of the budget, nudged toward the chosen battle style
    const bias: Record<RandomStyle, Partial<Tune>> = {
      any: {}, attack: { attack: 3, speed: 1.5 }, defense: { defense: 3, weight: 2, burst: 1.5 }, stamina: { stamina: 3, burst: 1 }, balance: { attack: 1, defense: 1, stamina: 1, speed: 1 },
    };
    const t = Object.fromEntries(STAT_KEYS.map((k) => [k, TUNE_MIN])) as Tune;
    let left = TUNE_BUDGET - TUNE_MIN * STAT_KEYS.length;
    while (left > 0) {
      const w = STAT_KEYS.map((k) => (t[k] >= TUNE_MAX ? 0 : 1 + (bias[style][k] ?? 0) + r() * 2));
      let x = r() * w.reduce((a, b) => a + b, 0);
      let pick = 0;
      while (x > w[pick]) { x -= w[pick]; pick++; }
      t[STAT_KEYS[Math.min(pick, 5)]]++;
      left--;
    }
    d.tune = t;
  }
  if (!keepName || part === 'all') d.name = `${NAME_A[Math.floor(r() * NAME_A.length)]} ${NAME_B[Math.floor(r() * NAME_B.length)]}`;
  return d;
}
