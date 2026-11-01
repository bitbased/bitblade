// Music Studio: make chip-tune songs for menus, tracks and courses.
// Left: songs. Top: tempo / swing / key / mood / crunch. Middle: patterns A-D, the arrangement (parts + chord
// shift), an 8-lane x 16-step grid, and a piano roll (in key) for the selected melodic lane. Right: lane voice.
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import {
  DEG_CHARS, DRUMS, EMPTY, KEYS, LANE_KINDS, LANE_LABEL, PRESET_SONGS, SCALES, STEPS, WAVES,
  emptyPattern, genLane, genVoice, laneDefaults, loadCustomSongs, musicPrefs, newSong, sanitizeSong, saveCustomSongs, saveMusicPrefs, semis, surpriseSong,
  type Lane, type ScaleId, type Song,
} from '../game/music';
import { setBackdropVisible } from './backdrop';
import { icon } from './icons';
import { sharedForStudio, shareSong } from './sharedSong';
import { draftBar, draftsOf, dropDraft, getDraft, lastOpen, putDraft, setLastOpen } from './drafts';
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
  loopPattern = false; // (▶ plays the whole song, as people expect — PATTERN loops just the one you're editing)
  saveT = 0;
  /** the song has edits that aren't saved yet (kept as a draft until SAVE / DISCARD) */
  dirty = false;
  /** not in My Songs yet (new, a copy, a surprise, an import): SAVE adds it */
  fresh = false;
  private bar: ReturnType<typeof draftBar> | null = null;
  private el: Record<string, HTMLElement> = {};
  private cells: HTMLElement[][] = []; // [lane][step]
  private rollCells: HTMLElement[][] = []; // [row][step]
  private lastHead = -2;
  /** song mode: the pattern chip and song part that are sounding right now (green; the selection stays pink) */
  private patChips: HTMLElement[] = [];
  private partBtns: HTMLElement[] = [];
  private lastPlay = '';

  constructor(private app: App) {
    setBackdropVisible(true, app.canvas);
    app.sfx.playSong(null); // quiet while editing; ▶ plays the song you're working on
    // reopen where you left off (on its draft, if it has one)
    const last = lastOpen('song'), lastDraft = last ? getDraft<Song>('song', last) : null;
    const from = (last && (this.custom.find((s) => s.id === last) ?? PRESET_SONGS.find((s) => s.id === last) ?? (lastDraft ? sanitizeSong(lastDraft.work) : null))) || this.custom[0] || PRESET_SONGS[0];
    this.song = this.load(from);
    this.root = h('div.ms-root');
    app.root.append(this.root);
    this.render();
    this.nav = new MenuNav(app, this.root, () => this.app.back());
    addEventListener('keydown', this.onKey);
  }
  private onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); } };

  /** the working copy of a song: its draft if it has one, else a copy of the saved song */
  load(s: Song): Song {
    const d = getDraft<Song>('song', s.id);
    this.dirty = !!d; this.fresh = !!d?.fresh;
    setLastOpen('song', s.id);
    return d ? { ...sanitizeSong(d.work), id: s.id, custom: true } : clone(s);
  }

  get isPreset() { return !this.song.custom; }

  // ------------------------------------------------------------------ editing helpers
  /** presets are read-only: the first edit starts your own (unsaved) copy */
  editable() {
    if (!this.isPreset) return true;
    this.song = { ...clone(this.song), id: newSong().id, name: this.song.name + ' (mine)', custom: true };
    this.fresh = true; this.dirty = true;
    this.app.toast('Editing your own copy — SAVE keeps it in My Songs');
    this.persist();
    this.renderListSoon();
    this.renderBarSlot();
    return true;
  }
  changed() {
    this.saveT = 0.4;
    this.pendingSurprise = null; // (edited it: it's your work now, kept as a draft)
    if (!this.dirty) { this.dirty = true; this.renderListSoon(); }
    this.bar?.update();
    if (this.playing) this.app.sfx.player?.play(this.song, false);
  }
  /** keep the work in progress as a draft (never touches My Songs — SAVE does that) */
  persist() {
    if (this.isPreset || !(this.dirty || this.fresh)) return;
    putDraft('song', this.song.id, this.song, this.fresh);
  }
  save() {
    if (this.isPreset) { this.app.toast('Presets are read-only — edit it to make your own copy'); return; }
    if (!this.dirty && !this.fresh) return;
    const i = this.custom.findIndex((s) => s.id === this.song.id);
    if (i >= 0) this.custom[i] = clone(this.song); else this.custom.unshift(clone(this.song));
    saveCustomSongs(this.custom);
    dropDraft('song', this.song.id);
    this.dirty = false; this.fresh = false; this.saveT = 0;
    this.bar?.update(); this.renderList();
    this.app.toast(`Saved ${this.song.name}`);
  }
  discard() {
    dropDraft('song', this.song.id);
    const saved = this.custom.find((s) => s.id === this.song.id) ?? PRESET_SONGS.find((s) => s.id === this.song.id);
    this.saveT = 0; this.dirty = false; this.fresh = false;
    this.open(saved ?? this.custom[0] ?? PRESET_SONGS[0], false);
    this.app.toast(saved ? 'Changes discarded' : 'Unsaved song thrown away');
  }
  open(s: Song, keep = true) {
    if (keep) this.persist();
    this.song = this.load(s);
    this.pat = 0; this.part = 0;
    if (this.playing) this.app.sfx.playSong(this.song);
    this.render();
  }
  /** start on a song that isn't in My Songs yet (new / surprise / copy / import) */
  openFresh(s: Song) {
    this.persist();
    this.song = s; this.fresh = true; this.dirty = true;
    this.pat = 0; this.part = 0;
    this.persist();
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
    this.el.barSlot = h('span.ms-barslot');
    this.renderBarSlot();
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
      this.el.barSlot,
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
  /** the top bar's SAVE / DISCARD (or, on a preset, a note that edits make your own copy) */
  renderBarSlot() {
    const slot = this.el.barSlot;
    if (!slot) return;
    slot.innerHTML = '';
    if (this.isPreset) { this.bar = null; slot.append(h('span.draft-status.ms-preset', { title: 'Presets are read-only: any edit starts your own copy' }, '★ Preset — edits make your copy')); return; }
    this.bar = draftBar(this.app, { what: 'song', state: () => ({ dirty: this.dirty, fresh: this.fresh }), onSave: () => this.save(), onDiscard: () => this.discard() });
    slot.append(this.bar.el);
  }
  renderList() {
    const L = this.el.left;
    L.innerHTML = '';
    // (songs with unsaved edits are marked; brand-new unsaved ones sit at the top of My Songs until saved or thrown away)
    const drafts = new Map(draftsOf<Song>('song').map((x) => [x.id, x.d]));
    if (this.dirty || this.fresh) drafts.set(this.song.id, { work: this.song, fresh: this.fresh, t: Date.now() });
    const item = (s: Song) => {
      const d = drafts.get(s.id), cur = s.id === this.song.id ? this.song : d ? d.work : s;
      return h('div.ms-item.nav' + (s.id === this.song.id ? '.on' : '') + (d ? '.draft' : ''), { onclick: () => { if (s.id !== this.song.id) this.open(s); } },
        h('b', null, (d ? '● ' : '') + cur.name), h('span', null, d?.fresh ? 'new · not saved yet' : `${d ? 'unsaved changes · ' : ''}${s.custom ? '' : '★ '}${SCALES[cur.scale]?.mood ?? ''} · ${cur.bpm}`));
    };
    const freshOnes = [...drafts].filter(([id, d]) => d.fresh && !this.custom.some((c) => c.id === id)).sort((a, b) => b[1].t - a[1].t).map(([id, d]) => ({ ...sanitizeSong(d.work), id, custom: true }));
    const mine = [...freshOnes, ...this.custom];
    const isMenu = musicPrefs.menu === this.song.id;
    // actions stay pinned at the top; only the song lists scroll (a long library never hides them)
    L.append(
      h('div.ms-actions', null,
        h('button.btn.small.nav', { onclick: () => { const s = newSong(); s.patterns[0][4] = 'x...x...x...x...'; s.patterns[0][6] = '..x...x...x...x.'; this.openFresh(s); } }, '+ New'),
        h('button.btn.small.nav', { onclick: () => this.openFresh({ ...clone(this.song), id: newSong().id, name: this.song.name + ' copy', custom: true }) }, 'Duplicate'),
        h('button.btn.small.nav.ms-wide.ms-gen', { onclick: () => this.surprise(), title: 'Generate a brand-new song (press again for another — an untouched one is replaced)' }, icon('dice'), ' Generate Song'),
        h('button.btn.small.nav', { onclick: () => this.exportSong(), title: 'Download the song as a file' }, 'Export'),
        h('button.btn.small.nav.ms-gen', { onclick: () => shareSong(this.app, this.song), title: 'A link with the whole song in it — anyone who opens it can play it and save it' }, icon('link'), ' Share'),
        h('button.btn.small.nav', { onclick: () => this.importSong() }, 'Import'),
        this.isPreset || this.fresh ? null : h('button.btn.small.nav.ms-danger', { onclick: () => this.deleteSong() }, 'Delete'),
        h('button.btn.small.nav.ms-wide' + (isMenu ? '.on' : ''), { onclick: () => { if (this.fresh) { this.app.toast('Save the song first'); return; } musicPrefs.menu = isMenu ? 'neon-drive' : this.song.id; saveMusicPrefs(); this.renderList(); this.app.toast(isMenu ? 'Menu music back to Neon Drive' : `${this.song.name} is now the menu music`); } }, isMenu ? '♪ Menu music ✓' : '♪ Use as menu music'),
      ),
      h('div.ms-scroll', null,
        h('h3', null, `MY SONGS (${this.custom.length})`),
        h('div.ms-list', null, ...(mine.length ? mine.map(item) : [h('div.ms-muted', null, 'Nothing yet — start from a preset or a new song.')])),
        h('h3', null, 'PRESETS'),
        h('div.ms-list', null, ...PRESET_SONGS.map(item)),
        h('div.ms-muted', null, 'Pick a song for a track or course in Track Studio / Course Builder. Settings chooses menu & match music.'),
      ),
    );
    // show the selected song: scroll just its list panel (scrollIntoView would scroll the whole studio page too)
    const on = L.querySelector<HTMLElement>('.ms-item.on'), box = on?.closest<HTMLElement>('.ms-scroll');
    if (on && box) { const r = on.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.top < b.top) box.scrollTop -= b.top - r.top; else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom; }
  }

  renderMain() {
    const s = this.song, M = this.el.main;
    M.innerHTML = '';
    // patterns
    this.patChips = s.patterns.map((_, i) => h('button.ms-chip.nav' + (i === this.pat ? '.on' : ''), { onclick: () => { this.pat = i; if (this.app.sfx.player && this.loopPattern) this.app.sfx.player.solo = i; this.renderMain(); } }, PLETTER[i]));
    const pats = h('div.ms-row', null, h('span.ms-lbl', null, 'PATTERN'),
      ...this.patChips,
      s.patterns.length < 4 ? h('button.ms-chip.nav', { title: 'New pattern (a copy of this one)', onclick: () => { this.editable(); this.song.patterns.push(clone(this.song.patterns[this.pat])); this.pat = this.song.patterns.length - 1; this.changed(); this.renderMain(); } }, '+') : null,
      h('button.ms-chip.nav', { title: 'Clear this pattern', onclick: () => { if (!confirmTwice(this.app, 'ms-clear', 'Press again to clear this pattern')) return; this.editable(); this.song.patterns[this.pat] = emptyPattern(); this.changed(); this.renderMain(); } }, 'Clear'),
    );
    // arrangement
    const cur = s.arrange[this.part] ?? s.arrange[0];
    this.partBtns = s.arrange.map((a, i) => h('button.ms-part.nav' + (i === this.part ? '.on' : ''), { onclick: () => { this.part = i; this.pat = a.p; this.renderMain(); } }, h('b', null, PLETTER[a.p]), h('span', null, SHIFT(a.t))));
    this.lastPlay = ''; // (fresh buttons: mark what's playing again)
    const arr = h('div.ms-row', null, h('span.ms-lbl', null, 'SONG'),
      ...this.partBtns,
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
  /** the surprise song on screen, while it's still untouched and unsaved: 🎲 again replaces it instead of piling up */
  private pendingSurprise: string | null = null;
  surprise() {
    if (this.fresh && this.pendingSurprise === this.song.id) { dropDraft('song', this.song.id); this.dirty = false; this.fresh = false; }
    this.openFresh(surpriseSong());
    this.pendingSurprise = this.song.id;
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
        this.openFresh(s);
      } catch (e) { this.app.toast(`Couldn't import: ${(e as Error).message}`); }
    };
    inp.click();
  }
  deleteSong() {
    if (!confirmTwice(this.app, 'ms-del-' + this.song.id, `Press again to delete ${this.song.name}`)) return;
    this.custom = this.custom.filter((s) => s.id !== this.song.id);
    saveCustomSongs(this.custom);
    dropDraft('song', this.song.id);
    this.dirty = false; this.fresh = false;
    this.open(this.custom[0] ?? PRESET_SONGS[0], false);
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
    // song mode: light the pattern and the song part that are playing
    const playing = pos && !this.loopPattern ? `${pos.part}:${pos.p}` : '-';
    if (playing !== this.lastPlay) {
      this.lastPlay = playing;
      this.patChips.forEach((c, i) => c.classList.toggle('play', !!pos && !this.loopPattern && pos.p === i));
      this.partBtns.forEach((c, i) => c.classList.toggle('play', !!pos && !this.loopPattern && pos.part === i));
    }
  }

  dispose() {
    this.persist(); // (unsaved work stays as a draft: it's here next time)
    removeEventListener('keydown', this.onKey);
    this.root.remove();
    this.app.sfx.useMusic('menu');
  }
}

let studio: MusicStudio | null = null;
export const musicStudioScreen: Screen = {
  mount(app: App) { studio = new MusicStudio(app); if (sharedForStudio.song) { studio.openFresh(sharedForStudio.song); sharedForStudio.song = null; } if (import.meta.env.DEV) (window as unknown as { __ms?: MusicStudio }).__ms = studio; },
  unmount() { studio?.dispose(); studio = null; },
  update(dt: number) { studio?.update(dt); },
};
