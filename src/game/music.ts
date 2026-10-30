// Songs: a tiny chip-tune step sequencer that plays every bit of game music (menus, matches, Music Studio).
// A song is plain JSON: tempo/key/mood, 8 lanes (lead, arp, bass, pad, kick, snare, hat, perc) with chip voice
// settings, up to 4 sixteen-step patterns, and an arrangement of parts (pattern + chord shift).
// Notes are scale degrees, so whatever you draw stays in key.

export type Wave = 'square' | 'pulse25' | 'pulse12' | 'triangle' | 'saw' | 'sine' | 'noise';
export type LaneKind = 'lead' | 'arp' | 'bass' | 'pad' | 'kick' | 'snare' | 'hat' | 'perc';
export type ScaleId = 'major' | 'minor' | 'dorian' | 'phrygian' | 'lydian' | 'harmonic' | 'penta' | 'minpenta' | 'blues';

export interface Lane {
  kind: LaneKind;
  wave: Wave;
  /** octaves above the song's root */
  oct: number;
  vol: number; // 0..1
  /** seconds the note rings out */
  decay: number;
  /** 0..1 brightness (low-pass filter) */
  cutoff: number;
  /** 0..1 echo send */
  echo: number;
  /** 0..1 vibrato depth */
  vib: number;
  /** melodic lanes: play the note as a chord (pads: all at once; others: a fast chip arpeggio) */
  chord: boolean;
  mute?: boolean;
}

/**
 * patterns[p][lane] is a 16-char string, one char per 16th step:
 *   '.' rest · '0'-'9','a'-'f' scale degree 0-15 (melodic lanes) · '-' hold the previous note · drums: 'x' hit, 'X' accent
 */
export interface Song {
  id: string;
  name: string;
  bpm: number;
  /** 0..0.5: delays every other 16th for a shuffle feel */
  swing: number;
  /** MIDI note of the key's root (e.g. 45 = A2) */
  root: number;
  scale: ScaleId;
  /** 0..1 lo-fi bit-crunch on the whole song */
  crunch: number;
  lanes: Lane[];
  patterns: string[][];
  /** the song plays these parts in order, then loops; t shifts the pattern by scale degrees (chord changes) */
  arrange: { p: number; t: number }[];
  custom?: boolean;
}

export const STEPS = 16;
export const LANE_KINDS: LaneKind[] = ['lead', 'arp', 'bass', 'pad', 'kick', 'snare', 'hat', 'perc'];
export const DRUMS = new Set<LaneKind>(['kick', 'snare', 'hat']);
export const WAVES: { id: Wave; label: string }[] = [
  { id: 'square', label: 'Square' }, { id: 'pulse25', label: 'Pulse 25%' }, { id: 'pulse12', label: 'Pulse 12%' },
  { id: 'triangle', label: 'Triangle' }, { id: 'saw', label: 'Saw' }, { id: 'sine', label: 'Sine' }, { id: 'noise', label: 'Noise' },
];
export const SCALES: Record<ScaleId, { mood: string; steps: number[] }> = {
  major: { mood: 'Heroic', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { mood: 'Dark', steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { mood: 'Groovy', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { mood: 'Mysterious', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { mood: 'Dreamy', steps: [0, 2, 4, 6, 7, 9, 11] },
  harmonic: { mood: 'Epic', steps: [0, 2, 3, 5, 7, 8, 11] },
  penta: { mood: 'Happy', steps: [0, 2, 4, 7, 9] },
  minpenta: { mood: 'Cool', steps: [0, 3, 5, 7, 10] },
  blues: { mood: 'Bluesy', steps: [0, 3, 5, 6, 7, 10] },
};
export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const LANE_LABEL: Record<LaneKind, string> = { lead: 'Lead', arp: 'Arp', bass: 'Bass', pad: 'Chords', kick: 'Kick', snare: 'Snare', hat: 'Hi-hat', perc: 'Blips' };

export function laneDefaults(kind: LaneKind): Lane {
  const L: Record<LaneKind, Omit<Lane, 'kind'>> = {
    lead: { wave: 'square', oct: 1, vol: 0.55, decay: 0.28, cutoff: 0.7, echo: 0.15, vib: 0.15, chord: false },
    arp: { wave: 'pulse12', oct: 2, vol: 0.3, decay: 0.14, cutoff: 0.75, echo: 0.25, vib: 0, chord: true },
    bass: { wave: 'triangle', oct: 0, vol: 0.7, decay: 0.22, cutoff: 0.5, echo: 0, vib: 0, chord: false },
    pad: { wave: 'sine', oct: 1, vol: 0.3, decay: 1.2, cutoff: 0.55, echo: 0.3, vib: 0.1, chord: true },
    kick: { wave: 'sine', oct: 0, vol: 0.8, decay: 0.2, cutoff: 1, echo: 0, vib: 0, chord: false },
    snare: { wave: 'noise', oct: 0, vol: 0.5, decay: 0.15, cutoff: 0.8, echo: 0.05, vib: 0, chord: false },
    hat: { wave: 'noise', oct: 0, vol: 0.3, decay: 0.05, cutoff: 1, echo: 0, vib: 0, chord: false },
    perc: { wave: 'pulse25', oct: 2, vol: 0.3, decay: 0.08, cutoff: 0.8, echo: 0.3, vib: 0, chord: false },
  };
  return { kind, ...L[kind] };
}

export const EMPTY = '.'.repeat(STEPS);
export function emptyPattern() { return LANE_KINDS.map(() => EMPTY); }

/** a fresh song with the default lanes */
export function newSong(name = 'New Song'): Song {
  return {
    id: 'song-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    name, bpm: 120, swing: 0, root: 45, scale: 'minor', crunch: 0,
    lanes: LANE_KINDS.map(laneDefaults),
    patterns: [emptyPattern()],
    arrange: [{ p: 0, t: 0 }],
    custom: true,
  };
}

export const DEG_CHARS = '0123456789abcdef';
export function degOf(ch: string) { const i = DEG_CHARS.indexOf(ch); return i; }

/** semitones above the root for a scale degree (wraps into higher octaves) */
export function semis(scale: ScaleId, deg: number) {
  const st = SCALES[scale].steps, n = st.length;
  const o = Math.floor(deg / n), r = ((deg % n) + n) % n;
  return o * 12 + st[r];
}

// ------------------------------------------------------------------ presets
const S = (name: string, id: string, o: Partial<Song>, lanes: Partial<Record<LaneKind, Partial<Lane>>>, patterns: Partial<Record<LaneKind, string>>[], arrange: [number, number][]): Song => ({
  id, name, bpm: 120, swing: 0, root: 45, scale: 'minor', crunch: 0, ...o,
  lanes: LANE_KINDS.map((k) => ({ ...laneDefaults(k), ...(lanes[k] ?? {}) })),
  patterns: patterns.map((p) => LANE_KINDS.map((k) => (p[k] ?? EMPTY).padEnd(STEPS, '.').slice(0, STEPS))),
  arrange: arrange.map(([p, t]) => ({ p, t })),
});

export const PRESET_SONGS: Song[] = [
  // Every preset is arranged like a real track (as Crunch Rush was first): up to 4 parts — usually an intro groove,
  // the theme, a lift / climb and a breakdown — played through chord changes over ~18-24 bars, so it develops
  // instead of looping one bar. Each section's lead is a variation of the song's own motif (its notes reordered,
  // sequenced or held), and blips only use notes from the melody, so the whole thing hangs together.
  // synthwave cruise: arp-and-bass intro → the hook → a higher answer over 16th hats → a half-time breakdown
  S('Neon Drive', 'neon-drive', { bpm: 118, root: 45, scale: 'minor' },
    { lead: { wave: 'saw', oct: 2, vol: 0.4, decay: 0.22, cutoff: 0.6, echo: 0.1, vib: 0 }, arp: { vol: 0.17, echo: 0.35 }, bass: { wave: 'square', oct: 0, vol: 0.45, decay: 0.3 }, pad: { vol: 0.2, decay: 1.6 }, perc: { vol: 0.14 } },
    [
      { arp: '0.2.4.2.0.2.4.2.', bass: '0.0.0.0.0.0.0.0.', pad: '0---------------', kick: 'x...x...x...x...', hat: '..x...x...x...x.' },
      { lead: '0.4.7.9.7.4.6.4.', bass: '0.0.0.0.0.0.0.0.', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.', perc: '..............7.' },
      { lead: '9.7.4.7.9.7.6.4.', arp: '0.2.4.7.4.2.0.2.', bass: '0..0..0.0..0..0.', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x..x', hat: 'x.x.x.x.x.x.x.x.', perc: '..............4.' },
      { lead: '7-------4-------', arp: '0...4...0...4...', bass: '0-------0-------', pad: '0---------------', kick: 'x.......x.......', snare: '........x...xxxx', perc: '9.7.4...........' },
    ],
    [
      [0, 0], [0, 5], [0, 2], [0, 6], // intro: i VI III VII
      [1, 0], [1, 5], [1, 2], [1, 6], // the hook
      [2, 3], [2, 4], [2, 0], [2, 5], // lift: iv v i VI
      [3, 0], [3, 5], [3, 3], [3, 4], // breakdown → roll
      [1, 0], [1, 5], [2, 2], [2, 6], // hook home
    ]),
  // bright sky racer: sparkling intro → verse → a soaring chorus up the octave → a lift with snare pickups
  S('Sky Ride', 'sky-ride', { bpm: 132, root: 48, scale: 'major' },
    { lead: { wave: 'pulse25', oct: 1 }, pad: { vol: 0.2 }, perc: { vol: 0.14 } },
    [
      { arp: '0.2.4.2.0.2.4.2.', bass: '0.0.0.0.0.0.0.0.', pad: '0---------------', kick: 'x...x...x...x...', hat: '..x...x...x...x.', perc: '..............7.' },
      { lead: '4-.4.5.7---5.4.2', arp: '0...0...0...0...', bass: '0.0.0.0.0.0.0.0.', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.' },
      { lead: '6-.6.7.9---7.6.4', arp: '0.4.0.4.0.4.0.4.', bass: '0.0.4.0.0.0.4.0.', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x.x.', hat: 'x.x.x.x.x.x.x.x.', perc: '..........7.....' },
      { lead: '2-.2.4.5---4.2.0', arp: '0...0...0...0...', bass: '0.0.0.0.0.0.0.0.', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x.xx', hat: '..x...x...x...x.' },
    ],
    [
      [0, 0], [0, 4], [0, 5], [0, 3], // intro: I V vi IV
      [1, 0], [1, 4], [3, 5], [3, 3], // verse
      [2, 0], [2, 4], [2, 5], [2, 3], // chorus
      [3, 3], [3, 4], [1, 5], [3, 4], // lift: IV V vi V
      [2, 0], [2, 4], [2, 5], [1, 3], // last chorus
    ]),
  // the clean boss theme (Crunch Rush is its crunchy cousin): tension intro → riff → climb → a frantic phase two
  S('Boss Rush', 'boss-rush', { bpm: 150, root: 50, scale: 'harmonic', crunch: 0.2 },
    { bass: { wave: 'saw', oct: -1, vol: 0.5, decay: 0.12, cutoff: 0.45 }, lead: { wave: 'square', vib: 0.25 }, arp: { vol: 0.18 }, pad: { vol: 0.22 }, perc: { vol: 0.15 } },
    [
      { arp: '0.4.7.4.0.4.7.4.', bass: '0000300004000300', pad: '0---------------', kick: 'x...x.x.x...x.x.', hat: 'x...x...x...x...' },
      { lead: '7---6-5-4---2-4-', bass: '0000300004000300', kick: 'x...x.x.x...x.x.', snare: '....X.......X..x', hat: 'x.x.x.x.x.x.x.x.' },
      { lead: '7-8-9---8-7-6-4-', bass: '0000300004000300', kick: 'x...x.x.x...x.x.', snare: '....X.......X..x', hat: 'x.x.x.x.x.x.x.x.', perc: '..............7.' },
      { lead: '7.8.9.9.8.7.6.4.', arp: '0.4.7.4.0.4.7.4.', bass: '0000000033334444', kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X.X.', hat: 'x.xxx.x.x.xxx.x.', perc: '..............7.' },
    ],
    [
      [0, 0], [0, 0], [0, 5], [0, 4], // the boss appears
      [1, 0], [1, 0], [2, 3], [2, 4], // riff → climb
      [3, 0], [3, 5], [3, 3], [3, 4], // phase two
      [1, 0], [1, 5], [2, 3], [2, 4], // riff again
      [3, 0], [3, 0], [2, 4], [2, 4], // finale
    ]),
  // a heavy, crunchy take on Boss Rush (found while testing random voices), arranged out: intro groove →
  // main riff → climb → half-time breakdown with a snare roll → final run (20 bars)
  S('Crunch Rush', 'crunch-rush', { bpm: 150, root: 50, scale: 'harmonic', crunch: 0.7 },
    {
      lead: { wave: 'pulse12', oct: 1, vol: 0.55, decay: 0.45, cutoff: 0.82, echo: 0.13, vib: 0.32, chord: true },
      arp: { wave: 'pulse12', oct: 2, vol: 0.24, decay: 0.12, cutoff: 0.8, echo: 0.3, vib: 0, chord: false },
      bass: { wave: 'pulse25', oct: -1, vol: 0.5, decay: 0.3, cutoff: 0.63, echo: 0 },
      pad: { wave: 'sine', oct: 0, vol: 0.3, decay: 1.52, cutoff: 0.61, echo: 0.42, vib: 0.17, chord: true },
      hat: { decay: 0.07, cutoff: 0.53, echo: 0.19 },
      perc: { wave: 'pulse25', oct: 2, vol: 0.24, decay: 0.07, echo: 0.35 },
    },
    [
      // A: intro groove (no lead) — arp hook over the driving bass
      { arp: '0.2.4.2.0.2.4.6.', bass: '0000300004000300', pad: '0---------------', kick: 'x...x.x.x...x.x.', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', perc: '..........9...b.' },
      // B: the main riff
      { lead: '7---6-5-4---2-4-', arp: '..........0.4...', bass: '0000300004000300', pad: '0-------4-------', kick: 'x...x.x.x...x.x.', snare: '....X.......X..x', hat: 'x.xxx.x.x.xxx.x.', perc: '.............9.b' },
      // C: the climb — four on the floor, 16th hats, snare pickups
      { lead: '7-8-9---8-7-6-4-', arp: '0.4.0.4.0.4.0.4.', bass: '0000300004000300', pad: '0---------------', kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X.XX', hat: 'xxxxxxxxxxxxxxxx' },
      // D: half-time breakdown, long notes, falling blips, builds to a snare roll
      { lead: '9-----7-----6---', arp: '0.2.4.6.4.2.0.2.', bass: '0-------3-------', pad: '0---------------', kick: 'x.........x.....', snare: '........X...xXXX', hat: '..x...x...x...x.', perc: 'b.9.7.....b.9.7.' },
    ],
    [
      [0, 0], [0, 0], [0, 5], [0, 4], // intro: i  i  VI V
      [1, 0], [1, 0], [1, 5], [1, 4], // riff
      [2, 3], [2, 4], [2, 0], [2, 5], // climb: iv V i VI
      [3, 0], [3, 5], [3, 3], [3, 4], // breakdown → roll
      [1, 0], [2, 4], [1, 5], [2, 4], // final run
    ]),
  // laid-back lobby: pad-and-bass intro → the two-line theme → a sparkly bridge with a walking bass
  S('Chill Lobby', 'chill-lobby', { bpm: 92, root: 50, scale: 'dorian', swing: 0.18 },
    { lead: { wave: 'triangle', echo: 0.5, vol: 0.5 }, arp: { wave: 'triangle', vol: 0.16, echo: 0.45, chord: false }, bass: { oct: -1 }, kick: { vol: 0.55 }, snare: { vol: 0.3 }, hat: { vol: 0.18 }, perc: { vol: 0.16, echo: 0.5 } },
    [
      { bass: '0.....0...4.....', pad: '0---------------', kick: 'x.........x.....', hat: '..x...x...x...x.', perc: '..........7.....' },
      { lead: '....4.5.7...5...', bass: '0.....0...4.....', pad: '0---------------', kick: 'x.........x.....', snare: '....x.......x...', hat: '..x...x...x...x.' },
      { lead: '....2.4.5...4...', bass: '0.....0...4.....', pad: '0---------------', kick: 'x.........x.....', snare: '....x.......x...', hat: '..x...x...x...x.', perc: '..............7.' },
      { lead: '....7.5.4...2...', arp: '0.2.4.2.0.2.4.2.', bass: '0...0...3...3...', pad: '0---------------', kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
    ],
    [
      [0, 0], [0, 3], [0, 0], [0, 3], // i IV vamp
      [1, 0], [1, 3], [2, 5], [2, 4], // theme
      [1, 0], [1, 3], [2, 5], [2, 4],
      [3, 0], [3, 3], [3, 1], [3, 4], // bridge
      [1, 0], [1, 3], [2, 5], [0, 4], // theme, fading into the vamp
    ]),
  // creeping dungeon: an ominous drone → the theme → its darker answer → a chase with a pounding kick
  S('Dungeon Crawl', 'dungeon-crawl', { bpm: 100, root: 52, scale: 'phrygian' },
    { bass: { wave: 'pulse25', oct: -1, vol: 0.5 }, lead: { vib: 0.4, echo: 0.3 }, arp: { mute: true }, pad: { wave: 'sine', oct: 0, vol: 0.18, decay: 2 }, perc: { vol: 0.18, echo: 0.45 } },
    [
      { bass: '0..0..1.0..0..1.', pad: '0---------------', kick: 'x.....x...x.....', perc: '..........4.....' },
      { lead: '4---3---1---0---', bass: '0..0..1.0..0..1.', perc: '..........4.....', kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x...x...x...x...' },
      { lead: '7---6---4---3-1-', bass: '0..0..1.0..0..1.', pad: '0---------------', perc: '..........4.....', kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x...x...x...x...' },
      { lead: '4.3.1.0.4.3.1.0.', bass: '0.0.1.0.0.0.1.0.', kick: 'x..x..x.x..x..x.', snare: '....x.......x.x.', hat: 'x.x.x.x.x.x.x.x.', perc: '4.......4.......' },
    ],
    [
      [0, 0], [0, 0], [0, 1], [0, 0], // the drone
      [1, 0], [1, 0], [2, 0], [2, 1], // theme
      [3, 0], [3, 1], [3, 0], [3, -1], // chase
      [1, 3], [2, 1], [1, 0], [2, 1], // theme, moved
      [0, 0], [0, 1], // back into the dark
    ]),
  // winners' fanfare: a rising call → the tune → its answer → a bouncing chorus with 16th hats
  S('Victory Lap', 'victory-lap', { bpm: 140, root: 43, scale: 'penta' },
    { lead: { wave: 'pulse25' }, pad: { mute: true }, perc: { vol: 0.14 } },
    [
      { lead: '0...2...4...7---', arp: '0.......0.......', bass: '0...0...0...0...', kick: 'x...x...x...x...', snare: '............xxxx', hat: 'x.x.x.x.x.x.x.x.' },
      { lead: '0.1.2.3.4---3.2.', arp: '0.......0.......', bass: '0...2...3...2...', kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
      { lead: '4.3.2.1.2---0...', arp: '0.......0.......', bass: '0...2...3...2...', kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
      { lead: '5.6.7.8.9---8.7.', arp: '0.2.4.2.0.2.4.2.', bass: '0.0.2.0.3.0.2.0.', kick: 'x...x...x...x...', snare: '....x.......x.x.', hat: 'x.x.x.x.x.x.x.x.', perc: '......9.......9.' },
    ],
    [
      [0, 0], [0, 2], // the call
      [1, 0], [2, 0], [1, 2], [2, 0], // the tune
      [3, 0], [3, 3], [3, 2], [3, 1], // chorus
      [1, 0], [2, 0], [1, 2], [2, 0],
      [3, 0], [3, 3], [3, 2], [0, 0], // chorus → one last call
    ]),
  // icy and floating: a shimmering arp intro → the theme → its answer → a blooming lift with soft drums
  S('Glacier Dream', 'glacier-dream', { bpm: 108, root: 53, scale: 'lydian' },
    { lead: { wave: 'sine', echo: 0.6, vib: 0.3, decay: 0.5 }, arp: { wave: 'triangle', chord: false, vol: 0.22 }, bass: { oct: -1 }, pad: { vol: 0.18, decay: 2 }, kick: { vol: 0.5 }, snare: { vol: 0.28 }, hat: { vol: 0.15 }, perc: { wave: 'triangle', vol: 0.18, echo: 0.6 } },
    [
      { arp: '0.4.7.4.0.4.7.4.', bass: '0-------4-------', pad: '0---------------', perc: '..............7.' },
      { lead: '0---4---6---7---', arp: '0.4.7.4.0.4.7.4.', bass: '0-------4-------', kick: 'x.......x.......', hat: '....x.......x...' },
      { lead: '8---7---6---4---', arp: '0.4.7.4.0.4.7.4.', bass: '0-------4-------', pad: '0---------------', kick: 'x.......x.......', hat: '....x.......x...' },
      { lead: '6---7---8---7---', arp: '0.4.7.4.0.4.7.4.', bass: '0---0---4---4---', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.', perc: '..............7.' },
    ],
    [
      [0, 0], [0, 1], [0, 0], [0, 1], // I II (the lydian shimmer)
      [1, 0], [1, 1], [2, 0], [2, 1], // theme
      [3, 0], [3, 1], [3, 3], [3, 4], // bloom
      [1, 0], [1, 1], [2, 3], [2, 4],
      [3, 0], [3, 1], [0, 0], [0, 1], // bloom, then melt away
    ]),
  // a proper 12-bar blues, twice: the riff with its turnaround, then stop-time hits and a shuffle solo
  S('Gravel Blues', 'gravel-blues', { bpm: 112, root: 45, scale: 'blues', swing: 0.3 },
    { bass: { wave: 'square', vol: 0.45 }, lead: { wave: 'saw', cutoff: 0.45, vol: 0.45 }, arp: { mute: true }, pad: { mute: true }, perc: { vol: 0.2 } },
    [
      { lead: '5-.4.3-.1-......', bass: '0.2.3.4.5.4.3.2.', kick: 'x.....x.x.....x.', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
      { lead: '0.1.2.3.4.5.6---', bass: '0.2.3.4.5.4.3.2.', kick: 'x.....x.x.....x.', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
      { lead: '......5-4-3-1-0-', bass: '0.......0.......', kick: 'x.......x.......', snare: 'X.......X.......' },
      { lead: '5-.5.4-.3-.1.0..', bass: '0.2.3.4.5.4.3.2.', kick: 'x.....x.x.....x.', snare: '....x.......x..x', hat: 'x.xxx.xxx.xxx.xx', perc: EMPTY },
    ],
    [
      [0, 0], [0, 0], [0, 0], [0, 0], [0, 2], [0, 2], [0, 0], [0, 0], [1, 4], [1, 2], [0, 0], [1, 4], // chorus 1
      [2, 0], [2, 0], [3, 0], [3, 0], [3, 2], [3, 2], [2, 0], [2, 0], [3, 4], [3, 2], [1, 0], [1, 4], // stop-time + solo
    ]),
];

// ------------------------------------------------------------------ storage + choosing what plays
const SONGS_KEY = 'bitblade.songs.v1';
const PREFS_KEY = 'bitblade.music.v1';

export function loadCustomSongs(): Song[] {
  try { const v = JSON.parse(localStorage.getItem(SONGS_KEY) || '[]'); return Array.isArray(v) ? v.map(sanitizeSong) : []; } catch { return []; }
}
export function saveCustomSongs(list: Song[]) {
  try { localStorage.setItem(SONGS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
export function allSongs(): Song[] { return [...PRESET_SONGS, ...loadCustomSongs()]; }
export function songById(id: string | undefined | null) { return id ? allSongs().find((s) => s.id === id) ?? null : null; }

/** repair anything missing / malformed (imports, older saves) */
export function sanitizeSong(s: Partial<Song>): Song {
  const base = newSong(s.name ?? 'Song');
  const lanes = LANE_KINDS.map((k, i) => ({ ...laneDefaults(k), ...(s.lanes?.[i] ?? {}), kind: k }));
  const patterns = (s.patterns?.length ? s.patterns : base.patterns).slice(0, 4).map((p) => LANE_KINDS.map((_, i) => String(p?.[i] ?? EMPTY).padEnd(STEPS, '.').slice(0, STEPS)));
  const arrange = (s.arrange?.length ? s.arrange : base.arrange).slice(0, 32).map((a) => ({ p: Math.max(0, Math.min(patterns.length - 1, a.p | 0)), t: Math.max(-7, Math.min(7, a.t | 0)) }));
  return {
    ...base, ...s, lanes, patterns, arrange,
    bpm: Math.max(50, Math.min(220, s.bpm ?? 120)), swing: Math.max(0, Math.min(0.5, s.swing ?? 0)),
    root: Math.max(36, Math.min(60, s.root ?? 45)), scale: s.scale && SCALES[s.scale] ? s.scale : 'minor', crunch: Math.max(0, Math.min(1, s.crunch ?? 0)),
    id: s.id ?? base.id, name: s.name ?? base.name, custom: !!s.custom, // (presets arriving over the network stay presets)
  };
}

/**
 * What plays where. menu: a song id, 'random' (cycles) or 'off'. game: 'track' (each track/course's own song,
 * else a fitting preset), a song id (always that), 'random' (cycles) or 'off'.
 */
export const musicPrefs = { menu: 'neon-drive', game: 'track', /** what menu music to go back to when Surprise is switched off */ menuPrev: 'neon-drive', /** 📻 radio: surprise songs keep coming (each ≥45s, switching at the end of a loop) */ radio: false };
try { Object.assign(musicPrefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* ignore */ }
export function saveMusicPrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(musicPrefs)); } catch { /* ignore */ } }

const GAME_DEFAULTS = ['neon-drive', 'sky-ride', 'boss-rush', 'crunch-rush', 'victory-lap', 'dungeon-crawl', 'glacier-dream', 'gravel-blues'];
/** a stable preset for an arena with no song of its own */
export function defaultSongFor(arenaId: string) {
  let h = 0;
  for (let i = 0; i < arenaId.length; i++) h = (h * 31 + arenaId.charCodeAt(i)) | 0;
  return songById(GAME_DEFAULTS[Math.abs(h) % GAME_DEFAULTS.length])!;
}

export function randomSong(except?: string) {
  const list = allSongs().filter((s) => s.id !== except);
  return list[Math.floor(Math.random() * list.length)] ?? PRESET_SONGS[0];
}

// ------------------------------------------------------------------ the synth
/**
 * The crusher runs per sample in an AudioWorklet: hold each sample for `hold` samples (sample-rate reduction)
 * and round it to `bits` bits. The signal is level-matched first (music runs quiet, so rounding the raw mix
 * left quiet notes to crackle and drop out) and gently saturated, then scaled back.
 */
const CRUSH_SRC = `
class BBCrush extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'hold', defaultValue: 1, minValue: 1, maxValue: 32 }, { name: 'bits', defaultValue: 12, minValue: 2, maxValue: 16 }]; }
  constructor() { super(); this.n = 0; this.h = [0, 0]; this.env = 0.05; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const hold = Math.max(1, Math.round(p.hold[0])), q = Math.pow(2, p.bits[0] - 1);
    const len = out[0].length, chans = out.length;
    for (let i = 0; i < len; i++) {
      // follow the loudness, so the bit grid is relative to the music rather than to full scale
      const a = Math.abs(inp[0][i]);
      this.env = a > this.env ? this.env + (a - this.env) * 0.01 : this.env + (a - this.env) * 0.0002;
      const g = 0.6 / Math.max(0.02, this.env);
      if (this.n <= 0) {
        for (let c = 0; c < chans; c++) {
          const x = (inp[c] || inp[0])[i] * g;
          this.h[c] = (Math.round(Math.tanh(x) * q) / q) / g;
        }
        this.n = hold;
      }
      this.n--;
      for (let c = 0; c < chans; c++) out[c][i] = this.h[c];
    }
    return true;
  }
}
registerProcessor('bb-crush', BBCrush);
`;
const crusherLoads = new WeakMap<AudioContext, Promise<boolean>>();
function loadCrusher(ctx: AudioContext) {
  let p = crusherLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CRUSH_SRC], { type: 'application/javascript' }))).then(() => true, () => false)
      : Promise.resolve(false);
    crusherLoads.set(ctx, p);
  }
  return p;
}

/** Plays a Song on the audio clock (look-ahead scheduling: a busy frame never makes the beat stumble). */
export class SongPlayer {
  song: Song | null = null;
  /** called whenever the arrangement wraps around (for random cycling) */
  onLoop: (() => void) | null = null;
  /** studio: loop just this pattern instead of the arrangement */
  solo: number | null = null;
  private next = 0;
  private stepIdx = 0;
  private log: { t: number; part: number; step: number; p: number }[] = [];
  private bus: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private crusher: AudioWorkletNode | null = null;
  private echoIn: GainNode;
  private crunchNow = -1;
  private waves = new Map<string, PeriodicWave>();

  constructor(private ctx: AudioContext, out: AudioNode, private noise: AudioBuffer) {
    this.bus = ctx.createGain();
    // crunch = a chip-style bit crusher (sample-rate + bit-depth reduction) blended with the clean mix
    this.dry = ctx.createGain(); this.wet = ctx.createGain(); this.wet.gain.value = 0;
    this.bus.connect(this.dry).connect(out);
    this.wet.connect(out);
    loadCrusher(ctx).then((ok) => {
      if (!ok) return;
      this.crusher = new AudioWorkletNode(ctx, 'bb-crush', { outputChannelCount: [2] });
      this.bus.connect(this.crusher).connect(this.wet);
      this.crunchNow = -1; // apply the current setting now that it exists
    });
    // shared echo: a dotted-eighth-ish delay with a darkening feedback loop
    this.echoIn = ctx.createGain();
    const d = ctx.createDelay(2), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
    d.delayTime.value = 0.33; fb.gain.value = 0.38; lp.type = 'lowpass'; lp.frequency.value = 2600;
    this.echoIn.connect(d); d.connect(lp).connect(fb).connect(d); lp.connect(this.bus);
    (this as unknown as { delay: DelayNode }).delay = d;
  }

  play(song: Song | null, restart = true) {
    if (song && this.song && song.id === this.song.id && !restart) { this.song = song; return; }
    this.song = song;
    this.stepIdx = 0;
    this.next = 0;
    this.log = [];
  }

  /** where the music is right now (for a playhead) */
  position(): { part: number; step: number; p: number } | null {
    const now = this.ctx.currentTime;
    let cur: (typeof this.log)[number] | null = null;
    for (const e of this.log) if (e.t <= now) cur = e;
    return cur;
  }

  /** queue every step due in the next ~0.4s */
  schedule() {
    const s = this.song;
    if (!s) { this.next = 0; return; }
    const c = this.ctx;
    const stepLen = 60 / s.bpm / 4;
    if (s.crunch !== this.crunchNow) this.setCrunch(s.crunch);
    (this as unknown as { delay: DelayNode }).delay.delayTime.value = Math.min(1.5, stepLen * 3);
    if (this.next < c.currentTime) this.next = c.currentTime + 0.05;
    while (this.next < c.currentTime + 0.4) {
      const parts = this.solo !== null ? [{ p: Math.min(this.solo, s.patterns.length - 1), t: 0 }] : s.arrange.length ? s.arrange : [{ p: 0, t: 0 }];
      const total = parts.length * STEPS;
      const i = this.stepIdx % total;
      const part = Math.floor(i / STEPS), step = i % STEPS;
      const swing = step % 2 === 1 ? s.swing * stepLen : 0;
      const t = this.next + swing;
      this.playStep(s, parts[part], step, t, stepLen);
      this.log.push({ t, part, step, p: parts[part].p });
      if (this.log.length > 64) this.log.splice(0, this.log.length - 64);
      this.next += stepLen;
      this.stepIdx++;
      if (this.stepIdx % total === 0 && this.onLoop) this.onLoop();
      if (this.song !== s) return; // onLoop switched songs
    }
  }

  private playStep(s: Song, part: { p: number; t: number }, step: number, t: number, stepLen: number) {
    const pat = s.patterns[part.p] ?? s.patterns[0];
    s.lanes.forEach((lane, li) => {
      if (lane.mute) return;
      const row = pat[li] ?? EMPTY;
      const ch = row[step];
      if (!ch || ch === '.' || ch === '-') return;
      if (DRUMS.has(lane.kind)) { this.drum(lane, t, ch === 'X' ? 1 : 0.7); return; }
      const deg = degOf(ch);
      if (deg < 0) return;
      // held notes: count the '-' after it
      let hold = 0;
      for (let k = step + 1; k < STEPS && row[k] === '-'; k++) hold++;
      const midi = s.root + 12 * lane.oct + semis(s.scale, deg + part.t);
      const gate = hold * stepLen;
      if (lane.chord) {
        const tri = [0, 2, 4].map((d) => s.root + 12 * lane.oct + semis(s.scale, deg + part.t + d));
        if (lane.kind === 'pad') tri.forEach((m) => this.voice(lane, m, t, gate, 0.55));
        else {
          // chip arpeggio: cycle the chord tones fast for the length of the note
          const len = Math.max(stepLen, gate + stepLen), tick = Math.min(0.06, stepLen / 3);
          for (let k = 0; k * tick < len - 0.001; k++) this.voice(lane, tri[k % 3], t + k * tick, 0, 1, tick * 1.1);
        }
      } else this.voice(lane, midi, t, gate, 1);
    });
  }

  /** sound one note / hit right now (editor feedback) */
  preview(s: Song, li: number, ch: string, t = 0) {
    const lane = s.lanes[li];
    if (!lane) return;
    const at = this.ctx.currentTime + 0.01;
    if (s.crunch !== this.crunchNow) this.setCrunch(s.crunch);
    if (DRUMS.has(lane.kind)) { this.drum(lane, at, ch === 'X' ? 1 : 0.7); return; }
    const deg = degOf(ch);
    if (deg < 0) return;
    const stepLen = 60 / s.bpm / 4;
    if (lane.chord && lane.kind === 'pad') [0, 2, 4].forEach((d) => this.voice(lane, s.root + 12 * lane.oct + semis(s.scale, deg + t + d), at, stepLen, 0.55));
    else this.voice(lane, s.root + 12 * lane.oct + semis(s.scale, deg + t), at, 0, 1);
  }

  private wave(w: Wave): PeriodicWave | null {
    if (w !== 'pulse25' && w !== 'pulse12') return null;
    let pw = this.waves.get(w);
    if (!pw) {
      const duty = w === 'pulse25' ? 0.25 : 0.125, N = 48;
      const re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) re[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
      pw = this.ctx.createPeriodicWave(re, im);
      this.waves.set(w, pw);
    }
    return pw;
  }

  private voice(lane: Lane, midi: number, t: number, gate: number, gain: number, decayOverride?: number) {
    const c = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = c.createGain(), lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 300 * Math.pow(2, lane.cutoff * 6);
    const vol = 0.13 * lane.vol * gain;
    const dec = decayOverride ?? lane.decay;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    if (gate > 0) g.gain.setValueAtTime(vol, t + gate);
    g.gain.exponentialRampToValueAtTime(0.0001, t + gate + Math.max(0.03, dec));
    const end = t + gate + Math.max(0.03, dec) + 0.05;
    let src: AudioScheduledSourceNode;
    if (lane.wave === 'noise') {
      const n = c.createBufferSource(); n.buffer = this.noise; n.playbackRate.value = Math.max(0.1, f / 880); src = n;
    } else {
      const o = c.createOscillator();
      const pw = this.wave(lane.wave);
      if (pw) o.setPeriodicWave(pw); else o.type = lane.wave as OscillatorType;
      o.frequency.value = f;
      if (lane.vib > 0) {
        const lfo = c.createOscillator(), lg = c.createGain();
        lfo.frequency.value = 5.5; lg.gain.value = f * 0.02 * lane.vib;
        lfo.connect(lg).connect(o.frequency); lfo.start(t + 0.08); lfo.stop(end);
      }
      src = o;
    }
    src.connect(lp).connect(g).connect(this.bus);
    if (lane.echo > 0) { const e = c.createGain(); e.gain.value = lane.echo * 0.6; g.connect(e).connect(this.echoIn); }
    src.start(t); src.stop(end);
  }

  private drum(lane: Lane, t: number, acc: number) {
    const c = this.ctx;
    const g = c.createGain();
    g.connect(this.bus);
    if (lane.echo > 0) { const e = c.createGain(); e.gain.value = lane.echo * 0.6; g.connect(e).connect(this.echoIn); }
    const v = lane.vol * acc;
    if (lane.kind === 'kick') {
      const o = c.createOscillator();
      o.type = lane.wave === 'noise' ? 'sine' : (this.wave(lane.wave) ? 'square' : (lane.wave as OscillatorType));
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(0.32 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.08, lane.decay));
      o.connect(g); o.start(t); o.stop(t + lane.decay + 0.1);
      return;
    }
    const n = c.createBufferSource(); n.buffer = this.noise;
    const f = c.createBiquadFilter();
    if (lane.kind === 'snare') {
      f.type = 'bandpass'; f.frequency.value = 1200 + lane.cutoff * 2400; f.Q.value = 0.8;
      g.gain.setValueAtTime(0.16 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, lane.decay));
      // a little tone body under the noise
      const o = c.createOscillator(), og = c.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
      og.gain.setValueAtTime(0.1 * v, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(og).connect(this.bus); o.start(t); o.stop(t + 0.1);
    } else {
      f.type = 'highpass'; f.frequency.value = 5000 + lane.cutoff * 4000;
      g.gain.setValueAtTime(0.09 * v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.02, lane.decay));
    }
    n.connect(f).connect(g); n.start(t); n.stop(t + lane.decay + 0.1);
  }

  private setCrunch(k: number) {
    this.crunchNow = k;
    const c = this.crusher, t = this.ctx.currentTime;
    if (!c || k <= 0.001) { this.dry.gain.setTargetAtTime(1, t, 0.02); this.wet.gain.setTargetAtTime(0, t, 0.02); return; }
    // more crunch: fewer samples per second (grainy, aliased console sound) and fewer bits, more of it in the mix
    c.parameters.get('hold')!.setValueAtTime(1 + Math.round(k * 14 * (0.4 + 0.6 * k)), t); // 30% → ~16kHz, 100% → ~3kHz
    c.parameters.get('bits')!.setValueAtTime(10 - k * 6, t);
    const wet = Math.min(1, 0.35 + k * 0.9);
    this.wet.gain.setTargetAtTime(wet, t, 0.02);
    this.dry.gain.setTargetAtTime(1 - wet * 0.85, t, 0.02);
  }
}

// ------------------------------------------------------------------ generators (🎲)
/** a random voice for a lane, kept within ranges that suit its job (bass stays low, hats stay short...) */
export function genVoice(l: Lane): Partial<Lane> {
  const r = Math.random, pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const rng = (a: number, b: number) => +(a + r() * (b - a)).toFixed(2);
  switch (l.kind) {
    case 'lead': return { wave: pick(['square', 'pulse25', 'pulse12', 'saw', 'triangle', 'sine']), oct: pick([1, 1, 2]), decay: rng(0.15, 0.6), cutoff: rng(0.45, 0.95), echo: rng(0, 0.5), vib: rng(0, 0.45), chord: r() < 0.15 };
    case 'arp': return { wave: pick(['pulse12', 'pulse25', 'square', 'triangle']), oct: pick([1, 2, 2]), decay: rng(0.08, 0.25), cutoff: rng(0.5, 1), echo: rng(0.1, 0.5), vib: 0, chord: r() < 0.75 };
    case 'bass': return { wave: pick(['triangle', 'square', 'pulse25', 'saw']), oct: pick([-1, 0, 0]), decay: rng(0.12, 0.45), cutoff: rng(0.3, 0.65), echo: 0, vib: 0, chord: false };
    case 'pad': return { wave: pick(['sine', 'triangle', 'square', 'saw']), oct: pick([0, 1, 1]), decay: rng(0.6, 1.8), cutoff: rng(0.35, 0.7), echo: rng(0.15, 0.55), vib: rng(0, 0.3), chord: true };
    case 'perc': return { wave: pick(['pulse25', 'pulse12', 'square', 'triangle', 'noise']), oct: pick([1, 2, 3]), decay: rng(0.04, 0.15), cutoff: rng(0.5, 1), echo: rng(0, 0.5), vib: 0, chord: false };
    case 'kick': return { wave: pick(['sine', 'sine', 'triangle', 'square']), decay: rng(0.12, 0.35), cutoff: 1, echo: 0 };
    case 'snare': return { decay: rng(0.08, 0.3), cutoff: rng(0.4, 1), echo: rng(0, 0.25) };
    case 'hat': return { decay: rng(0.02, 0.1), cutoff: rng(0.5, 1), echo: rng(0, 0.2) };
  }
  return {};
}

/** a musical starting idea for one lane (in key, sensible rhythm for its job) */
export function genLane(kind: Lane['kind'], s: { scale: ScaleId }): string {
  const r = Math.random, n = SCALES[s.scale].steps.length;
  const out = Array(STEPS).fill('.');
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  switch (kind) {
    case 'kick': return pick(['x...x...x...x...', 'x.....x.x.......', 'x...x.x.x...x.x.', 'x.......x.x.....', 'x..x..x...x.....']);
    case 'snare': return pick(['....x.......x...', '....x.......x..x', '....X.......X...', '........x.......', '....x..x....x...']);
    case 'hat': return pick(['..x...x...x...x.', 'x.x.x.x.x.x.x.x.', 'xxxxxxxxxxxxxxxx', 'x.xxx.xxx.xxx.xx', '....x.......x...']);
    case 'bass': {
      const rhythm = pick(['0...0...0...0...', '0.0.0.0.0.0.0.0.', '0..0..0.0..0..0.', '0.....0...0.....']);
      const alt = [0, 0, 0, Math.min(4, n - 1), 2];
      return rhythm.split('').map((c, i) => (c === '.' ? '.' : DEG_CHARS[i > 8 && r() < 0.4 ? pick(alt) : 0])).join('');
    }
    case 'pad': return pick(['0---------------', '0-------4-------', '0-------2-------']);
    case 'arp': return pick(['0...0...0...0...', '0.......0.......', '0.2.4.2.0.2.4.2.', '0.4.7.4.0.4.7.4.']).replace(/7/g, DEG_CHARS[Math.min(n, 7)]);
    case 'perc': { for (let i = 0; i < STEPS; i++) if (r() < 0.12) out[i] = DEG_CHARS[Math.floor(r() * (n + 2))]; return out.join(''); }
    case 'lead': {
      // a phrase: notes on 8ths with a gentle random walk, some held, ends near home
      let d = Math.floor(r() * n);
      for (let i = 0; i < STEPS; i += 2) {
        if (r() < 0.28) continue;
        d = Math.max(0, Math.min(n + 3, d + pick([-2, -1, -1, 0, 1, 1, 2])));
        out[i] = DEG_CHARS[d];
        if (r() < 0.3 && i + 1 < STEPS) out[i + 1] = '-';
      }
      out[STEPS - 2] = r() < 0.5 ? DEG_CHARS[0] : out[STEPS - 2];
      return out.join('');
    }
  }
  return EMPTY;
}

/** which shape the next surprise takes: they alternate, a sectioned song then a short loop */
let surpriseLong = Math.random() < 0.5;

/**
 * 🎲 Surprise me: a whole song from a few dice rolls inside rules that keep it musical — a random mood/key/
 * tempo (+ maybe swing / crunch / chip waves), every lane written for its job (genLane), arranged over proven
 * chord progressions. Notes are scale degrees, so nothing can land out of key. Two shapes, taking turns:
 *  · a loop: two patterns (A answers B) over one progression (8 bars)
 *  · a sectioned song like Crunch Rush: intro groove (no lead) → the theme → a lift (a higher phrase, four on the
 *    floor, 16th hats, pickups) over another progression → a half-time breakdown into a snare roll → the theme
 *    home (20 bars)
 */
export function surpriseSong(shape?: 'loop' | 'long'): Song {
  const long = shape ? shape === 'long' : (surpriseLong = !surpriseLong);
  const s = newSong('Surprise ' + Math.floor(Math.random() * 900 + 100));
  const scales = Object.keys(SCALES) as ScaleId[];
  s.scale = scales[Math.floor(Math.random() * scales.length)];
  s.bpm = 90 + Math.floor(Math.random() * 14) * 5;
  s.root = 40 + Math.floor(Math.random() * 12);
  s.swing = Math.random() < 0.3 ? 0.15 + Math.random() * 0.15 : 0;
  s.crunch = Math.random() < 0.3 ? Math.random() * 0.4 : 0;
  const chip: Lane['wave'][] = ['square', 'pulse25', 'pulse12', 'triangle', 'saw'];
  s.lanes.forEach((l) => { if (!DRUMS.has(l.kind) && l.kind !== 'pad') l.wave = chip[Math.floor(Math.random() * chip.length)]; });
  s.lanes[3].mute = Math.random() < 0.4;
  s.lanes[7].mute = Math.random() < 0.5;
  const progs = [[0, 4, 5, 3], [0, 3, 4, 4], [0, 5, 3, 4], [0, 0, 3, 4], [0, 3, 0, 4], [0, 5, 2, 6], [3, 4, 0, 5]];
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const pr = pick(progs);
  s.lanes[7].vol = 0.17; // (blips sit under the tune)
  const L = (k: LaneKind) => LANE_KINDS.indexOf(k);
  const set = (pat: string[], o: Partial<Record<LaneKind, string>>) => { const q = [...pat]; for (const k in o) q[L(k as LaneKind)] = o[k as LaneKind]!; return q; };
  const n = SCALES[s.scale].steps.length;
  const shift = (str: string, d: number) => str.split('').map((c) => (degOf(c) >= 0 ? DEG_CHARS[Math.max(0, Math.min(15, degOf(c) + d))] : c)).join('');
  // an answer to a phrase: the same first half, then that half again a step or two away, coming home on the root
  const answer = (str: string) => {
    const h = str.slice(0, STEPS / 2), out = (h + shift(h, pick([-2, -1, 1, 2]))).split('');
    const last = out.map((c, i) => (degOf(c) >= 0 ? i : -1)).filter((i) => i >= 0).pop();
    if (last !== undefined) out[last] = DEG_CHARS[0];
    return out.join('');
  };
  // blips: a couple of the theme's own notes, up an octave, on off-beats
  const notes = (str: string) => str.split('').filter((c) => degOf(c) >= 0);
  const blips = (str: string, at: number[]) => {
    const ns = notes(str), out = Array(STEPS).fill('.');
    if (ns.length) for (const i of at) out[i] = DEG_CHARS[Math.min(15, degOf(pick(ns)) + n)];
    return out.join('');
  };
  const theme = LANE_KINDS.map((k) => genLane(k, s));
  theme[L('perc')] = blips(theme[L('lead')], pick([[14], [10, 14], [6, 14]]));
  if (!long) {
    // a loop: B answers A (same groove, the lead's answer phrase, maybe a new arp)
    s.patterns = [theme, set(theme, { lead: answer(theme[L('lead')]), arp: Math.random() < 0.5 ? genLane('arp', s) : theme[L('arp')] })];
    s.arrange = [...pr.map((t) => ({ p: 0, t })), ...pr.map((t) => ({ p: 1, t }))];
    return s;
  }
  s.lanes[3].mute = false; s.lanes[7].mute = false; // (the sections lean on pads and blips)
  if (theme[L('arp')] === EMPTY || /^0\.{7}0\.{7}$/.test(theme[L('arp')])) theme[L('arp')] = '0.2.4.2.0.2.4.2.';
  // the breakdown's lead: the theme's first notes of each third, held long
  const held = (str: string) => {
    const out = Array(STEPS).fill('-');
    for (const [a, b] of [[0, 6], [6, 12], [12, 16]]) out[a] = str.slice(a, b).split('').find((c) => degOf(c) >= 0) ?? DEG_CHARS[0];
    return out.join('');
  };
  const intro = set(theme, { lead: EMPTY, snare: EMPTY, kick: pick(['x...x...x...x...', 'x.......x.......']), perc: blips(theme[L('lead')], [14]) });
  // the lift: the theme's answer, a few steps higher, with more drive underneath
  const lift = set(theme, {
    lead: shift(answer(theme[L('lead')]), Math.min(3, Math.floor(n / 2))), kick: 'x...x...x...x...', hat: pick(['x.x.x.x.x.x.x.x.', 'x.xxx.x.x.xxx.x.']),
    snare: pick(['....x.......x.xx', '....x.......x..x']), perc: blips(theme[L('lead')], [6, 14]),
  });
  const breakdown = set(theme, {
    lead: held(theme[L('lead')]), bass: '0-------' + pick(['0', '2', '3']) + '-------', kick: 'x.........x.....',
    snare: '........x...xXXX', hat: '..x...x...x...x.', perc: blips(theme[L('lead')], [0, 2, 4]),
  });
  s.patterns = [intro, theme, lift, breakdown];
  const pr2 = pick(progs.filter((q) => q !== pr));
  s.arrange = [
    ...pr.map((t) => ({ p: 0, t })), ...pr.map((t) => ({ p: 1, t })), ...pr2.map((t) => ({ p: 2, t })), ...pr.map((t) => ({ p: 3, t })),
    { p: 1, t: pr[0] }, { p: 1, t: pr[1] }, { p: 2, t: pr2[2] }, { p: 2, t: pr2[3] },
  ];
  return s;
}
