// Track Studio: build race tracks and track adventures from segments. Left: your courses. Right: the segment chain
// (palette, per-segment sliders, attachments). Centre: live 3D preview with the selected segment highlighted.
// Bottom: checks (overlaps, steepness, loop closure, jump speeds). Draw mode turns a sketched path into segments.
import * as THREE from 'three';
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { buildArenaMesh, getRenderer } from '../game/render';
import { COASTER, THEMES, Terrain, VOID, loadTrackCourses, saveTrackCourses } from '../game/terrain';
import { compileCourse, jumpSpeed, type Seg, type SegAttach, type SegAttachKind, type SegCourse } from '../game/segments';
import { sampleTrack } from '../game/track';
import { icon } from './icons';
import './trackStudio.css';

const PALETTE: { label: string; seg: Seg }[] = [
  { label: 'Straight', seg: { kind: 'straight', len: 30 } },
  { label: 'Curve ◀', seg: { kind: 'curve', len: 40, turn: 60 } },
  { label: 'Curve ▶', seg: { kind: 'curve', len: 40, turn: -60 } },
  { label: 'Hairpin ◀', seg: { kind: 'hairpin', len: 50, turn: 160, rails: true } },
  { label: 'Hairpin ▶', seg: { kind: 'hairpin', len: 50, turn: -160, rails: true } },
  { label: 'Climb', seg: { kind: 'climb', len: 30, climb: 6 } },
  { label: 'Drop', seg: { kind: 'drop', len: 30, climb: -8 } },
  { label: 'Jump', seg: { kind: 'jump', len: 28, lip: 1.6, gap: 9, boost: true } },
  { label: 'Banked ◀', seg: { kind: 'banked', len: 44, turn: 80, bank: 0.35, rails: true } },
  { label: 'Banked ▶', seg: { kind: 'banked', len: 44, turn: -80, bank: -0.35, rails: true } },
  { label: 'Kicker', seg: { kind: 'kicker', len: 24, lip: 1.2 } },
  { label: 'Chicane', seg: { kind: 'chicane', len: 36, turn: 0, att: [{ at: 0.3, kind: 'pillar', lat: -0.4 }, { at: 0.7, kind: 'pillar', lat: 0.4 }] } },
];

const ATTACH: { kind: SegAttachKind; label: string; adventure?: boolean }[] = [
  { kind: 'arm', label: 'Sweeper' }, { kind: 'saw', label: 'Saw' }, { kind: 'bumper', label: 'Bumper' }, { kind: 'pillar', label: 'Pillar' },
  { kind: 'gem', label: 'Gem' }, { kind: 'item', label: 'Item Box' }, { kind: 'spinpad', label: 'Spin Pad' }, { kind: 'boost', label: 'Boost Pad' },
  { kind: 'checkpoint', label: 'Checkpoint', adventure: true }, { kind: 'hive', label: 'Drone Hive', adventure: true },
];
const ATT_COLOR: Record<SegAttachKind, string> = { arm: '#ffb000', saw: '#ff2a2a', bumper: '#ff3db4', pillar: '#8a8aa8', gem: '#ff5cf4', item: '#b46bff', spinpad: '#38ffb0', boost: '#ffe23a', checkpoint: '#38ffb0', hive: '#ff2244' };

const segLabel = (s: Seg) => {
  const bits = [s.kind ? s.kind[0].toUpperCase() + s.kind.slice(1) : 'Segment', `${Math.round(s.len)}m`];
  if (s.turn) bits.push(`${s.turn > 0 ? '◀' : '▶'}${Math.abs(Math.round(s.turn))}°`);
  if (s.climb) bits.push(`${s.climb > 0 ? '↑' : '↓'}${Math.abs(s.climb)}m`);
  if (s.gap) bits.push(`gap ${s.gap}m`);
  return bits.join(' · ');
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const newId = () => 'ts-' + Math.random().toString(36).slice(2, 9);

function starter(open: boolean): SegCourse {
  if (open) return { id: newId(), name: 'My Adventure', desc: 'A custom track adventure.', theme: THEMES.neon, width: 11, open: true, segs: [
    { kind: 'straight', len: 30, rails: true }, { kind: 'climb', len: 30, climb: 6, boost: true }, { kind: 'jump', len: 28, lip: 1.6, gap: 9, boost: true },
    { kind: 'curve', len: 40, turn: 70, bank: 0.3, rails: true, att: [{ at: 0.3, kind: 'checkpoint' }, { at: 0.7, kind: 'gem' }] }, { kind: 'straight', len: 30 },
  ] };
  // a closed oval-ish loop: four 90° banked turns joined by straights
  return { id: newId(), name: 'My Track', desc: 'A custom race track.', theme: THEMES.neon, width: 11, open: false, segs: [
    { kind: 'straight', len: 60, boost: true }, { kind: 'banked', len: 50, turn: 90, bank: 0.3, rails: true }, { kind: 'straight', len: 40, items: true },
    { kind: 'banked', len: 50, turn: 90, bank: 0.3, rails: true }, { kind: 'straight', len: 60 }, { kind: 'banked', len: 50, turn: 90, bank: 0.3, rails: true },
    { kind: 'straight', len: 40 }, { kind: 'banked', len: 50, turn: 90, bank: 0.3, rails: true },
  ] };
}

class TrackStudio {
  app: App;
  root!: HTMLElement;
  nav!: MenuNav;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
  renderer: THREE.WebGLRenderer;
  arenaMesh: THREE.Group | null = null;
  overlay = new THREE.Group();
  courses: SegCourse[] = [];
  cur!: SegCourse;
  sel = 0;
  dirty = 0;
  saveT = 0;
  yaw = 0.6; pitch = 0.9; dist = 200; target = new THREE.Vector3();
  drag: { x: number; y: number } | null = null;
  el: Record<string, HTMLElement> = {};
  compiled: ReturnType<typeof compileCourse> | null = null;
  drawing: { pts: [number, number][] } | null = null;
  time = 0;

  constructor(app: App) {
    this.app = app;
    this.renderer = getRenderer(app.canvas).renderer;
    this.scene.environment = getRenderer(app.canvas).env;
    this.scene.environmentIntensity = 0.6;
    this.scene.background = new THREE.Color('#05060c');
    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#20140a', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 2.0);
    sun.position.set(80, 160, 60);
    this.scene.add(sun, this.overlay);
    this.courses = loadTrackCourses();
    this.cur = this.courses[0] ? clone(this.courses[0]) : { ...clone(COASTER), theme: COASTER.theme, id: newId(), name: 'Rollercoaster Copy' };
    this.root = this.build();
    app.root.append(this.root);
    this.nav = new MenuNav(app, this.root, () => this.back());
    this.refreshAll(true);
    this.frame();
    this.resize();
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const stage = h('div.ts-stage');
    stage.addEventListener('pointerdown', (e) => {
      if (this.drawing) { this.drawing.pts = [[e.clientX, e.clientY]]; stage.setPointerCapture(e.pointerId); return; }
      this.drag = { x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (this.drawing && e.buttons & 1) { const last = this.drawing.pts[this.drawing.pts.length - 1]; if (!last || Math.hypot(e.clientX - last[0], e.clientY - last[1]) > 6) this.drawing.pts.push([e.clientX, e.clientY]); this.drawSketch(); return; }
      if (!this.drag) return;
      this.yaw -= (e.clientX - this.drag.x) * 0.006;
      this.pitch = Math.max(0.2, Math.min(1.45, this.pitch + (e.clientY - this.drag.y) * 0.005));
      this.drag = { x: e.clientX, y: e.clientY };
    });
    stage.addEventListener('pointerup', () => { if (this.drawing && this.drawing.pts.length > 4) this.finishDraw(); this.drag = null; });
    stage.addEventListener('wheel', (e) => { e.preventDefault(); this.dist = Math.max(30, Math.min(900, this.dist * Math.pow(1.12, Math.sign(e.deltaY)))); }, { passive: false });
    const sketch = h<HTMLCanvasElement>('canvas.ts-sketch');
    this.el.sketch = sketch;
    stage.append(sketch, h('div.ts-hint', null, 'Drag to orbit · wheel to zoom'));

    const name = h<HTMLInputElement>('input.ts-name', { type: 'text', maxLength: 32 });
    name.addEventListener('change', () => { this.cur.name = name.value.trim() || 'Untitled'; this.changed(false); });
    this.el.name = name;
    const modeBtn = h('button.btn.small.nav', { onclick: () => { this.cur.open = !this.cur.open; this.changed(); }, title: 'Adventure = start → goal (Blade Quest) · Race = closed loop (Grand Prix)' });
    this.el.mode = modeBtn;
    const width = h<HTMLInputElement>('input', { type: 'number', min: '7', max: '18', step: '0.5' });
    width.addEventListener('change', () => { this.cur.width = +width.value; this.changed(); });
    this.el.width = width;
    const theme = h<HTMLSelectElement>('select', null, ...Object.keys(THEMES).map((k) => h('option', { value: k }, k)));
    theme.addEventListener('change', () => { this.cur.theme = THEMES[theme.value]; this.changed(); });
    this.el.theme = theme;
    const stats = h('div.ts-stats');
    this.el.stats = stats;
    const top = h('div.ts-top', null,
      h('button.btn.small.nav', { onclick: () => this.back(), 'data-k': 'ESC', 'data-p': 'B', 'data-ps': '○' }, '◀ Back'),
      h('div.ts-title', null, 'TRACK STUDIO'),
      name, modeBtn,
      h('label.ts-lbl', null, 'WIDTH'), width,
      h('label.ts-lbl', null, 'THEME'), theme,
      stats, h('div.spacer'),
      h('button.btn.small.nav', { onclick: () => this.toggleDraw(), title: 'Sketch a path from above; it becomes a segment chain you can then tune' }, icon('ramp'), ' Draw Path'),
      h('button.btn.small.nav', { onclick: () => this.frame() }, 'Frame'),
      h('button.btn.primary.nav', { onclick: () => this.testRide(), 'data-p': 'START', 'data-ps': 'OPTIONS' }, '▶ TEST RIDE'));

    this.el.list = h('div.ts-list');
    const left = h('div.ts-panel.ts-left', null,
      h('h3', null, 'MY TRACKS'), this.el.list,
      h('div.ts-btns', null,
        h('button.btn.small.nav', { onclick: () => this.newCourse(true) }, '+ Adventure'),
        h('button.btn.small.nav', { onclick: () => this.newCourse(false) }, '+ Race Track'),
        h('button.btn.small.nav', { onclick: () => { this.cur = { ...clone(COASTER), theme: COASTER.theme, id: newId(), name: 'Rollercoaster Copy' }; this.sel = 0; this.changed(); } }, 'Copy Rollercoaster'),
        h('button.btn.small.nav', { onclick: () => { this.cur = { ...clone(this.cur), id: newId(), name: this.cur.name + ' copy' }; this.changed(); } }, 'Duplicate'),
        h('button.btn.small.nav', { onclick: () => this.exportJson() }, 'Export'),
        h('button.btn.small.nav', { onclick: () => this.importJson() }, 'Import'),
        h('button.btn.small.nav.ts-danger', { onclick: () => this.deleteCourse() }, 'Delete')));

    this.el.chain = h('div.ts-chain');
    this.el.palette = h('div.ts-palette', null, ...PALETTE.map((p) => h('button.ts-pal.nav', { onclick: () => this.insert(clone(p.seg)), title: `Add after the selected segment` }, p.label)));
    this.el.segEdit = h('div.ts-segedit');
    const right = h('div.ts-panel.ts-right', null,
      h('h3', null, 'SEGMENTS'), this.el.chain,
      h('div.ts-sub', null, 'ADD AFTER SELECTED'), this.el.palette,
      this.el.segEdit);

    this.el.checks = h('div.ts-checks');
    return h('div.ts-root', null, top, left, stage, right, this.el.checks);
  }

  // ------------------------------------------------------------------ state changes
  changed(rebuild = true) {
    this.saveT = 0.6;
    if (rebuild) this.dirty = 0.25;
    this.refreshAll(false);
  }

  refreshAll(rebuildNow: boolean) {
    const c = this.cur;
    (this.el.name as HTMLInputElement).value = c.name;
    this.el.mode.textContent = c.open ? 'ADVENTURE (start → goal)' : 'RACE (loop)';
    (this.el.width as HTMLInputElement).value = String(c.width);
    const tk = Object.entries(THEMES).find(([, v]) => v === c.theme || JSON.stringify(v) === JSON.stringify(c.theme))?.[0] ?? 'neon';
    (this.el.theme as HTMLSelectElement).value = tk;
    this.renderList();
    this.renderChain();
    this.renderSegEdit();
    if (rebuildNow) this.rebuild();
  }

  renderList() {
    const el = this.el.list;
    el.innerHTML = '';
    const all = [...this.courses];
    if (!all.some((x) => x.id === this.cur.id)) all.unshift(this.cur);
    for (const c of all) {
      el.append(h('div.ts-item.nav' + (c.id === this.cur.id ? '.on' : ''), { onclick: () => { if (c.id === this.cur.id) return; this.cur = clone(c); this.cur.theme = c.theme; this.sel = 0; this.changed(); this.frame(); } },
        h('b', null, c.name), h('span', null, c.open ? 'Adventure' : 'Race')));
    }
  }

  renderChain() {
    const el = this.el.chain;
    el.innerHTML = '';
    this.cur.segs.forEach((s, i) => {
      const row = h('div.ts-seg.nav' + (i === this.sel ? '.on' : ''), { onclick: () => { this.sel = i; this.renderChain(); this.renderSegEdit(); this.highlight(); } },
        h('span.ts-n', null, String(i + 1)), h('span', null, segLabel(s)), (s.att?.length ? h('span.ts-att', null, `+${s.att.length}`) : null));
      el.append(row);
    });
    (el.children[this.sel] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }

  renderSegEdit() {
    const el = this.el.segEdit;
    el.innerHTML = '';
    const s = this.cur.segs[this.sel];
    if (!s) return;
    const num = (label: string, key: keyof Seg, min: number, max: number, step: number, tip = '') => {
      const inp = h<HTMLInputElement>('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String((s[key] as number | undefined) ?? 0) });
      inp.addEventListener('change', () => { (s as unknown as Record<string, number>)[key] = +inp.value; this.changed(); this.renderChain(); });
      return h('div.ts-field', { title: tip }, h('label', null, label), inp);
    };
    const tog = (label: string, key: 'rails' | 'boost' | 'items') => {
      const t = h('div.toggle.panel.nav', { onclick: () => { s[key] = !s[key]; t.classList.toggle('on', !!s[key]); this.changed(); } }, h('span.dot'), label);
      t.classList.toggle('on', !!s[key]);
      return t;
    };
    el.append(
      h('div.ts-sub', null, `SEGMENT ${this.sel + 1}`),
      h('div.ts-grid', null,
        num('LENGTH m', 'len', 6, 160, 2),
        num('TURN °', 'turn', -180, 180, 5, '+ turns left, - turns right'),
        num('CLIMB m', 'climb', -20, 20, 0.5, '+ up, - down'),
        num('TILT', 'bank', -0.5, 0.5, 0.05, 'Sideways tilt reached by the end: + raises the left edge'),
        num('GAP m', 'gap', 0, 18, 0.5, 'No floor at the end: a jump'),
        num('LIP m', 'lip', 0, 3, 0.1, 'Ramp height at the end — launches you (over the gap)')),
      h('div.ts-row', null, tog('RAILS', 'rails'), tog('BOOST', 'boost'), tog('ITEMS', 'items')),
      h('div.ts-row', null,
        h('button.btn.small.nav', { onclick: () => this.move(-1), title: 'Move earlier' }, '▲'),
        h('button.btn.small.nav', { onclick: () => this.move(1), title: 'Move later' }, '▼'),
        h('button.btn.small.nav', { onclick: () => { this.cur.segs.splice(this.sel + 1, 0, clone(s)); this.sel++; this.changed(); } }, 'Duplicate'),
        h('button.btn.small.nav.ts-danger', { onclick: () => { if (this.cur.segs.length <= 1) return; this.cur.segs.splice(this.sel, 1); this.sel = Math.max(0, this.sel - 1); this.changed(); } }, 'Delete')),
      h('div.ts-sub', null, 'ATTACHED'),
    );
    (s.att ?? []).forEach((a, ai) => {
      const kind = h<HTMLSelectElement>('select', null, ...ATTACH.map((k) => h('option', { value: k.kind }, k.label)));
      kind.value = a.kind;
      kind.addEventListener('change', () => { a.kind = kind.value as SegAttachKind; this.changed(); });
      const at = h<HTMLInputElement>('input', { type: 'number', min: '0', max: '1', step: '0.05', value: String(a.at) });
      at.addEventListener('change', () => { a.at = +at.value; this.changed(); });
      const lat = h<HTMLInputElement>('input', { type: 'number', min: '-1', max: '1', step: '0.1', value: String(a.lat ?? 0) });
      lat.addEventListener('change', () => { a.lat = +lat.value; this.changed(); });
      el.append(h('div.ts-attrow', null, kind,
        h('div.ts-field', { title: 'Where along the segment (0 = start, 1 = end)' }, h('label', null, 'ALONG'), at),
        h('div.ts-field', { title: 'Across the road (-1 left edge … 1 right edge)' }, h('label', null, 'ACROSS'), lat),
        h('button.btn.small.nav.ts-danger', { onclick: () => { s.att!.splice(ai, 1); this.changed(); this.renderSegEdit(); this.renderChain(); } }, icon('close'))));
    });
    el.append(h('div.ts-addatt', null, ...ATTACH.filter((k) => !k.adventure || this.cur.open).map((k) => h('button.ts-chip.nav', {
      onclick: () => { (s.att ??= []).push({ at: 0.5, kind: k.kind, lat: k.kind === 'arm' ? 1 : 0 } as SegAttach); this.changed(); this.renderSegEdit(); this.renderChain(); },
    }, '+ ' + k.label))));
  }

  insert(seg: Seg) {
    this.cur.segs.splice(this.sel + 1, 0, seg);
    this.sel = Math.min(this.cur.segs.length - 1, this.sel + 1);
    this.app.sfx.play('tick');
    this.changed();
  }

  move(d: number) {
    const j = this.sel + d;
    if (j < 0 || j >= this.cur.segs.length) return;
    const [s] = this.cur.segs.splice(this.sel, 1);
    this.cur.segs.splice(j, 0, s);
    this.sel = j;
    this.changed();
  }

  newCourse(open: boolean) { this.persist(); this.cur = starter(open); this.sel = 0; this.changed(); this.frame(); }

  deleteCourse() {
    if (!confirmTwice(this.app, 'ts-del-' + this.cur.id, `Press again to delete ${this.cur.name}`)) return;
    this.courses = this.courses.filter((c) => c.id !== this.cur.id);
    saveTrackCourses(this.courses);
    this.cur = this.courses[0] ? clone(this.courses[0]) : starter(true);
    this.sel = 0;
    this.refreshAll(true);
  }

  persist() {
    const i = this.courses.findIndex((c) => c.id === this.cur.id);
    const copy = clone(this.cur);
    if (i >= 0) this.courses[i] = copy; else this.courses.unshift(copy);
    saveTrackCourses(this.courses);
  }

  exportJson() {
    const txt = JSON.stringify(this.cur);
    navigator.clipboard?.writeText(txt);
    this.app.toast('Course copied to clipboard as JSON');
  }

  importJson() {
    const txt = prompt('Paste a Track Studio course (JSON)');
    if (!txt) return;
    try {
      const c = JSON.parse(txt) as SegCourse;
      if (!Array.isArray(c.segs) || !c.segs.length) throw new Error('no segments');
      c.id = newId();
      c.theme ??= THEMES.neon;
      this.cur = c; this.sel = 0; this.changed(); this.frame();
    } catch (e) { this.app.toast(`Couldn't import: ${(e as Error).message}`); }
  }

  testRide() {
    this.persist();
    const c = this.compiled ?? compileCourse(this.cur);
    if (c.issues.some((x) => x.includes('passes over itself'))) { this.app.toast('Fix the overlap first — the track can’t pass over itself'); return; }
    this.app.go('lobby', { mode: this.cur.open ? 'quest' : 'race', arenaId: this.cur.id });
  }

  back() { this.persist(); this.app.back(); }

  // ------------------------------------------------------------------ draw a path
  toggleDraw() {
    this.drawing = this.drawing ? null : { pts: [] };
    this.root.classList.toggle('ts-drawing', !!this.drawing);
    this.drawSketch();
    if (this.drawing) this.app.toast('Draw mode: drag a path on the pad (1px ≈ 1m). Release to turn it into segments.');
  }

  drawSketch() {
    const cv = this.el.sketch as HTMLCanvasElement;
    const r = cv.getBoundingClientRect();
    cv.width = r.width; cv.height = r.height;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    if (!this.drawing) return;
    g.fillStyle = 'rgba(3,6,14,0.82)'; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = 'rgba(60,242,255,0.12)';
    for (let x = 0; x < cv.width; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cv.height); g.stroke(); }
    for (let y = 0; y < cv.height; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(cv.width, y); g.stroke(); }
    const pts = this.drawing.pts;
    if (pts.length > 1) {
      g.strokeStyle = '#3cf2ff'; g.lineWidth = 8; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x - r.left, y - r.top) : g.moveTo(x - r.left, y - r.top))); g.stroke();
    }
    g.fillStyle = '#ffd23a'; g.font = '700 14px Orbitron, sans-serif';
    g.fillText(pts.length > 1 ? 'Release to build segments' : 'Drag to draw the path', 16, 26);
  }

  /** sketch → segments: resample every 10m, turn into a chain, merge near-straight runs */
  finishDraw() {
    const raw = this.drawing!.pts;
    const pts: [number, number][] = [raw[0]];
    let acc = 0;
    for (let i = 1; i < raw.length; i++) {
      const [ax, ay] = raw[i - 1], [bx, by] = raw[i];
      let d = Math.hypot(bx - ax, by - ay), t0 = 0;
      while (acc + d - t0 >= 10) { t0 += 10 - acc; acc = 0; const f = t0 / d; pts.push([ax + (bx - ax) * f, ay + (by - ay) * f]); }
      acc += d - t0;
      void d; d = 0;
    }
    if (pts.length < 3) { this.app.toast('Draw a longer path'); return; }
    const segs: Seg[] = [];
    let prev = Math.atan2(-(pts[1][1] - pts[0][1]), pts[1][0] - pts[0][0]);
    for (let i = 1; i < pts.length; i++) {
      const hd = Math.atan2(-(pts[i][1] - pts[i - 1][1]), pts[i][0] - pts[i - 1][0]);
      let dt = ((hd - prev) * 180) / Math.PI;
      while (dt > 180) dt -= 360; while (dt < -180) dt += 360;
      prev = hd;
      const last = segs[segs.length - 1];
      const straight = Math.abs(dt) < 6;
      if (last && ((straight && last.kind === 'straight') || (!straight && last.kind === 'curve' && Math.sign(dt) === Math.sign(last.turn ?? 0)))) { last.len += 10; if (!straight) last.turn = Math.round((last.turn ?? 0) + dt); }
      else segs.push(straight ? { kind: 'straight', len: 10 } : { kind: 'curve', len: 10, turn: Math.round(dt) });
    }
    this.cur.segs = segs;
    this.sel = 0;
    this.drawing = null;
    this.root.classList.remove('ts-drawing');
    this.drawSketch();
    this.changed();
    this.frame();
    this.app.toast(`Built ${segs.length} segments from your path — now add climbs, jumps and obstacles`);
  }

  // ------------------------------------------------------------------ preview
  rebuild() {
    this.dirty = 0;
    this.compiled = compileCourse(this.cur);
    const ter = new Terrain(this.compiled.arena);
    if (this.arenaMesh) { this.scene.remove(this.arenaMesh); this.arenaMesh.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); }); }
    this.arenaMesh = buildArenaMesh(ter, this.cur.theme);
    this.scene.add(this.arenaMesh);
    this.terrain = ter;
    this.renderChecks();
    this.highlight();
  }
  terrain: Terrain | null = null;

  /** selected segment as a glowing line; attachments as coloured posts */
  highlight() {
    for (const o of [...this.overlay.children]) { this.overlay.remove(o); (o as THREE.Mesh).geometry?.dispose?.(); }
    const comp = this.compiled;
    if (!comp || !this.terrain) return;
    const S = this.terrain.track!;
    let start = 0;
    for (let i = 0; i < this.sel; i++) start += this.cur.segs[i].len;
    const total = this.cur.segs.reduce((a, s) => a + s.len, 0);
    const i0 = Math.floor((start / total) * S.n), i1 = Math.min(S.n - 1, Math.floor(((start + this.cur.segs[this.sel].len) / total) * S.n));
    const gy = (i: number) => { const y = this.terrain!.height(S.x[i], S.z[i]); return (y <= VOID ? S.y[i] : y) + 0.6; };
    const linePts: THREE.Vector3[] = [];
    for (let i = i0; i <= i1; i += 2) linePts.push(new THREE.Vector3(S.x[i], gy(i), S.z[i]));
    if (linePts.length > 1) {
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(linePts), Math.max(4, linePts.length), 0.45, 6), new THREE.MeshBasicMaterial({ color: '#ffd23a', toneMapped: false, depthTest: false, transparent: true, opacity: 0.85 }));
      tube.renderOrder = 10;
      this.overlay.add(tube);
    }
    // start (and goal) flags
    const flag = (i: number, col: string) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6, 8), new THREE.MeshBasicMaterial({ color: col, toneMapped: false })); m.position.set(S.x[i], gy(i) + 3, S.z[i]); this.overlay.add(m); };
    flag(Math.min(S.n - 1, 4), '#38ff7a');
    if (this.cur.open) flag(S.n - 10, '#ffd23a');
    for (const m of comp.arena.markers) {
      const col = ATT_COLOR[m.kind as SegAttachKind];
      if (!col || m.kind === 'boost') continue;
      const post = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.2, 8), new THREE.MeshBasicMaterial({ color: col, toneMapped: false }));
      const y = this.terrain.height(m.x, m.z);
      post.position.set(m.x, (y <= VOID ? 0 : y) + 1.4, m.z);
      post.rotation.x = Math.PI;
      this.overlay.add(post);
    }
  }

  renderChecks() {
    const c = this.compiled!;
    const el = this.el.checks;
    el.innerHTML = '';
    const lines: HTMLElement[] = [];
    for (const i of c.issues) lines.push(h('div.ts-bad', null, '⚠ ', i));
    // jump check: what speed each gap needs
    this.cur.segs.forEach((s, i) => {
      if (!s.gap) return;
      const need = jumpSpeed(s, Math.max(0, -(this.cur.segs[i + 1]?.climb ?? 0)) * 0.3);
      // a blade cruises up to ~12 m/s on its own; a boost on (or just before) the jump carries it to ~16
      const boosted = !!(s.boost || this.cur.segs[i - 1]?.boost);
      const ok = need > 0 && need <= (boosted ? 16 : 12);
      lines.push(h(ok ? 'div.ts-ok' : 'div.ts-bad', null, `${ok ? '✓' : '⚠'} Jump at segment ${i + 1}: ${s.gap}m gap needs ≈${need ? need.toFixed(1) : '30+'} m/s${!boosted && need > 12 ? ' — add a BOOST on or before it' : boosted && need > 16 ? ' — too long even with a boost: shorten the gap or raise the lip' : ''}${!s.lip ? ' — add a LIP to launch' : ''}`));
    });
    if (!c.issues.length) lines.unshift(h('div.ts-ok', null, '✓ No overlaps · slopes OK' + (this.cur.open ? '' : ' · loop closes')));
    const sum = this.cur.segs.reduce((a, s) => a + (s.turn ?? 0), 0);
    if (!this.cur.open) lines.push(h('div.ts-dim', null, `Total turning ${Math.round(sum)}° (a loop needs ±360°)`));
    el.append(...lines);
    this.el.stats.textContent = `${c.length}m · ${c.rise}m of elevation · ${this.cur.segs.length} segments`;
  }

  frame() {
    const S = this.compiled ? new Terrain(this.compiled.arena).track : sampleTrack(compileCourse(this.cur).arena.track!);
    if (!S) return;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y = 0;
    for (let i = 0; i < S.n; i += 4) { x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); z0 = Math.min(z0, S.z[i]); z1 = Math.max(z1, S.z[i]); y += S.y[i]; }
    this.target.set((x0 + x1) / 2, y / Math.ceil(S.n / 4), (z0 + z1) / 2);
    this.dist = Math.max(60, Math.hypot(x1 - x0, z1 - z0) * 0.85);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.drawing) this.drawSketch();
  }

  update(dt: number) {
    this.time += dt;
    this.nav.update(dt);
    if (this.dirty > 0) { this.dirty -= dt; if (this.dirty <= 0) this.rebuild(); }
    if (this.saveT > 0) { this.saveT -= dt; if (this.saveT <= 0) { this.persist(); this.renderList(); } }
    // right stick orbits, triggers zoom (controller)
    const inp = this.app.input;
    for (let p = 0; p < inp.padAxes.length; p++) {
      const a = inp.padAxes[p] ?? [];
      if (Math.abs(a[2] ?? 0) > 0.15) this.yaw -= (a[2] ?? 0) * 1.8 * dt;
      if (Math.abs(a[3] ?? 0) > 0.15) this.pitch = Math.max(0.2, Math.min(1.45, this.pitch - (a[3] ?? 0) * 1.4 * dt));
    }
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + sp * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(this.target);
    this.overlay.children.forEach((o, i) => { if (i === 0) ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.3 * Math.sin(this.time * 5); });
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.persist();
    this.root.remove();
    this.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); });
  }
}

let studio: TrackStudio | null = null;
export const trackStudioScreen: Screen = {
  mount(app: App) { studio = new TrackStudio(app); },
  unmount() { studio?.dispose(); studio = null; },
  update(dt: number) { studio?.update(dt); },
  resize() { studio?.resize(); },
};
