// Course Lab: build skate-park courses by connecting pool pieces on a tile grid, then place hazards/markers.
import * as THREE from 'three';
import './courseDesigner.css';
import { h, MenuNav, type App, type Screen } from './app';
import { getRenderer, buildArenaMesh, buildSky } from '../game/render';
import { hazardPose } from '../game/hazards';
import {
  Terrain, VOID, PIECES, THEMES, BUILTIN_ARENAS, loadCustomArenas, saveCustomArenas, courseHeight, pieceAt,
  type ArenaDef, type Marker, type MarkerKind, type PieceKind, type Piece, type CourseDef,
} from '../game/terrain';

const LEVEL_H = 1.6;
const TEAM_COL = ['#ff3b4a', '#3b8bff'];
const MARKERS: { kind: MarkerKind; label: string; color: string }[] = [
  { kind: 'spawn', label: 'Spawn', color: '#ffffff' },
  { kind: 'item', label: 'Item Box', color: '#b46bff' },
  { kind: 'bumper', label: 'Bumper', color: '#ff3db4' },
  { kind: 'arm', label: 'Sweeper', color: '#ffb000' },
  { kind: 'saw', label: 'Saw Orbit', color: '#ff2a2a' },
  { kind: 'boost', label: 'Boost Pad', color: '#ffe23a' },
  { kind: 'pillar', label: 'Pillar', color: '#8a8aa8' },
  { kind: 'spinpad', label: 'Spin Pad', color: '#38ffb0' },
  { kind: 'flag', label: 'Flag Base', color: '#ff3b4a' },
  { kind: 'zone', label: 'Hill Zone', color: '#ffd23a' },
  { kind: 'gem', label: 'Gem', color: '#ff5cf4' },
];
const MARKER_COLOR = Object.fromEntries(MARKERS.map((m) => [m.kind, m.color])) as Record<MarkerKind, string>;
// "high edge" direction per rot (verified against courseHeight: rot0 +z, rot1 -x, rot2 -z, rot3 +x)
const EDGE_DIR: [number, number][] = [[0, 1], [-1, 0], [0, -1], [1, 0]];
const CORNER_DIR: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
const DIRECTIONAL = new Set<PieceKind>(['quarter', 'half', 'corner', 'kicker', 'spine', 'ramp', 'wall']);
const PIECE_ABBR: Record<PieceKind, string> = { flat: 'F', bowl: 'B', quarter: 'Q', half: 'H', corner: 'C', kicker: 'K', spine: 'S', hump: 'X', ramp: 'R', pit: 'P', wall: 'W', dome: 'D', cradle: 'U' };
const PIECE_COL: Record<PieceKind, string> = { flat: '#39405e', bowl: '#2a6f9e', quarter: '#3d7fcf', half: '#4f63d6', corner: '#3b9ec9', kicker: '#d9a326', spine: '#c95c2a', hump: '#7d58c9', ramp: '#3fae6a', pit: '#111', wall: '#8a8aa8', dome: '#a2468f', cradle: '#26897a' };

type Tool = 'piece' | 'marker';

function pieceIcon(kind: PieceKind, rot = 0, S = 36) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const c: CourseDef = { tile: 6, w: 1, h: 1, pieces: [{ kind, x: 0, y: 0, rot, level: 0 }] };
  const img = ctx.createImageData(S, S);
  for (let py = 0; py < S; py++)
    for (let px = 0; px < S; px++) {
      const x = ((px + 0.5) / S - 0.5) * 6, z = ((py + 0.5) / S - 0.5) * 6;
      const hh = courseHeight(c, x, z);
      const k = (py * S + px) * 4;
      if (hh <= VOID) { img.data[k] = 5; img.data[k + 1] = 6; img.data[k + 2] = 10; }
      else {
        const b = Math.max(0, Math.min(1, 0.25 + hh * 0.33));
        img.data[k] = 40 + b * 20; img.data[k + 1] = 70 + b * 160; img.data[k + 2] = 110 + b * 145;
      }
      img.data[k + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function poolPieces(w: number, hgt: number, walls: boolean): Piece[] {
  const out: Piece[] = [];
  for (let j = 0; j < hgt; j++)
    for (let i = 0; i < w; i++) {
      const L = i === 0, R = i === w - 1, T = j === 0, B = j === hgt - 1;
      const p = (kind: PieceKind, rot = 0): Piece => ({ kind, x: i, y: j, rot, level: 0 });
      if (!walls) { out.push(p('flat')); continue; }
      if (B && R) out.push(p('corner', 0));
      else if (B && L) out.push(p('corner', 1));
      else if (T && L) out.push(p('corner', 2));
      else if (T && R) out.push(p('corner', 3));
      else if (B) out.push(p('quarter', 0));
      else if (L) out.push(p('quarter', 1));
      else if (T) out.push(p('quarter', 2));
      else if (R) out.push(p('quarter', 3));
      else out.push(p('flat'));
    }
  return out;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const mm of list) {
      const anyM = mm as THREE.Material & { map?: THREE.Texture | null; emissiveMap?: THREE.Texture | null };
      anyM.map?.dispose();
      anyM.emissiveMap?.dispose();
      mm.dispose();
    }
  });
}

function themeKey(t: ArenaDef['theme']) {
  for (const [k, v] of Object.entries(THEMES)) if (JSON.stringify(v) === JSON.stringify(t)) return k;
  return '';
}

class CourseEditor {
  app: App;
  root: HTMLDivElement;
  nav: MenuNav;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 800);
  arena: THREE.Group | null = null;
  sky: THREE.Group | null = null;
  markerGroup = new THREE.Group();
  markerObjs: THREE.Group[] = [];
  hoverLine: THREE.Line;
  hoverArrow: THREE.Mesh;
  selRing: THREE.Mesh;
  terrain!: Terrain;
  custom: ArenaDef[] = [];
  def!: ArenaDef;
  tool: Tool = 'piece';
  pieceKind: PieceKind = 'quarter';
  paintRot = 0;
  paintLevel = 0;
  markerKind: MarkerKind = 'item';
  team: number | undefined = undefined;
  hover: { i: number; j: number } | null = null;
  hoverPt: { x: number; z: number } | null = null;
  selected = -1;
  undo: string[] = [];
  yaw = 0; pitch = 0.95; dist = 40;
  target = new THREE.Vector3();
  time = 0;
  rebuildT = -1;
  saveT = -1;
  painting = false;
  dragging = false;
  rightDown: { x: number; y: number; moved: boolean } | null = null;
  midDown: { x: number; y: number } | null = null;
  delArmed = false;
  ray = new THREE.Raycaster();
  // DOM refs
  el: Record<string, HTMLElement> = {};
  mini!: HTMLCanvasElement;
  iconCache = new Map<string, HTMLCanvasElement>();

  constructor(app: App) {
    this.app = app;
    this.renderer = getRenderer(app.canvas).renderer;
    const env = getRenderer(app.canvas).env;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.6;
    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#20140a', 0.8));
    const sun = new THREE.DirectionalLight('#ffffff', 2.0);
    sun.position.set(20, 50, 25);
    this.scene.add(sun);
    this.scene.add(this.markerGroup);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(100 * 3), 3));
    this.hoverLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#3cf2ff', toneMapped: false, depthTest: false, transparent: true }));
    this.hoverLine.renderOrder = 20;
    this.hoverLine.frustumCulled = false;
    const cone = new THREE.ConeGeometry(0.45, 1.2, 12);
    cone.rotateX(Math.PI / 2); // point +z
    this.hoverArrow = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: '#3cf2ff', toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }));
    this.hoverArrow.renderOrder = 21;
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.15, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, depthTest: false, transparent: true, side: THREE.DoubleSide }));
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.renderOrder = 22;
    this.scene.add(this.hoverLine, this.hoverArrow, this.selRing);

    this.custom = loadCustomArenas().filter((a) => a.course);
    this.root = this.buildDom();
    app.root.appendChild(this.root);
    this.nav = new MenuNav(app, this.el.left, () => this.app.back());
    const first = this.custom[0] ?? BUILTIN_ARENAS.find((a) => a.course)!;
    this.select(first);
    this.resize();
  }

  // ------------------------------------------------------------ DOM
  buildDom() {
    const view = h('div.cd-view', {
      onpointerdown: (e: PointerEvent) => this.onDown(e),
      onpointermove: (e: PointerEvent) => this.onMove(e),
      onpointerup: (e: PointerEvent) => this.onUp(e),
      onpointerleave: () => { this.hover = null; this.updateHover(); },
      onwheel: (e: WheelEvent) => this.onWheel(e),
      oncontextmenu: (e: Event) => e.preventDefault(),
    });
    const left = h('div.cd-panel.cd-left');
    const right = h('div.cd-panel.cd-right');
    const hint = h('div.cd-hint');
    this.el = { view, left, right, hint };
    const root = h<HTMLDivElement>('div.cd-root', null, view, left, right, hint);
    this.renderLeft();
    this.renderRight();
    return root;
  }

  renderLeft() {
    const L = this.el.left;
    L.innerHTML = '';
    const lib = h('div.cd-lib');
    const templates = BUILTIN_ARENAS.filter((a) => a.course);
    const item = (a: ArenaDef, tag: string) =>
      h('div.cd-lib-item.nav' + (this.def?.id === a.id ? '.cd-active' : ''), { onclick: () => this.select(a) },
        h('span.cd-lib-name', null, a.name), h('span.cd-tag', null, tag));
    lib.append(h('div.cd-sub', null, 'MY COURSES'));
    if (!this.custom.length) lib.append(h('div.cd-muted', null, 'None yet — edit a template or create a new course.'));
    for (const a of this.custom) lib.append(item(a, `${a.course!.w}×${a.course!.h}`));
    lib.append(h('div.cd-sub', null, 'TEMPLATES'));
    for (const a of templates) lib.append(item(a, 'TEMPLATE'));

    const newBox = h('div.cd-new.cd-hidden');
    const wSel = h<HTMLSelectElement>('select.cd-input', null, ...[2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { value: n, selected: n === 4 }, String(n))));
    const hSel = h<HTMLSelectElement>('select.cd-input', null, ...[2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { value: n, selected: n === 4 }, String(n))));
    const style = h<HTMLSelectElement>('select.cd-input', null, h('option', { value: 'pool' }, 'Walled pool'), h('option', { value: 'flat' }, 'Open flat deck'));
    newBox.append(
      h('div.cd-row', null, h('label', null, 'W'), wSel, h('label', null, 'H'), hSel),
      h('div.cd-row', null, style),
      h('div.cd-row', null,
        h('button.btn.nav', { onclick: () => { this.createNew(+wSel.value, +hSel.value, style.value === 'pool'); newBox.classList.add('cd-hidden'); } }, 'Create'),
        h('button.btn.nav', { onclick: () => newBox.classList.add('cd-hidden') }, 'Cancel')),
    );
    const del = h<HTMLButtonElement>('button.btn.nav.cd-danger', {
      onclick: () => {
        if (!this.def.custom) return this.app.toast('Templates cannot be deleted');
        if (!this.delArmed) { this.delArmed = true; del.textContent = 'Confirm?'; setTimeout(() => { this.delArmed = false; del.textContent = 'Delete'; }, 2500); return; }
        this.delArmed = false;
        this.custom = this.custom.filter((a) => a.id !== this.def.id);
        this.persist();
        this.select(this.custom[0] ?? templates[0]);
      },
    }, 'Delete');
    const fileIn = h<HTMLInputElement>('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onchange: (e: Event) => this.importFile(e) });
    const name = h<HTMLInputElement>('input.cd-input', { value: this.def?.name ?? '', placeholder: 'Course name', oninput: (e: Event) => { if (this.ensureEditable()) { this.def.name = (e.target as HTMLInputElement).value; this.scheduleSave(); } } });
    const desc = h<HTMLTextAreaElement>('textarea.cd-input', { rows: 2, placeholder: 'Description', oninput: (e: Event) => { if (this.ensureEditable()) { this.def.desc = (e.target as HTMLTextAreaElement).value; this.scheduleSave(); } } });
    desc.value = this.def?.desc ?? '';
    const tk = this.def ? themeKey(this.def.theme) : '';
    const theme = h<HTMLSelectElement>('select.cd-input', {
      onchange: (e: Event) => {
        if (!this.ensureEditable()) return;
        this.def.theme = { ...THEMES[(e.target as HTMLSelectElement).value] };
        this.rebuildSky();
        this.rebuildT = 0.01;
        this.scheduleSave();
      },
    }, ...Object.keys(THEMES).map((k) => h('option', { value: k, selected: k === tk }, k[0].toUpperCase() + k.slice(1))));
    L.append(
      h('h2.cd-title', null, 'COURSE LAB'),
      lib,
      h('div.cd-row', null,
        h('button.btn.nav', { onclick: () => newBox.classList.toggle('cd-hidden') }, 'New'),
        h('button.btn.nav', { onclick: () => this.duplicate() }, 'Duplicate'),
        del),
      newBox,
      h('div.cd-sub', null, 'PROPERTIES'),
      name, desc,
      h('div.cd-row', null, h('label', null, 'Theme'), theme),
      h('div.cd-row', null,
        h('button.btn.nav', { onclick: () => this.exportJson() }, 'Export'),
        h('button.btn.nav', { onclick: () => fileIn.click() }, 'Import'),
        fileIn),
      h('div.cd-spacer'),
      h('button.btn.nav.cd-back', { onclick: () => this.app.back() }, '◀ Back'),
    );
  }

  renderRight() {
    const R = this.el.right;
    R.innerHTML = '';
    const tabs = h('div.cd-tabs', null,
      h('button.cd-tab' + (this.tool === 'piece' ? '.cd-on' : ''), { onclick: () => { this.tool = 'piece'; this.selected = -1; this.renderRight(); this.updateHover(); } }, 'PIECES'),
      h('button.cd-tab' + (this.tool === 'marker' ? '.cd-on' : ''), { onclick: () => { this.tool = 'marker'; this.renderRight(); this.updateHover(); } }, 'MARKERS'),
    );
    R.append(h('h2.cd-title', null, 'BUILD'), tabs);
    if (this.tool === 'piece') {
      const pal = h('div.cd-palette');
      for (const k of Object.keys(PIECES) as PieceKind[]) {
        const key = k + ':' + (DIRECTIONAL.has(k) ? this.paintRot : 0);
        let icon = this.iconCache.get(key);
        if (!icon) { icon = pieceIcon(k, DIRECTIONAL.has(k) ? this.paintRot : 0); this.iconCache.set(key, icon); }
        const ic = icon.cloneNode() as HTMLCanvasElement;
        ic.getContext('2d')!.drawImage(icon, 0, 0);
        pal.append(h('button.cd-pal' + (this.pieceKind === k ? '.cd-on' : ''), { title: PIECES[k].desc, onclick: () => { this.pieceKind = k; this.renderRight(); } }, ic, h('span', null, PIECES[k].label)));
      }
      R.append(pal,
        h('div.cd-row', null,
          h('label', null, 'Rotate'),
          h('button.btn', { onclick: () => { this.paintRot = (this.paintRot + 1) % 4; this.renderRight(); this.updateHover(); } }, `⟳ ${this.paintRot * 90}°`),
          h('label', null, 'Level'),
          h('button.btn', { onclick: () => { this.paintLevel = Math.max(0, this.paintLevel - 1); this.renderRight(); } }, '−'),
          h('span.cd-val', null, String(this.paintLevel)),
          h('button.btn', { onclick: () => { this.paintLevel = Math.min(3, this.paintLevel + 1); this.renderRight(); } }, '+')),
        h('div.cd-muted', null, PIECES[this.pieceKind].desc));
    } else {
      const pal = h('div.cd-mpalette');
      for (const m of MARKERS)
        pal.append(h('button.cd-mpal' + (this.markerKind === m.kind ? '.cd-on' : ''), { onclick: () => { this.markerKind = m.kind; this.renderRight(); } },
          h('i', { style: { background: m.color } }), m.label));
      const teamRow = h('div.cd-row', null, h('label', null, 'Team'),
        ...[undefined, 0, 1].map((t) => h('button.btn' + (this.team === t ? '.cd-on' : ''), { onclick: () => { this.team = t; this.renderRight(); } }, t === undefined ? 'Any' : t === 0 ? 'Red' : 'Blue')));
      R.append(pal, teamRow);
      R.append(this.markerProps());
    }
    // grid resize
    R.append(h('div.cd-sub', null, 'GRID ' + (this.def?.course ? `${this.def.course.w}×${this.def.course.h}` : '')),
      h('div.cd-grid-btns', null,
        h('button.btn', { title: 'Add column left', onclick: () => this.resizeGrid(1, 0, 0, 0) }, '+◀'),
        h('button.btn', { title: 'Add column right', onclick: () => this.resizeGrid(0, 1, 0, 0) }, '▶+'),
        h('button.btn', { title: 'Add row top', onclick: () => this.resizeGrid(0, 0, 1, 0) }, '+▲'),
        h('button.btn', { title: 'Add row bottom', onclick: () => this.resizeGrid(0, 0, 0, 1) }, '▼+'),
        h('button.btn', { title: 'Remove column left', onclick: () => this.resizeGrid(-1, 0, 0, 0) }, '−◀'),
        h('button.btn', { title: 'Remove column right', onclick: () => this.resizeGrid(0, -1, 0, 0) }, '▶−'),
        h('button.btn', { title: 'Remove row top', onclick: () => this.resizeGrid(0, 0, -1, 0) }, '−▲'),
        h('button.btn', { title: 'Remove row bottom', onclick: () => this.resizeGrid(0, 0, 0, -1) }, '▼−')));
    this.mini = h<HTMLCanvasElement>('canvas.cd-mini', {
      width: 248, height: 170,
      onpointerdown: (e: PointerEvent) => this.miniClick(e),
      onpointermove: (e: PointerEvent) => { if (e.buttons & 1) this.miniClick(e, true); },
      oncontextmenu: (e: Event) => e.preventDefault(),
    });
    R.append(this.mini);
    R.append(h('div.cd-spacer'),
      h('div.cd-row', null,
        h('button.btn', { onclick: () => this.doUndo() }, '↶ Undo'),
        h('button.btn', { onclick: () => this.save(true) }, 'Save')),
      h('button.btn.cd-go', { onclick: () => this.testRide() }, '▶ TEST RIDE'));
    this.drawMini();
  }

  markerProps() {
    const box = h('div.cd-props');
    const m = this.def?.markers[this.selected];
    if (!m) { box.append(h('div.cd-muted', null, 'Click to place. Click a marker to select & drag it. Right-click removes.')); return box; }
    box.append(h('div.cd-sub', null, `SELECTED: ${MARKERS.find((x) => x.kind === m.kind)?.label ?? m.kind}`));
    const slider = (label: string, key: 'r' | 'len' | 'speed' | 'rot', min: number, max: number, step: number, def: number, deg = false) => {
      const v = m[key] ?? def;
      const out = h('span.cd-val', null, deg ? `${Math.round((v * 180) / Math.PI)}°` : v.toFixed(2));
      const inp = h<HTMLInputElement>('input', {
        type: 'range', min: deg ? 0 : min, max: deg ? 360 : max, step: deg ? 15 : step, value: deg ? (v * 180) / Math.PI : v,
        oninput: (e: Event) => {
          let nv = +(e.target as HTMLInputElement).value;
          out.textContent = deg ? `${nv}°` : nv.toFixed(2);
          if (deg) nv = (nv * Math.PI) / 180;
          this.ensureEditable();
          const mm = this.def.markers[this.selected];
          if (!mm) return;
          mm[key] = nv;
          this.rebuildMarkers();
          this.scheduleSave();
        },
        onpointerdown: () => this.snapshot(),
      });
      box.append(h('div.cd-slider', null, h('label', null, label), inp, out));
    };
    switch (m.kind) {
      case 'arm': slider('Length', 'len', 1.5, 9, 0.1, 4); slider('Speed', 'speed', -3, 3, 0.05, 1); slider('Start', 'rot', 0, 0, 0, 0, true); break;
      case 'saw': slider('Orbit R', 'r', 0, 14, 0.1, 5); slider('Speed', 'speed', -2, 2, 0.05, 0.5); slider('Phase', 'rot', 0, 0, 0, 0, true); break;
      case 'boost': slider('Direction', 'rot', 0, 0, 0, 0, true); break;
      case 'bumper': case 'pillar': slider('Radius', 'r', 0.4, 2.2, 0.05, 0.8); break;
      case 'spinpad': slider('Radius', 'r', 0.6, 2.6, 0.05, 1.1); break;
      case 'zone': slider('Radius', 'r', 1.5, 7, 0.1, 2.6); break;
    }
    if (m.kind === 'spawn' || m.kind === 'flag') {
      const opts = m.kind === 'flag' ? [0, 1] : [undefined, 0, 1];
      box.append(h('div.cd-row', null, h('label', null, 'Team'),
        ...opts.map((t) => h('button.btn' + (m.team === t ? '.cd-on' : ''), {
          onclick: () => { this.snapshot(); const mm = this.def.markers[this.selected]; if (mm) mm.team = t; this.rebuildMarkers(); this.scheduleSave(); this.renderRight(); },
        }, t === undefined ? 'Any' : t === 0 ? 'Red' : 'Blue'))));
    }
    box.append(h('div.cd-row', null,
      h('span.cd-muted', null, `x ${m.x.toFixed(1)}  z ${m.z.toFixed(1)}`),
      h('button.btn.cd-danger', { onclick: () => this.deleteMarker(this.selected) }, 'Delete')));
    return box;
  }

  // ------------------------------------------------------------ course management
  select(a: ArenaDef) {
    this.def = a;
    this.selected = -1;
    this.undo = [];
    const c = a.course!;
    this.dist = Math.max(c.w, c.h) * c.tile * 1.15 + 6;
    this.target.set(0, 0, 0);
    this.yaw = 0; this.pitch = 0.95;
    this.rebuildSky();
    this.rebuildTerrain();
    this.renderLeft();
    this.renderRight();
  }

  ensureEditable(): boolean {
    if (this.def.custom) return true;
    const copy: ArenaDef = JSON.parse(JSON.stringify(this.def));
    copy.id = 'course-' + Date.now().toString(36);
    copy.name = this.def.name + ' Copy';
    copy.custom = true;
    this.custom.push(copy);
    this.def = copy;
    this.persist();
    this.renderLeft();
    this.app.toast('Template copied — editing your own version');
    return true;
  }

  createNew(w: number, hgt: number, walls: boolean) {
    const def: ArenaDef = {
      id: 'course-' + Date.now().toString(36), name: 'My Course ' + (this.custom.length + 1), desc: 'Custom skate course', theme: { ...THEMES.concrete },
      course: { tile: 6, w, h: hgt, pieces: poolPieces(w, hgt, walls) },
      markers: [{ kind: 'item', x: 0, z: 0 }], custom: true,
    };
    this.custom.push(def);
    this.persist();
    this.select(def);
  }

  duplicate() {
    const copy: ArenaDef = JSON.parse(JSON.stringify(this.def));
    copy.id = 'course-' + Date.now().toString(36);
    copy.name = this.def.name + ' Copy';
    copy.custom = true;
    this.custom.push(copy);
    this.persist();
    this.select(copy);
  }

  persist() {
    const others = loadCustomArenas().filter((a) => !a.course);
    saveCustomArenas([...others, ...this.custom]);
  }

  scheduleSave() { if (this.def.custom) this.saveT = 0.6; }

  save(explicit = false) {
    if (!this.def.course?.pieces.length) { this.app.toast('Course needs at least one piece'); return false; }
    if (!this.def.custom) { if (explicit) this.ensureEditable(); else return true; }
    this.persist();
    if (explicit) {
      if (!this.def.markers.some((m) => m.kind === 'spawn')) this.app.toast('Saved — no spawn markers, spawns will be auto-placed');
      else this.app.toast('Course saved');
      this.renderLeft();
    }
    return true;
  }

  testRide() {
    if (!this.save(true)) return;
    this.app.go('lobby', { mode: 'rush', arenaId: this.def.id });
  }

  exportJson() {
    const blob = new Blob([JSON.stringify(this.def, null, 2)], { type: 'application/json' });
    const a = h<HTMLAnchorElement>('a', { href: URL.createObjectURL(blob), download: `${this.def.name.replace(/[^\w-]+/g, '_')}.bitcourse.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text()) as ArenaDef;
      if (!d.course || !Array.isArray(d.course.pieces)) throw new Error('not a course');
      d.id = 'course-' + Date.now().toString(36);
      d.custom = true;
      d.markers ??= [];
      d.theme ??= { ...THEMES.concrete };
      d.name ??= 'Imported Course';
      d.desc ??= '';
      this.custom.push(d);
      this.persist();
      this.select(d);
      this.app.toast('Course imported');
    } catch {
      this.app.toast('Import failed — not a BitBlade course file');
    }
  }

  snapshot() {
    this.ensureEditable();
    this.undo.push(JSON.stringify({ course: this.def.course, markers: this.def.markers }));
    if (this.undo.length > 60) this.undo.shift();
  }

  doUndo() {
    const s = this.undo.pop();
    if (!s) return this.app.toast('Nothing to undo');
    const d = JSON.parse(s);
    this.def.course = d.course;
    this.def.markers = d.markers;
    this.selected = -1;
    this.rebuildTerrain();
    this.renderRight();
    this.scheduleSave();
  }

  // ------------------------------------------------------------ edits
  setPiece(i: number, j: number, kind: PieceKind | null, rot: number, level: number) {
    const c = this.def.course!;
    if (i < 0 || j < 0 || i >= c.w || j >= c.h) return false;
    const cur = pieceAt(c, i, j);
    if (kind === null) {
      if (!cur) return false;
      c.pieces = c.pieces.filter((p) => p !== cur);
    } else {
      if (cur && cur.kind === kind && cur.rot === rot && cur.level === level) return false;
      if (cur) { cur.kind = kind; cur.rot = rot; cur.level = level; }
      else c.pieces.push({ kind, x: i, y: j, rot, level });
    }
    this.rebuildT = 0.12;
    this.scheduleSave();
    this.drawMini();
    return true;
  }

  rotateHovered(dir = 1) {
    const c = this.def.course!;
    const p = this.hover ? pieceAt(c, this.hover.i, this.hover.j) : undefined;
    if (p) {
      this.snapshot();
      const np = pieceAt(this.def.course!, this.hover!.i, this.hover!.j)!; // after possible copy
      np.rot = (np.rot + dir + 4) % 4;
      this.paintRot = np.rot;
      this.rebuildT = 0.12;
      this.scheduleSave();
      this.drawMini();
    } else this.paintRot = (this.paintRot + dir + 4) % 4;
    if (this.tool === 'piece') this.renderRight();
    this.updateHover();
  }

  levelHovered(d: number) {
    if (!this.hover) return;
    const p = pieceAt(this.def.course!, this.hover.i, this.hover.j);
    if (!p) return;
    this.snapshot();
    const np = pieceAt(this.def.course!, this.hover.i, this.hover.j)!;
    np.level = Math.max(0, Math.min(3, np.level + d));
    this.rebuildT = 0.12;
    this.scheduleSave();
    this.drawMini();
  }

  resizeGrid(l: number, r: number, t: number, b: number) {
    this.snapshot();
    const c = this.def.course!;
    const nw = c.w + l + r, nh = c.h + t + b;
    if (nw < 1 || nh < 1 || nw > 10 || nh > 10) return this.app.toast('Grid must be 1–10 tiles per side');
    c.pieces = c.pieces.map((p) => ({ ...p, x: p.x + l, y: p.y + t })).filter((p) => p.x >= 0 && p.y >= 0 && p.x < nw && p.y < nh);
    for (const m of this.def.markers) { m.x += ((l - r) * c.tile) / 2; m.z += ((t - b) * c.tile) / 2; }
    c.w = nw; c.h = nh;
    this.rebuildTerrain();
    this.renderRight();
    this.scheduleSave();
  }

  addMarker(x: number, z: number) {
    this.snapshot();
    const k = this.markerKind;
    const m: Marker = { kind: k, x, z };
    if (k === 'spawn') { if (this.team !== undefined) m.team = this.team; }
    if (k === 'flag') m.team = this.team ?? (this.def.markers.filter((q) => q.kind === 'flag').length % 2);
    if (k === 'arm') { m.len = 4; m.speed = 1; m.rot = 0; }
    if (k === 'saw') { m.r = 4; m.speed = 0.6; m.rot = 0; }
    if (k === 'boost') m.rot = 0;
    if (k === 'bumper' || k === 'pillar') m.r = 0.8;
    if (k === 'spinpad') m.r = 1.1;
    if (k === 'zone') m.r = 2.6;
    this.def.markers.push(m);
    this.selected = this.def.markers.length - 1;
    this.rebuildMarkers();
    this.renderRight();
    this.scheduleSave();
  }

  deleteMarker(i: number) {
    if (i < 0 || !this.def.markers[i]) return;
    this.snapshot();
    this.def.markers.splice(i, 1);
    this.selected = -1;
    this.rebuildMarkers();
    this.renderRight();
    this.scheduleSave();
  }

  markerAt(x: number, z: number) {
    let best = -1, bd = 1.2;
    this.def.markers.forEach((m, i) => {
      const d = Math.hypot(m.x - x, m.z - z);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  // ------------------------------------------------------------ 3D building
  rebuildSky() {
    if (this.sky) { this.scene.remove(this.sky); disposeTree(this.sky); }
    this.sky = buildSky(this.def.theme);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.FogExp2(new THREE.Color(this.def.theme.sky2).getHex(), 0.006);
  }

  rebuildTerrain() {
    this.rebuildT = -1;
    this.terrain = new Terrain(this.def);
    if (this.arena) { this.scene.remove(this.arena); disposeTree(this.arena); }
    this.arena = buildArenaMesh(this.terrain, this.def.theme);
    this.scene.add(this.arena);
    this.rebuildMarkers();
    this.updateHover();
    this.drawMini();
  }

  groundY(x: number, z: number) {
    const y = this.terrain.height(x, z);
    return y <= VOID ? 0 : y;
  }

  makeMarker(m: Marker): THREE.Group {
    const g = new THREE.Group();
    const col = (m.kind === 'spawn' || m.kind === 'flag') && m.team !== undefined ? TEAM_COL[m.team] ?? '#fff' : MARKER_COLOR[m.kind];
    const glowMat = () => new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: 0.85 });
    const solid = () => new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.3 });
    const flatRing = (r0: number, r1: number, op = 0.7) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      return ring;
    };
    switch (m.kind) {
      case 'spawn': {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1, 16), glowMat());
        c.rotation.x = Math.PI; c.position.y = 1.2;
        g.add(c, flatRing(0.6, 0.8));
        break;
      }
      case 'item': {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.75), solid());
        b.position.y = 0.8; b.userData.spin = true;
        g.add(b);
        break;
      }
      case 'bumper': case 'pillar': {
        const r = m.r ?? 0.8, hh = m.kind === 'pillar' ? 2.4 : 0.9;
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, hh, m.kind === 'pillar' ? 8 : 24), solid());
        c.position.y = hh / 2;
        g.add(c);
        break;
      }
      case 'arm': {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.2, 12), new THREE.MeshStandardMaterial({ color: '#333', metalness: 0.8, roughness: 0.3 }));
        post.position.y = 0.6;
        const L = m.len ?? 4;
        const pivot = new THREE.Group();
        const bar = new THREE.Mesh(new THREE.BoxGeometry(L, 0.4, 0.55), solid());
        bar.position.set(L / 2, 0.45, 0);
        pivot.add(bar);
        pivot.userData.arm = true;
        g.add(post, pivot, flatRing(L - 0.05, L + 0.05, 0.25));
        break;
      }
      case 'saw': {
        const R = m.r ?? 5;
        g.add(flatRing(Math.max(0.01, R - 0.06), R + 0.06, 0.45));
        const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.12, 16), new THREE.MeshStandardMaterial({ color: '#d9dde3', metalness: 1, roughness: 0.2, emissive: '#ff1a1a', emissiveIntensity: 0.3 }));
        blade.position.y = 0.35;
        blade.userData.saw = true;
        const hub = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), glowMat());
        hub.position.y = 0.3;
        g.add(blade, hub);
        break;
      }
      case 'boost': {
        const pad = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 2.8), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
        pad.rotation.x = -Math.PI / 2; pad.position.y = 0.05;
        const cone = new THREE.ConeGeometry(0.5, 1.2, 3);
        cone.rotateX(Math.PI / 2);
        const arrow = new THREE.Mesh(cone, glowMat());
        arrow.position.set(0, 0.25, 0.5);
        g.add(pad, arrow);
        g.rotation.y = m.rot ?? 0;
        break;
      }
      case 'spinpad': g.add(flatRing((m.r ?? 1.1) * 0.6, m.r ?? 1.1)); break;
      case 'flag': {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), new THREE.MeshStandardMaterial({ color: '#ccc' }));
        pole.position.y = 0.8;
        const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), glowMat());
        orb.position.y = 1.7;
        g.add(pole, orb, flatRing(1.6, 2.0));
        break;
      }
      case 'zone': {
        const r = m.r ?? 2.6;
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 2.5, 40, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
        cyl.position.y = 1.25;
        g.add(cyl, flatRing(r - 0.08, r));
        break;
      }
      case 'gem': {
        const gm = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42), glowMat());
        gm.position.y = 0.9; gm.userData.spin = true;
        g.add(gm);
        break;
      }
    }
    g.position.set(m.x, this.groundY(m.x, m.z), m.z);
    return g;
  }

  rebuildMarkers() {
    for (const o of this.markerObjs) { this.markerGroup.remove(o); disposeTree(o); }
    this.markerObjs = this.def.markers.map((m) => {
      const o = this.makeMarker(m);
      this.markerGroup.add(o);
      return o;
    });
    this.drawMini();
  }

  updateHover() {
    const c = this.def?.course;
    const show = !!(c && this.hover && this.tool === 'piece');
    this.hoverLine.visible = show;
    this.hoverArrow.visible = false;
    if (!show || !c || !this.hover) { this.updateHint(); return; }
    const { i, j } = this.hover;
    const T = c.tile;
    const x0 = i * T - (c.w * T) / 2, z0 = j * T - (c.h * T) / 2;
    const pos = this.hoverLine.geometry.attributes.position as THREE.BufferAttribute;
    const cur = pieceAt(c, i, j);
    const baseY = (cur?.level ?? this.paintLevel) * LEVEL_H;
    const corners = [[x0, z0], [x0 + T, z0], [x0 + T, z0 + T], [x0, z0 + T]];
    let n = 0, maxY = baseY;
    for (let e = 0; e < 4; e++) {
      const [ax, az] = corners[e], [bx, bz] = corners[(e + 1) % 4];
      for (let k = 0; k < 24; k++) {
        const t = k / 24;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        // sample slightly inside so we read this tile's height
        const sx = x + (x0 + T / 2 - x) * 0.02, sz = z + (z0 + T / 2 - z) * 0.02;
        const hh = this.terrain.height(sx, sz);
        const y = (hh <= VOID ? baseY : hh) + 0.1;
        maxY = Math.max(maxY, y);
        pos.setXYZ(n++, x, y, z);
      }
    }
    pos.setXYZ(n, corners[0][0], pos.getY(0), corners[0][1]);
    n++;
    pos.needsUpdate = true;
    this.hoverLine.geometry.setDrawRange(0, n);
    const kind = cur?.kind ?? this.pieceKind;
    const rot = cur ? cur.rot : this.paintRot;
    (this.hoverLine.material as THREE.LineBasicMaterial).color.set(cur ? '#ffd23a' : '#3cf2ff');
    if (DIRECTIONAL.has(kind)) {
      const [dx, dz] = kind === 'corner' ? CORNER_DIR[rot] : EDGE_DIR[rot];
      const L = Math.hypot(dx, dz);
      this.hoverArrow.visible = true;
      this.hoverArrow.position.set(x0 + T / 2 + (dx / L) * T * 0.2, maxY + 0.8, z0 + T / 2 + (dz / L) * T * 0.2);
      this.hoverArrow.rotation.set(0, Math.atan2(dx, dz), 0);
      (this.hoverArrow.material as THREE.MeshBasicMaterial).color.set(cur ? '#ffd23a' : '#3cf2ff');
    }
    this.updateHint();
  }

  updateHint() {
    const c = this.def?.course;
    let s = '';
    if (this.tool === 'piece') {
      s = 'LMB paint · RMB erase · RMB-drag orbit · MMB pan · Wheel zoom · R / Shift+Wheel rotate · [ ] level · Ctrl+Z undo';
      if (c && this.hover) {
        const p = pieceAt(c, this.hover.i, this.hover.j);
        s = `Cell ${this.hover.i},${this.hover.j}: ${p ? `${PIECES[p.kind].label} · ${p.rot * 90}° · L${p.level}` : 'empty (void)'}   —   ` + s;
      }
    } else {
      s = 'LMB place / select+drag · RMB delete · Del removes selected · RMB-drag orbit · Wheel zoom';
      if (this.hoverPt) s = `x ${this.hoverPt.x.toFixed(1)} z ${this.hoverPt.z.toFixed(1)}   —   ` + s;
    }
    this.el.hint.textContent = s;
  }

  // ------------------------------------------------------------ input
  pick(e: PointerEvent | WheelEvent) {
    const rect = this.app.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const mesh = this.arena?.children[0];
    if (mesh) {
      const hit = this.ray.intersectObject(mesh, false)[0];
      if (hit && hit.point.y > -3) return { x: hit.point.x, z: hit.point.z };
    }
    const p = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.paintLevel * LEVEL_H);
    return this.ray.ray.intersectPlane(plane, p) ? { x: p.x, z: p.z } : null;
  }

  cellOf(x: number, z: number) {
    const c = this.def.course!;
    const i = Math.floor((x + (c.w * c.tile) / 2) / c.tile), j = Math.floor((z + (c.h * c.tile) / 2) / c.tile);
    if (i < 0 || j < 0 || i >= c.w || j >= c.h) return null;
    return { i, j };
  }

  refreshHover(e: PointerEvent | WheelEvent) {
    const p = this.pick(e);
    this.hoverPt = p;
    const cell = p ? this.cellOf(p.x, p.z) : null;
    const changed = cell?.i !== this.hover?.i || cell?.j !== this.hover?.j;
    this.hover = cell;
    if (changed || this.tool === 'marker') this.updateHover();
    return changed;
  }

  onDown(e: PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.refreshHover(e);
    if (e.button === 2) { this.rightDown = { x: e.clientX, y: e.clientY, moved: false }; return; }
    if (e.button === 1) { this.midDown = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    if (this.tool === 'piece') {
      if (!this.hover) return;
      this.snapshot();
      this.painting = true;
      this.setPiece(this.hover.i, this.hover.j, this.pieceKind, DIRECTIONAL.has(this.pieceKind) ? this.paintRot : 0, this.paintLevel);
      this.updateHover();
    } else if (this.hoverPt) {
      const idx = this.markerAt(this.hoverPt.x, this.hoverPt.z);
      if (idx >= 0) {
        this.snapshot();
        this.selected = idx;
        this.renderRight();
      } else this.addMarker(this.hoverPt.x, this.hoverPt.z);
      this.dragging = true;
    }
  }

  onMove(e: PointerEvent) {
    if (this.rightDown) {
      const dx = e.clientX - this.rightDown.x, dy = e.clientY - this.rightDown.y;
      if (!this.rightDown.moved && Math.hypot(dx, dy) > 4) this.rightDown.moved = true;
      if (this.rightDown.moved) {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(0.12, Math.min(1.48, this.pitch + dy * 0.005));
        this.rightDown.x = e.clientX; this.rightDown.y = e.clientY;
      }
      return;
    }
    if (this.midDown) {
      const dx = e.clientX - this.midDown.x, dy = e.clientY - this.midDown.y;
      const k = this.dist * 0.0016;
      const cs = Math.cos(this.yaw), sn = Math.sin(this.yaw);
      this.target.x += (-dx * cs - dy * sn) * k;
      this.target.z += (dx * sn - dy * cs) * k;
      this.midDown.x = e.clientX; this.midDown.y = e.clientY;
      return;
    }
    const changed = this.refreshHover(e);
    if (this.painting && changed && this.hover)
      this.setPiece(this.hover.i, this.hover.j, this.pieceKind, DIRECTIONAL.has(this.pieceKind) ? this.paintRot : 0, this.paintLevel);
    if (this.dragging && this.selected >= 0 && this.hoverPt) {
      const m = this.def.markers[this.selected];
      m.x = this.hoverPt.x; m.z = this.hoverPt.z;
      const o = this.markerObjs[this.selected];
      o?.position.set(m.x, this.groundY(m.x, m.z), m.z);
    }
  }

  onUp(e: PointerEvent) {
    if (e.button === 2 && this.rightDown) {
      if (!this.rightDown.moved) {
        if (this.tool === 'piece' && this.hover) {
          if (pieceAt(this.def.course!, this.hover.i, this.hover.j)) { this.snapshot(); this.setPiece(this.hover.i, this.hover.j, null, 0, 0); this.updateHover(); }
        } else if (this.tool === 'marker' && this.hoverPt) {
          this.deleteMarker(this.markerAt(this.hoverPt.x, this.hoverPt.z));
        }
      }
      this.rightDown = null;
      return;
    }
    if (e.button === 1) { this.midDown = null; return; }
    if (this.dragging) {
      this.dragging = false;
      this.rebuildMarkers();
      if (this.tool === 'marker') this.renderRight();
      this.scheduleSave();
    }
    this.painting = false;
  }

  onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.shiftKey && this.tool === 'piece') { this.refreshHover(e); this.rotateHovered(e.deltaY > 0 ? 1 : -1); return; }
    this.dist = Math.max(6, Math.min(160, this.dist * Math.pow(1.1, Math.sign(e.deltaY))));
  }

  miniLayout() {
    const c = this.def.course!;
    const W = this.mini.width, H = this.mini.height;
    const cs = Math.floor(Math.min((W - 8) / c.w, (H - 8) / c.h));
    const ox = Math.floor((W - cs * c.w) / 2), oy = Math.floor((H - cs * c.h) / 2);
    return { cs, ox, oy };
  }

  miniClick(e: PointerEvent, drag = false) {
    e.preventDefault();
    const c = this.def.course!;
    const r = this.mini.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * this.mini.width, py = ((e.clientY - r.top) / r.height) * this.mini.height;
    const { cs, ox, oy } = this.miniLayout();
    const i = Math.floor((px - ox) / cs), j = Math.floor((py - oy) / cs);
    if (i < 0 || j < 0 || i >= c.w || j >= c.h) return;
    if (!drag) this.snapshot();
    if (e.button === 2) this.setPiece(i, j, null, 0, 0);
    else this.setPiece(i, j, this.pieceKind, DIRECTIONAL.has(this.pieceKind) ? this.paintRot : 0, this.paintLevel);
  }

  drawMini() {
    const cv = this.mini;
    if (!cv || !this.def?.course) return;
    const ctx = cv.getContext('2d')!;
    const c = this.def.course;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const { cs, ox, oy } = this.miniLayout();
    ctx.font = `700 ${Math.max(9, cs * 0.36)}px Rajdhani, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let j = 0; j < c.h; j++)
      for (let i = 0; i < c.w; i++) {
        const x = ox + i * cs, y = oy + j * cs;
        const p = pieceAt(c, i, j);
        ctx.fillStyle = p ? PIECE_COL[p.kind] : 'rgba(255,255,255,0.04)';
        ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2);
        if (!p) continue;
        ctx.fillStyle = '#fff';
        ctx.fillText(PIECE_ABBR[p.kind], x + cs / 2, y + cs / 2);
        if (p.level) { ctx.fillStyle = '#ffd23a'; ctx.fillText('·'.repeat(p.level), x + cs / 2, y + cs * 0.8); }
        if (DIRECTIONAL.has(p.kind)) {
          const [dx, dz] = p.kind === 'corner' ? CORNER_DIR[p.rot] : EDGE_DIR[p.rot];
          ctx.strokeStyle = '#3cf2ff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          if (p.kind === 'corner') {
            const cx = x + cs / 2 + (dx * cs) / 2 - dx * 3, cy = y + cs / 2 + (dz * cs) / 2 - dz * 3;
            ctx.moveTo(cx - dx * cs * 0.3, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy - dz * cs * 0.3);
          } else if (dx) {
            const ex = x + cs / 2 + (dx * cs) / 2 - dx * 3;
            ctx.moveTo(ex, y + 4); ctx.lineTo(ex, y + cs - 4);
          } else {
            const ey = y + cs / 2 + (dz * cs) / 2 - dz * 3;
            ctx.moveTo(x + 4, ey); ctx.lineTo(x + cs - 4, ey);
          }
          ctx.stroke();
        }
      }
    // markers
    const T = c.tile;
    this.def.markers.forEach((m, k) => {
      const px = ox + ((m.x + (c.w * T) / 2) / T) * cs, py = oy + ((m.z + (c.h * T) / 2) / T) * cs;
      ctx.fillStyle = (m.kind === 'spawn' || m.kind === 'flag') && m.team !== undefined ? TEAM_COL[m.team] : MARKER_COLOR[m.kind];
      ctx.beginPath();
      ctx.arc(px, py, k === this.selected ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (k === this.selected) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
    });
    if (this.hover && this.tool === 'piece') {
      ctx.strokeStyle = '#ffd23a';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + this.hover.i * cs + 1, oy + this.hover.j * cs + 1, cs - 2, cs - 2);
    }
  }

  // ------------------------------------------------------------ frame
  update(dt: number) {
    this.time += dt;
    this.nav.update(dt);
    const inp = this.app.input;
    const ctrl = inp.keys.has('ControlLeft') || inp.keys.has('ControlRight');
    if (ctrl && inp.pressed.has('KeyZ')) this.doUndo();
    else if (inp.pressed.has('KeyR')) this.rotateHovered(1);
    if (inp.pressed.has('BracketLeft')) this.levelHovered(-1);
    if (inp.pressed.has('BracketRight')) this.levelHovered(1);
    if (inp.pressed.has('Delete') && this.selected >= 0) this.deleteMarker(this.selected);
    if (inp.pressed.has('Digit1')) { this.tool = 'piece'; this.renderRight(); this.updateHover(); }
    if (inp.pressed.has('Digit2')) { this.tool = 'marker'; this.renderRight(); this.updateHover(); }

    if (this.rebuildT > 0) { this.rebuildT -= dt; if (this.rebuildT <= 0) this.rebuildTerrain(); }
    if (this.saveT > 0) { this.saveT -= dt; if (this.saveT <= 0) this.persist(); }

    // animate markers
    this.def.markers.forEach((m, k) => {
      const o = this.markerObjs[k];
      if (!o) return;
      for (const ch of o.children) {
        if (ch.userData.spin) ch.rotation.y = this.time * 1.5;
        if (ch.userData.arm) { const p = hazardPose(m, this.time); if (p) ch.rotation.y = -p.angle; }
        if (ch.userData.saw) {
          const p = hazardPose(m, this.time);
          if (p) { ch.position.x = p.ax - m.x; ch.position.z = p.az - m.z; ch.rotation.y = p.angle; }
        }
      }
    });
    const sel = this.def.markers[this.selected];
    this.selRing.visible = !!sel && this.tool === 'marker';
    if (sel) {
      this.selRing.position.set(sel.x, this.groundY(sel.x, sel.z) + 0.12, sel.z);
      this.selRing.scale.setScalar(1 + Math.sin(this.time * 6) * 0.08);
    }
    (this.hoverArrow.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(this.time * 6) * 0.3;

    // camera
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + sp * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(this.target);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  dispose() {
    if (this.saveT > 0) this.persist();
    this.root.remove();
    disposeTree(this.scene);
    this.scene.clear();
  }
}

let editor: CourseEditor | null = null;

export const courseDesignerScreen: Screen = {
  mount(app: App) {
    editor = new CourseEditor(app);
  },
  unmount() {
    editor?.dispose();
    editor = null;
  },
  update(dt: number) {
    editor?.update(dt);
  },
  resize() {
    editor?.resize();
  },
};
