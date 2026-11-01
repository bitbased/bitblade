// Procedural WebAudio sound effects + chip-tune songs (see music.ts). No asset files needed.
import { SongPlayer, musicPrefs, songById, defaultSongFor, randomSong, surpriseSong, loadCustomSongs, PRESET_SONGS, type Song } from './music';

export type SfxName = 'tick' | 'select' | 'back' | 'clash' | 'bigclash' | 'land' | 'launch' | 'count' | 'go' | 'finish' | 'burst' | 'pickup' | 'item' | 'shock' | 'dash' | 'jump' | 'special' | 'crystal' | 'gem' | 'hazard' | 'win' | 'grind';

export type HumStyle = 'buzz' | 'soft' | 'chip' | 'hum' | 'whine' | 'wind' | 'grind' | 'engine' | 'off';
/** spin sound characters: the blade's whir from rough to smooth (noise: a filtered hiss instead of a tone; grind:
 *  metal on metal — a rasping, ringing scrape, with a little of the tone underneath; engine: a sports car revving) */
export const HUM_STYLES: { id: HumStyle; label: string; wave: OscillatorType; cutoff: number; pitch: number; gain: number; noise?: boolean; grind?: boolean; engine?: boolean }[] = [
  { id: 'buzz', label: 'Classic buzz', wave: 'sawtooth', cutoff: 900, pitch: 1, gain: 1 },
  { id: 'soft', label: 'Soft whir', wave: 'sine', cutoff: 2000, pitch: 1.4, gain: 1.6 },
  { id: 'chip', label: '8-bit chip', wave: 'square', cutoff: 1400, pitch: 1, gain: 0.8 },
  { id: 'hum', label: 'Smooth hum', wave: 'triangle', cutoff: 1200, pitch: 0.8, gain: 1.4 },
  { id: 'whine', label: 'High whine', wave: 'sawtooth', cutoff: 2600, pitch: 2, gain: 0.7 },
  { id: 'wind', label: 'Wind hiss', wave: 'sine', cutoff: 0, pitch: 1, gain: 1, noise: true },
  { id: 'grind', label: 'Metal grind', wave: 'sawtooth', cutoff: 700, pitch: 0.7, gain: 1, grind: true },
  { id: 'engine', label: 'Engine', wave: 'sawtooth', cutoff: 0, pitch: 1, gain: 1, engine: true },
  { id: 'off', label: 'Off', wave: 'sine', cutoff: 800, pitch: 1, gain: 0 },
];

export class Sfx {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  musicGain: GainNode | null = null;
  volume = 0.7;
  musicVolume = 0.35;
  private noiseBuf: AudioBuffer | null = null;
  private pump: ReturnType<typeof setInterval> | null = null;
  private musicOn = false;
  /** the song sequencer (created with the audio context) */
  player: SongPlayer | null = null;
  private wanted: Song | null = null;
  private cycleLoops = 0;
  /** the menu's 🎲 Surprise song: made fresh each session, kept only in memory until you save it */
  surprise: Song | null = null;
  /** told whenever the music changes by itself (radio / random), e.g. so the menu can show the new name */
  onSongChange: ((s: Song | null) => void) | null = null;
  private songStart = 0;
  private hum: { osc: OscillatorNode; gain: GainNode; f: BiquadFilterNode; nf: BiquadFilterNode; ngain: GainNode; gbands: { b: BiquadFilterNode; m: number }[]; lfo: OscillatorNode; ggain: GainNode;
    eng: { e1: OscillatorNode; e2: OscillatorNode; elp: BiquadFilterNode; elp2: BiquadFilterNode; ebp: BiquadFilterNode; egain: GainNode } } | null = null;
  /** the spinning-blade sound: loudness (0 = off) and its character */
  humVolume = 1;
  humStyle: HumStyle = 'buzz';

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem('bitblade.audio') || '{}');
      if (typeof s.volume === 'number') this.volume = s.volume;
      if (typeof s.music === 'number') this.musicVolume = s.music;
      if (typeof s.hum === 'number') this.humVolume = s.hum;
      if (s.humStyle && HUM_STYLES.some((h) => h.id === s.humStyle)) this.humStyle = s.humStyle;
    } catch { /* ignore */ }
    const unlock = () => { this.ensure(); this.ctx?.resume(); };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    // (on a touch screen the press itself doesn't count as a click for the browser's sound rules — letting go does)
    addEventListener('pointerup', unlock);
    addEventListener('touchend', unlock);
  }

  save() {
    try { localStorage.setItem('bitblade.audio', JSON.stringify({ volume: this.volume, music: this.musicVolume, hum: this.humVolume, humStyle: this.humStyle })); } catch { /* ignore */ }
    if (this.hum) this.styleHum();
    if (this.master) this.master.gain.value = this.volume;
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.master);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.player = new SongPlayer(this.ctx, this.musicGain, this.noiseBuf);
      if (this.wanted) this.player.play(this.wanted);
    } catch { this.ctx = null; }
    return this.ctx;
  }

  private tone(f: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0) {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, f * slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol: number, freq: number, q = 1, delay = 0, type: BiquadFilterType = 'bandpass') {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master!);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  play(name: SfxName, intensity = 1) {
    if (!this.ensure() || this.ctx!.state !== 'running') return;
    const k = Math.min(1.5, intensity);
    switch (name) {
      case 'tick': this.tone(880, 0.05, 'square', 0.05); break;
      case 'select': this.tone(660, 0.08, 'square', 0.08); this.tone(990, 0.12, 'square', 0.08, 0, 0.06); break;
      case 'back': this.tone(500, 0.1, 'square', 0.07, 0.6); break;
      case 'clash':
        this.noise(0.12, 0.35 * k, 3500 + Math.random() * 2000, 2);
        this.tone(1800 + Math.random() * 1500, 0.08, 'triangle', 0.12 * k, 0.5);
        break;
      case 'bigclash':
        this.noise(0.35, 0.6, 2500, 1);
        this.noise(0.25, 0.5, 200, 1, 0, 'lowpass');
        this.tone(2400, 0.2, 'sawtooth', 0.12, 0.3);
        break;
      case 'grind': this.noise(0.06, 0.08, 6000, 4); break;
      case 'land': this.noise(0.2, 0.35 * k, 300, 1, 0, 'lowpass'); this.tone(90, 0.2, 'sine', 0.3 * k, 0.5); break;
      case 'launch': this.noise(0.5, 0.3, 1500, 0.7); this.tone(200, 0.6, 'sawtooth', 0.12, 4); break;
      case 'count': this.tone(440, 0.18, 'square', 0.12); break;
      case 'go': this.tone(880, 0.4, 'square', 0.14); this.tone(1320, 0.4, 'square', 0.08, 0, 0.05); this.noise(0.6, 0.3, 1200, 0.5); break;
      case 'finish': this.tone(300, 0.6, 'sawtooth', 0.15, 0.3); this.noise(0.5, 0.3, 800, 0.5); break;
      case 'burst': this.noise(0.8, 0.7, 1800, 0.4); this.noise(0.6, 0.6, 120, 1, 0, 'lowpass'); this.tone(1200, 0.5, 'square', 0.12, 0.2); break;
      case 'pickup': this.tone(1046, 0.08, 'square', 0.08); this.tone(1568, 0.12, 'square', 0.08, 0, 0.07); break;
      case 'item': for (let i = 0; i < 4; i++) this.tone(600 + i * 200, 0.06, 'square', 0.06, 0, i * 0.05); break;
      case 'shock': this.tone(120, 0.5, 'sine', 0.45, 0.3); this.noise(0.4, 0.4, 600, 0.6); break;
      case 'dash': this.noise(0.18, 0.25, 2500, 0.8, 0, 'highpass'); this.tone(300, 0.15, 'sawtooth', 0.06, 2); break;
      case 'jump': this.tone(300, 0.15, 'square', 0.08, 2.2); break;
      case 'special': this.tone(220, 0.8, 'sawtooth', 0.15, 4); this.tone(330, 0.8, 'sawtooth', 0.1, 4, 0.05); this.noise(0.8, 0.25, 3000, 0.5); break;
      case 'crystal': this.tone(1800 + Math.random() * 400, 0.1, 'sine', 0.1); this.tone(2600, 0.12, 'sine', 0.06, 0, 0.04); break;
      case 'gem': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, 0.15, 'triangle', 0.1, 0, i * 0.06)); break;
      case 'hazard': this.noise(0.25, 0.4, 900, 2); this.tone(150, 0.2, 'square', 0.12, 0.5); break;
      case 'win': [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.25, 'square', 0.09, 0, i * 0.12)); break;
    }
  }

  /** continuous spin hum: intensity 0..1 */
  setHum(level: number) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.hum) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      gain.gain.value = 0;
      osc.connect(f).connect(gain).connect(this.master!);
      osc.start();
      // the hiss: looping noise through a band-pass that sweeps up with the spin
      const nsrc = this.ctx.createBufferSource();
      nsrc.buffer = this.noiseBuf; nsrc.loop = true;
      const nf = this.ctx.createBiquadFilter(), ngain = this.ctx.createGain();
      nf.type = 'bandpass'; nf.Q.value = 0.8; ngain.gain.value = 0;
      nsrc.connect(nf).connect(ngain).connect(this.master!);
      nsrc.start();
      // the grind: noise ringing at three clashing (inharmonic) resonances, chopped into a rasp by a square LFO
      const gsrc = this.ctx.createBufferSource();
      gsrc.buffer = this.noiseBuf; gsrc.loop = true;
      const ghp = this.ctx.createBiquadFilter(); ghp.type = 'highpass'; ghp.frequency.value = 1800;
      const gsum = this.ctx.createGain(), rasp = this.ctx.createGain(), ggain = this.ctx.createGain();
      gsum.gain.value = 1; rasp.gain.value = 0.75; ggain.gain.value = 0;
      const gbands = [1, 1.58, 2.41].map((m, i) => {
        const b = this.ctx!.createBiquadFilter(); b.type = 'bandpass'; b.Q.value = 20 - i * 4; // (narrow: it rings, rather than rasps)
        const bg = this.ctx!.createGain(); bg.gain.value = [1, 0.8, 0.6][i] * 5.5; // (narrow bands are quiet: lift them)
        gsrc.connect(ghp); ghp.connect(b).connect(bg).connect(gsum);
        return { b, m };
      });
      const lfo = this.ctx.createOscillator(), depth = this.ctx.createGain();
      lfo.type = 'triangle'; depth.gain.value = 0.2; // (a gentle flutter, not a chop)
      lfo.connect(depth).connect(rasp.gain);
      gsum.connect(rasp).connect(ggain).connect(this.master!);
      gsrc.start(); lfo.start();
      // the engine: a firing note (saw) plus a half-speed pulse for the uneven, burbly firing, driven into a growl,
      // through a resonant filter that opens as it revs — and exhaust noise pulsing with every firing
      const e1 = this.ctx.createOscillator(), e2 = this.ctx.createOscillator(), e2g = this.ctx.createGain();
      e1.type = 'sawtooth'; e2.type = 'square'; e2g.gain.value = 0.85; // (a strong half-speed lump: the burble)
      const shaper = this.ctx.createWaveShaper(), curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * 1.7); } // (warm, not fizzy)
      shaper.curve = curve;
      // two gentle low-passes in a row (steep, no peak): the throat, without the buzz on top
      const elp = this.ctx.createBiquadFilter(), elp2 = this.ctx.createBiquadFilter(), egain = this.ctx.createGain();
      elp.type = 'lowpass'; elp.Q.value = 1.2; elp2.type = 'lowpass'; elp2.Q.value = 0.7; egain.gain.value = 0;
      e1.connect(shaper); e2.connect(e2g).connect(shaper);
      shaper.connect(elp).connect(elp2).connect(egain).connect(this.master!);
      const esrc = this.ctx.createBufferSource(); esrc.buffer = this.noiseBuf; esrc.loop = true;
      const ebp = this.ctx.createBiquadFilter(), epulse = this.ctx.createGain(), edepth = this.ctx.createGain();
      ebp.type = 'bandpass'; ebp.Q.value = 0.8; epulse.gain.value = 0.35; edepth.gain.value = 0.35;
      e1.connect(edepth).connect(epulse.gain); // (the exhaust puffs in time with the firing)
      esrc.connect(ebp).connect(epulse).connect(elp); // (through the same low-passes: a rumble, not a hiss)
      e1.start(); e2.start(); esrc.start();
      this.hum = { osc, gain, f, nf, ngain, gbands, lfo, ggain, eng: { e1, e2, elp, elp2, ebp, egain } };
      this.styleHum();
    }
    const st = HUM_STYLES.find((h) => h.id === this.humStyle) ?? HUM_STYLES[0];
    const on = st.id !== 'off' && this.humVolume > 0, t = this.ctx.currentTime;
    const v = on ? level * st.gain * this.humVolume : 0;
    // (the hiss and the grind fall away faster than a tone as they slow: a gentler curve keeps a slow top audible)
    const vn = on ? Math.pow(level, 0.6) * st.gain * this.humVolume : 0;
    this.hum.osc.frequency.setTargetAtTime((60 + level * 220) * st.pitch, t, 0.1);
    this.hum.gain.gain.setTargetAtTime(st.noise || st.engine ? 0 : v * 0.035 * (st.grind ? 0.12 : 1), t, 0.1); // (a grind keeps a touch of buzz for body)
    // (wind: a low breathy rush at low spin, a bright hiss at full spin, with a slight swirl)
    this.hum.nf.frequency.setTargetAtTime((250 + level * level * 3200) * (1 + 0.07 * Math.sin(t * 9)), t, 0.08);
    this.hum.ngain.gain.setTargetAtTime(st.noise ? vn * 0.11 : 0, t, 0.1);
    // (grind: the ring climbs and the rasp speeds up with the spin, with a slight waver like an uneven contact)
    const ring = (2600 + level * 3200) * (1 + 0.03 * Math.sin(t * 13));
    for (const g of this.hum.gbands) g.b.frequency.setTargetAtTime(ring * g.m, t, 0.06);
    this.hum.lfo.frequency.setTargetAtTime(18 + level * 52, t, 0.1);
    this.hum.ggain.gain.setTargetAtTime(st.grind ? vn * 0.045 : 0, t, 0.08);
    // (engine: revs with the spin — a lumpy idle at low spin, a howl at full spin)
    const E = this.hum.eng, rpm = (24 + level * 150) * (1 + 0.012 * Math.sin(t * 23));
    E.e1.frequency.setTargetAtTime(rpm, t, 0.07);
    E.e2.frequency.setTargetAtTime(rpm * 0.5, t, 0.07);
    E.elp.frequency.setTargetAtTime(150 + level * 700, t, 0.08);
    E.elp2.frequency.setTargetAtTime(190 + level * 850, t, 0.08);
    E.ebp.frequency.setTargetAtTime(160 + level * 450, t, 0.08);
    E.egain.gain.setTargetAtTime(st.engine ? vn * 0.05 : 0, t, 0.08); // (darker is quieter-sounding: a little more level)
  }

  private styleHum() {
    if (!this.hum) return;
    const st = HUM_STYLES.find((h) => h.id === this.humStyle) ?? HUM_STYLES[0];
    this.hum.osc.type = st.wave;
    this.hum.f.frequency.value = st.cutoff;
  }

  /** 📻 the next radio song: about half fresh surprises, the rest presets and songs from your library (never the
   *  same one twice in a row; with no library songs, presets take their share) */
  radioPick(): Song {
    const not = this.wanted?.id, pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    const lib = loadCustomSongs().filter((s) => s.id !== not), pre = PRESET_SONGS.filter((s) => s.id !== not);
    const r = Math.random();
    if (r < 0.25 && lib.length) return pick(lib);
    if (r < 0.5 && pre.length) return pick(pre);
    return surpriseSong();
  }

  /** 📻 in a match: radio songs keep coming (each ≥45s, switching at the end of a loop) */
  startRadio() {
    const n = this.radioPick();
    this.surprise = n;
    this.playSong(n);
    this.armRadio();
  }
  private armRadio() {
    if (!this.player) return;
    this.player.onLoop = () => {
      if (!this.ctx || this.ctx.currentTime - this.songStart < 45) return;
      const n = this.radioPick();
      this.surprise = n; this.wanted = n; this.songStart = this.ctx.currentTime;
      this.player!.play(n);
      this.onSongChange?.(n);
    };
  }

  music(on: boolean) { this.musicOn = on; }
  /** music turned down (k < 1) while a sound is being previewed — the spin test was buried under the menu music */
  duck(k: number) {
    if (!this.ctx || !this.musicGain) return;
    this.musicGain.gain.setTargetAtTime(this.musicVolume * k, this.ctx.currentTime, k < 1 ? 0.05 : 0.25);
  }
  /** is music actually audible right now? (browsers keep audio locked until the first click / key) */
  get musicLive() { return this.musicOn && this.ctx?.state === 'running' && this.musicVolume > 0 && musicPrefs.menu !== 'off'; }

  /** play a specific song (Music Studio preview); restart=false keeps going if it's already this song */
  playSong(song: Song | null, restart = true) {
    if (restart || this.wanted?.id !== song?.id) this.songStart = this.ctx?.currentTime ?? 0;
    this.wanted = song;
    this.cycleLoops = 0;
    if (this.player) { this.player.onLoop = null; this.player.solo = null; this.player.play(song, restart); }
  }

  /**
   * Pick the music for a place (see musicPrefs): menus, or a match on `arena` (its own song when it has one).
   * Doesn't restart a song that's already playing, so moving between menus is seamless.
   */
  useMusic(where: 'menu' | 'game', arena?: { id: string; song?: string }) {
    const pref = where === 'menu' ? musicPrefs.menu : musicPrefs.game;
    if (pref === 'off') { this.playSong(null); return; }
    const random = pref === 'random';
    let song: Song | null;
    if (random) song = this.wanted && this.player?.song ? this.wanted : randomSong();
    else if (pref === 'surprise' && where === 'menu') song = this.surprise ??= surpriseSong();
    else if (where === 'game' && pref === 'track') song = songById(arena?.song) ?? (arena ? defaultSongFor(arena.id) : PRESET_SONGS[0]);
    else song = songById(pref) ?? PRESET_SONGS[0];
    const same = !!song && this.wanted?.id === song.id;
    this.playSong(song, !same);
    if (random && this.player) {
      // random: a new song every couple of times round
      this.player.onLoop = () => { if (++this.cycleLoops >= 2) { this.cycleLoops = 0; const n = randomSong(this.wanted?.id); this.wanted = n; this.player!.play(n); this.onSongChange?.(n); } };
    }
    if (pref === 'surprise' && where === 'menu' && musicPrefs.radio && this.player) {
      // 📻 radio: once a song has had 45s, the next time it comes round to its start, the next one takes over
      this.player.onLoop = () => {
        if (!this.ctx || this.ctx.currentTime - this.songStart < 45) return;
        const n = this.radioPick();
        this.surprise = n; this.wanted = n; this.songStart = this.ctx.currentTime;
        this.player!.play(n);
        this.onSongChange?.(n);
      };
    }
  }

  /**
   * Music is scheduled on the audio clock with a lookahead, so a slow frame never delays the beat: every call
   * (each frame, plus a timer in case frames stall) queues all steps due in the next ~0.4s at exact times.
   */
  update(_dt = 0) {
    if (!this.pump && typeof setInterval !== 'undefined') this.pump = setInterval(() => this.update(), 100);
    if (!this.musicOn || !this.ctx || this.ctx.state !== 'running' || this.musicVolume <= 0 || !this.player) return;
    this.player.schedule();
  }
}
