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
  S('Neon Drive', 'neon-drive', { bpm: 118, root: 45, scale: 'minor' },
    { lead: { wave: 'saw', oct: 2, vol: 0.4, decay: 0.22, cutoff: 0.6, echo: 0.1, vib: 0 }, bass: { wave: 'square', oct: 0, vol: 0.45, decay: 0.3 }, pad: { mute: true } },
    [{ lead: '0.4.7.9.7.4.6.4.', bass: '0...0...0...0...', kick: 'x.......x.......', hat: '....x.......x...' }],
    [[0, 0], [0, 0], [0, 5], [0, 6]]),
  S('Sky Ride', 'sky-ride', { bpm: 132, root: 48, scale: 'major' },
    { lead: { wave: 'pulse25', oct: 1 }, pad: { vol: 0.2 } },
    [
      { lead: '4-.4.5.7---5.4.2', arp: '0...0...0...0...', bass: '0.0.0.0.0.0.0.0.', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.' },
      { lead: '2-.2.4.5---4.2.0', arp: '0...0...0...0...', bass: '0.0.0.0.0.0.0.0.', pad: '0---------------', kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.' },
    ],
    [[0, 0], [0, 4], [1, 5], [1, 3]]),
  S('Boss Rush', 'boss-rush', { bpm: 150, root: 50, scale: 'harmonic', crunch: 0.2 },
    { bass: { wave: 'saw', oct: -1, vol: 0.5, decay: 0.12, cutoff: 0.45 }, lead: { wave: 'square', vib: 0.25 }, arp: { mute: true } },
    [
      { lead: '7---6-5-4---2-4-', bass: '0000300004000300', kick: 'x...x.x.x...x.x.', snare: '....X.......X..x', hat: 'x.x.x.x.x.x.x.x.' },
      { lead: '7-8-9---8-7-6-4-', bass: '0000300004000300', kick: 'x...x.x.x...x.x.', snare: '....X.......X..x', hat: 'x.x.x.x.x.x.x.x.' },
    ],
    [[0, 0], [0, 0], [1, 3], [1, 4]]),
  S('Chill Lobby', 'chill-lobby', { bpm: 92, root: 50, scale: 'dorian', swing: 0.18 },
    { lead: { wave: 'triangle', echo: 0.5, vol: 0.5 }, bass: { oct: -1 }, kick: { vol: 0.55 }, snare: { vol: 0.3 }, hat: { vol: 0.18 }, arp: { mute: true } },
    [
      { lead: '....4.5.7...5...', bass: '0.....0...4.....', pad: '0---------------', kick: 'x.........x.....', snare: '....x.......x...', hat: '..x...x...x...x.' },
      { lead: '....2.4.5...4...', bass: '0.....0...4.....', pad: '0---------------', kick: 'x.........x.....', snare: '....x.......x...', hat: '..x...x...x...x.' },
    ],
    [[0, 0], [0, 3], [1, 5], [1, 4]]),
  S('Dungeon Crawl', 'dungeon-crawl', { bpm: 100, root: 52, scale: 'phrygian' },
    { bass: { wave: 'pulse25', oct: -1, vol: 0.5 }, lead: { vib: 0.4, echo: 0.3 }, arp: { mute: true }, pad: { mute: true } },
    [
      { lead: '4---3---1---0---', bass: '0..0..1.0..0..1.', perc: '..........4.....', kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x...x...x...x...' },
      { lead: '7---6---4---3-1-', bass: '0..0..1.0..0..1.', perc: '..........4.....', kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x...x...x...x...' },
    ],
    [[0, 0], [0, 0], [1, 0], [1, 1]]),
  S('Victory Lap', 'victory-lap', { bpm: 140, root: 43, scale: 'penta' },
    { lead: { wave: 'pulse25' }, pad: { mute: true } },
    [
      { lead: '0.1.2.3.4---3.2.', arp: '0.......0.......', bass: '0...2...3...2...', kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
      { lead: '4.3.2.1.2---0...', arp: '0.......0.......', bass: '0...2...3...2...', kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
    ],
    [[0, 0], [1, 0], [0, 2], [1, 0]]),
  S('Glacier Dream', 'glacier-dream', { bpm: 108, root: 53, scale: 'lydian' },
    { lead: { wave: 'sine', echo: 0.6, vib: 0.3, decay: 0.5 }, arp: { wave: 'triangle', chord: false, vol: 0.22 }, bass: { oct: -1 }, pad: { mute: true }, kick: { vol: 0.5 }, hat: { vol: 0.15 } },
    [
      { lead: '0---4---6---7---', arp: '0.4.7.4.0.4.7.4.', bass: '0-------4-------', kick: 'x.......x.......', hat: '....x.......x...' },
      { lead: '8---7---6---4---', arp: '0.4.7.4.0.4.7.4.', bass: '0-------4-------', kick: 'x.......x.......', hat: '....x.......x...' },
    ],
    [[0, 0], [0, 1], [1, 0], [1, 1]]),
  S('Gravel Blues', 'gravel-blues', { bpm: 112, root: 45, scale: 'blues', swing: 0.3 },
    { bass: { wave: 'square', vol: 0.45 }, lead: { wave: 'saw', cutoff: 0.45, vol: 0.45 }, arp: { mute: true }, pad: { mute: true } },
    [
      { lead: '5-.4.3-.1-......', bass: '0.2.3.4.5.4.3.2.', kick: 'x.....x.x.....x.', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
      { lead: '0.1.2.3.4.5.6---', bass: '0.2.3.4.5.4.3.2.', kick: 'x.....x.x.....x.', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx' },
    ],
    [[0, 0], [0, 0], [0, 2], [0, 0], [1, 4], [0, 2], [0, 0], [1, 0]]),
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
    id: s.id ?? base.id, name: s.name ?? base.name,
  };
}

/**
 * What plays where. menu: a song id, 'random' (cycles) or 'off'. game: 'track' (each track/course's own song,
 * else a fitting preset), a song id (always that), 'random' (cycles) or 'off'.
 */
export const musicPrefs = { menu: 'neon-drive', game: 'track' };
try { Object.assign(musicPrefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* ignore */ }
export function saveMusicPrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(musicPrefs)); } catch { /* ignore */ } }

const GAME_DEFAULTS = ['neon-drive', 'sky-ride', 'boss-rush', 'victory-lap', 'dungeon-crawl', 'glacier-dream', 'gravel-blues'];
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
