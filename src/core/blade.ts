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
}

export interface BladeStats {
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

export function computeStats(d: BladeDesign): BladeStats {
  const tip = TIPS[d.tip];
  const wingMass = d.wings * (0.2 + d.wingLength * 0.6) * (0.25 + d.wingWidth * 0.75);
  const mass = 0.75 + d.discWeight * 0.55 + d.discSize * 0.2 + d.ringThickness * 0.2 + wingMass * 0.08;
  // fewer, longer, sharper, curved wings = more attack
  let attack = 0.15 + d.wingLength * 0.35 + d.wingSharp * 0.25 + Math.abs(d.wingCurve) * 0.12 + (d.wings <= 3 ? 0.12 : d.wings >= 6 ? -0.08 : 0) + tip.friction * 0.12;
  // many wide wings, thick ring, heavy disc = defense
  let defense = 0.12 + d.wingWidth * 0.2 + d.ringThickness * 0.25 + d.discWeight * 0.25 + (d.wings >= 5 ? 0.1 : 0) - d.wingSharp * 0.08 + (d.tip === 'ball' ? 0.08 : 0);
  // outward weight and low drag = stamina
  let stamina = 0.25 + d.discSize * 0.25 + (1 / tip.decay) * 0.25 - d.wingLength * 0.12 - d.wingSharp * 0.05 - (d.wings > 5 ? 0.06 : 0) + d.discWeight * 0.06;
  let speed = 0.2 + tip.control * 0.4 - (mass - 1) * 0.35 + (1 - d.wingLength) * 0.1;
  const burstRes = clamp01(0.3 + d.ringThickness * 0.3 + (1 - d.wingLength) * 0.15 + d.discWeight * 0.15 + (d.discNotches < 3 ? 0.1 : 0));
  attack = clamp01(attack); defense = clamp01(defense); stamina = clamp01(stamina); speed = clamp01(speed);
  const ringR = 0.55 + d.ringRadius * 0.15 + d.wingLength * 0.25;
  const radius = 0.55 + ringR * 0.22;
  return {
    attack, defense, stamina, speed,
    weight: clamp01((mass - 0.75) / 1.1),
    burstRes,
    mass,
    radius,
    height: 0.55 + d.tipHeight * 0.25,
    tipFriction: tip.friction,
    spinDecay: 0.011 * tip.decay * (1.25 - stamina * 0.6),
    control: tip.control * (0.85 + speed * 0.3),
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
  P({ id: 'preset-pyro', name: 'Pyro Drake', wings: 3, wingLength: 0.85, wingWidth: 0.45, wingCurve: 0.7, wingSharp: 0.8, ringThickness: 0.4, discWeight: 0.6, tip: 'flat', primary: '#ff3b1f', secondary: '#2a0800', accent: '#ffc530', glow: '#ff6a00', pattern: 'flames', emblem: 'sun', metal: 0.5 }),
  P({ id: 'preset-frost', name: 'Frost Fang', spinDir: -1, wings: 6, wingLength: 0.4, wingWidth: 0.75, wingCurve: -0.3, wingSharp: 0.5, ringThickness: 0.8, discWeight: 0.85, discSize: 0.6, tip: 'ball', primary: '#9fe8ff', secondary: '#0b2a44', accent: '#ffffff', glow: '#5fd6ff', pattern: 'scales', emblem: 'sparkle', metal: 0.85, rough: 0.15 }),
  P({ id: 'preset-volt', name: 'Volt Viper', wings: 2, wingLength: 1.0, wingWidth: 0.35, wingCurve: 0.9, wingSharp: 1.0, ringThickness: 0.3, discWeight: 0.45, tip: 'rubber', primary: '#ffe600', secondary: '#151515', accent: '#00ffa2', glow: '#e8ff3a', pattern: 'lightning', emblem: 'bolt', metal: 0.3 }),
  P({ id: 'preset-terra', name: 'Terra Golem', wings: 5, wingLength: 0.3, wingWidth: 0.95, wingCurve: 0.1, wingSharp: 0.1, ringThickness: 1, discWeight: 1, discSize: 0.8, discNotches: 0, tip: 'ball', primary: '#7a5a3a', secondary: '#2b2b2b', accent: '#9cff6b', glow: '#6bff8f', pattern: 'camo', emblem: 'hex', metal: 0.7, rough: 0.6 }),
  P({ id: 'preset-nebula', name: 'Nebula Wraith', spinDir: -1, wings: 4, wingLength: 0.6, wingWidth: 0.5, wingCurve: -0.8, wingSharp: 0.6, ringThickness: 0.5, discSize: 1, discWeight: 0.7, tip: 'needle', primary: '#7b2cff', secondary: '#10002b', accent: '#ff5cf4', glow: '#c77dff', pattern: 'stars', emblem: 'moon', metal: 0.6 }),
  P({ id: 'preset-kraken', name: 'Solar Kraken', wings: 8, wingLength: 0.55, wingWidth: 0.3, wingCurve: 0.5, wingSharp: 0.7, ringThickness: 0.6, discWeight: 0.6, tip: 'wheel', primary: '#ff8c00', secondary: '#003049', accent: '#00f5d4', glow: '#ffb703', pattern: 'radial', emblem: 'target', metal: 0.75 }),
  P({ id: 'preset-onyx', name: 'Onyx Reaper', wings: 3, wingLength: 0.7, wingWidth: 0.55, wingCurve: -0.5, wingSharp: 0.9, ringThickness: 0.7, discWeight: 0.8, tip: 'sharp', primary: '#1a1a1a', secondary: '#000000', accent: '#ff0044', glow: '#ff0044', pattern: 'carbon', emblem: 'skull', metal: 0.9, rough: 0.2 }),
  P({ id: 'preset-circuit', name: 'Cyber Mantis', spinDir: -1, wings: 4, wingLength: 0.75, wingWidth: 0.4, wingCurve: 0.6, wingSharp: 0.85, ringThickness: 0.45, discWeight: 0.55, tip: 'flat', primary: '#00ff9d', secondary: '#04140c', accent: '#00b3ff', glow: '#00ff9d', pattern: 'circuit', emblem: 'diamond', metal: 0.4 }),
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
