// Track Studio: draw and shape tracks on a top-down MAP. The track is a smooth curve through points:
//   • drag a point to move it (only the curve next to it changes)   • click the road to select that stretch
//   • double-click the road to add a point   • Delete removes the selected point   • drag empty space to pan
// The HEIGHT strip along the bottom shows the track's elevation; drag a point's handle up/down.
// The panel on the right edits exactly what's selected (a point, or a stretch between two points), plus whole-track
// tools (loop, scale, rotate, reverse). Obstacles live on stretches, so they move with the road when you reshape it.
// The 3D VIEW tab builds the full arena (only then — editing never waits on 3D).
import * as THREE from 'three';
import { confirmTwice, h, MenuNav, type App, type Screen } from './app';
import { buildRibbon, getRenderer } from '../game/render';
import { BUILTIN_ARENAS, COASTER, THEMES, loadTrackCourses, saveTrackCourses } from '../game/terrain';
import { MODES } from '../game/types';
import { testRide } from './testRide';
import { allSongs, songById } from '../game/music';
import { compileNodeCourse, jumpSpeed, nodeTrackDef, segToNodes, trackToNodes, spanRanges, type NodeCourse, type SegAttach, type SegAttachKind, type Span } from '../game/segments';
import { sampleTrack, type TrackSamples } from '../game/track';
import { icon } from './icons';
import './trackStudio.css';

const ATTACH: { kind: SegAttachKind; label: string; adventure?: boolean; color: string; letter: string }[] = [
  { kind: 'arm', label: 'Sweeper', color: '#ffb000', letter: 'S' }, { kind: 'saw', label: 'Saw', color: '#ff2a2a', letter: '✱' },
  { kind: 'bumper', label: 'Bumper', color: '#ff3db4', letter: 'B' }, { kind: 'pillar', label: 'Pillar', color: '#a0a0c0', letter: 'P' },
  { kind: 'gem', label: 'Gem', color: '#ff5cf4', letter: '◆' }, { kind: 'item', label: 'Item box', color: '#b46bff', letter: '?' },
  { kind: 'spinpad', label: 'Spin pad', color: '#38ffb0', letter: '@' }, { kind: 'boost', label: 'Boost pad', color: '#ffe23a', letter: '»' },
  { kind: 'checkpoint', label: 'Checkpoint', adventure: true, color: '#38ffb0', letter: '|' }, { kind: 'hive', label: 'Drone hive', adventure: true, color: '#ff2244', letter: 'H' },
];
const A = Object.fromEntries(ATTACH.map((a) => [a.kind, a])) as Record<SegAttachKind, (typeof ATTACH)[number]>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const newId = () => 'ts-' + Math.random().toString(36).slice(2, 9);

function starter(closed: boolean): NodeCourse {
  if (closed) {
    // a rounded rectangle loop
    const pts: [number, number][] = [[0, 0], [60, 0], [100, -20], [110, -60], [90, -100], [40, -110], [-10, -95], [-30, -55], [-25, -20]];
    return { id: newId(), name: 'My Race Track', desc: 'A custom race track.', theme: THEMES.neon, width: 11, closed: true, nodes: pts.map(([x, z]) => ({ x, z, y: 4 })), spans: pts.map((_, i) => (i === 0 ? { boost: true } : i === 4 ? { items: true } : {})) };
  }
  const pts: [number, number, number][] = [[0, 0, 4], [40, 0, 4], [80, -10, 8], [115, -30, 10], [140, -60, 7], [150, -100, 7], [175, -130, 9]];
  return { id: newId(), name: 'My Adventure', desc: 'A custom track adventure.', theme: THEMES.neon, width: 11, closed: false,
    nodes: pts.map(([x, z, y]) => ({ x, z, y })),
    spans: [{ rails: true }, { boost: true }, { gap: 8, lip: 1.6, boost: true }, { rails: true, att: [{ at: 0.4, kind: 'checkpoint' }] }, { att: [{ at: 0.5, kind: 'gem' }] }, {}] };
}

type Sel = { kind: 'none' } | { kind: 'node'; i: number } | { kind: 'span'; i: number };

class TrackStudio {
  app: App;
  root!: HTMLElement;
  nav!: MenuNav;
  el: Record<string, HTMLElement> = {};
  map!: HTMLCanvasElement;
  prof!: HTMLCanvasElement;
  courses: NodeCourse[] = [];
  cur!: NodeCourse;
  sel: Sel = { kind: 'none' };
  undoStack: string[] = [];
  view: 'map' | '3d' = 'map';
  // map camera
  cx = 0; cz = 0; scale = 2.5;
  // derived (cheap, recomputed on every edit)
  S!: TrackSamples;
  ranges: ReturnType<typeof spanRanges> = [];
  issues: string[] = [];
  /** where the problems are, for markers on the map / in 3D */
  spots: { d: number; msg: string }[] = [];
  compiled: ReturnType<typeof compileNodeCourse> | null = null;
  // pointer state
  drag: { mode: 'node' | 'pan' | 'height' | 'draw'; i?: number; x: number; y: number; moved: boolean } | null = null;
  drawPts: [number, number][] = [];
  drawing = false;
  hover = -1;
  saveT = 0;
  /** an untouched copy (a game track, or the starting Rollercoaster copy): not saved into My Tracks until edited */
  pristine = false;
  // 3D view
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
  renderer: THREE.WebGLRenderer;
  arenaMesh: THREE.Group | null = null;
  view3dKey = '';
  yaw = 0.7; pitch = 0.75; dist = 220; target = new THREE.Vector3();
  orbit: { x: number; y: number; pan: boolean } | null = null;

  constructor(app: App) {
    this.app = app;
    this.renderer = getRenderer(app.canvas).renderer;
    this.scene.environment = getRenderer(app.canvas).env;
    this.scene.environmentIntensity = 0.6;
    this.scene.background = new THREE.Color('#05060c');
    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#20140a', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 2.0);
    sun.position.set(80, 160, 60);
    this.scene.add(sun);
    this.courses = loadTrackCourses();
    // back from a test ride: reopen the track you were riding
    const back = testRide.from === 'tracks' ? this.courses.find((c) => c.id === testRide.id) : undefined;
    testRide.from = null;
    this.cur = back ? clone(back) : this.courses[0] ? clone(this.courses[0]) : this.fromCoaster();
    this.pristine = !back && !this.courses[0];
    this.root = this.build();
    app.root.append(this.root);
    this.nav = new MenuNav(app, this.el.panel, () => this.escape());
    addEventListener('keydown', this.onKey);
    (this.el.name as HTMLInputElement).value = this.cur.name;
    this.recompute();
    this.fit();
    this.renderPanel();
    this.renderList();
    this.resize();
  }

  fromCoaster(): NodeCourse { const n = segToNodes(COASTER); n.id = newId(); n.name = 'Rollercoaster (copy)'; return n; }
  /** every built-in race track (and Rollercoaster Run), as an editable copy */
  builtins(): { name: string; make: () => NodeCourse }[] {
    const race = (MODES.find((m) => m.id === 'race')?.arenas ?? []).map((id) => BUILTIN_ARENAS.find((a) => a.id === id)).filter((a) => a?.track);
    return [
      ...race.map((a) => ({ name: a!.name, make: () => { const n = trackToNodes(a!); n.id = newId(); n.name = `${a!.name} (copy)`; return n; } })),
      { name: COASTER.name, make: () => this.fromCoaster() },
    ];
  }

  // ------------------------------------------------------------------ layout
  build() {
    const name = h<HTMLInputElement>('input.ts-name', { type: 'text', maxLength: 32, title: 'Track name' });
    name.addEventListener('change', () => { this.cur.name = name.value.trim() || 'Untitled'; this.changed(false); this.renderList(); });
    this.el.name = name;
    const tab = (v: 'map' | '3d', label: string) => h('button.ts-tab.nav', { onclick: () => this.setView(v), 'data-v': v }, label);
    this.el.tabs = h('div.ts-tabs', null, tab('map', 'MAP · EDIT'), tab('3d', '3D VIEW'));
    this.el.stats = h('div.ts-stats');
    const top = h('div.ts-top', null,
      h('button.btn.small.nav', { onclick: () => this.back(), 'data-k': 'ESC', 'data-p': 'B', 'data-ps': '○' }, '◀ Back'),
      h('div.ts-title', null, 'TRACK STUDIO'), name, this.el.tabs, this.el.stats, h('div.spacer'),
      h('button.btn.small.nav.ts-drawbtn', { onclick: () => this.toggleDraw(), title: 'Sketch a new path; it becomes points you can then shape' }, icon('ramp'), ' Draw new path'),
      h('button.btn.primary.nav', { onclick: () => this.testRide(), 'data-p': 'START', 'data-ps': 'OPTIONS' }, '▶ TEST RIDE'));

    this.el.list = h('div.ts-list');
    // the game's own tracks: open an editable copy of any of them
    const builtin = h('div.ts-list.ts-builtin', null, ...this.builtins().map((b) => h('div.ts-item.nav', { title: `Open an editable copy of ${b.name}`, onclick: () => { this.persist(); this.open(b.make()); this.pristine = true; this.saveT = 0; } }, h('b', null, b.name), h('span', null, 'copy ›'))));
    const left = h('div.ts-panel.ts-left', null,
      h('h3', null, 'MY TRACKS'), this.el.list,
      h('h3', null, 'GAME TRACKS'), builtin,
      h('div.ts-btns', null,
        h('button.btn.small.nav', { onclick: () => this.open(starter(true)) }, '+ New race track'),
        h('button.btn.small.nav', { onclick: () => this.open(starter(false)) }, '+ New adventure'),
        h('button.btn.small.nav', { onclick: () => this.open({ ...clone(this.cur), id: newId(), name: this.cur.name + ' copy' }) }, 'Duplicate'),
        h('button.btn.small.nav', { onclick: () => this.exportJson() }, 'Export'),
        h('button.btn.small.nav', { onclick: () => this.importJson() }, 'Import'),
        h('button.btn.small.nav.ts-danger', { onclick: () => this.deleteCourse() }, 'Delete')));

    // centre: the map (2D canvas) + height strip; the 3D view renders on the main canvas behind
    this.map = h<HTMLCanvasElement>('canvas.ts-map');
    this.prof = h<HTMLCanvasElement>('canvas.ts-prof');
    this.el.help = h('div.ts-help');
    const stage = h('div.ts-stage', null, this.map, this.el.help);
    this.el.stage = stage;
    this.bindMap();
    this.bindProfile();
    this.bind3d(stage);
    const profWrap = h('div.ts-profwrap', null, h('div.ts-proflbl', null, 'HEIGHT — drag a point up or down'), this.prof);
    this.el.profWrap = profWrap;

    this.el.panel = h('div.ts-panel.ts-right');
    return h('div.ts-root', null, top, left, stage, profWrap, this.el.panel);
  }

  // ------------------------------------------------------------------ derived data
  /** centre the view on the k-th reported problem */
  goToSpot(k: number) {
    const msg = this.issues[k] ?? '';
    const m = msg.match(/(\d+)m/);
    const d = m ? +m[1] : this.spots[k]?.d ?? 0;
    const i = Math.max(0, Math.min(this.S.n - 1, Math.round((d / this.S.total) * this.S.n)));
    if (this.view === 'map') { this.cx = this.S.x[i]; this.cz = this.S.z[i]; this.scale = Math.max(this.scale, 3); this.drawMap(); }
    else { this.target.set(this.S.x[i], this.S.y[i], this.S.z[i]); this.dist = Math.min(this.dist, 80); }
  }

  /** cheap derived data for drawing; `light` skips the overlap/steepness checks (used while dragging) */
  recompute(light = false) {
    const def = nodeTrackDef(this.cur);
    this.S = sampleTrack(def);
    this.ranges = spanRanges(this.cur, this.S);
    this.compiled = compileNodeCourse(this.cur, !light);
    if (!light) { this.issues = this.compiled.issues; this.spots = this.compiled.spots ?? []; }
    this.el.stats.textContent = `${Math.round(this.S.total)}m · ${this.rise()}m of height · ${this.cur.nodes.length} points · ${this.cur.closed ? 'race loop' : 'adventure (start → goal)'}`;
    this.drawMap();
    this.drawProfile();
    if (this.view === '3d') this.refresh3d();
  }

  rise() { let lo = Infinity, hi = -Infinity; for (let i = 0; i < this.S.n; i++) { lo = Math.min(lo, this.S.y[i]); hi = Math.max(hi, this.S.y[i]); } return Math.round(hi - lo); }

  changed(geometry = true, snapshot = false) {
    if (snapshot) this.snapshot();
    if (geometry) this.recompute();
    this.saveT = 0.5; this.pristine = false;
  }

  snapshot() { this.undoStack.push(JSON.stringify(this.cur)); if (this.undoStack.length > 60) this.undoStack.shift(); }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.cur = JSON.parse(s); this.sel = { kind: 'none' }; this.recompute(); this.renderPanel(); this.saveT = 0.5; this.pristine = false; }

  // ------------------------------------------------------------------ map view
  w2s(x: number, z: number): [number, number] { const r = this.map; return [r.width / 2 + (x - this.cx) * this.scale, r.height / 2 + (z - this.cz) * this.scale]; }
  s2w(px: number, py: number): [number, number] { const r = this.map; return [(px - r.width / 2) / this.scale + this.cx, (py - r.height / 2) / this.scale + this.cz]; }

  fit() {
    const S = this.S;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < S.n; i += 2) { x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); z0 = Math.min(z0, S.z[i]); z1 = Math.max(z1, S.z[i]); }
    this.cx = (x0 + x1) / 2; this.cz = (z0 + z1) / 2;
    const r = this.map.getBoundingClientRect();
    this.scale = Math.max(0.4, Math.min(8, Math.min((r.width || 800) / (x1 - x0 + 60), (r.height || 500) / (z1 - z0 + 60))));
    this.drawMap();
  }

  spanAtSample(i: number) { for (let k = 0; k < this.ranges.length; k++) if (i >= this.ranges[k].i0 && (i <= this.ranges[k].i1 || k === this.ranges.length - 1)) return k; return 0; }

  /** nearest sample to a screen point, and its distance in pixels */
  pickRoad(px: number, py: number) {
    const [wx, wz] = this.s2w(px, py);
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.S.n; i++) { const d = (this.S.x[i] - wx) ** 2 + (this.S.z[i] - wz) ** 2; if (d < bd) { bd = d; best = i; } }
    return { i: best, px: Math.sqrt(bd) * this.scale, onRoad: Math.sqrt(bd) <= this.S.w[best] / 2 + 6 / this.scale };
  }

  pickNode(px: number, py: number) {
    let best = -1, bd = 14;
    this.cur.nodes.forEach((n, i) => { const [sx, sy] = this.w2s(n.x, n.z); const d = Math.hypot(sx - px, sy - py); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  bindMap() {
    const c = this.map;
    const local = (e: PointerEvent | MouseEvent) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)] as [number, number]; };
    c.addEventListener('pointerdown', (e) => {
      if (this.view !== 'map') return;
      const [px, py] = local(e);
      c.setPointerCapture(e.pointerId);
      if (this.drawing) { this.drawPts = [this.s2w(px, py)]; this.drag = { mode: 'draw', x: px, y: py, moved: false }; return; }
      if (e.button === 0) {
        const n = this.pickNode(px, py);
        if (n >= 0) { this.select({ kind: 'node', i: n }); this.snapshot(); this.drag = { mode: 'node', i: n, x: px, y: py, moved: false }; return; }
        const r = this.pickRoad(px, py);
        if (r.onRoad) { this.select({ kind: 'span', i: this.spanAtSample(r.i) }); this.drag = { mode: 'pan', x: px, y: py, moved: false }; return; }
        this.select({ kind: 'none' });
      }
      this.drag = { mode: 'pan', x: px, y: py, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const [px, py] = local(e);
      if (!this.drag) { const n = this.pickNode(px, py); if (n !== this.hover) { this.hover = n; c.style.cursor = n >= 0 ? 'grab' : this.drawing ? 'crosshair' : 'default'; this.drawMap(); } return; }
      const d = this.drag;
      if (Math.hypot(px - d.x, py - d.y) > 3) d.moved = true;
      if (d.mode === 'draw') { const w = this.s2w(px, py); const last = this.drawPts[this.drawPts.length - 1]; if (Math.hypot(w[0] - last[0], w[1] - last[1]) > 2) { this.drawPts.push(w); this.drawMap(); } return; }
      if (d.mode === 'node' && d.i !== undefined) {
        const [wx, wz] = this.s2w(px, py);
        this.cur.nodes[d.i].x = Math.round(wx * 2) / 2; this.cur.nodes[d.i].z = Math.round(wz * 2) / 2;
        this.recompute(true);
        return;
      }
      if (d.mode === 'pan' && d.moved) { this.cx -= (px - d.x) / this.scale; this.cz -= (py - d.y) / this.scale; d.x = px; d.y = py; this.drawMap(); }
    });
    c.addEventListener('pointerup', () => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.mode === 'draw') { this.finishDraw(); return; }
      if (d.mode === 'node') { if (d.moved) this.changed(true); else this.undoStack.pop(); this.renderPanel(); }
    });
    c.addEventListener('dblclick', (e) => {
      if (this.view !== 'map' || this.drawing) return;
      const [px, py] = local(e);
      const r = this.pickRoad(px, py);
      if (r.onRoad && this.pickNode(px, py) < 0) this.insertAt(r.i);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = local(e);
      const before = this.s2w(px, py);
      this.scale = Math.max(0.3, Math.min(12, this.scale * Math.pow(1.15, -Math.sign(e.deltaY))));
      const after = this.s2w(px, py);
      this.cx += before[0] - after[0]; this.cz += before[1] - after[1];
      this.drawMap();
    }, { passive: false });
  }

  drawMap() {
    const c = this.map;
    if (!c || this.view !== 'map') return;
    const r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) { c.width = Math.max(1, Math.round(r.width)); c.height = Math.max(1, Math.round(r.height)); }
    const g = c.getContext('2d')!;
    g.fillStyle = '#05070f';
    g.fillRect(0, 0, c.width, c.height);
    // grid: 10m fine, 50m bold
    const step = this.scale > 2 ? 10 : 50;
    const [wx0, wz0] = this.s2w(0, 0), [wx1, wz1] = this.s2w(c.width, c.height);
    g.lineWidth = 1;
    for (let x = Math.floor(wx0 / step) * step; x <= wx1; x += step) { const [sx] = this.w2s(x, 0); g.strokeStyle = x % 50 === 0 ? 'rgba(60,242,255,0.13)' : 'rgba(60,242,255,0.05)'; g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, c.height); g.stroke(); }
    for (let z = Math.floor(wz0 / step) * step; z <= wz1; z += step) { const [, sy] = this.w2s(0, z); g.strokeStyle = z % 50 === 0 ? 'rgba(60,242,255,0.13)' : 'rgba(60,242,255,0.05)'; g.beginPath(); g.moveTo(0, sy); g.lineTo(c.width, sy); g.stroke(); }
    const S = this.S, def = (this.compiled ?? compileNodeCourse(this.cur, false)).arena;
    const track = def.track!;
    const inR = (f: number, rs: [number, number][]) => rs.some(([a, b]) => f >= a && f <= b);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < S.n; i++) { lo = Math.min(lo, S.y[i]); hi = Math.max(hi, S.y[i]); }
    const theme = this.cur.theme;
    const cLo = new THREE.Color(theme.floor).lerp(new THREE.Color('#ffffff'), 0.15), cHi = new THREE.Color(theme.glow);
    const selSpan = this.sel.kind === 'span' ? this.ranges[this.sel.i] : null;
    // road: quads between consecutive samples, coloured by height; gaps as dark holes
    const last = this.cur.closed ? S.n : S.n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % S.n;
      const f = S.cum[i] / S.total;
      const hw0 = S.w[i] / 2, hw1 = S.w[j] / 2;
      const p = [this.w2s(S.x[i] - S.tz[i] * hw0, S.z[i] + S.tx[i] * hw0), this.w2s(S.x[j] - S.tz[j] * hw1, S.z[j] + S.tx[j] * hw1), this.w2s(S.x[j] + S.tz[j] * hw1, S.z[j] - S.tx[j] * hw1), this.w2s(S.x[i] + S.tz[i] * hw0, S.z[i] - S.tx[i] * hw0)];
      const gap = inR(f, track.gaps);
      const col = cLo.clone().lerp(cHi, hi > lo ? (S.y[i] - lo) / (hi - lo) : 0);
      g.fillStyle = gap ? 'rgba(0,0,0,0.9)' : `#${col.getHexString()}`;
      g.beginPath(); g.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) g.lineTo(q[0], q[1]); g.closePath(); g.fill();
      if (gap) { g.strokeStyle = 'rgba(255,60,80,0.6)'; g.lineWidth = 1; g.stroke(); }
      // rails as bright edges
      if (inR(f, track.rails) && !gap) { g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath(); g.moveTo(p[0][0], p[0][1]); g.lineTo(p[1][0], p[1][1]); g.moveTo(p[2][0], p[2][1]); g.lineTo(p[3][0], p[3][1]); g.stroke(); }
    }
    // selected stretch outline
    if (selSpan) {
      g.strokeStyle = '#ffd23a'; g.lineWidth = 4; g.setLineDash([10, 5]); g.shadowColor = '#ffd23a'; g.shadowBlur = 10;
      for (const side of [1, -1]) {
        g.beginPath();
        for (let i = selSpan.i0; i <= Math.min(S.n - 1, selSpan.i1 || S.n - 1); i++) { const hw = (S.w[i] / 2 + 1.2) * side; const [sx, sy] = this.w2s(S.x[i] - S.tz[i] * hw, S.z[i] + S.tx[i] * hw); if (i === selSpan.i0) g.moveTo(sx, sy); else g.lineTo(sx, sy); }
        g.stroke();
      }
      g.setLineDash([]); g.shadowBlur = 0;
    }
    // direction arrows along the centre line
    g.fillStyle = 'rgba(0,0,0,0.45)';
    for (let i = 20; i < S.n; i += 60) { const [sx, sy] = this.w2s(S.x[i], S.z[i]); const a = Math.atan2(S.tz[i], S.tx[i]); g.save(); g.translate(sx, sy); g.rotate(a); g.beginPath(); g.moveTo(8, 0); g.lineTo(-5, -6); g.lineTo(-2, 0); g.lineTo(-5, 6); g.closePath(); g.fill(); g.restore(); }
    // things on the track
    g.font = '700 11px Rajdhani, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const m of def.markers) {
      const a = A[m.kind as SegAttachKind];
      if (!a || m.kind === 'item') continue;
      const [sx, sy] = this.w2s(m.x, m.z);
      if (m.kind === 'checkpoint') { const yaw = m.rot ?? 0, hw = (m.r ?? 2.2) * this.scale; g.strokeStyle = a.color; g.lineWidth = 3; g.beginPath(); g.moveTo(sx - Math.cos(yaw) * hw, sy + Math.sin(yaw) * hw); g.lineTo(sx + Math.cos(yaw) * hw, sy - Math.sin(yaw) * hw); g.stroke(); continue; }
      g.fillStyle = a.color; g.beginPath(); g.arc(sx, sy, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#05060a'; g.fillText(a.letter, sx, sy + 0.5);
    }
    // problems, marked where they are
    for (const sp of this.spots) {
      const i = Math.max(0, Math.min(S.n - 1, Math.round((sp.d / S.total) * S.n)));
      const [sx, sy] = this.w2s(S.x[i], S.z[i]);
      g.strokeStyle = '#ff3b4a'; g.lineWidth = 3; g.beginPath(); g.arc(sx, sy, 14 + 3 * Math.sin(performance.now() / 200), 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#ff3b4a'; g.beginPath(); g.arc(sx, sy - 22, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = '900 12px Orbitron, sans-serif'; g.fillText('!', sx, sy - 21.5);
      g.font = '700 10px Rajdhani, sans-serif'; g.fillStyle = '#ff8a94'; g.fillText(sp.msg.toUpperCase(), sx, sy + 24);
    }
    g.font = '700 11px Rajdhani, sans-serif';
    // start / goal
    const flag = (i: number, col: string, txt: string) => { const [sx, sy] = this.w2s(S.x[i], S.z[i]); g.fillStyle = col; g.fillRect(sx - 15, sy - 22, 30, 13); g.fillStyle = '#05060a'; g.fillText(txt, sx, sy - 15); };
    flag(Math.min(S.n - 1, 6), '#38ff7a', 'START');
    if (!this.cur.closed) flag(Math.max(0, S.n - 10), '#ffd23a', 'GOAL');
    // points
    this.cur.nodes.forEach((n, i) => {
      const [sx, sy] = this.w2s(n.x, n.z);
      const sel = this.sel.kind === 'node' && this.sel.i === i, hov = this.hover === i;
      g.beginPath(); g.arc(sx, sy, sel ? 10 : hov ? 9 : 7, 0, Math.PI * 2);
      g.fillStyle = sel ? '#ffd23a' : '#0b1020'; g.fill();
      g.lineWidth = 2; g.strokeStyle = sel ? '#ffffff' : '#3cf2ff'; g.stroke();
      g.fillStyle = sel ? '#05060a' : '#e8f0ff'; g.fillText(String(i + 1), sx, sy + 0.5);
    });
    // the open end in race mode: show where the loop will join
    if (this.drawing && this.drawPts.length > 1) {
      g.strokeStyle = '#3cf2ff'; g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); this.drawPts.forEach(([x, z], i) => { const [sx, sy] = this.w2s(x, z); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }); g.stroke();
    }
    if (this.drawing) { g.fillStyle = 'rgba(255,210,58,0.9)'; g.textAlign = 'left'; g.font = '700 14px Orbitron, sans-serif'; g.fillText(this.drawPts.length > 1 ? 'Release to turn this into points' : 'DRAW: drag a path (finish near the start for a loop) · Esc to cancel', 14, 20); }
  }

  // ------------------------------------------------------------------ height strip
  bindProfile() {
    const c = this.prof;
    const local = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)] as [number, number]; };
    c.addEventListener('pointerdown', (e) => {
      const [px] = local(e);
      // nearest point handle by x
      let best = -1, bd = 18;
      this.nodeProfileX().forEach((x, i) => { const d = Math.abs(x - px); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      c.setPointerCapture(e.pointerId);
      this.snapshot();
      this.select({ kind: 'node', i: best });
      this.drag = { mode: 'height', i: best, x: px, y: 0, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag?.mode !== 'height' || this.drag.i === undefined) return;
      const [, py] = local(e);
      const { lo, hi } = this.profRange();
      const y = hi - (py - 10) / (c.height - 20) * (hi - lo);
      this.cur.nodes[this.drag.i].y = Math.max(-10, Math.min(60, Math.round(y * 2) / 2));
      this.drag.moved = true;
      this.recompute(true);
    });
    c.addEventListener('pointerup', () => { if (this.drag?.mode === 'height') { if (!this.drag.moved) this.undoStack.pop(); this.drag = null; this.changed(true); this.renderPanel(); } });
  }

  profRange() { let lo = Infinity, hi = -Infinity; for (const n of this.cur.nodes) { lo = Math.min(lo, n.y); hi = Math.max(hi, n.y); } return { lo: Math.min(lo, 0) - 2, hi: Math.max(hi, lo + 8) + 4 }; }
  nodeProfileX() { const c = this.prof, ni = this.ranges.map((r) => r.i0); if (!this.cur.closed) ni.push(this.S.n - 1); return this.cur.nodes.map((_, i) => 10 + ((this.S.cum[ni[i] ?? 0] ?? 0) / this.S.total) * (c.width - 20)); }

  drawProfile() {
    const c = this.prof;
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) { c.width = Math.max(1, Math.round(r.width)); c.height = Math.max(1, Math.round(r.height)); }
    const g = c.getContext('2d')!;
    g.fillStyle = '#05070f'; g.fillRect(0, 0, c.width, c.height);
    const S = this.S, { lo, hi } = this.profRange();
    const X = (i: number) => 10 + (S.cum[i] / S.total) * (c.width - 20), Y = (y: number) => 10 + (hi - y) / (hi - lo) * (c.height - 20);
    // 2m grid lines
    g.strokeStyle = 'rgba(60,242,255,0.07)'; g.lineWidth = 1;
    for (let y = Math.ceil(lo / 2) * 2; y <= hi; y += 2) { g.beginPath(); g.moveTo(0, Y(y)); g.lineTo(c.width, Y(y)); g.stroke(); }
    // selected stretch band
    if (this.sel.kind === 'span') { const rg = this.ranges[this.sel.i]; g.fillStyle = 'rgba(255,210,58,0.12)'; g.fillRect(X(rg.i0), 0, X(Math.min(S.n - 1, rg.i1 || S.n - 1)) - X(rg.i0), c.height); }
    const gaps = (this.compiled ?? compileNodeCourse(this.cur, false)).arena.track!.gaps;
    g.beginPath(); g.moveTo(X(0), c.height);
    for (let i = 0; i < S.n; i += 2) g.lineTo(X(i), Y(S.y[i]));
    g.lineTo(X(S.n - 1), c.height); g.closePath();
    g.fillStyle = 'rgba(60,242,255,0.18)'; g.fill();
    g.strokeStyle = '#3cf2ff'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < S.n; i += 2) { const p = [X(i), Y(S.y[i])]; if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }
    g.stroke();
    for (const [a, b] of gaps) { g.fillStyle = 'rgba(255,40,60,0.35)'; g.fillRect(10 + a * (c.width - 20), 0, (b - a) * (c.width - 20), c.height); }
    const xs = this.nodeProfileX();
    g.font = '700 10px Rajdhani, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    this.cur.nodes.forEach((n, i) => {
      const sel = this.sel.kind === 'node' && this.sel.i === i;
      g.beginPath(); g.arc(xs[i], Y(n.y), sel ? 8 : 6, 0, Math.PI * 2);
      g.fillStyle = sel ? '#ffd23a' : '#0b1020'; g.fill(); g.strokeStyle = sel ? '#fff' : '#3cf2ff'; g.lineWidth = 2; g.stroke();
      g.fillStyle = sel ? '#05060a' : '#e8f0ff'; g.fillText(String(i + 1), xs[i], Y(n.y) + 0.5);
    });
  }

  // ------------------------------------------------------------------ editing ops
  select(s: Sel) { this.sel = s; this.drawMap(); this.drawProfile(); this.renderPanel(); if (this.view === '3d') this.refresh3d(); }

  insertAt(sample: number) {
    this.snapshot();
    const k = this.spanAtSample(sample);
    const S = this.S, rg = this.ranges[k];
    const frac = Math.max(0.05, Math.min(0.95, (S.cum[sample] - rg.start) / (rg.end - rg.start)));
    const node = { x: Math.round(S.x[sample] * 2) / 2, z: Math.round(S.z[sample] * 2) / 2, y: Math.round(S.y[sample] * 2) / 2, bank: +S.bank[sample].toFixed(2), w: +(S.w[sample]).toFixed(1) };
    if (Math.abs(node.w - this.cur.width) < 0.05) delete (node as { w?: number }).w;
    this.cur.nodes.splice(k + 1, 0, node);
    // split the stretch: rails/items carry over, the jump stays at the end, things keep their place on the road
    const old = this.cur.spans[k] ?? {};
    const a: Span = { rails: old.rails, pipe: old.pipe, boost: old.boost, items: old.items, att: [] }, b: Span = { rails: old.rails, pipe: old.pipe, gap: old.gap, lip: old.lip, att: [] };
    for (const t of old.att ?? []) { if (t.at < frac) a.att!.push({ ...t, at: t.at / frac }); else b.att!.push({ ...t, at: (t.at - frac) / (1 - frac) }); }
    this.cur.spans.splice(k, 1, a, b);
    this.recompute();
    this.select({ kind: 'node', i: k + 1 });
    this.saveT = 0.5; this.pristine = false;
    this.app.sfx.play('tick');
  }

  deleteNode(i: number) {
    const min = this.cur.closed ? 3 : 2;
    if (this.cur.nodes.length <= min) { this.app.toast(`A ${this.cur.closed ? 'loop' : 'track'} needs at least ${min} points`); return; }
    this.snapshot();
    this.cur.nodes.splice(i, 1);
    // merge the two stretches around the point (keep the later one's jump)
    const before = this.cur.spans[i - 1], after = this.cur.spans[i];
    if (before && after) { this.cur.spans.splice(i - 1, 2, { ...before, gap: after.gap, lip: after.lip, att: [...(before.att ?? []).map((t) => ({ ...t, at: t.at * 0.5 })), ...(after.att ?? []).map((t) => ({ ...t, at: 0.5 + t.at * 0.5 }))] }); }
    else this.cur.spans.splice(Math.max(0, i - 1), 1);
    this.fixSpans();
    this.sel = { kind: 'none' };
    this.changed(true);
    this.renderPanel();
  }

  fixSpans() { const n = this.cur.closed ? this.cur.nodes.length : this.cur.nodes.length - 1; while (this.cur.spans.length < n) this.cur.spans.push({}); this.cur.spans.length = n; }

  transform(fn: (x: number, z: number) => [number, number]) {
    this.snapshot();
    let mx = 0, mz = 0; for (const n of this.cur.nodes) { mx += n.x; mz += n.z; } mx /= this.cur.nodes.length; mz /= this.cur.nodes.length;
    for (const n of this.cur.nodes) { const [x, z] = fn(n.x - mx, n.z - mz); n.x = Math.round((x + mx) * 2) / 2; n.z = Math.round((z + mz) * 2) / 2; }
    this.changed(true);
  }

  setClosed(closed: boolean) {
    if (closed === this.cur.closed) return;
    this.snapshot();
    this.cur.closed = closed;
    if (closed) {
      // strip adventure-only things (checkpoints/hives) and make sure the loop isn't absurd
      for (const s of this.cur.spans) s.att = (s.att ?? []).filter((a) => !A[a.kind].adventure);
      const a = this.cur.nodes[0], b = this.cur.nodes[this.cur.nodes.length - 1];
      if (Math.hypot(a.x - b.x, a.z - b.z) < 12) this.cur.nodes.pop(); // last point sits on the start: let the loop join there
    }
    this.fixSpans();
    this.changed(true);
    this.renderPanel();
    this.app.toast(closed ? 'Loop closed: the last point now joins back to the start (race track)' : 'Loop opened: start → goal (adventure)');
  }

  /** bank each point by the curvature there: tighter corners lean more, outside edge up */
  autoTilt() {
    this.snapshot();
    const S = this.S, ni = this.ranges.map((r) => r.i0);
    if (!this.cur.closed) ni.push(S.n - 1);
    this.cur.nodes.forEach((n, k) => {
      const i = ni[k] ?? 0;
      // average curvature around the point; + curvature = turning left → raise the right edge (negative tilt)
      let cv = 0, m = 0;
      for (let d = -12; d <= 12; d++) { const j = this.cur.closed ? (i + d + S.n) % S.n : Math.max(0, Math.min(S.n - 1, i + d)); cv += S.curv[j]; m++; }
      cv /= m;
      const b = Math.max(-0.4, Math.min(0.4, -cv * 9));
      n.bank = Math.abs(b) < 0.04 ? undefined : +b.toFixed(2);
    });
    this.changed(true);
    this.renderPanel();
    this.app.toast('Corners tilted — tweak any point or stretch’s tilt in the panel');
  }

  reverse() {
    this.snapshot();
    this.cur.nodes.reverse();
    const sp = this.cur.spans.slice(0, this.cur.closed ? this.cur.nodes.length : this.cur.nodes.length - 1);
    if (this.cur.closed) { const last = sp.pop()!; sp.reverse(); sp.unshift(last); } else sp.reverse();
    this.cur.spans = sp.map((s) => ({ ...s, att: (s.att ?? []).map((t) => ({ ...t, at: 1 - t.at, lat: -(t.lat ?? 0) })) }));
    this.changed(true);
    this.renderPanel();
  }

  // ------------------------------------------------------------------ the inspector
  renderPanel() {
    const el = this.el.panel;
    const keepScroll = el.scrollTop;
    el.innerHTML = '';
    const c = this.cur;
    const num = (label: string, val: number, min: number, max: number, step: number, set: (v: number) => void, tip = '') => {
      const inp = h<HTMLInputElement>('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(+val.toFixed(2)) });
      inp.addEventListener('change', () => { this.snapshot(); set(+inp.value); this.changed(true); this.drawProfile(); });
      return h('div.ts-field', { title: tip }, h('label', null, label), inp);
    };
    const tog = (label: string, on: boolean, set: (v: boolean) => void, tip = '') => {
      const t = h('div.toggle.panel.nav', { title: tip, onclick: () => { this.snapshot(); set(!on); this.changed(true); this.renderPanel(); } }, h('span.dot'), label);
      t.classList.toggle('on', on);
      return t;
    };
    const s = this.sel;
    // ---- the selection
    if (s.kind === 'none') {
      el.append(h('div.ts-sec', null, h('h3', null, 'NOTHING SELECTED'),
        h('ul.ts-howto', null,
          h('li', null, h('b', null, 'Click a point'), ' to move it, or set its height, tilt and width'),
          h('li', null, h('b', null, 'Click the road'), ' to choose what is on that stretch (jumps, rails, obstacles…)'),
          h('li', null, h('b', null, 'Double-click the road'), ' to add a point there'),
          h('li', null, h('b', null, 'Drag empty space'), ' to pan · wheel to zoom · ', h('b', null, 'Ctrl+Z'), ' undo'))));
    } else if (s.kind === 'node') {
      const n = c.nodes[s.i];
      el.append(h('div.ts-sec.ts-selsec', null,
        h('h3', null, `POINT ${s.i + 1}`), h('div.ts-dim', null, 'Drag it on the map or in 3D to move it (Shift-drag in 3D: up/down). Only the road next to it changes.'),
        h('div.ts-grid', null,
          num('HEIGHT m', n.y, -10, 60, 0.5, (v) => { n.y = v; }, 'Also draggable on the height strip below'),
          num('TILT', n.bank ?? 0, -0.5, 0.5, 0.05, (v) => { n.bank = v; }, 'Leans the road: + raises the left edge, - the right'),
          num('WIDTH m', n.w ?? c.width, 4, 24, 0.5, (v) => { n.w = v; }, 'Road width at this point: narrow it for a squeeze')),
        h('div.ts-row', null,
          h('button.btn.small.nav', { onclick: () => { const k = s.i < c.nodes.length - 1 || c.closed ? s.i : s.i - 1; const rg = this.ranges[k]; if (rg) this.insertAt(Math.round((rg.i0 + (rg.i1 || this.S.n - 1)) / 2)); } }, '+ Add point after'),
          h('button.btn.small.nav.ts-danger', { onclick: () => this.deleteNode(s.i) }, 'Delete point'))));
    } else if (s.kind === 'span') {
      const sp = (c.spans[s.i] ??= {});
      const rg = this.ranges[s.i];
      const to = s.i + 1 < c.nodes.length ? s.i + 2 : 1;
      const need = sp.gap ? jumpSpeed({ len: rg.end - rg.start, gap: sp.gap, lip: sp.lip } as never) : 0;
      const boosted = !!(sp.boost || c.spans[s.i - 1]?.boost);
      const jumpNote = sp.gap ? (need && need <= (boosted ? 16 : 12) ? `✓ needs about ${need.toFixed(1)} m/s${boosted ? ' (boosted)' : ''}` : `⚠ needs about ${need ? need.toFixed(1) : '30+'} m/s — ${boosted ? 'shorten the gap or raise the ramp' : 'turn on a boost pad here or on the stretch before'}`) : 'No jump on this stretch';
      el.append(h('div.ts-sec.ts-selsec', null,
        h('h3', null, `STRETCH ${s.i + 1} → ${to}`), h('div.ts-dim', null, `${Math.round(rg.end - rg.start)}m of road, highlighted on the map`),
        h('div.ts-sub', null, 'JUMP AT THE END OF THIS STRETCH'),
        h('div.ts-grid', null,
          num('GAP LENGTH m', sp.gap ?? 0, 0, 18, 0.5, (v) => { sp.gap = v || undefined; }, '0 = no gap'),
          num('RAMP HEIGHT m', sp.lip ?? 0, 0, 3, 0.1, (v) => { sp.lip = v || undefined; }, 'Launch ramp right before the gap (or a kicker with no gap)')),
        h('div' + (sp.gap ? (jumpNote.startsWith('✓') ? '.ts-ok' : '.ts-bad') : '.ts-dim'), null, jumpNote),
        h('div.ts-sub', null, 'ROAD SHAPE'),
        h('div.ts-seg2', null,
          h('button.ts-segbtn.nav' + (!sp.pipe ? '.on' : ''), { onclick: () => { this.snapshot(); sp.pipe = undefined; this.changed(true); this.renderPanel(); } }, 'FLAT ROAD'),
          h('button.ts-segbtn.nav' + (sp.pipe ? '.on' : ''), { onclick: () => { this.snapshot(); sp.pipe = true; this.changed(true); this.renderPanel(); }, title: 'U-shaped half-pipe: ride up the walls' }, 'HALF-PIPE')),
        h('div.ts-sub', null, 'TILT (+ raises the left edge)'),
        h('div.ts-grid', null,
          num(`AT START (point ${s.i + 1})`, c.nodes[s.i].bank ?? 0, -0.5, 0.5, 0.05, (v) => { c.nodes[s.i].bank = v; }),
          num(`AT END (point ${to})`, c.nodes[(s.i + 1) % c.nodes.length].bank ?? 0, -0.5, 0.5, 0.05, (v) => { c.nodes[(s.i + 1) % c.nodes.length].bank = v; })),
        h('div.ts-sub', null, 'EDGES & EXTRAS'),
        h('div.ts-row', null,
          tog('GUARD RAILS', !!sp.rails, (v) => { sp.rails = v || undefined; }, 'Low walls along both edges'),
          tog('BOOST PAD', !!sp.boost, (v) => { sp.boost = v || undefined; }, 'Speed strip at the start of the stretch'),
          tog('ITEM BOXES', !!sp.items, (v) => { sp.items = v || undefined; }, 'A row of item boxes in the middle'))));
      const list = h('div.ts-attlist');
      (sp.att ?? []).forEach((a, ai) => {
        const along = h<HTMLInputElement>('input', { type: 'range', min: '0', max: '1', step: '0.02', value: String(a.at) });
        along.addEventListener('input', () => { a.at = +along.value; this.recompute(true); });
        along.addEventListener('change', () => this.changed(true));
        const across = h<HTMLInputElement>('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: String(a.lat ?? 0) });
        across.addEventListener('input', () => { a.lat = +across.value; this.recompute(true); });
        across.addEventListener('change', () => this.changed(true));
        list.append(h('div.ts-attrow', null,
          h('span.ts-attname', { style: { color: A[a.kind].color } }, A[a.kind].label),
          h('label', null, 'along', along), h('label', null, 'across', across),
          h('button.ts-x.nav', { title: 'Remove', onclick: () => { this.snapshot(); sp.att!.splice(ai, 1); this.changed(true); this.renderPanel(); } }, icon('close'))));
      });
      el.append(list, h('div.ts-addatt', null, ...ATTACH.filter((k) => !k.adventure || !c.closed).map((k) => h('button.ts-chip.nav', {
        style: { borderColor: k.color },
        onclick: () => { this.snapshot(); (sp.att ??= []).push({ at: 0.5, kind: k.kind, lat: k.kind === 'arm' ? 1 : 0 } as SegAttach); this.changed(true); this.renderPanel(); },
      }, '+ ' + k.label))));
    }
    // ---- the whole track
    const theme = h<HTMLSelectElement>('select', null, ...Object.keys(THEMES).map((k) => h('option', { value: k }, k)));
    theme.value = Object.entries(THEMES).find(([, v]) => JSON.stringify(v) === JSON.stringify(c.theme))?.[0] ?? 'neon';
    theme.addEventListener('change', () => { c.theme = THEMES[theme.value]; this.changed(true); });
    el.append(h('div.ts-sec', null,
      h('h3', null, 'WHOLE TRACK'),
      h('div.ts-seg2', null,
        h('button.ts-segbtn.nav' + (c.closed ? '.on' : ''), { onclick: () => this.setClosed(true), title: 'Closed loop: Grand Prix laps' }, 'RACE LOOP'),
        h('button.ts-segbtn.nav' + (!c.closed ? '.on' : ''), { onclick: () => this.setClosed(false), title: 'Open: start → goal with checkpoints (Blade Quest)' }, 'ADVENTURE')),
      h('div.ts-grid', null, num('ROAD WIDTH m', c.width, 6, 20, 0.5, (v) => { c.width = v; }, 'Default width (points can override it)'), h('div.ts-field', null, h('label', null, 'THEME'), theme)),
      h('div.ts-field', null, h('label', null, 'MUSIC'), h<HTMLSelectElement>('select', {
        onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; c.song = v || undefined; this.pristine = false; this.persist(); if (v) this.app.sfx.playSong(songById(v)); else this.app.sfx.useMusic('menu'); },
      }, h('option', { value: '' }, 'Auto (a fitting preset)'), ...allSongs().map((s) => h('option', { value: s.id, selected: c.song === s.id }, `♪ ${s.name}${s.custom ? '' : ' ★'}`)))),
      h('div.ts-row', null,
        h('button.btn.small.nav', { onclick: () => this.transform((x, z) => [x * 0.9, z * 0.9]), title: 'Shrink the whole track 10%' }, 'Scale −'),
        h('button.btn.small.nav', { onclick: () => this.transform((x, z) => [x * 1.1, z * 1.1]), title: 'Grow the whole track 10%' }, 'Scale +'),
        h('button.btn.small.nav', { onclick: () => this.transform((x, z) => { const a = Math.PI / 12; return [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)]; }), title: 'Rotate 15°' }, 'Rotate ⟳'),
        h('button.btn.small.nav', { onclick: () => this.reverse(), title: 'Drive it the other way' }, 'Reverse'),
        h('button.btn.small.nav', { onclick: () => this.autoTilt(), title: 'Bank every corner by how tight it is (outside edge up)' }, 'Auto-tilt corners'),
        h('button.btn.small.nav', { onclick: () => { this.snapshot(); for (const n of c.nodes) delete n.bank; this.changed(true); this.renderPanel(); } }, 'Clear tilts'),
        h('button.btn.small.nav', { onclick: () => { this.snapshot(); const all = c.spans.every((x) => x.rails); for (const x of c.spans) x.rails = all ? undefined : true; this.changed(true); this.renderPanel(); } }, c.spans.every((x) => x.rails) ? 'Remove all rails' : 'Rails everywhere'),
        h('button.btn.small.nav', { onclick: () => this.fit(), title: 'Fit the track in view' }, 'Fit view')),
      h('div.ts-sub', null, 'CHECKS'),
      ...(this.issues.length ? this.issues.map((i, k) => h('div.ts-bad.ts-issue', { title: 'Show me', onclick: () => this.goToSpot(k) }, '⚠ ' + i, h('span.ts-goto', null, ' → show'))) : [h('div.ts-ok', null, '✓ No overlaps · slopes and bends OK')]),
    ));
    el.scrollTop = keepScroll;
    this.nav?.focus(this.nav.idx);
  }

  // ------------------------------------------------------------------ courses
  renderList() {
    const el = this.el.list;
    el.innerHTML = '';
    const all = [...this.courses];
    if (!all.some((x) => x.id === this.cur.id)) all.unshift(this.cur);
    for (const c of all) el.append(h('div.ts-item.nav' + (c.id === this.cur.id ? '.on' : ''), { onclick: () => { if (c.id !== this.cur.id) { this.persist(); this.open(clone(c)); } } }, h('b', null, c.name), h('span', null, c.closed ? 'Race loop' : 'Adventure')));
  }

  open(c: NodeCourse) { this.pristine = false; this.cur = c; this.sel = { kind: 'none' }; this.undoStack = []; this.framed3d = false; this.recompute(); this.fit(); if (this.view === '3d') this.frame3d(); this.renderPanel(); this.renderList(); (this.el.name as HTMLInputElement).value = c.name; this.saveT = 0.3; }

  persist() {
    if (this.pristine) return;
    const i = this.courses.findIndex((c) => c.id === this.cur.id);
    const copy = clone(this.cur);
    if (i >= 0) this.courses[i] = copy; else this.courses.unshift(copy);
    saveTrackCourses(this.courses);
  }

  deleteCourse() {
    if (!confirmTwice(this.app, 'ts-del-' + this.cur.id, `Press again to delete ${this.cur.name}`)) return;
    this.courses = this.courses.filter((c) => c.id !== this.cur.id);
    saveTrackCourses(this.courses);
    this.open(this.courses[0] ? clone(this.courses[0]) : starter(true));
  }

  exportJson() { navigator.clipboard?.writeText(JSON.stringify(this.cur)); this.app.toast('Track copied to the clipboard'); }

  importJson() {
    const txt = prompt('Paste a Track Studio track');
    if (!txt) return;
    try { const c = JSON.parse(txt) as NodeCourse; if (!Array.isArray(c.nodes) || c.nodes.length < 2) throw new Error('no points'); c.id = newId(); c.theme ??= THEMES.neon; c.spans ??= []; this.open(c); this.fixSpans(); }
    catch (e) { this.app.toast(`Couldn't import: ${(e as Error).message}`); }
  }

  testRide() {
    this.pristine = false; // (riding it saves it: the lobby loads it from My Tracks)
    this.persist();
    if (this.issues.some((x) => x.includes('passes over itself'))) { this.app.toast('Fix the overlap first: a track can’t pass over itself'); return; }
    testRide.from = 'tracks'; testRide.id = this.cur.id;
    this.app.go('lobby', { mode: this.cur.closed ? 'race' : 'quest', arenaId: this.cur.id });
  }

  /** leaving the studio goes to the main menu (not back through a test ride's lobby / match) */
  back() { this.persist(); this.app.go('menu'); }

  /** Esc / B: cancel drawing, then clear the selection, and only then leave the studio */
  escape() {
    if (this.drawing) { this.toggleDraw(); return; }
    if (this.sel.kind !== 'none') { this.select({ kind: 'none' }); return; }
    this.back();
  }

  // ------------------------------------------------------------------ draw a new path
  toggleDraw() {
    this.drawing = !this.drawing;
    this.drawPts = [];
    if (this.drawing) this.setView('map');
    this.root.classList.toggle('ts-drawing', this.drawing);
    this.map.style.cursor = this.drawing ? 'crosshair' : 'default';
    this.drawMap();
  }

  /** sketch → a few clean points (Ramer–Douglas–Peucker), auto-closing into a loop if it ends near the start */
  finishDraw() {
    const raw = this.drawPts;
    if (raw.length < 6) { this.app.toast('Draw a longer path'); return; }
    const rdp = (pts: [number, number][], eps: number): [number, number][] => {
      if (pts.length < 3) return pts;
      const [a, b] = [pts[0], pts[pts.length - 1]];
      let idx = 0, dmax = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const [px, pz] = pts[i];
        const d = Math.abs((b[1] - a[1]) * px - (b[0] - a[0]) * pz + b[0] * a[1] - b[1] * a[0]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (dmax <= eps) return [a, b];
      return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
    };
    let pts = rdp(raw, Math.max(2, 6 / this.scale + 2));
    // keep points at least ~14m apart
    pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 14 || i === pts.length - 1);
    const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 30;
    if (closed) pts.pop();
    this.snapshot();
    this.cur.closed = closed;
    this.cur.nodes = pts.map(([x, z]) => ({ x: Math.round(x * 2) / 2, z: Math.round(z * 2) / 2, y: 4 }));
    this.cur.spans = [];
    this.fixSpans();
    this.drawing = false;
    this.root.classList.remove('ts-drawing');
    this.sel = { kind: 'none' };
    this.changed(true);
    this.renderPanel();
    this.app.toast(`${this.cur.nodes.length} points · ${closed ? 'race loop (you finished near the start)' : 'adventure (start → goal)'} — now set heights and add jumps`);
  }

  onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.kind === 'node') { e.preventDefault(); this.deleteNode(this.sel.i); }

  };

  // ------------------------------------------------------------------ 3D view
  setView(v: 'map' | '3d') {
    this.view = v;
    this.root.classList.toggle('ts-3d', v === '3d');
    this.el.tabs.querySelectorAll('.ts-tab').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.v === v));
    this.el.help.textContent = v === '3d' ? 'Drag a point to move it (Shift-drag: up/down) · click the road to select a stretch · double-click to add a point · drag empty space to orbit · right-drag to pan · wheel to zoom' : '';
    if (v === '3d') { this.refresh3d(); if (!this.framed3d) this.frame3d(); } else this.drawMap();
  }

  // ---- the 3D scene is drawn straight from the track curve (no heightfield build), so it updates instantly
  road = new THREE.Group();
  handles = new THREE.Group();
  things = new THREE.Group();
  framed3d = false;
  ray = new THREE.Raycaster();

  frame3d() {
    const S = this.S;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y = 0;
    for (let i = 0; i < S.n; i += 4) { x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); z0 = Math.min(z0, S.z[i]); z1 = Math.max(z1, S.z[i]); y += S.y[i]; }
    this.target.set((x0 + x1) / 2, y / Math.ceil(S.n / 4), (z0 + z1) / 2);
    this.dist = Math.max(60, Math.hypot(x1 - x0, z1 - z0) * 0.8);
    this.framed3d = true;
  }

  refresh3d() {
    if (!this.road.parent) this.scene.add(this.road, this.handles, this.things);
    for (const grp of [this.road, this.handles, this.things]) for (const o of [...grp.children]) { grp.remove(o); (o as THREE.Mesh).geometry?.dispose?.(); }
    const S = this.S, comp = this.compiled ?? compileNodeCourse(this.cur, false);
    const track = comp.arena.track!;
    const inR = (f: number, rs: [number, number][]) => rs.some(([a, b]) => f >= a && f <= b);
    const theme = this.cur.theme;
    // the road exactly as the game draws it (pipes, ramps, tilt, rails, side walls)
    const ribbon = buildRibbon(track, sampleTrack(track), theme);
    ribbon.name = 'road';
    this.road.add(ribbon);
    // the selected stretch: a glowing band over it
    const sel = this.sel.kind === 'span' ? this.ranges[this.sel.i] : null;
    if (sel) {
      const pts: THREE.Vector3[] = [];
      for (let i = sel.i0; i <= Math.min(S.n - 1, sel.i1 || S.n - 1); i += 2) pts.push(new THREE.Vector3(S.x[i], S.y[i] + 1.2, S.z[i]));
      if (pts.length > 1) this.road.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(4, pts.length), 0.5, 6), new THREE.MeshBasicMaterial({ color: '#ffd23a', toneMapped: false, transparent: true, opacity: 0.9, depthTest: false })));
    }
    void inR;
    // obstacles & things as simple coloured shapes
    for (const m of comp.arena.markers) {
      const a = A[m.kind as SegAttachKind];
      if (!a) continue;
      let k = 0, bd = Infinity;
      for (let i = 0; i < S.n; i += 3) { const d = (S.x[i] - m.x) ** 2 + (S.z[i] - m.z) ** 2; if (d < bd) { bd = d; k = i; } }
      const y = S.y[k];
      const mat = new THREE.MeshBasicMaterial({ color: a.color, toneMapped: false });
      let obj: THREE.Object3D;
      if (m.kind === 'checkpoint') { obj = new THREE.Mesh(new THREE.BoxGeometry((m.r ?? 2.2) * 2, 0.3, 0.3), mat); obj.position.set(m.x, y + 2.4, m.z); obj.rotation.y = m.rot ?? 0; }
      else if (m.kind === 'boost' || m.kind === 'item') { obj = new THREE.Mesh(new THREE.BoxGeometry(1, 0.4, 1), mat); obj.position.set(m.x, y + 0.4, m.z); }
      else { obj = new THREE.Mesh(new THREE.CylinderGeometry(m.kind === 'pillar' ? 0.7 : 0.5, 0.6, m.kind === 'pillar' ? 2.4 : 1.2, 10), mat); obj.position.set(m.x, y + 0.8, m.z); }
      this.things.add(obj);
    }
    // problems: red beacons where they are
    for (const sp of this.spots) {
      const i = Math.max(0, Math.min(S.n - 1, Math.round((sp.d / S.total) * S.n)));
      const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 14, 10, 1, true), new THREE.MeshBasicMaterial({ color: '#ff3b4a', transparent: true, opacity: 0.55, toneMapped: false, side: THREE.DoubleSide }));
      beacon.position.set(S.x[i], S.y[i] + 7, S.z[i]);
      this.things.add(beacon);
    }
    // point handles
    this.cur.nodes.forEach((n, i) => {
      const selN = this.sel.kind === 'node' && this.sel.i === i;
      const hnd = new THREE.Mesh(new THREE.SphereGeometry(selN ? 1.6 : 1.2, 16, 12), new THREE.MeshBasicMaterial({ color: selN ? '#ffd23a' : '#3cf2ff', toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 }));
      hnd.position.set(n.x, n.y + 2.2, n.z);
      hnd.renderOrder = 20;
      hnd.userData.node = i;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.2, 6), new THREE.MeshBasicMaterial({ color: '#3cf2ff', toneMapped: false }));
      stem.position.set(n.x, n.y + 1.1, n.z);
      this.handles.add(hnd, stem);
    });
  }

  /** screen point → ray against handles / road */
  pick3d(e: PointerEvent | MouseEvent) {
    const r = this.app.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hNode = this.ray.intersectObjects(this.handles.children.filter((o) => o.userData.node !== undefined))[0];
    if (hNode) return { node: hNode.object.userData.node as number };
    const hRoad = this.ray.intersectObject(this.road.children[0] ?? new THREE.Object3D())[0];
    if (hRoad) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < this.S.n; i++) { const d = (this.S.x[i] - hRoad.point.x) ** 2 + (this.S.z[i] - hRoad.point.z) ** 2; if (d < bd) { bd = d; best = i; } }
      return { road: best };
    }
    return {};
  }

  drag3d: { node: number; y0: number; sx: number; sy: number; vertical: boolean; moved: boolean } | null = null;

  bind3d(stage: HTMLElement) {
    stage.addEventListener('pointerdown', (e) => {
      if (this.view !== '3d') return;
      stage.setPointerCapture(e.pointerId);
      if (e.button === 0) {
        const p = this.pick3d(e);
        if (p.node !== undefined) { this.select({ kind: 'node', i: p.node }); this.snapshot(); this.drag3d = { node: p.node, y0: this.cur.nodes[p.node].y, sx: e.clientX, sy: e.clientY, vertical: e.shiftKey, moved: false }; return; }
        if (p.road !== undefined) { this.select({ kind: 'span', i: this.spanAtSample(p.road) }); }
      }
      this.orbit = { x: e.clientX, y: e.clientY, pan: e.button !== 0 };
    });
    stage.addEventListener('pointermove', (e) => {
      const d = this.drag3d;
      if (d) {
        d.moved = true;
        const n = this.cur.nodes[d.node];
        if (d.vertical || e.shiftKey) {
          n.y = Math.max(-10, Math.min(60, Math.round((d.y0 - (e.clientY - d.sy) * this.dist * 0.0012) * 2) / 2));
        } else {
          // move on the horizontal plane at the point's height
          const r = this.app.canvas.getBoundingClientRect();
          this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
          const hit = new THREE.Vector3();
          if (this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -n.y), hit)) { n.x = Math.round(hit.x * 2) / 2; n.z = Math.round(hit.z * 2) / 2; }
        }
        this.recompute(true);
        return;
      }
      if (!this.orbit) return;
      const dx = e.clientX - this.orbit.x, dy = e.clientY - this.orbit.y;
      this.orbit.x = e.clientX; this.orbit.y = e.clientY;
      if (this.orbit.pan) {
        const k = this.dist * 0.0015, s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        this.target.x -= (dx * c + dy * s) * k; this.target.z -= (-dx * s + dy * c) * k;
      } else { this.yaw -= dx * 0.006; this.pitch = Math.max(0.12, Math.min(1.5, this.pitch + dy * 0.005)); }
    });
    stage.addEventListener('pointerup', () => {
      if (this.drag3d) { if (this.drag3d.moved) this.changed(true); else this.undoStack.pop(); this.drag3d = null; this.renderPanel(); }
      this.orbit = null;
    });
    stage.addEventListener('dblclick', (e) => { if (this.view !== '3d') return; const p = this.pick3d(e); if (p.road !== undefined && p.node === undefined) this.insertAt(p.road); });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('wheel', (e) => { if (this.view !== '3d') return; e.preventDefault(); this.dist = Math.max(25, Math.min(1500, this.dist * Math.pow(1.12, Math.sign(e.deltaY)))); }, { passive: false });
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.drawMap(); this.drawProfile();
  }

  update(dt: number) {
    this.nav.update(dt);
    if (this.saveT > 0) { this.saveT -= dt; if (this.saveT <= 0) { this.persist(); this.renderList(); } }
    if (this.view === '3d') {
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + sp * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
      this.camera.lookAt(this.target);
      // handles stay a usable size at any zoom
      const k = Math.max(1, this.dist / 90);
      for (const o of this.handles.children) if (o.userData.node !== undefined) o.scale.setScalar(k);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    this.persist();
    removeEventListener('keydown', this.onKey);
    this.root.remove();
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
  }
}

let studio: TrackStudio | null = null;
export const trackStudioScreen: Screen = {
  mount(app: App) { studio = new TrackStudio(app); (window as unknown as { __ts?: TrackStudio }).__ts = studio; },
  unmount() { studio?.dispose(); studio = null; },
  update(dt: number) { studio?.update(dt); },
  resize() { studio?.resize(); },
};
