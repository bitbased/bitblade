// Music Studio: make chip-tune songs for menus, tracks and courses.
// Left: songs. Top: tempo / swing / key / mood / crunch. Middle: patterns A-D, the arrangement (parts + chord
// shift), an 8-lane x 16-step grid, and a piano roll (in key) for the selected melodic lane. Right: lane voice.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import {
  DEG_CHARS, DRUMS, EMPTY, KEYS, LANE_KINDS, LANE_LABEL, PRESET_SONGS, SCALES, STEPS, WAVES,
  emptyPattern, laneDefaults, loadCustomSongs, musicPrefs, newSong, sanitizeSong, saveCustomSongs, saveMusicPrefs, semis,
  type Lane, type ScaleId, type Song,
} from '../game/music';
import { setBackdropVisible } from './backdrop';
import './musicStudio.css';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const PLETTER = 'ABCD';
/** chord shift names for the arrangement (scale degree → roman numeral-ish) */
const SHIFT = (t: number) => (t === 0 ? 'I' : ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][((t % 7) + 7) % 7] + (t < 0 ? '↓' : t >= 7 ? '↑' : ''));
const ROLL_ROWS = 15; // scale degrees 0..14 (two octaves in a 7-note scale)

class MusicStudio {
  root: HTMLElement;
  nav: MenuNav;
  custom: Song[] = loadCustomSongs();
  song: Song;
  pat = 0; // pattern being edited
  part = 0; // selected arrangement part
  lane = 0; // selected lane
  holdMode = false; // roll: click extends a held note instead of placing one
  playing = false;
  loopPattern = true;
  saveT = 0;
  private el: Record<string, HTMLElement> = {};
  private cells: HTMLElement[][] = []; // [lane][step]
  private rollCells: HTMLElement[][] = []; // [row][step]
  private lastHead = -2;

  constructor(private app: App) {
    setBackdropVisible(true, app.canvas);
    app.sfx.playSong(null); // quiet while editing; ▶ plays the song you're working on
    this.song = clone(this.custom[0] ?? PRESET_SONGS[0]);
    this.root = h('div.ms-root');
    app.root.append(this.root);
    this.render();
    this.nav = new MenuNav(app, this.root, () => this.app.back());
  }

  get isPreset() { return !this.song.custom; }

  // ------------------------------------------------------------------ editing helpers
  /** presets are read-only: the first edit makes your own copy */
  editable() {
    if (!this.isPreset) return true;
    const copy = { ...clone(this.song), id: newSong().id, name: this.song.name + ' (mine)', custom: true };
    this.custom.unshift(copy);
    this.song = copy;
    this.app.toast('Made your own copy to edit');
    this.renderList();
    this.renderTop();
    return true;
  }
  changed() { this.saveT = 0.4; if (this.playing) this.app.sfx.player?.play(this.song, false); }
  persist() {
    if (this.isPreset) return;
    const i = this.custom.findIndex((s) => s.id === this.song.id);
    if (i >= 0) this.custom[i] = clone(this.song); else this.custom.unshift(clone(this.song));
    saveCustomSongs(this.custom);
  }
  open(s: Song) {
    this.persist();
    this.song = clone(s);
    this.pat = 0; this.part = 0;
    if (this.playing) this.app.sfx.playSong(this.song);
    this.render();
  }
  setCell(li: number, step: number, ch: string) {
    const row = this.song.patterns[this.pat][li];
    this.song.patterns[this.pat][li] = row.slice(0, step) + ch + row.slice(step + 1);
  }

  // ------------------------------------------------------------------ transport
  togglePlay() {
    this.playing = !this.playing;
    if (this.playing) {
      this.app.sfx.music(true);
      this.app.sfx.playSong(this.song);
      if (this.app.sfx.player) this.app.sfx.player.solo = this.loopPattern ? this.pat : null;
    } else this.app.sfx.playSong(null);
    this.renderTop();
  }
  setLoopPattern(v: boolean) {
    this.loopPattern = v;
    if (this.app.sfx.player) this.app.sfx.player.solo = v ? this.pat : null;
    this.renderTop();
  }

  // ------------------------------------------------------------------ rendering
  render() {
    this.root.innerHTML = '';
    this.el.top = h('div.ms-top');
    this.el.left = h('div.ms-panel.ms-left');
    this.el.main = h('div.ms-main');
    this.el.right = h('div.ms-panel.ms-right');
    this.root.append(this.el.top, this.el.left, this.el.main, this.el.right);
    this.renderTop(); this.renderList(); this.renderMain(); this.renderLane();
  }

  renderTop() {
    const s = this.song, T = this.el.top;
    T.innerHTML = '';
    const name = h<HTMLInputElement>('input.ms-name.nav', { value: s.name, placeholder: 'Song name', oninput: () => { this.editable(); this.song.name = name.value; this.changed(); this.renderListSoon(); } });
    const slider = (label: string, val: number, min: number, max: number, step: number, fmt: (v: number) => string, on: (v: number) => void) => {
      const out = h('b', null, fmt(val));
      const inp = h<HTMLInputElement>('input.nav', { type: 'range', min, max, step, value: val, 'data-navx': '1' });
      const set = (v: number) => { this.editable(); on(v); out.textContent = fmt(v); this.changed(); };
      inp.addEventListener('input', () => set(parseFloat(inp.value)));
      inp.addEventListener('navx', (e) => { inp.value = String(parseFloat(inp.value) + (e as CustomEvent).detail * step); set(parseFloat(inp.value)); });
      return h('label.ms-knob', null, h('span', null, label), inp, out);
    };
    const sel = (label: string, opts: [string, string][], cur: string, on: (v: string) => void) => {
      const se = h<HTMLSelectElement>('select.nav.ms-sel', { onchange: () => { this.editable(); on(se.value); this.changed(); } }, ...opts.map(([v, t]) => h('option', { value: v, selected: v === cur }, t)));
      return h('label.ms-knob', null, h('span', null, label), se);
    };
    T.append(
      h('button.btn.small.nav', { onclick: () => this.app.back(), 'data-k': 'ESC', 'data-p': 'B', 'data-ps': '○' }, '◀ Back'),
      h('div.ms-title', null, 'MUSIC STUDIO'),
      name,
      h('button.btn.primary.nav.ms-play', { onclick: () => this.togglePlay() }, this.playing ? '■ STOP' : '▶ PLAY'),
      h('div.ms-seg', null,
        h('button.nav' + (this.loopPattern ? '.on' : ''), { onclick: () => this.setLoopPattern(true), title: 'Loop the pattern you are editing' }, 'PATTERN'),
        h('button.nav' + (!this.loopPattern ? '.on' : ''), { onclick: () => this.setLoopPattern(false), title: 'Play the whole arrangement' }, 'SONG')),
      slider('TEMPO', s.bpm, 60, 200, 1, (v) => `${v}`, (v) => (this.song.bpm = v)),
      slider('SWING', s.swing, 0, 0.5, 0.02, (v) => `${Math.round(v * 200)}%`, (v) => (this.song.swing = v)),
      sel('KEY', KEYS.map((k, i) => [String(i), k] as [string, string]), String(((s.root % 12) + 12) % 12), (v) => { this.song.root = 36 + +v + (+v < 4 ? 12 : 0); }), // E2..D#3: a comfy root for every lane's octave
      sel('MOOD', (Object.keys(SCALES) as ScaleId[]).map((k) => [k, `${SCALES[k].mood} (${k === 'penta' ? 'major penta' : k === 'minpenta' ? 'minor penta' : k === 'harmonic' ? 'harmonic minor' : k})`] as [string, string]), s.scale, (v) => { this.song.scale = v as ScaleId; this.renderMain(); }),
      slider('CRUNCH', s.crunch, 0, 1, 0.05, (v) => (v ? `${Math.round(v * 100)}%` : 'off'), (v) => (this.song.crunch = v)),
    );
  }

  private listT = 0;
  renderListSoon() { this.listT = 0.3; }
  renderList() {
    const L = this.el.left;
    L.innerHTML = '';
    const item = (s: Song) => h('div.ms-item.nav' + (s.id === this.song.id ? '.on' : ''), { onclick: () => { if (s.id !== this.song.id) this.open(s); } },
      h('b', null, s.name), h('span', null, `${s.custom ? '' : '★ '}${SCALES[s.scale].mood} · ${s.bpm}`));
    const isMenu = musicPrefs.menu === this.song.id;
    // actions stay pinned at the top; only the song lists scroll (a long library never hides them)
    L.append(
      h('div.ms-actions', null,
        h('button.btn.small.nav', { onclick: () => { const s = newSong(); s.patterns[0][4] = 'x...x...x...x...'; s.patterns[0][6] = '..x...x...x...x.'; this.custom.unshift(s); saveCustomSongs(this.custom); this.open(s); } }, '+ New'),
        h('button.btn.small.nav', { onclick: () => this.surprise() }, '🎲 Surprise'),
        h('button.btn.small.nav', { onclick: () => { const c = { ...clone(this.song), id: newSong().id, name: this.song.name + ' copy', custom: true }; this.custom.unshift(c); saveCustomSongs(this.custom); this.open(c); } }, 'Duplicate'),
        h('button.btn.small.nav', { onclick: () => this.exportSong() }, 'Export'),
        h('button.btn.small.nav', { onclick: () => this.importSong() }, 'Import'),
        this.isPreset ? null : h('button.btn.small.nav.ms-danger', { onclick: () => this.deleteSong() }, 'Delete'),
        h('button.btn.small.nav.ms-wide' + (isMenu ? '.on' : ''), { onclick: () => { musicPrefs.menu = isMenu ? 'neon-drive' : this.song.id; saveMusicPrefs(); this.persist(); this.renderList(); this.app.toast(isMenu ? 'Menu music back to Neon Drive' : `${this.song.name} is now the menu music`); } }, isMenu ? '♪ Menu music ✓' : '♪ Use as menu music'),
      ),
      h('div.ms-scroll', null,
        h('h3', null, `MY SONGS (${this.custom.length})`),
        h('div.ms-list', null, ...(this.custom.length ? this.custom.map(item) : [h('div.ms-muted', null, 'Nothing yet — start from a preset or a new song.')])),
        h('h3', null, 'PRESETS'),
        h('div.ms-list', null, ...PRESET_SONGS.map(item)),
        h('div.ms-muted', null, 'Pick a song for a track or course in Track Studio / Course Builder. Settings chooses menu & match music.'),
      ),
    );
    L.querySelector('.ms-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  renderMain() {
    const s = this.song, M = this.el.main;
    M.innerHTML = '';
    // patterns
    const pats = h('div.ms-row', null, h('span.ms-lbl', null, 'PATTERN'),
      ...s.patterns.map((_, i) => h('button.ms-chip.nav' + (i === this.pat ? '.on' : ''), { onclick: () => { this.pat = i; if (this.app.sfx.player && this.loopPattern) this.app.sfx.player.solo = i; this.renderMain(); } }, PLETTER[i])),
      s.patterns.length < 4 ? h('button.ms-chip.nav', { title: 'New pattern (a copy of this one)', onclick: () => { this.editable(); this.song.patterns.push(clone(this.song.patterns[this.pat])); this.pat = this.song.patterns.length - 1; this.changed(); this.renderMain(); } }, '+') : null,
      h('button.ms-chip.nav', { title: 'Clear this pattern', onclick: () => { if (!confirmTwice(this.app, 'ms-clear', 'Press again to clear this pattern')) return; this.editable(); this.song.patterns[this.pat] = emptyPattern(); this.changed(); this.renderMain(); } }, 'Clear'),
    );
    // arrangement
    const cur = s.arrange[this.part] ?? s.arrange[0];
    const arr = h('div.ms-row', null, h('span.ms-lbl', null, 'SONG'),
      ...s.arrange.map((a, i) => h('button.ms-part.nav' + (i === this.part ? '.on' : ''), { onclick: () => { this.part = i; this.pat = a.p; this.renderMain(); } }, h('b', null, PLETTER[a.p]), h('span', null, SHIFT(a.t)))),
      s.arrange.length < 32 ? h('button.ms-chip.nav', { title: 'Add a part', onclick: () => { this.editable(); this.song.arrange.splice(this.part + 1, 0, { ...cur }); this.part++; this.changed(); this.renderMain(); } }, '+') : null,
    );
    const partTools = h('div.ms-row.ms-sub', null, h('span.ms-lbl', null, `PART ${this.part + 1}`),
      h('button.ms-chip.nav', { title: 'Which pattern this part plays', onclick: () => { this.editable(); cur.p = (cur.p + 1) % this.song.patterns.length; this.pat = cur.p; this.changed(); this.renderMain(); } }, `Pattern ${PLETTER[cur.p]} ⟳`),
      h('button.ms-chip.nav', { title: 'Chord down', onclick: () => { this.editable(); cur.t = Math.max(-7, cur.t - 1); this.changed(); this.renderMain(); } }, '◀'),
      h('span.ms-shift', null, `Chord ${SHIFT(cur.t)}`),
      h('button.ms-chip.nav', { title: 'Chord up', onclick: () => { this.editable(); cur.t = Math.min(7, cur.t + 1); this.changed(); this.renderMain(); } }, '▶'),
      s.arrange.length > 1 ? h('button.ms-chip.nav', { onclick: () => { this.editable(); this.song.arrange.splice(this.part, 1); this.part = Math.max(0, this.part - 1); this.changed(); this.renderMain(); } }, 'Remove part') : null,
      h('span.ms-muted', null, 'Tip: I → IV → V → VI (or I V VI IV) makes a classic progression.'),
    );
    // lanes grid
    const grid = h('div.ms-grid');
    this.cells = [];
    s.lanes.forEach((lane, li) => {
      const row = s.patterns[this.pat][li];
      const head = h('button.ms-lane.nav' + (li === this.lane ? '.on' : '') + (lane.mute ? '.mute' : ''), { onclick: () => { this.lane = li; this.renderMain(); this.renderLane(); } },
        h('b', null, LANE_LABEL[lane.kind]), h('span', null, lane.mute ? 'muted' : DRUMS.has(lane.kind) ? 'drum' : WAVES.find((w) => w.id === lane.wave)?.label ?? ''));
      const cells: HTMLElement[] = [];
      const rowEl = h('div.ms-steps');
      for (let st = 0; st < STEPS; st++) {
        const ch = row[st];
        const c = h('button.ms-cell.nav' + (st % 4 === 0 ? '.beat' : '') + (ch === '-' ? '.hold' : ch !== '.' ? '.on' : '') + (ch === 'X' ? '.acc' : ''), {
          onclick: () => this.clickCell(li, st),
          title: DRUMS.has(lane.kind) ? 'hit / accent / off' : 'note — pick its pitch in the roll below',
        }, ch !== '.' && ch !== '-' && !DRUMS.has(lane.kind) ? ch : '');
        cells.push(c); rowEl.append(c);
      }
      this.cells.push(cells);
      grid.append(head, rowEl);
    });
    M.append(pats, arr, partTools, grid);
    // piano roll for melodic lanes
    const lane = s.lanes[this.lane];
    this.rollCells = [];
    if (!DRUMS.has(lane.kind)) {
      const roll = h('div.ms-roll');
      const row = s.patterns[this.pat][this.lane];
      for (let r = ROLL_ROWS - 1; r >= 0; r--) {
        const midi = s.root + 12 * lane.oct + semis(s.scale, r);
        const label = h('div.ms-rl' + (r % SCALES[s.scale].steps.length === 0 ? '.root' : ''), null, KEYS[midi % 12] + (Math.floor(midi / 12) - 1));
        const cells: HTMLElement[] = [];
        const rowEl = h('div.ms-steps');
        for (let st = 0; st < STEPS; st++) {
          const ch = row[st];
          const on = DEG_CHARS[r] === ch;
          // a held cell shows on the row of the note it holds
          let heldDeg = -1;
          if (ch === '-') for (let k = st - 1; k >= 0; k--) { if (row[k] !== '-') { heldDeg = DEG_CHARS.indexOf(row[k]); break; } }
          const c = h('button.ms-rc.nav' + (st % 4 === 0 ? '.beat' : '') + (on ? '.on' : '') + (heldDeg === r ? '.hold' : ''), { onclick: () => this.clickRoll(r, st) });
          cells.push(c); rowEl.append(c);
        }
        this.rollCells[r] = cells;
        roll.append(label, rowEl);
      }
      M.append(h('div.ms-row.ms-sub', null, h('span.ms-lbl', null, `${LANE_LABEL[lane.kind].toUpperCase()} NOTES`),
        h('div.ms-seg', null,
          h('button.nav' + (!this.holdMode ? '.on' : ''), { onclick: () => { this.holdMode = false; this.renderMain(); } }, 'PLACE'),
          h('button.nav' + (this.holdMode ? '.on' : ''), { onclick: () => { this.holdMode = true; this.renderMain(); }, title: 'Click after a note to make it ring on' }, 'HOLD')),
        h('span.ms-muted', null, 'Every row is in key — anything you draw fits. Click a note again to remove it.')), roll);
    } else M.append(h('div.ms-muted.ms-pad', null, `${LANE_LABEL[lane.kind]}: click steps above — once = hit, twice = accent, three times = off.`));
    this.lastHead = -2;
  }

  renderLane() {
    const R = this.el.right, s = this.song, lane = s.lanes[this.lane];
    R.innerHTML = '';
    const set = (fn: (l: Lane) => void, full = false) => { this.editable(); fn(this.song.lanes[this.lane]); this.changed(); if (full) { this.renderMain(); this.renderLane(); } };
    const slider = (label: string, key: 'vol' | 'decay' | 'cutoff' | 'echo' | 'vib', min: number, max: number, step: number, fmt: (v: number) => string) => {
      const out = h('b', null, fmt(lane[key]));
      const inp = h<HTMLInputElement>('input.nav', { type: 'range', min, max, step, value: lane[key], 'data-navx': '1' });
      const go = (v: number) => { set((l) => (l[key] = v)); out.textContent = fmt(v); };
      inp.addEventListener('input', () => go(parseFloat(inp.value)));
      inp.addEventListener('navx', (e) => { inp.value = String(parseFloat(inp.value) + (e as CustomEvent).detail * step); go(parseFloat(inp.value)); });
      return h('label.ms-slider', null, h('span', null, label), inp, out);
    };
    const drum = DRUMS.has(lane.kind);
    R.append(...([
      h('h3', null, `${LANE_LABEL[lane.kind].toUpperCase()} VOICE`),
      drum && lane.kind !== 'kick' ? null : h('div.ms-waves', null, ...WAVES.filter((w) => !(lane.kind === 'kick' && w.id === 'noise')).map((w) =>
        h('button.ms-chip.nav' + (lane.wave === w.id ? '.on' : ''), { onclick: () => { set((l) => (l.wave = w.id), true); this.app.sfx.player?.preview(this.song, this.lane, drum ? 'x' : '4'); } }, w.label))),
      drum ? null : h('div.ms-row', null, h('span.ms-lbl', null, 'OCTAVE'),
        h('button.ms-chip.nav', { onclick: () => set((l) => (l.oct = Math.max(-2, l.oct - 1)), true) }, '−'),
        h('b.ms-oct', null, String(lane.oct)),
        h('button.ms-chip.nav', { onclick: () => set((l) => (l.oct = Math.min(3, l.oct + 1)), true) }, '+')),
      slider('VOLUME', 'vol', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      slider(drum ? 'LENGTH' : 'RING', 'decay', 0.03, 2, 0.01, (v) => `${v.toFixed(2)}s`),
      slider('BRIGHTNESS', 'cutoff', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      slider('ECHO', 'echo', 0, 1, 0.05, (v) => (v ? `${Math.round(v * 100)}%` : 'off')),
      drum ? null : slider('VIBRATO', 'vib', 0, 1, 0.05, (v) => (v ? `${Math.round(v * 100)}%` : 'off')),
      drum ? null : h('button.ms-toggle.nav' + (lane.chord ? '.on' : ''), { onclick: () => set((l) => (l.chord = !l.chord), true), title: lane.kind === 'pad' ? 'Play each note as a full chord' : 'Chip arpeggio: each note flickers through its chord' }, lane.kind === 'pad' ? '♫ Chords' : '♫ Chip arpeggio'),
      h('button.ms-toggle.nav' + (lane.mute ? '.on' : ''), { onclick: () => set((l) => (l.mute = !l.mute), true) }, lane.mute ? '🔇 Muted' : '🔊 Mute'),
      h('div.ms-btns', null,
        h('button.btn.small.nav', { onclick: () => { set((l) => Object.assign(l, genVoice(l)), true); this.previewLane(); } }, '🎲 Random voice'),
        h('button.btn.small.nav', { onclick: () => { this.editable(); this.song.patterns[this.pat][this.lane] = genLane(lane.kind, this.song); this.changed(); this.renderMain(); } }, `🎲 New ${LANE_LABEL[lane.kind].toLowerCase()} idea`),
        h('button.btn.small.nav', { onclick: () => { this.editable(); this.song.patterns[this.pat][this.lane] = EMPTY; this.changed(); this.renderMain(); } }, 'Clear lane'),
        h('button.btn.small.nav', { onclick: () => set((l) => Object.assign(l, laneDefaults(l.kind)), true) }, 'Reset voice')),
    ].filter(Boolean) as HTMLElement[]));
  }

  /** play a note (or hit) from this lane so you hear its voice */
  previewLane() {
    const li = this.lane, row = this.song.patterns[this.pat][li];
    const ch = DRUMS.has(this.song.lanes[li].kind) ? 'x' : [...row].find((c) => c !== '.' && c !== '-') ?? '4';
    this.app.sfx.player?.preview(this.song, li, ch, this.song.arrange[this.part]?.t ?? 0);
  }

  // ------------------------------------------------------------------ clicks
  clickCell(li: number, st: number) {
    const lane = this.song.lanes[li];
    if (this.lane !== li) { this.lane = li; this.renderLane(); }
    this.editable();
    const ch = this.song.patterns[this.pat][li][st];
    if (DRUMS.has(lane.kind)) {
      const n = ch === '.' ? 'x' : ch === 'x' ? 'X' : '.';
      this.setCell(li, st, n);
      if (n !== '.') this.app.sfx.player?.preview(this.song, li, n);
    } else {
      // melodic: toggle a note (the roll picks its pitch); a new note starts on the middle degree
      if (ch === '.' || ch === '-') { this.setCell(li, st, '4'); this.app.sfx.player?.preview(this.song, li, '4', this.song.arrange[this.part]?.t ?? 0); }
      else this.setCell(li, st, '.');
    }
    this.changed();
    this.renderMain();
  }

  clickRoll(r: number, st: number) {
    this.editable();
    const li = this.lane, row = this.song.patterns[this.pat][li], ch = row[st], d = DEG_CHARS[r];
    if (this.holdMode) {
      // extend the previous note through this step (or cut the hold off here)
      let k = st - 1;
      while (k >= 0 && row[k] === '-') k--;
      if (k < 0 || row[k] === '.') { this.app.toast('Place a note first, then HOLD extends it'); return; }
      if (ch === '-') { for (let j = st; j < STEPS && this.song.patterns[this.pat][li][j] === '-'; j++) this.setCell(li, j, '.'); }
      else for (let j = k + 1; j <= st; j++) this.setCell(li, j, '-');
    } else if (ch === d) this.setCell(li, st, '.');
    else { this.setCell(li, st, d); this.app.sfx.player?.preview(this.song, li, d, this.song.arrange[this.part]?.t ?? 0); }
    this.changed();
    this.renderMain();
  }

  // ------------------------------------------------------------------ songs
  surprise() {
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
    s.patterns = [0, 1].map(() => LANE_KINDS.map((k) => genLane(k, s)));
    const progs = [[0, 4, 5, 3], [0, 3, 4, 4], [0, 5, 3, 4], [0, 0, 3, 4], [0, 3, 0, 4]];
    const pr = progs[Math.floor(Math.random() * progs.length)];
    s.arrange = [...pr.map((t) => ({ p: 0, t })), ...pr.map((t) => ({ p: 1, t }))];
    this.custom.unshift(s);
    saveCustomSongs(this.custom);
    this.open(s);
    if (!this.playing) this.togglePlay();
    this.setLoopPattern(false);
  }
  exportSong() {
    const blob = new Blob([JSON.stringify(this.song, null, 1)], { type: 'application/json' });
    const a = h<HTMLAnchorElement>('a', { href: URL.createObjectURL(blob), download: `${this.song.name.replace(/[^\w-]+/g, '_')}.bitsong.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  importSong() {
    const inp = h<HTMLInputElement>('input', { type: 'file', accept: '.json,application/json' });
    inp.onchange = async () => {
      try {
        const s = sanitizeSong(JSON.parse(await inp.files![0].text()));
        s.id = newSong().id; s.custom = true;
        this.custom.unshift(s); saveCustomSongs(this.custom); this.open(s);
      } catch (e) { this.app.toast(`Couldn't import: ${(e as Error).message}`); }
    };
    inp.click();
  }
  deleteSong() {
    if (!confirmTwice(this.app, 'ms-del-' + this.song.id, `Press again to delete ${this.song.name}`)) return;
    this.custom = this.custom.filter((s) => s.id !== this.song.id);
    saveCustomSongs(this.custom);
    this.song = clone(this.custom[0] ?? PRESET_SONGS[0]);
    this.render();
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    this.nav.update(dt);
    if (this.saveT > 0 && (this.saveT -= dt) <= 0) this.persist();
    if (this.listT > 0 && (this.listT -= dt) <= 0) this.renderList();
    // playhead
    const pos = this.playing ? this.app.sfx.player?.position() : null;
    const head = pos && pos.p === this.pat ? pos.step : -1;
    if (head !== this.lastHead) {
      for (const row of this.cells) { row[this.lastHead]?.classList.remove('head'); row[head]?.classList.add('head'); }
      for (const row of this.rollCells) { row?.[this.lastHead]?.classList.remove('head'); row?.[head]?.classList.add('head'); }
      this.lastHead = head;
    }
  }

  dispose() {
    this.persist();
    this.root.remove();
    this.app.sfx.useMusic('menu');
  }
}

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

let studio: MusicStudio | null = null;
export const musicStudioScreen: Screen = {
  mount(app: App) { studio = new MusicStudio(app); if (import.meta.env.DEV) (window as unknown as { __ms?: MusicStudio }).__ms = studio; },
  unmount() { studio?.dispose(); studio = null; },
  update(dt: number) { studio?.update(dt); },
};
