// Procedural WebAudio sound effects + chip-tune songs (see music.ts). No asset files needed.
import { SongPlayer, musicPrefs, songById, defaultSongFor, randomSong, surpriseSong, PRESET_SONGS, type Song } from './music';

export type SfxName = 'tick' | 'select' | 'back' | 'clash' | 'bigclash' | 'land' | 'launch' | 'count' | 'go' | 'finish' | 'burst' | 'pickup' | 'item' | 'shock' | 'dash' | 'jump' | 'special' | 'crystal' | 'gem' | 'hazard' | 'win' | 'grind';

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
  private hum: { osc: OscillatorNode; gain: GainNode } | null = null;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem('bitblade.audio') || '{}');
      if (typeof s.volume === 'number') this.volume = s.volume;
      if (typeof s.music === 'number') this.musicVolume = s.music;
    } catch { /* ignore */ }
    const unlock = () => { this.ensure(); this.ctx?.resume(); };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
  }

  save() {
    try { localStorage.setItem('bitblade.audio', JSON.stringify({ volume: this.volume, music: this.musicVolume })); } catch { /* ignore */ }
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
      osc.type = 'sawtooth';
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      gain.gain.value = 0;
      osc.connect(f).connect(gain).connect(this.master!);
      osc.start();
      this.hum = { osc, gain };
    }
    this.hum.osc.frequency.setTargetAtTime(60 + level * 220, this.ctx.currentTime, 0.1);
    this.hum.gain.gain.setTargetAtTime(level * 0.035, this.ctx.currentTime, 0.1);
  }

  music(on: boolean) { this.musicOn = on; }

  /** play a specific song (Music Studio preview); restart=false keeps going if it's already this song */
  playSong(song: Song | null, restart = true) {
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
      this.player.onLoop = () => { if (++this.cycleLoops >= 2) { this.cycleLoops = 0; const n = randomSong(this.wanted?.id); this.wanted = n; this.player!.play(n); } };
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
