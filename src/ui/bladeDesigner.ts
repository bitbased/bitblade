// Blade designer: library, live 3D turntable preview, geometry/paint/decal editor, derived stats.
import * as THREE from 'three';
import './bladeDesigner.css';
import { h, MenuNav, type App, type Screen } from './app';
import { icon, ICONS } from './icons';
import type { RandomPalette, RandomPart, RandomStyle } from '../core/blade';
import { getRenderer } from '../game/render';
import { buildBladeModel, type BladeModel } from '../core/bladeMesh';
import {
  computeStats, defaultDesign, EMBLEMS, loadCustomBlades, newBladeId, PATTERNS, PRESETS, randomDesign, randomizeDesign, saveCustomBlades, TIPS,
  type BladeDesign, type Decal, type TipType,
} from '../core/blade';

type Tab = 'shape' | 'core' | 'paint' | 'decals';
type NumKey = { [K in keyof BladeDesign]: BladeDesign[K] extends number ? K : never }[keyof BladeDesign];

const SPECIALS = { attack: 'METEOR RUSH', defense: 'IRON FORTRESS', stamina: 'ETERNAL VORTEX', speed: 'SKY DIVE' } as const;
const STAT_COLORS: Record<string, string> = { attack: '#ff4a5e', defense: '#47b6ff', stamina: '#38ffb0', speed: '#ffe23a', weight: '#c9a2ff', burstRes: '#ff9e3d' };
const STAT_LABEL: Record<string, string> = { attack: 'Attack', defense: 'Defense', stamina: 'Stamina', speed: 'Speed', weight: 'Weight', burstRes: 'Burst Res' };

const clone = (d: BladeDesign): BladeDesign => JSON.parse(JSON.stringify(d));

class BladeDesigner implements Screen {
  app!: App;
  root!: HTMLDivElement;
  nav!: MenuNav;
  // data
  custom: BladeDesign[] = [];
  cur: BladeDesign = clone(PRESETS[0]);
  isPreset = true;
  tab: Tab = 'shape';
  placing = false;
  // 3d
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
  model: BladeModel | null = null;
  holder = new THREE.Group();
  turntable!: THREE.Group;
  glowLight!: THREE.PointLight;
  yaw = 0.6; pitch = 0.55; dist = 3.4;
  spinOn = true;
  spinSpeed = 0.6;
  angle = 0;
  time = 0;
  rebuildTimer = 0;
  saveTimer = 0;
  // dom refs
  libList!: HTMLDivElement;
  stage!: HTMLDivElement;
  nameInput!: HTMLInputElement;
  statsEl!: HTMLDivElement;
  tabBody!: HTMLDivElement;
  tabBtns: Record<Tab, HTMLButtonElement> = {} as Record<Tab, HTMLButtonElement>;
  private cleanup: (() => void)[] = [];

  mount(app: App, arg?: unknown) {
    this.app = app;
    this.custom = loadCustomBlades();
    const want = (arg as { bladeId?: string } | undefined)?.bladeId;
    const found = want ? [...PRESETS, ...this.custom].find((b) => b.id === want) : this.custom[0];
    this.select(found ?? PRESETS[0], false);
    this.buildScene();
    this.buildDom();
    this.nav = new MenuNav(app, this.root, () => app.back());
    this.rebuildModel();
    this.refreshAll();
    this.resize();
  }

  unmount() {
    window.clearTimeout(this.rebuildTimer);
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.persist(); }
    for (const c of this.cleanup) c();
    this.cleanup = [];
    this.model?.dispose();
    this.model = null;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.scene.clear();
    this.camera.clearViewOffset();
    const { renderer } = getRenderer(this.app.canvas);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth || innerWidth, renderer.domElement.clientHeight || innerHeight);
    this.root.remove();
  }

  // ------------------------------------------------------------ data ops
  select(d: BladeDesign, refresh = true) {
    this.cur = clone(d);
    this.isPreset = PRESETS.some((p) => p.id === d.id);
    if (refresh) { this.rebuildModel(); this.refreshAll(); }
  }

  /** Apply a change; forks presets into a custom copy first. */
  randStyle: RandomStyle = 'any';
  randPalette: RandomPalette = 'any';
  randHistory: BladeDesign[] = [];
  undoBtn: HTMLButtonElement | null = null;

  buildRandomizer() {
    const sel = <T extends string>(opts: T[], get: () => T, set: (v: T) => void, title: string) => {
      const el = h('select.bd-rsel.nav', { title }, ...opts.map((o) => h('option', { value: o, selected: o === get() }, o.toUpperCase()))) as HTMLSelectElement;
      el.addEventListener('change', () => set(el.value as T));
      return el;
    };
    const btn = (part: RandomPart, label: string, primary = false) =>
      h('button.bd-mini.nav' + (primary ? '.bd-rand-main' : ''), { onclick: () => this.randomize(part), title: part === 'all' ? 'Randomize everything (R)' : `Randomize ${part} only` }, primary ? icon('dice') : null, primary ? ' ' : null, label);
    this.undoBtn = h('button.bd-mini.nav', { onclick: () => this.undoRandom(), title: 'Undo last randomize', disabled: true }, 'Undo') as HTMLButtonElement;
    return h('div.bd-rand', null,
      btn('all', 'RANDOMIZE', true), btn('shape', 'Shape'), btn('core', 'Core'), btn('paint', 'Paint'), btn('decals', 'Decals'),
      sel<RandomStyle>(['any', 'attack', 'defense', 'stamina', 'balance'], () => this.randStyle, (v) => (this.randStyle = v), 'Battle style bias'),
      sel<RandomPalette>(['any', 'neon', 'fire', 'ice', 'toxic', 'royal', 'mono', 'metal', 'complement'], () => this.randPalette, (v) => (this.randPalette = v), 'Color palette'),
      this.undoBtn);
  }

  randomize(part: RandomPart) {
    this.randHistory.push(clone(this.cur));
    if (this.randHistory.length > 30) this.randHistory.shift();
    const next = randomizeDesign(this.cur, part, this.randStyle, this.randPalette, part !== 'all');
    this.modify((d) => { const id = d.id; Object.assign(d, next, { id }); }, true);
    this.nameInput.value = this.cur.name;
    if (this.undoBtn) this.undoBtn.disabled = false;
    this.app.sfx.play('select');
  }

  undoRandom() {
    const prev = this.randHistory.pop();
    if (!prev) return;
    this.modify((d) => { const id = d.id; Object.assign(d, prev, { id }); }, true);
    this.nameInput.value = this.cur.name;
    if (this.undoBtn) this.undoBtn.disabled = this.randHistory.length === 0;
  }

  modify(fn: (d: BladeDesign) => void, rerenderTab = false) {
    if (this.isPreset) {
      const copy = clone(this.cur);
      copy.id = newBladeId();
      copy.name = `${this.cur.name} Custom`;
      this.custom.push(copy);
      this.cur = copy;
      this.isPreset = false;
      this.nameInput.value = copy.name;
      this.app.toast('Preset copied to your library');
      this.renderLib();
    }
    fn(this.cur);
    const idx = this.custom.findIndex((c) => c.id === this.cur.id);
    if (idx >= 0) this.custom[idx] = clone(this.cur);
    this.scheduleRebuild();
    this.scheduleSave();
    this.renderStats();
    if (rerenderTab) this.renderTab();
  }

  scheduleRebuild() {
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.rebuildModel(), 60);
  }

  scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persist(), 300);
  }

  persist() {
    this.saveTimer = 0;
    saveCustomBlades(this.custom);
    this.renderLib();
  }

  addCustom(d: BladeDesign) {
    this.custom.push(d);
    saveCustomBlades(this.custom);
    this.select(d);
  }

  // ------------------------------------------------------------ 3d
  buildScene() {
    const { env } = getRenderer(this.app.canvas);
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.8;
    this.scene.background = new THREE.Color('#05060d');
    this.scene.fog = new THREE.Fog('#05060d', 8, 22);
    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#1a0f20', 0.8));
    const key = new THREE.DirectionalLight('#ffffff', 2.4);
    key.position.set(3, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 1, far: 15 });
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#ff3db4', 1.2);
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);
    this.glowLight = new THREE.PointLight('#3cf2ff', 6, 6);
    this.glowLight.position.set(0, 0.3, 0);
    this.scene.add(this.glowLight);

    // turntable
    const tt = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.9, 0.12, 64), new THREE.MeshStandardMaterial({ color: '#0d1226', metalness: 0.8, roughness: 0.35 }));
    disc.position.y = -0.06;
    disc.receiveShadow = true;
    tt.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: '#3cf2ff', toneMapped: false }));
    ring.rotation.x = Math.PI / 2;
    tt.add(ring);
    const inner = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.3, 96), new THREE.MeshBasicMaterial({ color: '#ff3db4', transparent: true, opacity: 0.6, toneMapped: false, side: THREE.DoubleSide }));
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.005;
    tt.add(inner);
    for (let i = 0; i < 24; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.18), new THREE.MeshBasicMaterial({ color: '#3cf2ff', transparent: true, opacity: 0.5, toneMapped: false, side: THREE.DoubleSide }));
      const a = (i / 24) * Math.PI * 2;
      tick.rotation.x = -Math.PI / 2;
      tick.rotation.z = -a;
      tick.position.set(Math.sin(a) * 1.55, 0.006, Math.cos(a) * 1.55);
      tt.add(tick);
    }
    const grid = new THREE.GridHelper(30, 60, '#1b2a5a', '#101836');
    grid.position.y = -0.13;
    this.scene.add(grid);
    this.turntable = tt;
    this.scene.add(tt, this.holder);
  }

  rebuildModel() {
    this.model?.dispose();
    if (this.model) this.holder.remove(this.model.group);
    const m = buildBladeModel(this.cur);
    m.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    this.model = m;
    this.holder.add(m.group);
    this.glowLight.color.set(this.cur.glow);
    (this.turntable.children[1] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.color.set(this.cur.glow);
  }

  update(dt: number) {
    this.time += dt;
    this.nav.update(dt);
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (this.app.input.pressed.has('KeyR') && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') this.randomize('all');
    if (this.model) {
      if (this.spinOn) this.angle += this.cur.spinDir * dt * (2 + this.spinSpeed * 40);
      this.model.spinner.rotation.y = this.angle;
      const wob = this.spinOn ? 0.03 : 0;
      this.holder.rotation.set(Math.sin(this.time * 2.3) * wob, 0, Math.cos(this.time * 2.3) * wob);
      this.holder.position.y = Math.sin(this.time * 1.4) * 0.02;
    }
    this.turntable.rotation.y += dt * 0.15;
    // camera orbit around blade
    const tgt = new THREE.Vector3(0, 0.35, 0);
    this.camera.position.set(
      tgt.x + Math.cos(this.pitch) * Math.sin(this.yaw) * this.dist,
      tgt.y + Math.sin(this.pitch) * this.dist,
      tgt.z + Math.cos(this.pitch) * Math.cos(this.yaw) * this.dist,
    );
    this.camera.lookAt(tgt);
    this.applyViewOffset();
    const { renderer } = getRenderer(this.app.canvas);
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.render(this.scene, this.camera);
  }

  /** Shift the projection so the blade sits in the middle of the stage column. */
  applyViewOffset() {
    const W = innerWidth, H = innerHeight;
    this.camera.aspect = W / H;
    if (!this.stage) { this.camera.clearViewOffset(); this.camera.updateProjectionMatrix(); return; }
    const r = this.stage.getBoundingClientRect();
    const dx = r.left + r.width / 2 - W / 2;
    const dy = r.top + r.height / 2 - H / 2;
    this.camera.setViewOffset(W, H, -dx, -dy, W, H);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    this.applyViewOffset();
  }

  /** Raycast the ring's top face; returns decal coords (-1..1) or null. */
  pickFace(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.model) return null;
    const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    this.applyViewOffset();
    ray.setFromCamera(ndc, this.camera);
    let ring: THREE.Mesh | null = null;
    this.model.spinner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry?.type === 'ExtrudeGeometry') ring = m;
    });
    if (!ring) return null;
    const hit = ray.intersectObject(ring as THREE.Mesh, false)[0];
    if (!hit) return null;
    // ring local = blade units; shape (sx, sy) -> local (x, -z); texture covers +-ext.
    // canvas x = S/2 + sx/ext*S/2, canvas y (flipY) = S/2 - sy/ext*S/2 = S/2 + localZ/ext*S/2
    const local = (ring as THREE.Mesh).worldToLocal(hit.point.clone());
    const ext = this.model.outer + 0.05;
    const x = local.x / ext, y = local.z / ext;
    if (Math.abs(x) > 1 || Math.abs(y) > 1) return null;
    return { x, y };
  }

  // ------------------------------------------------------------ dom
  buildDom() {
    const app = this.app;
    this.root = h('div.bd-root') as HTMLDivElement;
    // top bar
    const top = h('div.bd-top', null,
      h('button.btn.nav', { onclick: () => app.back() }, '◀ Back'),
      h('div.bd-title', null, 'Blade Forge'),
      h('button.bd-mini.nav', { onclick: () => this.exportJson() }, 'Export'),
      h('button.bd-mini.nav', { onclick: () => this.importJson() }, 'Import'),
      h('button.btn.nav', { onclick: () => { this.persist(); app.go('lobby', { mode: 'duel', bladeId: this.cur.id }); } }, 'Test Spin ▶'),
    );
    // library
    this.libList = h('div.bd-lib-list') as HTMLDivElement;
    const lib = h('div.bd-panel.bd-lib', null,
      h('h3', null, 'Library'),
      this.libList,
      h('div.bd-lib-btns', null,
        h('button.bd-mini.nav', { onclick: () => { const d = defaultDesign(); this.addCustom(d); } }, '+ New'),
        h('button.bd-mini.nav', { onclick: () => { const d = clone(this.cur); d.id = newBladeId(); d.name = `${this.cur.name} II`; this.addCustom(d); } }, 'Duplicate'),
        h('button.bd-mini.nav', { onclick: () => this.deleteCur() }, 'Delete'),
        h('button.bd-mini.nav', { onclick: () => { const d = randomDesign(); this.addCustom(d); app.sfx.play('select'); } }, icon('dice'), ' Random'),
      ),
    );
    // center
    this.nameInput = h('input.bd-name', { type: 'text', maxLength: 24, value: this.cur.name }) as HTMLInputElement;
    this.nameInput.addEventListener('input', () => this.modify((d) => { d.name = this.nameInput.value || 'Unnamed'; }));
    const spinBtn = h('button.bd-mini.nav.bd-on', { onclick: () => { this.spinOn = !this.spinOn; spinBtn.classList.toggle('bd-on', this.spinOn); } }, 'Spin');
    const spd = h('input.bd-range.nav', { type: 'range', min: '0', max: '1', step: '0.01', value: String(this.spinSpeed), 'data-navx': '', style: { width: '90px' } }) as HTMLInputElement;
    spd.addEventListener('input', () => (this.spinSpeed = +spd.value));
    this.bindNavX(spd);
    this.stage = h('div.bd-stage', null, h('div.bd-hint', null, 'Drag to orbit · Wheel to zoom')) as HTMLDivElement;
    this.statsEl = h('div.bd-stats') as HTMLDivElement;
    const center = h('div.bd-center', null,
      h('div.bd-namebar', null, this.nameInput, spinBtn, spd),
      this.stage,
      this.buildRandomizer(),
      h('div.bd-panel', null, this.statsEl),
    );
    this.bindStage();
    // editor
    const tabs = h('div.bd-tabs');
    for (const t of ['shape', 'core', 'paint', 'decals'] as Tab[]) {
      const b = h('button.bd-mini.nav', { onclick: () => { this.tab = t; this.renderTab(); app.sfx.play('tick'); } }, t) as HTMLButtonElement;
      this.tabBtns[t] = b;
      tabs.append(b);
    }
    this.tabBody = h('div.bd-tabbody') as HTMLDivElement;
    const editor = h('div.bd-panel.bd-editor', null, tabs, this.tabBody);
    this.root.append(top, lib, center, editor);
    app.root.append(this.root);
  }

  bindStage() {
    const el = this.stage;
    let down = false, moved = 0, lx = 0, ly = 0;
    const onDown = (e: PointerEvent) => { down = true; moved = 0; lx = e.clientX; ly = e.clientY; el.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      moved += Math.abs(dx) + Math.abs(dy);
      lx = e.clientX; ly = e.clientY;
      this.yaw -= dx * 0.008;
      this.pitch = Math.max(0.05, Math.min(1.45, this.pitch + dy * 0.006));
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      if (moved < 6 && (this.placing || this.tab === 'decals')) {
        const p = this.pickFace(e.clientX, e.clientY);
        if (p) {
          const glyph = this.cur.emblem || 'star';
          this.modify((d) => d.decals.push({ glyph, x: p.x, y: p.y, size: 0.22, rot: 0, color: d.accent }), true);
          this.app.sfx.play('pickup');
        }
      }
    };
    const onWheel = (e: WheelEvent) => { e.preventDefault(); this.dist = Math.max(1.6, Math.min(8, this.dist * (1 + Math.sign(e.deltaY) * 0.1))); };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
  }

  bindNavX(input: HTMLInputElement) {
    input.addEventListener('navx', (e) => {
      const dir = (e as CustomEvent<number>).detail;
      const min = +input.min, max = +input.max;
      const step = +input.step >= 1 ? +input.step : (max - min) / 20;
      input.value = String(Math.max(min, Math.min(max, +input.value + dir * step)));
      input.dispatchEvent(new Event('input'));
    });
  }

  refreshAll() {
    if (!this.root) return;
    this.nameInput.value = this.cur.name;
    this.renderLib();
    this.renderStats();
    this.renderTab();
  }

  renderLib() {
    if (!this.libList) return;
    this.libList.innerHTML = '';
    const item = (d: BladeDesign, locked: boolean) => {
      const el = h('div.bd-lib-item.nav', { onclick: () => { this.select(d); this.app.sfx.play('select'); } },
        h('span.bd-dot', { style: { background: d.primary, color: d.glow, border: `2px solid ${d.glow}` } }),
        h('span', null, d.name),
        locked ? h('span.bd-lock', null, icon('lock'), ' PRESET') : null,
      );
      if (d.id === this.cur.id) el.classList.add('bd-sel');
      this.libList.append(el);
    };
    if (this.custom.length) {
      this.libList.append(h('div.bd-sub', null, 'My Blades'));
      for (const d of this.custom) item(d, false);
    }
    this.libList.append(h('div.bd-sub', null, 'Presets'));
    for (const d of PRESETS) item(d, true);
  }

  renderStats() {
    if (!this.statsEl) return;
    const st = computeStats(this.cur);
    if (!this.statsEl.childElementCount) {
      for (const k of Object.keys(STAT_LABEL)) {
        this.statsEl.append(h('div.bd-stat', { 'data-k': k },
          h('span', null, STAT_LABEL[k]),
          h('div.bd-bar', null, h('i', { style: { background: STAT_COLORS[k], color: STAT_COLORS[k] } })),
          h('output'),
        ));
      }
      this.statsEl.append(h('div.bd-special', null, h('b'), h('span')));
    }
    for (const k of Object.keys(STAT_LABEL)) {
      const row = this.statsEl.querySelector(`[data-k="${k}"]`)!;
      const v = st[k as keyof typeof st] as number;
      (row.querySelector('i') as HTMLElement).style.width = `${Math.round(v * 100)}%`;
      row.querySelector('output')!.textContent = String(Math.round(v * 100));
    }
    const kinds = ['attack', 'defense', 'stamina', 'speed'] as const;
    let best: (typeof kinds)[number] = kinds[0];
    for (const k of kinds) if (st[k] > st[best]) best = k;
    const sp = this.statsEl.querySelector('.bd-special')!;
    sp.querySelector('b')!.textContent = `SPECIAL: ${SPECIALS[best]}`;
    sp.querySelector('span')!.textContent = `${TIPS[this.cur.tip].label} tip — ${TIPS[this.cur.tip].desc}`;
  }

  slider(label: string, key: NumKey, min: number, max: number, step: number) {
    const fmt = (v: number) => (step >= 1 ? String(v) : v.toFixed(2));
    const out = h('output', null, fmt(this.cur[key] as number));
    const inp = h('input.bd-range.nav', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(this.cur[key]), 'data-navx': '' }) as HTMLInputElement;
    inp.addEventListener('input', () => {
      const v = +inp.value;
      out.textContent = fmt(v);
      this.modify((d) => { (d as unknown as Record<string, number>)[key] = v; });
    });
    this.bindNavX(inp);
    return h('div.bd-row', null, h('label', null, label), inp, out);
  }

  color(label: string, key: 'primary' | 'secondary' | 'accent' | 'glow' | 'emblemColor') {
    const inp = h('input.bd-color.nav', { type: 'color', value: toHex(this.cur[key]) }) as HTMLInputElement;
    inp.addEventListener('input', () => this.modify((d) => { d[key] = inp.value; }));
    return h('div.bd-row', null, h('label', null, label), inp, h('span'));
  }

  renderTab() {
    if (!this.tabBody) return;
    for (const [t, b] of Object.entries(this.tabBtns)) b.classList.toggle('bd-on', t === this.tab);
    const body = this.tabBody;
    body.innerHTML = '';
    const d = this.cur;
    switch (this.tab) {
      case 'shape':
        body.append(
          h('div.bd-sub', null, 'Attack Ring'),
          this.slider('Wings', 'wings', 1, 8, 1),
          this.slider('Length', 'wingLength', 0, 1, 0.01),
          this.slider('Width', 'wingWidth', 0, 1, 0.01),
          this.slider('Sweep', 'wingCurve', -1, 1, 0.01),
          this.slider('Sharpness', 'wingSharp', 0, 1, 0.01),
          this.slider('Tilt', 'wingTilt', -1, 1, 0.01),
          h('div.bd-sub', null, 'Ring Body'),
          this.slider('Core Size', 'ringRadius', 0, 1, 0.01),
          this.slider('Thickness', 'ringThickness', 0, 1, 0.01),
        );
        break;
      case 'core': {
        const tips = h('div.bd-tips');
        const desc = h('div.bd-tipdesc', null, TIPS[d.tip].desc);
        for (const t of Object.keys(TIPS) as TipType[]) {
          const b = h('button.bd-mini.nav', { onclick: () => { this.modify((x) => { x.tip = t; }, true); this.app.sfx.play('tick'); } }, TIPS[t].label);
          if (t === d.tip) b.classList.add('bd-on');
          b.addEventListener('mouseenter', () => (desc.textContent = TIPS[t].desc));
          tips.append(b);
        }
        const dirL = h('button.bd-mini.nav', { onclick: () => this.modify((x) => { x.spinDir = -1; }, true) }, '↺ Left');
        const dirR = h('button.bd-mini.nav', { onclick: () => this.modify((x) => { x.spinDir = 1; }, true) }, 'Right ↻');
        (d.spinDir < 0 ? dirL : dirR).classList.add('bd-on');
        body.append(
          h('div.bd-sub', null, 'Weight Disc'),
          this.slider('Size', 'discSize', 0, 1, 0.01),
          this.slider('Weight', 'discWeight', 0, 1, 0.01),
          this.slider('Notches', 'discNotches', 0, 8, 1),
          h('div.bd-sub', null, 'Driver Tip'),
          tips, desc,
          this.slider('Height', 'tipHeight', 0, 1, 0.01),
          h('div.bd-sub', null, 'Spin Direction'),
          h('div.bd-tips', { style: { gridTemplateColumns: '1fr 1fr' } }, dirL, dirR),
        );
        break;
      }
      case 'paint': {
        const pats = h('div.bd-grid');
        for (const p of PATTERNS) {
          const b = h('div.bd-swatch.nav', { onclick: () => this.modify((x) => { x.pattern = p; }, true), title: p }, p === 'none' ? '—' : p);
          if (p === d.pattern) b.classList.add('bd-on');
          pats.append(b);
        }
        const embs = h('div.bd-grid.bd-emb');
        for (const e of EMBLEMS) {
          const b = h('div.bd-swatch.nav', { onclick: () => this.modify((x) => { x.emblem = e; }, true) }, e ? icon(e) : '∅');
          if (e === d.emblem) b.classList.add('bd-on');
          b.style.color = d.emblemColor;
          embs.append(b);
        }
        body.append(
          h('div.bd-sub', null, 'Colors'),
          this.color('Primary', 'primary'),
          this.color('Secondary', 'secondary'),
          this.color('Accent', 'accent'),
          this.color('Glow', 'glow'),
          h('div.bd-sub', null, 'Finish'),
          this.slider('Metal', 'metal', 0, 1, 0.01),
          this.slider('Rough', 'rough', 0, 1, 0.01),
          h('div.bd-sub', null, 'Pattern'),
          pats,
          h('div.bd-sub', null, 'Emblem'),
          this.color('Emblem', 'emblemColor'),
          embs,
        );
        break;
      }
      case 'decals': {
        const placeBtn = h('button.bd-mini.nav', { onclick: () => { this.placing = !this.placing; placeBtn.classList.toggle('bd-on', this.placing); } }, 'Click-to-place') as HTMLButtonElement;
        placeBtn.classList.toggle('bd-on', true);
        this.placing = true;
        body.append(
          h('div.bd-tipdesc', null, 'Click the blade face in the preview to stamp a decal (uses your emblem glyph), then tweak it below.'),
          h('div.bd-actions', null,
            placeBtn,
            h('button.bd-mini.nav', { onclick: () => this.modify((x) => x.decals.push({ glyph: x.emblem || 'star', x: 0.5, y: 0, size: 0.25, rot: 0, color: x.accent }), true) }, '+ Add'),
            h('button.bd-mini.nav', { onclick: () => this.modify((x) => { x.decals = []; }, true) }, 'Clear All'),
          ),
        );
        if (!d.decals.length) body.append(h('div.bd-empty', null, 'No decals yet.'));
        d.decals.forEach((dc, i) => body.append(this.decalRow(dc, i)));
        break;
      }
    }
    this.stage?.classList.toggle('bd-placing', this.tab === 'decals' && this.placing);
  }

  decalRow(dc: Decal, i: number) {
    const glyph = h('select.bd-glyph.nav', null, ...[...Object.keys(ICONS), 'X', 'Ω', 'Δ', '01', 'BB'].map((n) => h('option', { value: n, selected: n === dc.glyph }, n))) as HTMLSelectElement;
    if (![...glyph.options].some((o) => o.value === dc.glyph)) glyph.append(h('option', { value: dc.glyph, selected: true }, dc.glyph));
    glyph.addEventListener('change', () => this.modify((x) => { x.decals[i].glyph = glyph.value; }, true));
    const col = h('input.bd-color.nav', { type: 'color', value: toHex(dc.color) }) as HTMLInputElement;
    col.addEventListener('input', () => this.modify((x) => { x.decals[i].color = col.value; }));
    const sl = (label: string, k: 'x' | 'y' | 'size' | 'rot', min: number, max: number) => {
      const out = h('output', null, dc[k].toFixed(2));
      const inp = h('input.bd-range.nav', { type: 'range', min: String(min), max: String(max), step: '0.01', value: String(dc[k]), 'data-navx': '' }) as HTMLInputElement;
      inp.addEventListener('input', () => { out.textContent = (+inp.value).toFixed(2); this.modify((x) => { x.decals[i][k] = +inp.value; }); });
      this.bindNavX(inp);
      return h('div.bd-row', null, h('label', null, label), inp, out);
    };
    return h('div.bd-decal', null,
      h('div.bd-decal-head', null, h('b', null, `#${i + 1}`), glyph, col,
        h('button.bd-mini.nav', { onclick: () => this.modify((x) => { x.decals.splice(i, 1); }, true) }, icon('close'))),
      sl('X', 'x', -1, 1), sl('Y', 'y', -1, 1), sl('Size', 'size', 0.05, 1), sl('Rotate', 'rot', -Math.PI, Math.PI),
    );
  }

  deleteCur() {
    if (this.isPreset) { this.app.toast('Presets can’t be deleted'); return; }
    const idx = this.custom.findIndex((c) => c.id === this.cur.id);
    if (idx < 0) return;
    this.custom.splice(idx, 1);
    saveCustomBlades(this.custom);
    this.select(this.custom[Math.min(idx, this.custom.length - 1)] ?? PRESETS[0]);
    this.app.sfx.play('back');
  }

  async exportJson() {
    const json = JSON.stringify(this.cur);
    try {
      await navigator.clipboard.writeText(json);
      this.app.toast('Blade copied to clipboard');
    } catch {
      prompt('Copy this blade JSON:', json);
    }
  }

  importJson() {
    const raw = prompt('Paste blade JSON:');
    if (!raw) return;
    try {
      const obj = JSON.parse(raw) as Partial<BladeDesign>;
      const d: BladeDesign = { ...defaultDesign(), ...obj, id: newBladeId(), decals: Array.isArray(obj.decals) ? obj.decals : [] };
      this.addCustom(d);
      this.app.toast(`Imported ${d.name}`);
    } catch {
      this.app.toast('Invalid blade JSON');
    }
  }
}

function toHex(c: string) {
  return '#' + new THREE.Color(c).getHexString();
}

let instance: BladeDesigner | null = null;
export const bladeDesignerScreen: Screen = {
  mount(app, arg) { instance = new BladeDesigner(); instance.mount(app, arg); },
  unmount() { instance?.unmount(); instance = null; },
  update(dt) { instance?.update(dt); },
  resize() { instance?.resize(); },
};
