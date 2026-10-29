// Three.js scene for a match: heightfield arena, blades, hazards, objects, trails, trajectories, particles, bloom.
import * as THREE from 'three';
import { surfaceCtx, trackSurface, type SurfaceCtx } from './track';
import { questRoute } from './ai';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildBladeModel, type BladeModel } from '../core/bladeMesh';
import { computeStats } from '../core/blade';
import { Terrain, VOID, type Theme } from './terrain';
import type { TrackSamples } from './track';
import { arenaRails, railPolyline, railSegments, rampRails, flipperHalf, flyLift, flyLiftAlong } from './pinball';
import { hazardPose } from './hazards';
import { G } from './sim';
import type { GameEvent, GameState, MatchConfig, TopState } from './types';
import { ITEMS } from './types';
import { settings, perf } from '../core/settings';

// ---------------------------------------------------------------- shared renderer
let shared: { renderer: THREE.WebGLRenderer; env: THREE.Texture } | null = null;
export function getRenderer(canvas: HTMLCanvasElement) {
  if (shared) return shared;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(perf.ratio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is much heavier (esp. on Macs)
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  shared = { renderer, env };
  return shared;
}

// ---------------------------------------------------------------- textures
function gridTexture(theme: Theme) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, S, S);
  // subtle concrete noise
  const img = c.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 225 + Math.random() * 30;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
  }
  c.putImageData(img, 0, 0);
  c.strokeStyle = 'rgba(0,0,0,0.35)';
  c.lineWidth = 3;
  c.strokeRect(0, 0, S, S);
  c.strokeStyle = 'rgba(0,0,0,0.12)';
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(S / 2, 0); c.lineTo(S / 2, S); c.moveTo(0, S / 2); c.lineTo(S, S / 2); c.stroke();
  void theme;
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function textSprite(text: string, color: string, size = 48) {
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d')!;
  c.font = `700 ${size}px Rajdhani, sans-serif`;
  const w = Math.ceil(c.measureText(text).width) + 24;
  cv.width = w; cv.height = size + 16;
  c.font = `700 ${size}px Rajdhani, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,0.8)';
  c.strokeText(text, w / 2, cv.height / 2);
  c.fillStyle = color;
  c.fillText(text, w / 2, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set((w / cv.height) * 0.45, 0.45, 1);
  sp.renderOrder = 10;
  return sp;
}

/** chevrons pointing toward canvas top (= local +y of a PlaneGeometry) */
function chevronTexture(color: string, n = 3) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 128;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#000'; c.fillRect(0, 0, 64, 128);
  c.strokeStyle = color; c.lineWidth = 10; c.lineCap = 'round'; c.lineJoin = 'round';
  const step = 128 / n;
  for (let k = 0; k < n; k++) { const y = step * k + step * 0.7; c.beginPath(); c.moveTo(10, y); c.lineTo(32, y - step * 0.45); c.lineTo(54, y); c.stroke(); }
  const t = new THREE.CanvasTexture(cv);
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** yaw for a flat plane (rotation.x = -PI/2, order YXZ) so its +y axis points along world (dx, dz) */
function planeYaw(dx: number, dz: number) {
  return Math.atan2(-dx, -dz);
}

function questionTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  const g = c.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#ff3cac'); g.addColorStop(0.5, '#784ba0'); g.addColorStop(1, '#2b86c5');
  c.fillStyle = g; c.fillRect(0, 0, S, S);
  c.strokeStyle = '#fff'; c.lineWidth = 8; c.strokeRect(4, 4, S - 8, S - 8);
  c.font = '900 90px Orbitron, sans-serif'; c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('?', S / 2, S / 2 + 6);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- arena mesh

/**
 * Tracks are drawn straight from the road curve (not from a heightfield grid): smooth slopes and banking, clean
 * curved edges and side walls, and roads that pass over themselves (bridges) render both levels.
 */
function buildTrackRibbon(terrain: Terrain, theme: Theme): THREE.Group { return buildRibbon(terrain.def.track!, terrain.track!, theme); }

/** the track surface (road, rails, pipe walls, side walls) built from the curve alone (Track Studio uses it live) */
export function buildRibbon(def: import('./track').TrackDef, S: import('./track').TrackSamples, theme: Theme): THREE.Group {
  const group = new THREE.Group();
  const ctx = surfaceCtx(def, S);
  const pipe = false;
  // across-the-road offsets as fractions of the half width; >1 reaches the rails and pipe rims
  const fr = [-1.12, -1.1, -1.06, -1, -0.97, -0.9, -0.75, -0.55, -0.3, 0, 0.3, 0.55, 0.75, 0.9, 0.97, 1, 1.06, 1.1, 1.12];
  const C = fr.length;
  const rows = S.open ? S.n : S.n + 1;
  const pos = new Float32Array(rows * C * 3), col = new Float32Array(rows * C * 3), uv = new Float32Array(rows * C * 2), glow = new Float32Array(rows * C);
  const ok = new Uint8Array(rows * C);
  const floor = new THREE.Color(theme.floor), wall = new THREE.Color(theme.wall);
  for (let r = 0; r < rows; r++) {
    const i = r % S.n;
    const half = S.w[i] / 2;
    for (let c = 0; c < C; c++) {
      // the rail / rim columns sit just past the edge (a fixed metre-ish, not proportional)
      const f = fr[c];
      const lat = Math.abs(f) <= 1 ? f * half : Math.sign(f) * (half + (Math.abs(f) - 1) * (pipe ? 5.8 : 6.5)); // 1.1 → +0.65m (pipe rim), 1.12 → +0.78m (rail top)
      const x = S.x[i] - S.tz[i] * lat, z = S.z[i] + S.tx[i] * lat;
      const h = trackSurface(def, S, i, x, z, ctx);
      const k = r * C + c;
      pos[k * 3] = x; pos[k * 3 + 1] = h <= VOID ? S.y[i] : h; pos[k * 3 + 2] = z;
      ok[k] = h > VOID ? 1 : 0;
      const edge = Math.abs(f) >= 0.97;
      const cc = edge ? wall : floor;
      col[k * 3] = cc.r; col[k * 3 + 1] = cc.g; col[k * 3 + 2] = cc.b;
      uv[k * 2] = x / 6; uv[k * 2 + 1] = z / 6;
      glow[k] = Math.abs(f) >= 1.05 ? 1 : Math.abs(f) >= 0.99 ? 0.85 : 0;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < C; c++) {
    const a = r * C + c, b = a + 1, d = a + C, e = d + 1;
    if (ok[a] && ok[b] && ok[d] && ok[e]) idx.push(a, d, b, b, d, e);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: gridTexture(theme), roughness: 0.62, metalness: 0.15, side: THREE.DoubleSide });
  const glowColor = new THREE.Color(theme.glow).multiplyScalar(1.6);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.glowColor = { value: glowColor };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform vec3 glowColor;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += glowColor * smoothstep(0.5, 1.0, vGlow);');
  };
  const road = new THREE.Mesh(geo, mat);
  road.receiveShadow = true;
  group.add(road);
  // side walls: from each row's outermost solid edge straight down, glowing at the lip, smooth along the curve
  const sp: number[] = [], sg: number[] = [], si: number[] = [];
  const edgeOf = (r: number, side: 1 | -1) => {
    for (let c = side < 0 ? 0 : C - 1; side < 0 ? c < C : c >= 0; c -= side) if (ok[r * C + c]) return r * C + c;
    return -1;
  };
  for (const side of [-1, 1] as const) {
    let prev = -1;
    for (let r = 0; r < rows; r++) {
      const k = edgeOf(r, side);
      if (k < 0) { prev = -1; continue; }
      const base = sp.length / 3;
      sp.push(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2], pos[k * 3], pos[k * 3 + 1] - 3.2, pos[k * 3 + 2]);
      sg.push(1, 0);
      if (prev >= 0) si.push(prev, base, prev + 1, prev + 1, base, base + 1);
      prev = base;
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  wg.setAttribute('glow', new THREE.Float32BufferAttribute(sg, 1));
  wg.setIndex(si);
  wg.computeVertexNormals();
  const wmat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { c0: { value: new THREE.Color(theme.wall).multiplyScalar(0.55) }, c1: { value: new THREE.Color(theme.glow) } },
    vertexShader: 'attribute float glow; varying float g; void main(){ g = glow; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 c0; uniform vec3 c1; varying float g; void main(){ gl_FragColor = vec4(mix(c0, c1 * 1.3, pow(g, 6.0)), 1.0); }',
  });
  group.add(new THREE.Mesh(wg, wmat));
  // abyss + grid far below, sized to the track
  const b = trackBoundsOf(S);
  const span = Math.max(400, (b.x1 - b.x0) * 1.6, (b.z1 - b.z0) * 1.6);
  let lo = Infinity; for (let i = 0; i < S.n; i++) lo = Math.min(lo, S.y[i]);
  const abyss = new THREE.Mesh(new THREE.PlaneGeometry(span, span), new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.sky2).multiplyScalar(0.35) }));
  abyss.rotation.x = -Math.PI / 2;
  abyss.position.set((b.x0 + b.x1) / 2, lo - 10, (b.z0 + b.z1) / 2);
  group.add(abyss);
  const grid = new THREE.GridHelper(span, Math.round(span / 2), new THREE.Color(theme.grid), new THREE.Color(theme.grid));
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.12;
  grid.position.set((b.x0 + b.x1) / 2, lo - 9.9, (b.z0 + b.z1) / 2);
  group.add(grid);
  return group;
}

export interface RailBuild { group: THREE.Group; slings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; nx: number; nz: number; x: number; z: number; t: number }[] }
/**
 * Curved walls as neon slabs along their smooth curves: dark at the foot, glowing along the top. Slingshot faces are
 * separate meshes (pink) so they can snap out and flash when they kick. Used in matches and the Course Builder.
 */
export function buildRailMeshes(rails: import('./pinball').Rail[], theme: Theme, groundY: (x: number, z: number) => number): RailBuild {
  const group = new THREE.Group();
  const slings: RailBuild['slings'] = [];
  const foot = new THREE.Color(theme.wall).multiplyScalar(0.7);
  const plain = { pos: [] as number[], col: [] as number[], idx: [] as number[] };
  const body = new THREE.Color(theme.wall).multiplyScalar(0.55);
  const addRail = (r: import('./pinball').Rail, into: typeof plain, topCol: THREE.Color) => {
    const pl = railPolyline(r);
    if (pl.length < 2) return;
    // drawn slimmer than it collides (the glow reads as the edge), flyover rails slimmest
    const half = Math.min((r.t ?? 0.45) / 2, r.deck ? 0.07 : (r.t ?? 0.45) >= 0.6 ? 0.3 : 0.14), H0 = r.h ?? 1.3;
    const base = into.pos.length / 3;
    for (let i = 0; i < pl.length; i++) {
      const a = pl[Math.max(0, i - 1)], b = pl[Math.min(pl.length - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const [x, z] = pl[i];
      const lift = r.deck ? flyLiftAlong(r.deck, x, z) : 0;
      const g = groundY(x, z) + (r.below ? 0 : lift); // (a flyover's walls stand on its deck; its skirt hangs under it)
      const f0 = r.deck && !r.below ? g - 0.12 : g - 0.3;
      const H = r.below ? lift - 0.05 : H0;
      const cap = Math.min(0.12, H * 0.3); // only the top edge glows
      for (const [sx, yy, c] of [[1, f0, foot], [1, g + H - cap, body], [1, g + H, topCol], [-1, g + H, topCol], [-1, g + H - cap, body], [-1, f0, foot]] as const) {
        into.pos.push(x + nx * half * sx, yy, z + nz * half * sx);
        into.col.push(c.r, c.g, c.b);
      }
      if (i > 0) {
        const p0 = base + (i - 1) * 6, p1 = base + i * 6;
        for (let q = 0; q < 5; q++) into.idx.push(p0 + q, p1 + q, p0 + q + 1, p0 + q + 1, p1 + q, p1 + q + 1);
      }
    }
  };
  const mesh = (d: typeof plain, mat: THREE.Material) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3));
    geo.setIndex(d.idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  };
  const segs = railSegments(rails);
  const deckRails = { pos: [] as number[], col: [] as number[], idx: [] as number[] };
  const wireMat = new THREE.MeshBasicMaterial({ color: theme.glow, toneMapped: false });
  for (const r of rails) {
    if (r.deck && !r.below) {
      // a flyover's side: two thin glowing wires following the deck (a wireform — you can see the play under it)
      const pl = railPolyline(r);
      for (const hh of [0.3, 1.05]) {
        const pts = pl.map(([x, z]) => new THREE.Vector3(x, groundY(x, z) + flyLiftAlong(r.deck!, x, z) + hh, z));
        if (pts.length < 2) continue;
        group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.max(8, pts.length * 2), 0.055, 6, false), wireMat));
      }
      continue;
    }
    if (r.deck) { addRail(r, deckRails, new THREE.Color(theme.wall)); continue; }
    if (!r.kick) { addRail(r, plain, new THREE.Color(r.oneWay ? '#ffd23a' : theme.glow)); continue; } // (gates in gold)
    const one = { pos: [] as number[], col: [] as number[], idx: [] as number[] };
    addRail(r, one, new THREE.Color('#ffffff'));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false, color: '#ff5cf4' });
    const m = mesh(one, mat);
    group.add(m);
    // its kick direction = the face the sim kicks from
    const pl = railPolyline(r), mid = pl[Math.floor(pl.length / 2)];
    const sg = segs.find((q) => Math.hypot(q.ax - mid[0], q.az - mid[1]) < 0.6) ?? segs[0];
    slings.push({ mesh: m, mat, nx: sg?.kx ?? 0, nz: sg?.kz ?? 0, x: mid[0], z: mid[1], t: 0 });
  }
  if (plain.idx.length) group.add(mesh(plain, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false })));
  if (deckRails.idx.length) group.add(mesh(deckRails, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false, transparent: true, opacity: 0.6, depthWrite: false })));
  return { group, slings };
}

function trackBoundsOf(S: { n: number; x: Float32Array; z: Float32Array }) {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < S.n; i++) { x0 = Math.min(x0, S.x[i]); x1 = Math.max(x1, S.x[i]); z0 = Math.min(z0, S.z[i]); z1 = Math.max(z1, S.z[i]); }
  return { x0, x1, z0, z1 };
}

export function buildArenaMesh(terrain: Terrain, theme: Theme): THREE.Group {
  if (terrain.track) return buildTrackRibbon(terrain, theme);
  const group = new THREE.Group();
  const { nx, nz, cell, minX, minZ } = terrain;
  const N = nx * nz;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), uv = new Float32Array(N * 2), glow = new Float32Array(N);
  const floor = new THREE.Color(theme.floor), wall = new THREE.Color(theme.wall), voidC = new THREE.Color('#05060a');
  const slopeAt = (i: number, j: number) => {
    const h = terrain.raw(i, j);
    if (h <= VOID) return 0;
    const a = terrain.raw(i + 1, j), b = terrain.raw(i - 1, j), c = terrain.raw(i, j + 1), d = terrain.raw(i, j - 1);
    const fx = (a <= VOID ? h : a) - (b <= VOID ? h : b), fz = (c <= VOID ? h : c) - (d <= VOID ? h : d);
    return Math.hypot(fx, fz) / (2 * cell);
  };
  const slopes = new Float32Array(N);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) slopes[j * nx + i] = slopeAt(i, j);
  const tmp = new THREE.Color();
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = terrain.raw(i, j);
      const v = h <= VOID;
      const x = minX + i * cell, z = minZ + j * cell;
      pos[k * 3] = x; pos[k * 3 + 1] = v ? -7 : h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 3; uv[k * 2 + 1] = z / 3 + (v ? 0 : h / 3);
      const sl = slopes[k];
      tmp.copy(floor).lerp(wall, Math.min(1, sl / 2.2));
      if (!v) tmp.offsetHSL(0, 0, Math.min(0.12, h * 0.02));
      if (v) tmp.copy(voidC);
      col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
      // glow on lips (flat-ish next to steep drop/rise) and on void edges
      if (!v) {
        let edge = 0;
        for (let dj = -2; dj <= 2; dj++)
          for (let di = -2; di <= 2; di++) {
            const hh = terrain.raw(i + di, j + dj);
            if (hh <= VOID) edge = Math.max(edge, 1);
            else if (sl < 0.7 && h - hh > 0.6 && slopes[(j + dj) * nx + (i + di)] > 1.4) edge = Math.max(edge, 0.85);
          }
        glow[k] = edge;
      }
    }
  const idx: number[] = [];
  // big arenas render at half grid resolution (physics keeps full resolution)
  const st = nx * nz > 70000 ? 2 : 1;
  for (let j = 0; j + st < nz; j += st)
    for (let i = 0; i + st < nx; i += st) {
      const a = j * nx + i, b = a + st, c = a + nx * st, d = c + st;
      const va = terrain.h[a] <= VOID, vb = terrain.h[b] <= VOID, vc = terrain.h[c] <= VOID, vd = terrain.h[d] <= VOID;
      if (va && vb && vc && vd) continue;
      idx.push(a, c, b, b, c, d);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: gridTexture(theme), roughness: 0.62, metalness: 0.15 });
  // big floating quest levels have long drop-off faces; full-strength neon there blows the picture out
  const quest = terrain.def.markers.some((m) => m.kind === 'goal');
  const glowColor = new THREE.Color(theme.glow).multiplyScalar(quest ? 0.8 : 2.2);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.glowColor = { value: glowColor };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform vec3 glowColor;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += glowColor * smoothstep(0.5, 1.0, vGlow);');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  group.add(mesh);
  // abyss
  const abyss = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.sky2).multiplyScalar(0.35) }));
  abyss.rotation.x = -Math.PI / 2;
  abyss.position.y = -7.5;
  group.add(abyss);
  const grid = new THREE.GridHelper(400, 200, new THREE.Color(theme.grid), new THREE.Color(theme.grid));
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.12;
  grid.position.y = -7.4;
  group.add(grid);
  return group;
}

export function buildSky(theme: Theme) {
  const g = new THREE.Group();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { c1: { value: new THREE.Color(theme.sky1) }, c2: { value: new THREE.Color(theme.sky2) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 c1; uniform vec3 c2; varying vec3 vP; void main(){ float t = smoothstep(-0.3, 0.6, vP.y); gl_FragColor = vec4(mix(c2, c1, t), 1.0); }',
    }),
  );
  g.add(sky);
  const n = 1500;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * Math.PI * 2, v = Math.acos(Math.random() * 1.6 - 0.6), r = 250;
    p[i * 3] = Math.sin(v) * Math.cos(u) * r; p[i * 3 + 1] = Math.cos(v) * r; p[i * 3 + 2] = Math.sin(v) * Math.sin(u) * r;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.8 })));
  return g;
}

// ---------------------------------------------------------------- particles
class Particles {
  N = 3000;
  pos = new Float32Array(this.N * 3);
  vel = new Float32Array(this.N * 3);
  col = new Float32Array(this.N * 3);
  size = new Float32Array(this.N);
  life = new Float32Array(this.N);
  maxLife = new Float32Array(this.N);
  grav = new Float32Array(this.N);
  baseSize = new Float32Array(this.N);
  cursor = 0;
  points: THREE.Points;
  geo = new THREE.BufferGeometry();
  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, toneMapped: false,
      vertexShader: 'attribute float size; varying vec3 vC; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * (420.0 / -mv.z); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying vec3 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(vC * a * 1.6, a); }',
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, grav = 1) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.N;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
    this.life[i] = life; this.maxLife[i] = life; this.baseSize[i] = size; this.grav[i] = grav;
  }
  burst(x: number, y: number, z: number, n: number, speed: number, color: THREE.Color, size = 0.12, life = 0.6, up = 0.5, grav = 1) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      this.emit(x, y, z, Math.cos(a) * s, (Math.random() * 0.8 + up) * s, Math.sin(a) * s, color, size * (0.6 + Math.random() * 0.8), life * (0.5 + Math.random() * 0.8), grav);
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.N; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 14 * this.grav[i] * dt;
      const drag = 1 - 1.5 * dt;
      this.vel[i * 3] *= drag; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.baseSize[i] * Math.max(0, this.life[i] / this.maxLife[i]);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- trail ribbons
class Trail {
  N = 44;
  pts: THREE.Vector3[] = [];
  wid: number[] = [];
  geo = new THREE.BufferGeometry();
  pos = new Float32Array(this.N * 2 * 3);
  alpha = new Float32Array(this.N * 2);
  mesh: THREE.Mesh;
  acc = 0;
  constructor(color: string) {
    const idx: number[] = [];
    for (let i = 0; i < this.N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      uniforms: { color: { value: new THREE.Color(color).multiplyScalar(1.6) } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color * vA, vA); }',
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }
  reset(p: THREE.Vector3) { this.pts = []; this.wid = []; for (let i = 0; i < this.N; i++) { this.pts.push(p.clone()); this.wid.push(0); } }
  update(p: THREE.Vector3, width: number, dt: number) {
    if (!this.pts.length) this.reset(p);
    this.acc += dt;
    if (this.acc > 1 / 60) {
      this.acc = 0;
      this.pts.pop(); this.wid.pop();
      this.pts.unshift(p.clone()); this.wid.unshift(width);
    } else { this.pts[0].copy(p); this.wid[0] = width; }
    for (let i = 0; i < this.N; i++) {
      const a = this.pts[i], b = this.pts[Math.min(this.N - 1, i + 1)], c = this.pts[Math.max(0, i - 1)];
      let dx = c.x - b.x, dz = c.z - b.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d; dz /= d;
      const w = this.wid[i] * (1 - i / this.N);
      this.pos[i * 6] = a.x - dz * w; this.pos[i * 6 + 1] = a.y; this.pos[i * 6 + 2] = a.z + dx * w;
      this.pos[i * 6 + 3] = a.x + dz * w; this.pos[i * 6 + 4] = a.y; this.pos[i * 6 + 5] = a.z - dx * w;
      const al = Math.pow(1 - i / this.N, 1.5) * Math.min(1, this.wid[i] * 3);
      this.alpha[i * 2] = this.alpha[i * 2 + 1] = al;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- per-top view
interface TopView {
  root: THREE.Group;
  tilt: THREE.Group;
  model: BladeModel;
  ring: THREE.Mesh;
  shadow: THREE.Mesh;
  blur: THREE.Mesh;
  label: THREE.Sprite;
  trail: Trail;
  shield: THREE.Mesh;
  ice: THREE.Mesh;
  aura: THREE.Mesh;
  core: THREE.Mesh;
  arc: THREE.Line;
  arcPos: Float32Array;
  landing: THREE.Mesh;
  launchRing: THREE.Mesh;
  scale: number;
  color: THREE.Color;
  burstDone: boolean;
  fallT: number;
}

interface Debris { mesh: THREE.Object3D; v: THREE.Vector3; w: THREE.Vector3; t: number }

export class GameView {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 800);
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  renderer: THREE.WebGLRenderer;
  terrain: Terrain;
  cfg: MatchConfig;
  tops: TopView[] = [];
  particles = new Particles();
  rings: { mesh: THREE.Mesh; t: number; dur: number; r: number }[] = [];
  debris: Debris[] = [];
  hazardMeshes: { m: THREE.Object3D; mi: number }[] = [];
  flippers: { g: THREE.Group; mi: number }[] = [];
  targets: { mat: THREE.MeshStandardMaterial; mi: number }[] = [];
  portals: THREE.Mesh[] = [];
  drops: { g: THREE.Mesh; mi: number; y: number }[] = [];
  kickbacks: { mat: THREE.MeshBasicMaterial; mi: number }[] = [];
  posts: { g: THREE.Mesh; y: number }[] = [];
  lights: { mat: THREE.MeshBasicMaterial; mi: number; base: string }[] = [];
  plungerRod: { g: THREE.Group; z0: number } | null = null;

  slings: RailBuild['slings'] = [];
  bumpers: { g: THREE.Group; ring: THREE.Mesh; x: number; z: number; t: number }[] = [];

  /** rails: smooth neon walls (shared with the Course Builder); slingshot faces are kept to animate */
  buildRails() {
    const arenas = this.cfg.arena.markers.flatMap((m, mi) => (m.kind === 'arena' ? arenaRails(m, mi) : []));
    const rails = [...(this.cfg.arena.rails ?? []), ...(this.cfg.arena.ramps ?? []).flatMap(rampRails), ...arenas.filter((r) => r.gate === undefined)];
    for (const gr of arenas) {
      if (gr.gate === undefined) continue;
      const [a, b] = gr.pts, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mat = new THREE.MeshBasicMaterial({ color: '#ff2a6d', transparent: true, opacity: 0.75, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });
      const gate = new THREE.Mesh(new THREE.BoxGeometry(len, 1.5, 0.12), mat);
      const mx2 = (a[0] + b[0]) / 2, mz2 = (a[1] + b[1]) / 2;
      gate.position.set(mx2, this.groundY(mx2, mz2) + 0.75, mz2);
      gate.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      this.scene.add(gate);
      this.gates.push({ mesh: gate, mat, mi: gr.gate });
    }
    if (!rails.length) return;
    const b = buildRailMeshes(rails, this.cfg.arena.theme, (x, z) => this.groundY(x, z));
    this.scene.add(b.group);
    this.slings = b.slings;
    // ramp decks: a glowing deck over the raised path with chevrons pointing up it (so it reads as a ramp)
    for (const rp of this.cfg.arena.ramps ?? []) {
      if (rp.fly) { this.buildFlyover(rp); continue; }
      const pl = railPolyline({ pts: rp.pts });
      const half = (rp.w ?? 3) / 2;
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      let along = 0;
      for (let i = 0; i < pl.length; i++) {
        const a = pl[Math.max(0, i - 1)], b2 = pl[Math.min(pl.length - 1, i + 1)];
        let tx = b2[0] - a[0], tz = b2[1] - a[1];
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        if (i > 0) along += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
        for (const sd of [1, -1]) {
          const x = pl[i][0] - tz * half * 0.92 * sd, z = pl[i][1] + tx * half * 0.92 * sd;
          pos.push(x, this.groundY(x, z) + (rp.fly ? Math.max(0, flyLift(rp, pl[i][0], pl[i][1], 0)) + 0.06 : 0.04), z);
          uv.push(sd > 0 ? 0 : 1, -along / 3);
        }
        if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const deck = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: chevronTexture(this.cfg.arena.theme.glow, 2), transparent: true, opacity: rp.fly ? 0.18 : 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      this.scene.add(deck);
      this.boostMeshes.push(deck); // (the chevrons scroll up the ramp)
    }
  }
  /** a swarm drone: a dark quad body, four arms with spinning rotors, a red glow */
  makeDrone() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.55), new THREE.MeshStandardMaterial({ color: '#1a1d26', emissive: '#ff2a6d', emissiveIntensity: 0.9, metalness: 0.6, roughness: 0.35 }));
    g.add(body);
    const rotors: THREE.Mesh[] = [];
    const armMat = new THREE.MeshStandardMaterial({ color: '#2c3240', metalness: 0.7, roughness: 0.4 });
    const rotMat = new THREE.MeshBasicMaterial({ color: '#ffb3c8', transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2, ax = Math.cos(a) * 0.48, az = Math.sin(a) * 0.48;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.08), armMat);
      arm.position.set(ax / 2, 0, az / 2); arm.rotation.y = -a;
      const rot = new THREE.Mesh(new THREE.CircleGeometry(0.26, 16), rotMat);
      rot.rotation.x = -Math.PI / 2;
      const hub = new THREE.Group(); hub.position.set(ax, 0.08, az); hub.add(rot);
      g.add(arm, hub);
      rotors.push(hub as unknown as THREE.Mesh);
    }
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff2a6d', toneMapped: false }));
    eye.position.set(0.3, 0, 0);
    g.add(eye);
    g.scale.setScalar(1.7);
    g.visible = false;
    this.scene.add(g);
    return { g, rotors };
  }

  /** a flyover's body under its chevrons: a tinted see-through deck (so balls rolling beneath stay visible) and posts */
  buildFlyover(rp: import('./pinball').PinRamp) {
    const pl = railPolyline({ pts: rp.pts });
    const half = (rp.w ?? 3) / 2 + 0.3;
    // the deck: thin cross ties under the ball's path (a wireform), dark with a faint glow
    const tieMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.cfg.arena.theme.glow).multiplyScalar(0.45), toneMapped: false });
    let acc = 0;
    for (let i = 1; i < pl.length; i++) {
      acc += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
      if (acc < 1.4) continue;
      acc = 0;
      const [x, z] = pl[i], L = flyLift(rp, x, z, 0);
      if (L < 0.15) continue;
      const tie = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.06, 0.12), tieMat);
      tie.position.set(x, this.groundY(x, z) + L + 0.02, z);
      tie.rotation.y = -Math.atan2(pl[i][1] - pl[i - 1][1], pl[i][0] - pl[i - 1][0]) + Math.PI / 2;
      this.scene.add(tie);
    }
    const postMat = new THREE.MeshStandardMaterial({ color: '#2a3140', metalness: 0.7, roughness: 0.35 });
    let since = 0;
    for (let i = 1; i < pl.length; i++) {
      since += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
      const L = flyLift(rp, pl[i][0], pl[i][1], 0);
      if (since < 5.5 || L < 1.6) continue;
      since = 0;
      const a = pl[i - 1], b = pl[i];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      for (const sd of [1, -1]) {
        const x = pl[i][0] - tz * half * sd, z = pl[i][1] + tx * half * sd, g = this.groundY(x, z);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, L, 6), postMat);
        post.position.set(x, g + L / 2, z);
        this.scene.add(post);
      }
    }
  }
  gates: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; mi: number }[] = [];
  aims: { beam: THREE.Group; mi: number }[] = [];
  arenaRings: { mat: THREE.MeshBasicMaterial; mi: number }[] = [];
  hiveZones: THREE.Object3D[] = [];
  droneMeshes: { g: THREE.Group; rotors: THREE.Mesh[] }[] = [];
  boxMeshes: THREE.Mesh[] = [];
  crystalMeshes = new Map<number, THREE.Mesh>();
  gemMeshes = new Map<number, THREE.Mesh>();
  projMeshes = new Map<number, THREE.Mesh>();
  mineMeshes = new Map<number, THREE.Mesh>();
  flagViews: { pole: THREE.Group; orb: THREE.Mesh; base: THREE.Mesh }[] = [];
  zoneMesh: THREE.Mesh | null = null;
  boostMeshes: THREE.Mesh[] = [];
  checkpoints: { mi: number; banner: THREE.Mesh; pad: THREE.Mesh }[] = [];
  goalRing: THREE.Mesh | null = null;
  spinPads: { arms: THREE.Mesh[]; spin: number; beam: THREE.Mesh; ring: THREE.Mesh; x: number; z: number; r: number }[] = [];
  camTarget = new THREE.Vector3();
  camPos = new THREE.Vector3();
  shake = 0;
  time = 0;
  attract = false;
  focus: number[] = []; // local player ids the camera should follow (race)
  camFwd = { x: 0, z: -1 }; // camera forward on the ground plane (controls are camera-relative)
  chaseYaw: number | null = null;
  chaseSt: { sp?: number; back?: number } = {};
  /** screen fractions covered by HUD at the top / bottom — the arena camera keeps every blade between them */
  safe = { top: 0, bottom: 0 };
  private fitCam = new THREE.PerspectiveCamera();
  private fitDist = 0;
  private fitV = new THREE.Vector3();
  /** split-screen: one chase camera per local racer */
  splits: { id: number; cam: THREE.PerspectiveCamera; pos: THREE.Vector3; tgt: THREE.Vector3; yaw: number | null; cam3?: { sp?: number; back?: number }; fwd: { x: number; z: number } }[] = [];

  enableSplit(ids: number[]) {
    this.splits = ids.slice(0, 4).map((id) => ({ id, cam: new THREE.PerspectiveCamera(62, 1, 0.1, 800), pos: this.camPos.clone(), tgt: this.camTarget.clone(), yaw: null, fwd: { x: 0, z: -1 } }));
  }

  camFwdOf(id: number) { return this.splits.find((v) => v.id === id)?.fwd ?? this.camFwd; }

  /** viewport rects (CSS px, origin bottom-left like WebGL): 2 = top/bottom, 3-4 = quadrants */
  splitRects() {
    const W = innerWidth, H = innerHeight, n = this.splits.length;
    if (n === 2) return [[0, H / 2, W, H / 2], [0, 0, W, H / 2]];
    return [[0, H / 2, W / 2, H / 2], [W / 2, H / 2, W / 2, H / 2], [0, 0, W / 2, H / 2], [W / 2, 0, W / 2, H / 2]].slice(0, n);
  }
  sun: THREE.DirectionalLight;
  private shared = {
    crystalGeo: new THREE.OctahedronGeometry(0.28),
    crystalMat: new THREE.MeshStandardMaterial({ color: '#7ffcff', emissive: '#28e0ff', emissiveIntensity: 1.6, metalness: 0.3, roughness: 0.1 }),
    gemGeo: new THREE.IcosahedronGeometry(0.42),
    gemMat: new THREE.MeshStandardMaterial({ color: '#ff5cf4', emissive: '#ff2ad4', emissiveIntensity: 1.8, roughness: 0.1, flatShading: true }),
  };

  constructor(canvas: HTMLCanvasElement, cfg: MatchConfig) {
    const { renderer, env } = getRenderer(canvas);
    this.renderer = renderer;
    this.cfg = cfg;
    this.terrain = new Terrain(cfg.arena);
    const theme = cfg.arena.theme;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.6;
    this.scene.fog = new THREE.FogExp2(new THREE.Color(theme.sky2).getHex(), 0.008);
    this.scene.add(buildSky(theme));
    this.scene.add(buildArenaMesh(this.terrain, theme));
    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#20140a', 0.7));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    const S = this.terrain.size;
    sun.position.set(S * 0.4, S * 1.5, S * 0.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536);
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: S * 4 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.sun = sun;
    const rim = new THREE.PointLight(theme.glow, 40, S * 3);
    rim.position.set(0, 6, 0);
    this.scene.add(rim);
    this.scene.add(this.particles.points);

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.75, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.setSize(innerWidth, innerHeight);

    this.buildMarkers();
    this.buildRails();
    if (import.meta.env.DEV) (window as any).__r = this; // for the headless visual checks
    const T = this.terrain.track;
    if (T) {
      // checkered start/finish line + gantry
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 32;
      const c = cv.getContext('2d')!;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { c.fillStyle = (i + j) % 2 ? '#fff' : '#111'; c.fillRect(i * 16, j * 16, 16, 16); }
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      // the line is a strip of the road itself (flush through banking / crests, edge to edge); the arch stands on both edges
      const i0 = T.open ? 2 : 0;
      const lineGeo = this.roadDecal(i0, 1.4, (T.w[i0] / 2) * 0.995, 0.05);
      if (lineGeo) scaleV(lineGeo, 11.2 / T.w[i0]);
      if (lineGeo) this.scene.add(new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })));
      this.scene.add(this.roadArch(i0, Math.max(3.2, T.w[i0] * 0.55), 0.12, new THREE.MeshBasicMaterial({ color: theme.glow, toneMapped: false })));
      // direction chevrons every ~9m along the ribbon
      const chevMat = new THREE.MeshBasicMaterial({ map: chevronTexture(theme.glow, 2), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      for (let i = 10; i < T.n - 6; i += 18) {
        if (this.terrain.height(T.x[i], T.z[i]) <= VOID) continue;
        // a strip of the road itself: bends with the curve, tilts with banking, sits flush over crests
        const geo = this.roadDecal(i, T.width * 0.45, T.width * 0.45 * 0.5, 0.05);
        if (geo) this.scene.add(new THREE.Mesh(geo, chevMat));
      }
      this.boostMeshes.push(new THREE.Mesh(new THREE.BufferGeometry(), chevMat)); // scroll the chevrons too
      if (cfg.arena.track?.profile === 'pipe') {
        const half = T.width / 2;
        const hoopMat = new THREE.MeshBasicMaterial({ color: theme.glow, toneMapped: false });
        const hoopGeo = new THREE.TorusGeometry(half + 0.6, 0.11, 6, 40, Math.PI);
        for (let i = 6; i < T.n; i += 26) {
          const y = this.terrain.height(T.x[i], T.z[i]);
          if (y <= VOID) continue;
          const hoop = new THREE.Mesh(hoopGeo, hoopMat);
          hoop.rotation.order = 'YXZ';
          hoop.rotation.y = Math.atan2(T.tx[i], T.tz[i]);
          hoop.position.set(T.x[i], y + (cfg.arena.track.depth ?? 3) * 0.55, T.z[i]);
          this.scene.add(hoop);
        }
      }
    }
    cfg.players.forEach((p) => this.addTopView(p.blade));
    this.camPos.set(0, S * 1.2, S * 1.1);
    this.camera.position.copy(this.camPos);
    this.onResize();
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }

  addTopView(blade: MatchConfig['players'][0]['blade']) {
    const model = buildBladeModel(blade);
    const st = computeStats(blade);
    const root = new THREE.Group();
    const tilt = new THREE.Group();
    root.add(tilt);
    tilt.add(model.group);
    const scale = st.radius / model.outer;
    model.group.scale.setScalar(scale);
    model.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    const color = new THREE.Color(blade.glow);
    const blur = new THREE.Mesh(new THREE.CircleGeometry(st.radius * 1.02, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    blur.rotation.x = -Math.PI / 2;
    blur.position.y = model.height * scale * 0.72;
    tilt.add(blur);
    const ring = new THREE.Mesh(new THREE.RingGeometry(st.radius * 1.05, st.radius * 1.2, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    const shadow = new THREE.Mesh(new THREE.RingGeometry(0, st.radius * 1.1, 24, 3), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.4, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    const label = textSprite(this.cfg.players[this.tops.length]?.name ?? blade.name, '#' + color.getHexString());
    label.position.y = 1.5;
    root.add(label);
    const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(st.radius * 1.5, 2), new THREE.MeshBasicMaterial({ color: '#47b6ff', transparent: true, opacity: 0.25, wireframe: true, toneMapped: false }));
    shield.position.y = 0.5;
    root.add(shield);
    const ice = new THREE.Mesh(new THREE.IcosahedronGeometry(st.radius * 1.3, 0), new THREE.MeshStandardMaterial({ color: '#bff3ff', transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1, flatShading: true }));
    ice.position.y = 0.45;
    root.add(ice);
    const aura = new THREE.Mesh(new THREE.CylinderGeometry(st.radius * 1.4, st.radius * 1.6, 3, 24, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    aura.position.y = 1.5;
    root.add(aura);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 12), new THREE.MeshBasicMaterial({ color: '#fff', toneMapped: false }));
    core.position.y = 1.9;
    root.add(core);
    const trail = new Trail(blade.glow);
    const arcPos = new Float32Array(60 * 3);
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
    const arc = new THREE.Line(arcGeo, new THREE.LineDashedMaterial({ color, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.9, toneMapped: false }));
    arc.frustumCulled = false;
    const landing = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.65, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
    landing.rotation.x = -Math.PI / 2;
    const launchRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 48, 2, 0, Math.PI * 2), new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.9, toneMapped: false, side: THREE.DoubleSide }));
    launchRing.rotation.x = -Math.PI / 2;
    this.scene.add(root, ring, shadow, trail.mesh, arc, landing, launchRing);
    this.tops.push({ root, tilt, model, ring, shadow, blur, label, trail, shield, ice, aura, core, arc, arcPos, landing, launchRing, scale, color, burstDone: false, fallT: 0 });
  }

  buildMarkers() {
    const theme = this.cfg.arena.theme;
    const glow = new THREE.Color(theme.glow);
    const tiltA = this.cfg.arena.tilt ? Math.atan(this.cfg.arena.tilt) : 0;
    // (draped decals already follow the surface; arena dishes are level; arms and saws are posed every frame)
    const UNTILTED = new Set(['arena', 'arm', 'saw', 'hive', 'boost', 'checkpoint', 'goal', 'spinpad']);
    this.cfg.arena.markers.forEach((m, mi) => {
      const before = this.scene.children.length, nDrops = this.drops.length, nPosts = this.posts.length, hadRod = !!this.plungerRod;
      // on bridge tracks a marker belongs to the road it was placed on (its y), not the top surface
      this.terrain.hintY = m.y !== undefined ? m.y + 1.5 : undefined;
      const y = m.fly ? this.terrain.topHeight(m.x, m.z) : this.groundY(m.x, m.z); // (fly: on the flyover deck)
      let obj: THREE.Object3D | null = null;
      switch (m.kind) {
        case 'arm': {
          const g = new THREE.Group();
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.2, 16), new THREE.MeshStandardMaterial({ color: '#333', metalness: 0.9, roughness: 0.3 }));
          post.position.y = 0.6;
          const L = m.len ?? 4;
          const bar = new THREE.Mesh(new THREE.BoxGeometry(L, 0.4, 0.55), new THREE.MeshStandardMaterial({ color: '#ffb000', emissive: '#ff5a00', emissiveIntensity: 0.4, metalness: 0.5, roughness: 0.4 }));
          bar.position.set(L / 2, 0.45, 0);
          bar.castShadow = true;
          const stripe = new THREE.Mesh(new THREE.BoxGeometry(L, 0.08, 0.57), new THREE.MeshBasicMaterial({ color: '#ff2a00', toneMapped: false }));
          stripe.position.set(L / 2, 0.68, 0);
          g.add(post, bar, stripe);
          g.position.set(m.x, y, m.z);
          obj = g;
          break;
        }
        case 'saw': {
          const g = new THREE.Group();
          const shape = new THREE.Shape();
          const n = 16;
          for (let i = 0; i <= n * 2; i++) { const a = (i / (n * 2)) * Math.PI * 2, r = i % 2 ? 0.75 : 0.55; i ? shape.lineTo(Math.cos(a) * r, Math.sin(a) * r) : shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
          const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false });
          geo.rotateX(-Math.PI / 2);
          const saw = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#d9dde3', metalness: 1, roughness: 0.15, emissive: '#ff1a1a', emissiveIntensity: 0.25 }));
          saw.position.y = 0.35;
          saw.castShadow = true;
          g.add(saw);
          const glowRing = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.04, 6, 32), new THREE.MeshBasicMaterial({ color: '#ff2a2a', toneMapped: false }));
          glowRing.rotation.x = Math.PI / 2;
          glowRing.position.y = 0.3;
          g.add(glowRing);
          obj = g;
          // orbit path
          const path = new THREE.Mesh(new THREE.RingGeometry((m.r ?? 5) - 0.05, (m.r ?? 5) + 0.05, 96), new THREE.MeshBasicMaterial({ color: '#ff2a2a', transparent: true, opacity: 0.35, toneMapped: false }));
          path.rotation.x = -Math.PI / 2;
          path.position.set(m.x, y + 0.05, m.z);
          this.scene.add(path);
          break;
        }
        case 'bumper': {
          const g = new THREE.Group();
          const c = new THREE.Mesh(new THREE.CylinderGeometry(m.r ?? 0.8, (m.r ?? 0.8) * 1.1, 0.9, 32), new THREE.MeshStandardMaterial({ color: '#ff3db4', emissive: '#ff3db4', emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.3 }));
          c.position.y = 0.45;
          c.castShadow = true;
          const top = new THREE.Mesh(new THREE.TorusGeometry(m.r ?? 0.8, 0.07, 8, 32), new THREE.MeshBasicMaterial({ color: '#fff', toneMapped: false }));
          top.rotation.x = Math.PI / 2;
          top.position.y = 0.92;
          g.add(c, top);
          g.position.set(m.x, y, m.z);
          obj = g;
          this.bumpers.push({ g, ring: top, x: m.x, z: m.z, t: 0 });
          break;
        }
        case 'flipper': {
          // a tapered paddle: fat round end at the pivot, slim round tip; it swings round the pivot (see update)
          const L = m.len ?? 3.4, r0 = flipperHalf(0), r1 = flipperHalf(1);
          const sh = new THREE.Shape();
          sh.absarc(0, 0, r0, Math.PI / 2, Math.PI * 1.5, false);
          sh.lineTo(L, -r1);
          sh.absarc(L, 0, r1, -Math.PI / 2, Math.PI / 2, false);
          sh.lineTo(0, r0);
          const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.75, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2, curveSegments: 12 });
          geo.rotateX(Math.PI / 2); // shape in x/z, extruded downward → flip so it stands up from the floor
          geo.translate(0, 0.8, 0);
          const g = new THREE.Group();
          const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#c9d2e6', emissive: glow, emissiveIntensity: 0.12, metalness: 0.35, roughness: 0.4 }));
          body.castShadow = true;
          const rim = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 0.45, r0 * 0.45, 0.86, 16), new THREE.MeshStandardMaterial({ color: '#1a1f30', emissive: glow, emissiveIntensity: 0.5 }));
          rim.position.y = 0.45;
          g.add(body, rim);
          g.position.set(m.x, y, m.z);
          g.rotation.y = -(m.rot ?? 0);
          this.scene.add(g);
          this.flippers.push({ g, mi });
          break;
        }
        case 'target': {
          // a stand-up target: a glowing slab facing the playfield (lights gold when hit)
          const w = (m.r ?? 0.8) * 1.6;
          const mat = new THREE.MeshStandardMaterial({ color: '#202436', emissive: '#38ffb0', emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.4 });
          const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 1.1, 0.3), mat);
          slab.position.set(m.x, y + 0.55, m.z);
          slab.rotation.y = -(m.rot ?? 0);
          slab.castShadow = true;
          this.scene.add(slab);
          this.targets.push({ mat, mi });
          break;
        }
        case 'plunger': {
          // the plunger rod below the ball in its lane (pulls back as you charge it)
          const rod = new THREE.Group();
          const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 2.4, 12), new THREE.MeshStandardMaterial({ color: '#c9ced9', metalness: 0.9, roughness: 0.25 }));
          shaft.rotation.x = Math.PI / 2;
          const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.35, 20), new THREE.MeshStandardMaterial({ color: '#ff3b4a', emissive: '#ff3b4a', emissiveIntensity: 0.5 }));
          knob.rotation.x = Math.PI / 2;
          knob.position.z = -1.2;
          rod.add(shaft, knob);
          rod.position.set(m.x, y + 0.5, m.z + 2.1);
          this.scene.add(rod);
          this.plungerRod = { g: rod, z0: m.z + 2.1 };
          break;
        }
        case 'saucer': {
          // capture saucer: a dark cup with a glowing rim and an arrow showing where it kicks the ball out
          const r = m.r ?? 1;
          const cup = new THREE.Mesh(new THREE.CircleGeometry(r * 0.85, 32), new THREE.MeshBasicMaterial({ color: '#05060c' }));
          cup.rotation.x = -Math.PI / 2;
          cup.position.set(m.x, y + 0.04, m.z);
          const wcol = m.team === undefined ? '#38ffb0' : ['#ff3b4a', '#38ffb0', '#ffd23a', '#3cf2ff'][m.team % 4];
          const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.88, 0.1, 8, 40), new THREE.MeshBasicMaterial({ color: wcol, toneMapped: false }));
          rim.rotation.x = Math.PI / 2;
          rim.position.set(m.x, y + 0.1, m.z);
          const a = m.rot ?? -Math.PI / 2;
          const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.6, 3), new THREE.MeshBasicMaterial({ color: '#38ffb0', toneMapped: false, transparent: true, opacity: 0.7 }));
          arrow.rotation.order = 'YXZ'; arrow.rotation.y = -a + Math.PI / 2; arrow.rotation.x = Math.PI / 2;
          arrow.position.set(m.x + Math.cos(a) * (r + 0.5), y + 0.1, m.z + Math.sin(a) * (r + 0.5));
          this.scene.add(cup, rim, arrow);
          this.portals.push(rim);
          if (m.aim) {
            // an aim lock: a faint fan over the range you can swing through, and a beam along the aim while locked
            const fan = new THREE.Mesh(new THREE.RingGeometry(r + 0.3, r + 3.2, 24, 1, -a - m.aim, m.aim * 2), new THREE.MeshBasicMaterial({ color: '#ffe14a', transparent: true, opacity: 0.14, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
            fan.rotation.x = -Math.PI / 2;
            fan.position.set(m.x, y + 0.05, m.z);
            const beam = new THREE.Group();
            const bm = new THREE.MeshBasicMaterial({ color: '#ffe14a', transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false });
            for (let k = 0; k < 9; k++) {
              const dot = new THREE.Mesh(new THREE.CircleGeometry(0.3 - k * 0.015, 12), bm);
              dot.rotation.x = -Math.PI / 2;
              dot.position.set(r + 0.6 + k * 0.85, 0, 0);
              beam.add(dot);
            }
            const line = new THREE.Mesh(new THREE.PlaneGeometry(9 * 0.85, 0.07), bm);
            line.rotation.x = -Math.PI / 2;
            line.position.set(r + 0.6 + 4 * 0.85, -0.01, 0);
            beam.add(line);
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 3), bm);
            tip.rotation.z = -Math.PI / 2;
            tip.position.set(r + 0.6 + 9 * 0.85, 0, 0);
            beam.add(tip);
            beam.position.set(m.x, y + 0.12, m.z);
            beam.visible = false;
            this.scene.add(fan, beam);
            this.aims.push({ beam, mi });
          }
          break;
        }
        case 'arena': {
          // arena bowl: a glowing ring round the dish's floor and a core emblem in the middle (red = locked)
          const r = m.r ?? 2.6;
          const mat = new THREE.MeshBasicMaterial({ color: '#ff2a6d', transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false });
          const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.62, r * 0.7, 48, 1), mat);
          this.drape(ring, m.x, m.z, 1, 0.05);
          const core = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.45, 6, 1), mat);
          this.drape(core, m.x, m.z, 1, 0.05);
          const inner = new THREE.Mesh(new THREE.RingGeometry(r * 0.3, r * 0.33, 48, 1), mat);
          this.drape(inner, m.x, m.z, 1, 0.05);
          const rimR = r + 0.3;
          for (let k = 0; k < 6; k++) {
            const a = (m.rot ?? Math.PI / 2) + Math.PI / 6 + (k * Math.PI * 2) / 6;
            const px = m.x + Math.cos(a) * rimR, pz = m.z + Math.sin(a) * rimR, gy = this.groundY(px, pz);
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 6), new THREE.MeshStandardMaterial({ color: '#2a3140', metalness: 0.7, roughness: 0.35 }));
            pole.position.set(px, gy + 1.1, pz);
            const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), mat);
            lamp.position.set(px, gy + 2.25, pz);
            this.scene.add(pole, lamp);
          }
          this.scene.add(ring, core, inner);
          this.arenaRings.push({ mat, mi });
          break;
        }
        case 'rollover': {
          // spin rollover: a lane light on the floor
          const r = m.r ?? 0.9;
          const lmat = new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.8, toneMapped: false, side: THREE.DoubleSide, depthWrite: false });
          const disc = new THREE.Mesh(new THREE.RingGeometry(r * 0.45, r * 0.7, 6), lmat);
          disc.rotation.x = -Math.PI / 2;
          disc.position.set(m.x, y + 0.05, m.z);
          this.scene.add(disc);
          this.portals.push(disc);
          if (m.team !== undefined) this.lights.push({ mat: lmat, mi, base: '#ffd23a' });
          break;
        }
        case 'drop': {
          // a drop-target plate: stands up facing rot; sinks into the floor when hit (see update)
          const w = (m.r ?? 0.8) * 2;
          const plate = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.0, w), new THREE.MeshStandardMaterial({ color: '#2a1d10', emissive: '#ff9a2a', emissiveIntensity: 0.8, metalness: 0.3, roughness: 0.4 }));
          plate.position.set(m.x, y + 0.5, m.z);
          plate.rotation.y = -(m.rot ?? 0);
          plate.castShadow = true;
          this.scene.add(plate);
          this.drops.push({ g: plate, mi, y });
          break;
        }
        case 'kickback': {
          const kmat = new THREE.MeshBasicMaterial({ color: '#38ffb0', toneMapped: false, transparent: true, opacity: 0.9 });
          const a = m.rot ?? -Math.PI / 2;
          const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 3), kmat);
          arrow.rotation.order = 'YXZ'; arrow.rotation.y = -a + Math.PI / 2; arrow.rotation.x = Math.PI / 2;
          arrow.position.set(m.x, y + 0.08, m.z);
          this.scene.add(arrow);
          this.kickbacks.push({ mat: kmat, mi });
          break;
        }
        case 'post': {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(m.r ?? 0.45, m.r ?? 0.45, 1.1, 16), new THREE.MeshStandardMaterial({ color: '#d8dce8', emissive: '#3cf2ff', emissiveIntensity: 0.6, metalness: 0.6, roughness: 0.3 }));
          post.position.set(m.x, y - 0.6, m.z);
          this.scene.add(post);
          this.posts.push({ g: post, y });
          break;
        }
        case 'portal': {
          const colors = ['#b46bff', '#3cf2ff', '#ffd23a', '#38ffb0'];
          const col = colors[(m.team ?? 0) % colors.length];
          const r = m.r ?? 1;
          const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.12, 8, 40), new THREE.MeshBasicMaterial({ color: col, toneMapped: false }));
          ring.rotation.x = Math.PI / 2;
          ring.position.set(m.x, y + 0.15, m.z);
          const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 0.92, 40), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
          disc.rotation.x = -Math.PI / 2;
          disc.position.set(m.x, y + 0.08, m.z);
          this.scene.add(ring, disc);
          this.portals.push(ring);
          break;
        }
        case 'pillar': {
          const c = new THREE.Mesh(new THREE.CylinderGeometry(m.r ?? 0.8, (m.r ?? 0.8) * 1.15, 2.4, 8), new THREE.MeshStandardMaterial({ color: '#2a2a33', emissive: glow, emissiveIntensity: 0.15, roughness: 0.7, flatShading: true }));
          c.position.set(m.x, y + 1.2, m.z);
          c.castShadow = true;
          this.scene.add(c);
          break;
        }
        case 'boost': {
          const pad = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(new THREE.PlaneGeometry((m.r ?? 0.9) * 2, this.terrain.track ? 3.6 : 2.8), new THREE.MeshBasicMaterial({ map: chevronTexture('#ffe23a'), blending: THREE.AdditiveBlending, transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
          const r = m.rot ?? 0;
          const TT = this.terrain.track;
          if (TT) {
            // on tracks the pad is a strip of road, following its curve and tilt
            let bi = 0, bd = Infinity;
            for (let k = 0; k < TT.n; k++) { const d = (TT.x[k] - m.x) ** 2 + (TT.z[k] - m.z) ** 2; if (d < bd) { bd = d; bi = k; } }
            const geo = this.roadDecal(bi, 3.6, m.r ?? 0.9, 0.06, m.x - TT.x[bi], m.z - TT.z[bi]);
            if (geo) { pad.geometry.dispose(); pad.geometry = geo; }
          } else {
            pad.rotation.order = 'YXZ';
            pad.rotation.y = planeYaw(Math.sin(r), Math.cos(r)); // sim pushes along (sin rot, cos rot)
            pad.rotation.x = -Math.PI / 2;
            pad.position.set(m.x, y + 0.05, m.z);
            this.drape(pad, m.x, m.z, 1, 0.05, planeYaw(Math.sin(r), Math.cos(r)));
          }
          this.scene.add(pad);
          this.boostMeshes.push(pad);
          break;
        }
        case 'checkpoint': {
          // a glowing gate you roll through; lights up once touched (see update)
          const r = m.r ?? 2.2;
          const gate = new THREE.Group();
          const postMat = new THREE.MeshStandardMaterial({ color: '#1a2a2a', emissive: '#38ffb0', emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.4 });
          for (const sgn of [-1, 1]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.6, 8), postMat);
            post.position.set(sgn * r, 1.3, 0);
            gate.add(post);
          }
          const banner = new THREE.Mesh(new THREE.BoxGeometry(r * 2 + 0.3, 0.32, 0.08), new THREE.MeshBasicMaterial({ color: '#38ffb0', toneMapped: false }));
          banner.position.y = 2.6;
          gate.add(banner);
          gate.position.set(m.x, y, m.z);
          gate.rotation.y = m.rot ?? this.routeYaw(m.x, m.z, mi);
          const pad = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(new THREE.RingGeometry(r * 0.85, r, 40, 2), new THREE.MeshBasicMaterial({ color: '#38ffb0', transparent: true, opacity: 0.5, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
          const TT = this.terrain.track;
          if (TT) {
            // on a track the gate spans the road: posts stand on each edge, the banner runs edge to edge
            const bi = this.trackIdx(m.x, m.z, m.y);
            const span = (TT.w[bi] / 2) * 0.98;
            const L = this.roadPoint(bi, span), R = this.roadPoint(bi, -span);
            gate.clear();
            const top = Math.max(L.y, R.y) + 2.6;
            for (const P of [L, R]) {
              const hgt = top - P.y + 0.1;
              const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, hgt, 8), postMat);
              post.position.set(P.x, P.y - 0.1 + hgt / 2, P.z);
              gate.add(post);
            }
            banner.geometry.dispose();
            banner.geometry = new THREE.BoxGeometry(span * 2 + 0.3, 0.32, 0.08);
            banner.position.set((L.x + R.x) / 2, top, (L.z + R.z) / 2);
            banner.rotation.y = Math.atan2(TT.tx[bi], TT.tz[bi]);
            gate.add(banner);
            gate.position.set(0, 0, 0);
            gate.rotation.set(0, 0, 0);
            const geo = this.roadDecal(bi, 0.8, span, 0.05);
            if (geo) { pad.geometry.dispose(); pad.geometry = geo; }
            else this.drape(pad, m.x, m.z, 1, 0.05);
          } else this.drape(pad, m.x, m.z, 1, 0.05);
          this.scene.add(gate, pad);
          this.checkpoints.push({ mi, banner, pad });
          break;
        }
        case 'goal': {
          // a big checkered portal ring with a light column
          const TT = this.terrain.track;
          const bi = TT ? this.trackIdx(m.x, m.z, m.y) : 0;
          // on a track the finish spans the road: centred on it, as wide as it
          const C = TT ? this.roadPoint(bi, 0) : new THREE.Vector3(m.x, y, m.z);
          const r = TT ? (TT.w[bi] / 2) * 0.98 : m.r ?? 2.6;
          const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.22, 10, 48), new THREE.MeshBasicMaterial({ color: '#ffd23a', toneMapped: false }));
          ring.position.set(C.x, C.y + r - (TT ? 0.15 : -0.3), C.z);
          ring.rotation.y = TT ? Math.atan2(TT.tx[bi], TT.tz[bi]) : m.rot ?? this.routeYaw(m.x, m.z, mi);
          const pad = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(new THREE.RingGeometry(0, r, 40, 3), new THREE.MeshBasicMaterial({ map: checkerTexture(), transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
          const pg = TT ? this.roadDecal(bi, 2.2, r, 0.05) : null;
          if (pg) { scaleV(pg, 2.2 / (2 * r)); pad.geometry.dispose(); pad.geometry = pg; (pad.material.map as THREE.Texture).wrapS = THREE.RepeatWrapping; }
          else this.drape(pad, m.x, m.z, 1, 0.05);
          const beam = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 14, 32, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
          beam.position.set(C.x, C.y + 7, C.z);
          this.scene.add(ring, pad, beam);
          this.goalRing = ring;
          break;
        }
        case 'hive': {
          // drone nest: dark hex dome + a red zone ring showing where its drones will hunt you
          const r = m.r ?? 8;
          const dome = new THREE.Mesh(new THREE.SphereGeometry(1.1, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#221016', emissive: '#ff2244', emissiveIntensity: 0.35, flatShading: true, metalness: 0.5, roughness: 0.5 }));
          dome.position.set(m.x, y, m.z);
          const zone = new THREE.Mesh(new THREE.RingGeometry(r - 0.18, r, 64, 1), new THREE.MeshBasicMaterial({ color: '#ff2244', transparent: true, opacity: 0.55, toneMapped: false, depthWrite: false }));
          this.drape(zone, m.x, m.z, 1, 0.06);
          const fill = new THREE.Mesh(new THREE.RingGeometry(0, r, 48, 4), new THREE.MeshBasicMaterial({ color: '#ff2244', transparent: true, opacity: 0.06, toneMapped: false, depthWrite: false }));
          this.drape(fill, m.x, m.z, 1, 0.04);
          this.scene.add(dome, zone, fill);
          if (this.cfg.mode === 'pinball') { zone.visible = fill.visible = false; this.hiveZones.push(zone, fill); }
          break;
        }
        case 'spinpad': {
          const r = m.r ?? 1.1;
          const col = '#38ffb0';
          // ring + swirl arms are draped onto the surface (bowls curve; flat discs would cut into them)
          const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.82, r, 48, 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }));
          this.drape(ring, m.x, m.z, 1, 0.05);
          this.scene.add(ring);
          // three swirl arms that spin (so it reads as "re-spin here")
          const armMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });
          const arms: THREE.Mesh[] = [];
          for (let k = 0; k < 3; k++) {
            const arm = new THREE.Mesh(new THREE.RingGeometry(r * 0.25, r * 0.7, 16, 3, (k * Math.PI * 2) / 3, Math.PI / 2.2), armMat);
            this.drape(arm, m.x, m.z, 1, 0.06);
            this.scene.add(arm);
            arms.push(arm);
          }
          // soft light column so pads are visible across the arena
          const beam = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r, 2.2, 32, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.1, toneMapped: false, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
          beam.position.set(m.x, y + 1.1, m.z);
          this.scene.add(beam);
          this.spinPads.push({ arms, spin: 0, beam, ring, x: m.x, z: m.z, r });
          break;
        }
      }
      if (obj && (m.kind === 'arm' || m.kind === 'saw')) { this.scene.add(obj); this.hazardMeshes.push({ m: obj, mi }); }
      else if (obj) this.scene.add(obj);
      if (tiltA && !UNTILTED.has(m.kind)) {
        // re-hang this piece's meshes in a group tilted with the table, pivoting where it stands
        const added = this.scene.children.splice(before);
        const pivot = new THREE.Group();
        pivot.position.set(m.x, y, m.z);
        pivot.rotation.x = tiltA;
        for (const c of added) { c.position.sub(pivot.position); pivot.add(c); }
        this.scene.add(pivot);
        for (const d of this.drops.slice(nDrops)) d.y -= y;
        for (const p of this.posts.slice(nPosts)) p.y -= y;
        if (!hadRod && this.plungerRod) this.plungerRod.z0 -= m.z;
      }
    });
    this.terrain.hintY = undefined;
  }

  /** surface height for placing props (bowls go below 0; void counts as 0) */
  groundY(x: number, z: number) {
    const h = this.terrain.height(x, z);
    return h <= VOID ? 0 : h;
  }

  ensureObjects(s: GameState) {
    // item boxes
    while (this.boxMeshes.length < s.boxes.length) {
      const tex = questionTexture();
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.75, 0.75), new THREE.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.6, transparent: true, opacity: 0.92 }));
      this.scene.add(m);
      this.boxMeshes.push(m);
    }
    if (s.flags.length && !this.flagViews.length) {
      for (const f of s.flags) {
        const col = f.team === 0 ? '#ff3b4a' : '#3b8bff';
        const pole = new THREE.Group();
        const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.8, flatShading: true }));
        orb.position.y = 1.0;
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.04, 6, 32), new THREE.MeshBasicMaterial({ color: col, toneMapped: false }));
        halo.position.y = 1.0;
        orb.add(halo);
        pole.add(orb);
        const base = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.0, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, toneMapped: false, side: THREE.DoubleSide }));
        base.rotation.x = -Math.PI / 2;
        base.position.set(f.hx, f.hy + 0.05, f.hz);
        this.scene.add(pole, base);
        this.flagViews.push({ pole, orb, base });
      }
    }
    if (s.zone && !this.zoneMesh) {
      this.zoneMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2.5, 48, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.18, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      this.scene.add(this.zoneMesh);
    }
    sync(this.crystalMeshes, s.crystals, () => new THREE.Mesh(this.shared.crystalGeo, this.shared.crystalMat), this.scene);
    sync(this.gemMeshes, s.gems, () => new THREE.Mesh(this.shared.gemGeo, this.shared.gemMat), this.scene);
    sync(this.projMeshes, s.projs, () => new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 8), new THREE.MeshBasicMaterial({ color: '#ffb35c', toneMapped: false })), this.scene);
    sync(this.mineMeshes, s.mines, () => new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), new THREE.MeshStandardMaterial({ color: '#9fe8ff', emissive: '#5fd6ff', emissiveIntensity: 1.2, flatShading: true })), this.scene);
  }

  /** world point on a horizontal plane at height y under screen ndc */
  groundPoint(ndc: { x: number; y: number }, y = 0, id = -1) {
    const ray = new THREE.Raycaster();
    let cam: THREE.Camera = this.camera, nx = ndc.x, ny = ndc.y;
    const k = this.splits.findIndex((v) => v.id === id);
    if (k >= 0 && this.splits.length > 1 && this.terrain.track) {
      // remap full-screen NDC into this player's viewport
      const [vx, vy, vw, vh] = this.splitRects()[k];
      const px = ((ndc.x + 1) / 2) * innerWidth, py = ((ndc.y + 1) / 2) * innerHeight;
      nx = ((px - vx) / vw) * 2 - 1; ny = ((py - vy) / vh) * 2 - 1;
      cam = this.splits[k].cam;
    }
    ray.setFromCamera(new THREE.Vector2(nx, ny), cam);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, p) ? { x: p.x, z: p.z } : null;
  }

  handleEvents(events: GameEvent[], s: GameState) {
    const white = new THREE.Color('#ffffff');
    for (const e of events) {
      switch (e.k) {
        case 'clash': {
          const ca = this.tops[e.a]?.color ?? white, cb = this.tops[e.b]?.color ?? white;
          const n = Math.min(80, 10 + e.s * 5);
          this.particles.burst(e.x, e.y, e.z, n / 2, 4 + e.s * 0.9, ca, 0.14, 0.5, 0.2);
          this.particles.burst(e.x, e.y, e.z, n / 2, 4 + e.s * 0.9, cb, 0.14, 0.5, 0.2);
          this.particles.burst(e.x, e.y, e.z, n / 3, 6 + e.s, white, 0.08, 0.3, 0.3);
          if (e.s > 7) this.ring(e.x, e.y, e.z, '#ffffff', 1.5 + e.s * 0.12, 0.3);
          this.shake = Math.min(1, this.shake + e.s * 0.04);
          break;
        }
        case 'land':
          this.ring(e.x, e.y + 0.05, e.z, '#' + (this.tops[e.id]?.color.getHexString() ?? 'ffffff'), 1 + e.s * 0.25, 0.45);
          this.particles.burst(e.x, e.y + 0.1, e.z, 18, 2 + e.s * 0.4, new THREE.Color('#9aa0b5'), 0.22, 0.6, 0.15, 0.4);
          this.shake = Math.min(1, this.shake + e.s * 0.03);
          break;
        case 'grind': {
          const c = this.tops[e.id]?.color ?? white;
          this.particles.burst(e.x, e.y + 0.1, e.z, 3, 4, c, 0.1, 0.35, 0.4);
          this.particles.burst(e.x, e.y + 0.1, e.z, 2, 5, new THREE.Color('#ffd27a'), 0.07, 0.3, 0.4);
          break;
        }
        case 'burst': this.burstTop(e.id, s); this.ring(e.x, e.y + 0.2, e.z, '#ffffff', 5, 0.6); this.shake = 1; break;
        case 'shock': this.ring(e.x, e.y, e.z, e.c, e.r, 0.5); this.particles.burst(e.x, e.y, e.z, 40, 9, new THREE.Color(e.c), 0.16, 0.5, 0.1); this.shake = Math.min(1, this.shake + 0.4); break;
        case 'pickup': {
          const c = e.what === 'crystal' ? '#7ffcff' : e.what === 'gem' ? '#ff5cf4' : e.what === 'boost' ? '#ffe23a' : '#ffffff';
          this.particles.burst(e.x, e.y, e.z, e.what === 'box' ? 30 : 16, 4, new THREE.Color(c), 0.15, 0.5, 0.6);
          if (e.what === 'gem' || e.what === 'flag') this.ring(e.x, e.y, e.z, c, 2.2, 0.4);
          break;
        }
        case 'hazard': if (this.cfg.mode !== 'pinball') { this.particles.burst(e.x, e.y, e.z, 25, 6, new THREE.Color('#ffb000'), 0.12, 0.4, 0.3); this.shake = Math.min(1, this.shake + 0.25); } break;
        case 'pin': {
          const near = <T extends { x: number; z: number }>(list: T[]) => list.reduce<T | null>((best, o) => (!best || Math.hypot(o.x - e.x, o.z - e.z) < Math.hypot(best.x - e.x, best.z - e.z) ? o : best), null);
          if (e.what === 'sling') { const sl = near(this.slings); if (sl) sl.t = 0.16; this.particles.burst(e.x, e.y + 0.4, e.z, 10, 5, new THREE.Color('#ff5cf4'), 0.08, 0.3, 0.2); }
          if (e.what === 'bumper') { const bp = near(this.bumpers); if (bp) bp.t = 0.2; this.particles.burst(e.x, e.y + 0.6, e.z, 14, 6, new THREE.Color('#ff3db4'), 0.1, 0.35, 0.25); }
          if (e.what === 'target' || e.what === 'rollover' || e.what === 'capture') this.particles.burst(e.x, e.y + 0.5, e.z, 16, 4, new THREE.Color(e.what === 'target' ? '#ffd23a' : '#38ffb0'), 0.1, 0.4, 0.2);
          if (e.what === 'multiball' || e.what === 'tilt') this.shake = Math.min(1, this.shake + 0.5);
          if (e.what === 'drone') { this.particles.burst(e.x, e.y, e.z, 30, 8, new THREE.Color('#ff2a6d'), 0.12, 0.5, 0.35); this.shake = Math.min(1, this.shake + 0.2); }
          if (e.what === 'zap') this.particles.burst(e.x, e.y, e.z, 12, 5, new THREE.Color('#9ad8ff'), 0.06, 0.25, 0.15);
          if (e.what === 'fire' || e.what === 'lock') this.particles.burst(e.x, e.y + 0.4, e.z, 14, 5, new THREE.Color('#39ff9c'), 0.08, 0.3, 0.2);
          if (e.what === 'duel' || e.what === 'duelwin' || e.what === 'unlock' || e.what === 'swarm') { this.particles.burst(e.x, e.y + 0.8, e.z, 40, 9, new THREE.Color(e.what === 'duelwin' ? '#ffd23a' : '#ff2a6d'), 0.12, 0.6, 0.4); this.shake = Math.min(1, this.shake + 0.35); }
          break;
        }
        case 'dash': { const t = s.tops[e.id]; if (t) this.particles.burst(t.x, t.y + 0.2, t.z, 14, 3, this.tops[e.id].color, 0.2, 0.35, 0.1, 0.2); break; }
        case 'special': { const t = s.tops[e.id]; if (t) { this.ring(t.x, t.y + 0.1, t.z, '#' + this.tops[e.id].color.getHexString(), 4, 0.5); this.particles.burst(t.x, t.y + 0.5, t.z, 60, 7, this.tops[e.id].color, 0.2, 0.8, 0.8, 0.3); } break; }
        case 'use': { const t = s.tops[e.id]; if (t) { this.particles.burst(t.x, t.y + 0.8, t.z, e.item === 'surge' ? 60 : 20, e.item === 'surge' ? 7 : 3, new THREE.Color(ITEMS[e.item].color), 0.18, 0.5, 1, 0.3); if (e.item === 'surge') this.ring(t.x, t.y + 0.1, t.z, '#38ffb0', 4, 0.5); } break; }
        case 'finish': if (e.type !== 'burst') this.shake = Math.min(1, this.shake + 0.5); break;
      }
    }
  }

  /**
   * Travel direction at a point, as a rotation.y: along the road on tracks, else toward the next waypoint
   * (next checkpoint / goal) — so gates stand across the route you take.
   */
  routeYaw(x: number, z: number, mi: number) {
    const T = this.terrain.track;
    if (T) {
      let best = 0, bd = Infinity;
      for (let i = 0; i < T.n; i += 2) { const d = (T.x[i] - x) ** 2 + (T.z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
      return Math.atan2(T.tx[best], T.tz[best]);
    }
    const ms = this.cfg.arena.markers;
    const prev = [...ms.slice(0, mi)].reverse().find((m) => m.kind === 'checkpoint' || m.kind === 'spawn');
    // the real route into this gate (tile pathfinding): face across its last step
    const route = prev ? questRoute(this, prev.x, prev.z, x, z) : null;
    if (route && route.length >= 2) { const a = route[route.length - 2], b = route[route.length - 1]; if (Math.hypot(b.x - a.x, b.z - a.z) > 0.5) return Math.atan2(b.x - a.x, b.z - a.z); }
    if (route && route.length === 1 && prev) return Math.atan2(x - prev.x, z - prev.z);
    const next = ms.slice(mi + 1).find((m) => m.kind === 'checkpoint' || m.kind === 'goal');
    return next ? Math.atan2(next.x - x, next.z - z) : prev ? Math.atan2(x - prev.x, z - prev.z) : Math.PI / 2;
  }

  /**
   * A decal that is a piece of the track surface: `len` metres along the centre line around sample `i`,
   * `halfW` either side, every vertex at the real ground height (+lift). UV v runs along travel, u left→right,
   * so chevron textures point the way you drive, through curves, banking and crests. (ox, oz) shifts it sideways.
   */
  /** nearest centre-line sample; with y, in 3D (so a marker on a bridge picks the bridge, not the road under it) */
  trackIdx(x: number, z: number, y?: number) {
    const T = this.terrain.track!;
    let bi = 0, bd = Infinity;
    for (let k = 0; k < T.n; k++) {
      const d = (T.x[k] - x) ** 2 + (T.z[k] - z) ** 2 + (y === undefined ? 0 : (T.y[k] - y) ** 2);
      if (d < bd) { bd = d; bi = k; }
    }
    return bi;
  }

  /** the road surface `lat` metres left (+) / right (-) of centre-line sample i */
  roadPoint(i: number, lat: number) {
    const T = this.terrain.track!;
    const x = T.x[i] - T.tz[i] * lat, z = T.z[i] + T.tx[i] * lat;
    const h = trackSurface(this.terrain.def.track!, T, i, x, z, (this.sctx ??= surfaceCtx(this.terrain.def.track!, T)));
    return new THREE.Vector3(x, h <= VOID ? T.y[i] : h, z);
  }

  /** an arch over the road at sample i: feet on both road edges (whatever the banking), `rise` metres high */
  roadArch(i: number, rise: number, thick: number, mat: THREE.Material) {
    const T = this.terrain.track!;
    const span = (T.w[i] / 2) * 0.98;
    const L = this.roadPoint(i, span), R = this.roadPoint(i, -span);
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= 32; s++) {
      const a = (Math.PI * s) / 32, c = Math.cos(a), lat = c * span, u = (1 - c) / 2;
      pts.push(new THREE.Vector3(T.x[i] - T.tz[i] * lat, L.y + (R.y - L.y) * u + Math.sin(a) * rise - 0.1, T.z[i] + T.tx[i] * lat));
    }
    return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, thick, 8, false), mat);
  }

  private sctx: SurfaceCtx | null = null;
  roadDecal(i: number, len: number, halfW: number, lift: number, ox = 0, oz = 0) {
    const T = this.terrain.track;
    if (!T) return null;
    const k = Math.max(2, Math.round(len / 0.5));
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let s = 0; s <= k; s++) {
      let j = i - Math.floor(k / 2) + s;
      j = T.open ? Math.max(0, Math.min(T.n - 1, j)) : ((j % T.n) + T.n) % T.n;
      for (const side of [-1, 1]) {
        // left of travel is (-tz, tx)
        const x = T.x[j] - T.tz[j] * halfW * side * -1 + ox, z = T.z[j] + T.tx[j] * halfW * side * -1 + oz;
        // the exact road formula at this sample (what the road mesh is built from): flush right to the edges, and the
        // right level of a bridge
        const h = trackSurface(this.terrain.def.track!, T, j, x, z, (this.sctx ??= surfaceCtx(this.terrain.def.track!, T)));
        if (h <= VOID) return null; // overlaps a gap or the edge: no decal hanging in the air
        pos.push(x, h + lift, z);
        uv.push(side < 0 ? 1 : 0, s / k);
      }
      if (s > 0) { const a = (s - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** quest: the next checkpoint after `qcp` (marker index), else the goal */
  questWaypoint(qcp: number) {
    const ms = this.cfg.arena.markers;
    for (let i = qcp + 1; i < ms.length; i++) if (ms[i].kind === 'checkpoint') return ms[i];
    return ms.find((m) => m.kind === 'goal') ?? null;
  }

  /** quest: a floating arrow over each of your blades pointing at where to go next */
  questArrows: THREE.Mesh[] = [];
  updateQuestArrows(s: GameState) {
    if (this.cfg.mode !== 'quest') return;
    this.focus.forEach((id, k) => {
      let a = this.questArrows[k];
      if (!a) {
        const shape = new THREE.Shape();
        shape.moveTo(0, 0.9); shape.lineTo(0.55, 0); shape.lineTo(0.2, 0.05); shape.lineTo(0.2, -0.6); shape.lineTo(-0.2, -0.6); shape.lineTo(-0.2, 0.05); shape.lineTo(-0.55, 0); shape.closePath();
        a = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: '#38ffb0', transparent: true, opacity: 0.85, side: THREE.DoubleSide, toneMapped: false, depthWrite: false }));
        a.rotation.order = 'YXZ';
        this.scene.add(a);
        this.questArrows[k] = a;
      }
      const t = s.tops[id];
      const wp = t && this.questWaypoint(t.qcp ?? -1);
      a.visible = !!(t && t.alive && wp && s.phase === 'battle');
      if (!a.visible || !wp || !t) return;
      const dx = wp.x - t.x, dz = wp.z - t.z, d = Math.hypot(dx, dz);
      a.visible = d > 4;
      const yaw = Math.atan2(dx, dz);
      a.position.set(t.x + (dx / (d || 1)) * 1.6, t.y + 1.9 + Math.sin(this.time * 4) * 0.12, t.z + (dz / (d || 1)) * 1.6);
      a.rotation.set(-Math.PI / 2, yaw + Math.PI, 0);
      (a.material as THREE.MeshBasicMaterial).color.set(wp.kind === 'goal' ? '#ffd23a' : '#38ffb0');
    });
  }

  /**
   * Lay a flat ring / disc (built in the XY plane) onto the terrain around (cx, cz): every vertex sits on the
   * surface + lift. `scale` and `angle` are applied to the flat shape first (so animated pads stay draped).
   */
  drape(m: THREE.Mesh, cx: number, cz: number, scale: number, lift: number, angle = 0) {
    const g = m.geometry as THREE.BufferGeometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    let base = m.userData.flat as Float32Array | undefined;
    if (!base) { base = Float32Array.from(pos.array as ArrayLike<number>); m.userData.flat = base; m.rotation.set(0, 0, 0); m.frustumCulled = false; }
    let y0 = this.terrain.height(cx, cz);
    if (y0 <= VOID) y0 = 0;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let i = 0; i < pos.count; i++) {
      const fx = base[i * 3] * scale, fy = base[i * 3 + 1] * scale;
      // flat XY → ground XZ, same facing as rotation.x = -90°
      const lx = fx * ca - fy * sa, lz = -(fx * sa + fy * ca);
      let h = this.terrain.height(cx + lx, cz + lz);
      if (h <= VOID) h = y0;
      // follow curves and slopes, but not walls or cliff drops: beyond ~35° the ring stays level with the centre
      const lim = Math.hypot(lx, lz) * 0.7 + 0.05;
      if (Math.abs(h - y0) > lim) h = y0;
      pos.setXYZ(i, lx, h - y0 + lift, lz);
    }
    pos.needsUpdate = true;
    m.position.set(cx, y0, cz);
    m.scale.setScalar(1);
  }

  ring(x: number, y: number, z: number, color: string, r: number, dur: number) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y + 0.08, z);
    this.scene.add(m);
    this.rings.push({ mesh: m, t: 0, dur, r });
  }

  burstTop(id: number, s: GameState) {
    const v = this.tops[id];
    if (!v || v.burstDone) return;
    v.burstDone = true;
    const t = s.tops[id];
    const parts = [...v.model.spinner.children];
    for (const p of parts) {
      const wp = new THREE.Vector3();
      p.getWorldPosition(wp);
      const wq = new THREE.Quaternion();
      p.getWorldQuaternion(wq);
      const ws = new THREE.Vector3();
      p.getWorldScale(ws);
      this.scene.attach(p);
      p.position.copy(wp); p.quaternion.copy(wq); p.scale.copy(ws);
      const a = Math.random() * Math.PI * 2;
      this.debris.push({ mesh: p, v: new THREE.Vector3(Math.cos(a) * 6 + t.vx * 0.5, 6 + Math.random() * 6, Math.sin(a) * 6 + t.vz * 0.5), w: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20), t: 0 });
    }
    this.particles.burst(t.x, t.y + 0.4, t.z, 90, 10, v.color, 0.2, 0.9, 0.6);
  }

  update(s: GameState, dt: number, launchPower: number) {
    this.time += dt;
    this.ensureObjects(s);
    const tmpV = new THREE.Vector3();
    // tops
    s.tops.forEach((t, i) => {
      if (!this.tops[i]) {
        // late-joined top (gauntlet drones)
        const p = this.cfg.players[0].blade;
        this.addTopView({ ...p, id: 'drone' + i, name: 'Drone', primary: '#3a3a3a', secondary: '#111', glow: '#ff2244', accent: '#ff2244', pattern: 'carbon', emblem: '☠', spinDir: -1, tip: 'flat' });
        const dv = this.tops[this.tops.length - 1] as TopView;
        dv.label.material.map = textSprite('DRONE', '#ff2244').material.map;
      }
      this.updateTop(t, this.tops[i], s, dt, launchPower);
      this.terrain.hintY = undefined;
    });
    // hazards
    for (const h of this.hazardMeshes) {
      const m = this.cfg.arena.markers[h.mi];
      const p = hazardPose(m, s.t);
      if (!p) continue;
      if (p.kind === 'arm') h.m.rotation.y = -p.angle;
      else if (p.kind === 'saw') { h.m.position.set(p.ax, this.groundY(p.ax, p.az), p.az); h.m.rotation.y = p.angle; if (Math.random() < 0.3) this.particles.emit(p.ax, h.m.position.y + 0.35, p.az, (Math.random() - 0.5) * 6, 2, (Math.random() - 0.5) * 6, new THREE.Color('#ffc46b'), 0.07, 0.25); }
    }
    if (s.pin) {
      for (const f of this.flippers) f.g.rotation.y = -(s.pin.flip[f.mi] ?? 0);
      for (const tg of this.targets) {
        const lit = s.pin.lit[tg.mi];
        tg.mat.emissive.set(lit ? '#ffd23a' : '#38ffb0');
        tg.mat.emissiveIntensity = lit ? 1.6 : 0.6 + 0.3 * Math.sin(this.time * 4 + tg.mi);
      }
      if (this.plungerRod) this.plungerRod.g.position.z = this.plungerRod.z0 + s.pin.charge * 1.3;
    }
    for (const p of this.portals) p.rotation.z += dt * 2.5;
    if (s.pin) {
      for (const d of this.drops) { const down = s.pin.lit[d.mi]; const ty = d.y + (down ? -0.55 : 0.5); d.g.position.y += (ty - d.g.position.y) * Math.min(1, dt * 18); }
      for (const k of this.kickbacks) { const armed = (s.pin.tm[k.mi] ?? 0) <= 0; k.mat.color.set(armed ? '#38ffb0' : '#3a4250'); k.mat.opacity = armed ? 0.6 + 0.35 * Math.sin(this.time * 6) : 0.5; }
      for (const p of this.posts) { const ty = p.y + (s.pin.save > 0 ? 0.55 : -0.6); p.g.position.y += (ty - p.g.position.y) * Math.min(1, dt * 12); }
      for (const l of this.lights) l.mat.color.set(s.pin.lit[l.mi] ? '#ffffff' : l.base);
      // arena gates: solid red while locked, gone while open (a flicker as it shuts)
      for (const g of this.gates) {
        const open = s.pin.lit[g.mi] || (s.pin.tm[g.mi] ?? 0) > 0;
        g.mesh.visible = !open;
        g.mat.opacity = 0.55 + 0.25 * Math.sin(this.time * 9);
      }
      for (const a of this.arenaRings) {
        const live = s.pin.duel?.mi === a.mi, open = s.pin.lit[a.mi];
        a.mat.color.set(live ? (Math.sin(this.time * 14) > 0 ? '#ffffff' : '#ff2a6d') : open ? '#39ff9c' : '#ff2a6d');
        a.mat.opacity = open ? 0.6 + 0.35 * Math.sin(this.time * 5) : 0.8;
      }
      // aim locks: the beam follows the held ball's aim
      for (const a of this.aims) {
        const b = s.tops.find((t) => t.alive && t.held === a.mi);
        a.beam.visible = !!b;
        if (b) { a.beam.rotation.y = -(b.aimA ?? 0); for (const c of a.beam.children) ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.35 * Math.sin(this.time * 10); }
      }
      // the swarm
      // (on a table the drones show where the swarm is; the hive's big patrol circle would hang off the table)
      const sw = s.pin.swarm;
      while (this.droneMeshes.length < sw.length) this.droneMeshes.push(this.makeDrone());
      this.droneMeshes.forEach((dm, k) => {
        const d = sw[k];
        dm.g.visible = !!d && d.hp > 0 && s.pin!.swarmT > 0;
        if (!dm.g.visible) return;
        const zap = d.zap > 0;
        dm.g.position.set(d.x, this.groundY(d.x, d.z) + 1.0 + Math.sin(this.time * 5 + k) * 0.12, d.z);
        dm.g.rotation.set(d.vz * 0.05, -Math.atan2(d.vz, d.vx), -d.vx * 0.05, 'YXZ');
        for (const r of dm.rotors) r.rotation.y += dt * 40;
        ((dm.g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.set(zap ? '#3a1020' : '#ff2a6d');
      });
    }
    for (const sl of this.slings) {
      sl.t = Math.max(0, sl.t - dt);
      const k = sl.t / 0.16;
      sl.mesh.position.set(sl.nx * 0.28 * k, 0, sl.nz * 0.28 * k);
      sl.mat.color.set(k > 0 ? '#ffffff' : '#ff5cf4');
    }
    for (const bp of this.bumpers) {
      bp.t = Math.max(0, bp.t - dt);
      const k = bp.t / 0.2;
      bp.g.scale.setScalar(1 + 0.18 * k);
      (bp.ring.material as THREE.MeshBasicMaterial).color.set(k > 0 ? '#ffe9ff' : '#ffffff');
      (bp.ring.material as THREE.MeshBasicMaterial).color.multiplyScalar(1 + 2 * k);
    }
    for (const b of this.boostMeshes) { const mat = b.material as THREE.MeshBasicMaterial; if (mat.map) mat.map.offset.y -= dt * 1.5; }
    // spin pads: swirl turns; flares up while someone is re-spinning on it
    // quest: checkpoints you've reached turn gold; the goal ring turns slowly
    for (const c of this.checkpoints) {
      const reached = this.focus.some((i) => (s.tops[i]?.qcp ?? -1) >= c.mi);
      (c.banner.material as THREE.MeshBasicMaterial).color.set(reached ? '#ffd23a' : '#38ffb0');
      (c.pad.material as THREE.MeshBasicMaterial).color.set(reached ? '#ffd23a' : '#38ffb0');
    }
    if (this.goalRing) this.goalRing.rotation.z = this.time * 0.6;
    this.updateQuestArrows(s);
    // when one of your blades is low on spin, every pad pulses like a beacon so you can find one
    const beacon = this.focus.some((i) => s.tops[i]?.alive && s.tops[i].spin < 0.4 && s.phase === 'battle');
    for (const p of this.spinPads) {
      const busy = s.tops.some((t) => t.alive && t.spin < 1 && Math.hypot(t.x - p.x, t.z - p.z) < p.r);
      p.spin += dt * (busy ? 9 : 2.5);
      for (const a of p.arms) this.drape(a, p.x, p.z, 1, 0.06, p.spin);
      const bm = p.beam.material as THREE.MeshBasicMaterial;
      bm.opacity += ((busy ? 0.32 : beacon ? 0.22 + 0.16 * Math.sin(this.time * 7) : 0.08 + 0.04 * Math.sin(this.time * 3 + p.x)) - bm.opacity) * Math.min(1, dt * 6);
      p.beam.scale.y = beacon && !busy ? 1.8 + 0.4 * Math.sin(this.time * 7) : 1;
      p.beam.position.y = this.groundY(p.x, p.z) + 1.1 * p.beam.scale.y;
      (p.ring.material as THREE.MeshBasicMaterial).opacity = busy ? 0.6 + 0.4 * Math.abs(Math.sin(this.time * 18)) : 0.85;
    }
    // boxes
    s.boxes.forEach((b, i) => {
      const m = this.boxMeshes[i];
      const tgt = b.t > 0 ? 0.001 : 1;
      m.scale.setScalar(m.scale.x + (tgt - m.scale.x) * Math.min(1, dt * 8));
      m.position.set(b.x, b.y + 0.75 + Math.sin(this.time * 2 + i) * 0.12, b.z);
      m.rotation.set(this.time * 0.9, this.time * 1.3, 0);
    });
    for (const c of s.crystals) { const m = this.crystalMeshes.get(c.id)!; m.position.set(c.x, c.y + Math.sin(this.time * 3 + c.id) * 0.06, c.z); m.rotation.y = this.time * 2 + c.id; }
    for (const g of s.gems) {
      const m = this.gemMeshes.get(g.id)!;
      m.position.set(g.x, g.y + 0.3 + Math.sin(this.time * 2.5 + g.id) * 0.15, g.z);
      m.rotation.set(this.time, this.time * 1.4, 0);
      if (Math.random() < 0.2) this.particles.emit(g.x, g.y + 0.3, g.z, 0, 2, 0, new THREE.Color('#ff5cf4'), 0.1, 0.8, 0);
    }
    for (const p of s.projs) {
      const m = this.projMeshes.get(p.id)!;
      m.position.set(p.x, p.y, p.z);
      for (let k = 0; k < 3; k++) this.particles.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.5, new THREE.Color(k ? '#ff7b1c' : '#ffe9a8'), 0.28, 0.4, 0);
    }
    for (const mi of s.mines) { const m = this.mineMeshes.get(mi.id)!; m.position.set(mi.x, mi.y + 0.3, mi.z); m.rotation.y = this.time * 3; m.scale.setScalar(mi.t < 0.6 ? 0.5 : 1 + Math.sin(this.time * 8) * 0.1); }
    s.flags.forEach((f, i) => {
      const v = this.flagViews[i];
      if (!v) return;
      v.pole.position.set(f.x, f.carrier >= 0 ? f.y : f.y + 0.2, f.z);
      v.orb.rotation.y = this.time * 2;
      v.orb.position.y = f.carrier >= 0 ? 0.3 : 1.0 + Math.sin(this.time * 2) * 0.15;
      (v.base.material as THREE.MeshBasicMaterial).opacity = f.home ? 0.75 : 0.25 + 0.2 * Math.sin(this.time * 6);
    });
    if (this.zoneMesh) this.zoneMesh.visible = !!s.zone;
    if (s.zone && this.zoneMesh) {
      const z = s.zone;
      this.zoneMesh.position.set(z.x, z.y + 1.25, z.z);
      this.zoneMesh.scale.set(z.r, 1, z.r);
      const col = z.owner >= 0 ? s.tops.find((t) => t.team === z.owner)?.color ?? '#ffd23a' : z.owner === -2 ? '#ffffff' : '#ffd23a';
      (this.zoneMesh.material as THREE.MeshBasicMaterial).color.set(col);
      (this.zoneMesh.material as THREE.MeshBasicMaterial).opacity = 0.14 + 0.06 * Math.sin(this.time * 4);
      if (Math.random() < 0.5) { const a = Math.random() * Math.PI * 2; this.particles.emit(z.x + Math.cos(a) * z.r, z.y + 0.1, z.z + Math.sin(a) * z.r, 0, 2.5, 0, new THREE.Color(col), 0.15, 0.8, 0); }
    }
    // rings & debris
    this.rings = this.rings.filter((r) => {
      r.t += dt;
      const k = r.t / r.dur;
      r.mesh.scale.setScalar(0.2 + k * r.r);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      if (k >= 1) { this.scene.remove(r.mesh); r.mesh.geometry.dispose(); return false; }
      return true;
    });
    this.debris = this.debris.filter((d) => {
      d.t += dt;
      d.v.y -= G * dt;
      d.mesh.position.addScaledVector(d.v, dt);
      d.mesh.rotation.x += d.w.x * dt; d.mesh.rotation.y += d.w.y * dt; d.mesh.rotation.z += d.w.z * dt;
      const g = this.terrain.height(d.mesh.position.x, d.mesh.position.z);
      if (g > VOID && d.mesh.position.y < g + 0.05) { d.mesh.position.y = g + 0.05; d.v.y = Math.abs(d.v.y) * 0.4; d.v.x *= 0.7; d.v.z *= 0.7; d.w.multiplyScalar(0.7); }
      if (d.t > 6) { this.scene.remove(d.mesh); return false; }
      return true;
    });
    this.particles.update(dt);
    this.updateCamera(s, dt);
    void tmpV;
  }

  updateTop(t: TopState, v: TopView, s: GameState, dt: number, launchPower: number) {
    this.terrain.hintY = t.y + 0.5; // rings, shadows and arcs use the surface under this blade
    const visible = !(t.out === 'burst' && v.burstDone);
    if (t.out !== 'burst' && v.burstDone) {
      // new round after a burst: rebuild model
      const idx = this.tops.indexOf(v);
      v.tilt.remove(v.model.group);
      const blade = this.cfg.players[idx]?.blade;
      if (blade) {
        v.model = buildBladeModel(blade);
        v.model.group.scale.setScalar(v.scale);
        v.tilt.add(v.model.group);
      }
      v.burstDone = false;
    }
    v.root.visible = visible || t.out !== 'burst';
    v.root.position.set(t.x, t.y, t.z);
    v.model.group.scale.setScalar(v.scale * t.scale);
    // tilt from physics (+ topple when spun out)
    if (!t.alive && t.out === 'spin') v.fallT = Math.min(1, v.fallT + dt * 1.5);
    else if (t.alive) v.fallT = 0;
    const k = 1.1;
    const fall = v.fallT * 1.25;
    v.tilt.rotation.set(t.tz * k + fall * 0.6, 0, -t.tx * k + fall * 0.8);
    v.model.spinner.rotation.y = t.angle;
    const blurMat = v.blur.material as THREE.MeshBasicMaterial;
    blurMat.opacity = t.alive ? 0.05 + t.spin * 0.16 : 0;
    v.model.glowRing.visible = t.alive;
    // ground ring + shadow
    const gh = this.terrain.height(t.x, t.z);
    const ground = gh <= VOID ? -50 : gh;
    const above = Math.max(0, t.y - ground);
    v.ring.visible = t.alive && gh > VOID;
    v.shadow.visible = gh > VOID;
    // ring + shadow follow the surface under the blade (bowls, ramps, pipes) instead of cutting through it
    if (gh > VOID) {
      this.drape(v.ring, t.x, t.z, t.scale * (1 + above * 0.15), 0.05);
      this.drape(v.shadow, t.x, t.z, 1, 0.035);
    }
    (v.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.45 - above * 0.06);
    v.label.visible = t.alive && !this.attract;
    v.shield.visible = t.fx.shield > 0 && t.alive;
    v.shield.rotation.y += dt * 2;
    v.ice.visible = t.fx.frozen > 0;
    v.aura.visible = t.fx.special > 0 || t.fx.vortex > 0 || t.fx.turbo > 0 || t.fx.surge > 0 || !!t.od;
    v.aura.rotation.y += dt * (t.fx.surge > 0 ? 14 : 5);
    (v.aura.material as THREE.MeshBasicMaterial).color.set(t.fx.surge > 0 && t.fx.special <= 0 ? '#38ffb0' : t.fx.turbo > 0 && t.fx.special <= 0 ? '#ff7b1c' : t.fx.vortex > 0 ? '#b46bff' : v.color);
    v.core.visible = t.flag >= 0;
    if (t.flag >= 0) (v.core.material as THREE.MeshBasicMaterial).color.set(t.flag === 0 ? '#ff3b4a' : '#3b8bff');
    // trail
    const speed = Math.hypot(t.vx, t.vy, t.vz);
    const tp = new THREE.Vector3(t.x, t.y + 0.25, t.z);
    v.trail.mesh.visible = t.alive || t.out === 'over' || t.out === 'xtreme';
    v.trail.update(tp, t.alive ? Math.min(0.55, speed * 0.035) * t.scale + (t.fx.dash > 0 ? 0.25 : 0) : 0.1, dt);
    // turbo flames, low-spin smoke
    if (t.alive && t.grounded && speed > 12 && Math.random() < 0.5) this.particles.emit(t.x + (Math.random() - 0.5) * 0.8, t.y + 0.3 + Math.random() * 0.5, t.z + (Math.random() - 0.5) * 0.8, -t.vx * 0.6, 0, -t.vz * 0.6, new THREE.Color('#ffffff'), 0.06, 0.25, 0);
    // overdrive: a stream of blue-white sparks behind you
    if (t.alive && t.od && Math.random() < 0.7) this.particles.emit(t.x, t.y + 0.25, t.z, -t.vx * 0.25 + (Math.random() - 0.5), 0.6, -t.vz * 0.25 + (Math.random() - 0.5), new THREE.Color(Math.random() < 0.5 ? '#3cf2ff' : '#ffffff'), 0.25, 0.3, -0.1);
    if (t.alive && t.fx.turbo > 0) this.particles.emit(t.x, t.y + 0.3, t.z, -t.vx * 0.2 + (Math.random() - 0.5), 1, -t.vz * 0.2 + (Math.random() - 0.5), new THREE.Color(Math.random() < 0.5 ? '#ff7b1c' : '#ffd23a'), 0.3, 0.35, -0.2);
    // Spin Surge: green sparks flung off the rim while overcharged
    if (t.alive && t.fx.surge > 0 && Math.random() < 0.8) { const a = Math.random() * Math.PI * 2; this.particles.emit(t.x + Math.cos(a) * 0.7, t.y + 0.35, t.z + Math.sin(a) * 0.7, Math.cos(a + 1.4 * t.dir) * 6, 0.6 + Math.random(), Math.sin(a + 1.4 * t.dir) * 6, new THREE.Color(Math.random() < 0.6 ? '#38ffb0' : '#ffffff'), 0.14, 0.3, 0.2); }
    if (t.alive && t.spin < 0.25 && Math.random() < 0.3) this.particles.emit(t.x, t.y + 0.4, t.z, 0, 0.8, 0, new THREE.Color('#555'), 0.25, 0.8, -0.1);
    if (t.alive && t.fx.vortex > 0) { const a = this.time * 8; this.particles.emit(t.x + Math.cos(a) * 2.5, t.y + 0.3, t.z + Math.sin(a) * 2.5, -Math.cos(a) * 5, 0.5, -Math.sin(a) * 5, new THREE.Color('#b46bff'), 0.2, 0.4, 0); }
    // airborne trajectory prediction
    const showArc = settings.trajectories && t.alive && !t.grounded && t.air > 0.08 && s.phase !== 'launch';
    v.arc.visible = showArc;
    v.landing.visible = showArc;
    if (showArc) {
      let x = t.x, y = t.y, z = t.z, vx = t.vx, vy = t.vy, vz = t.vz, n = 0;
      const step = 0.04;
      let landed = false;
      for (; n < 60; n++) {
        v.arcPos[n * 3] = x; v.arcPos[n * 3 + 1] = y + 0.2; v.arcPos[n * 3 + 2] = z;
        vy -= G * step;
        x += vx * step; y += vy * step; z += vz * step;
        const h = this.terrain.height(x, z);
        if (h > VOID && y <= h) { landed = true; v.landing.position.set(x, h + 0.06, z); n++; v.arcPos[n * 3] = x; v.arcPos[n * 3 + 1] = h + 0.1; v.arcPos[n * 3 + 2] = z; n++; break; }
        if (y < -6) break;
      }
      v.landing.visible = landed;
      if (landed) this.drape(v.landing, v.landing.position.x, v.landing.position.z, 1 + Math.sin(this.time * 12) * 0.15, 0.06);
      (v.landing.material as THREE.MeshBasicMaterial).color.set(landed ? v.color : new THREE.Color('#ff2244'));
      if (!landed) (v.arc.material as THREE.LineDashedMaterial).color.set('#ff2244');
      else (v.arc.material as THREE.LineDashedMaterial).color.copy(v.color);
      const g = v.arc.geometry;
      g.setDrawRange(0, n);
      g.attributes.position.needsUpdate = true;
      v.arc.computeLineDistances();
    }
    // launch meter ring
    v.launchRing.visible = s.phase === 'launch' && !this.attract;
    if (v.launchRing.visible) {
      const pw = t.launchLocked ? t.launch : launchPower;
      this.drape(v.launchRing, t.x, t.z, 0.6 + pw * 1.2, 0.07);
      (v.launchRing.material as THREE.MeshBasicMaterial).color.set(t.launchLocked ? (t.launch > 0.9 ? '#38ff7a' : '#ffffff') : pw > 0.9 ? '#38ff7a' : '#ffd23a');
    }
  }

  updateCamera(s: GameState, dt: number) {
    const A = this.cfg.arena;
    if (A.pinball && A.course && !this.attract) {
      const W = A.course.w * A.course.tile, Hl = A.course.h * A.course.tile;
      const balls = s.tops.filter((t) => t.alive && !t.drone);
      const bz = balls.length ? balls.reduce((a, t) => a + t.z, 0) / balls.length : 0;
      // look a little toward the ball, but keep the flippers in view
      const tz = Math.max(-Hl * 0.2, Math.min(Hl * 0.12, Hl * 0.06 + bz * 0.3));
      const ty = this.groundY(0, tz);
      // far enough back that the table's width fits (portrait phones need more)
      const vfov = (this.camera.fov * Math.PI) / 180, aspect = innerWidth / innerHeight;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
      const D = Math.max(Hl * 0.95, (W * 0.6) / Math.tan(hfov / 2));
      const want = new THREE.Vector3(0, ty + D * 0.9, tz + D * 0.5);
      const k = Math.min(1, dt * 3);
      this.camPos.lerp(want, k);
      this.camTarget.lerp(new THREE.Vector3(0, ty, tz - Hl * 0.06), k);
      this.camera.position.copy(this.camPos);
      if (this.shake > 0) { this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.4; this.shake = Math.max(0, this.shake - dt * 3); }
      this.camera.lookAt(this.camTarget);
      // keep the flippers above the player card (same HUD-free band the arenas use)
      if (this.safe.top || this.safe.bottom) this.camera.setViewOffset(innerWidth, innerHeight, 0, ((this.safe.bottom - this.safe.top) / 2) * innerHeight, innerWidth, innerHeight);
      else if (this.camera.view) this.camera.clearViewOffset();
      const fx = this.camTarget.x - this.camPos.x, fz = this.camTarget.z - this.camPos.z, fl = Math.hypot(fx, fz) || 1;
      this.camFwd.x = fx / fl; this.camFwd.z = fz / fl;
      return;
    }
    const T0 = this.terrain.track;
    if (T0 && this.splits.length > 1) {
      for (const v of this.splits) {
        const t = s.tops[v.id];
        if (!t) continue;
        const c = chaseCamera(T0, [t], v.yaw, 0, dt, this.terrain.layered ? (x, z) => this.terrain.layeredHeight(x, z) : undefined, v.cam3);
        v.yaw = c.yaw; v.cam3 = { sp: c.sp, back: c.back };
        v.tgt.lerp(new THREE.Vector3(c.tx, c.ty, c.tz), Math.min(1, dt * 6));
        v.pos.lerp(new THREE.Vector3(c.px, c.py, c.pz), Math.min(1, dt * 5));
        v.pos.y = Math.max(v.pos.y, c.py - 0.3); // never lag below the rig's height (it already clears the road)
        v.cam.position.copy(v.pos);
        if (this.shake > 0) { v.cam.position.x += (Math.random() - 0.5) * this.shake * 0.4; v.cam.position.y += (Math.random() - 0.5) * this.shake * 0.4; }
        v.cam.lookAt(v.tgt);
        const fx = v.tgt.x - v.pos.x, fz = v.tgt.z - v.pos.z, fl = Math.hypot(fx, fz) || 1;
        v.fwd.x = fx / fl; v.fwd.z = fz / fl;
      }
      this.shake = Math.max(0, this.shake - dt * 3);
      return;
    }
    let pts = s.tops.filter((t) => t.alive || (s.phase !== 'battle' && t.out !== 'over' && t.out !== 'xtreme'));
    if (this.cfg.mode === 'quest' && !this.terrain.track) {
      const mine = this.focus.map((i) => s.tops[i]).filter((t) => t && (t.alive || t.respawnT > 0));
      const humans = s.tops.filter((t) => !t.drone && t.alive);
      pts = mine.length ? mine : humans.length ? humans : pts;
      // look ahead: also frame a point ~10m toward each blade's next checkpoint / the goal, so you see where to go
      const ahead = pts.map((t) => {
        const wp = this.questWaypoint(t.qcp ?? -1);
        if (!wp) return null;
        const dx = wp.x - t.x, dz = wp.z - t.z, d = Math.hypot(dx, dz) || 1, k = Math.min(10, d);
        return { ...t, x: t.x + (dx / d) * k, z: t.z + (dz / d) * k, y: t.y } as typeof t;
      }).filter((p): p is (typeof pts)[number] => !!p);
      pts = [...pts, ...ahead];
    }
    if (this.terrain.track) {
      const f = this.focus.length ? this.focus.map((i) => s.tops[i]).filter(Boolean) : [...s.tops].filter((t) => !t.drone).sort((a, b) => a.place - b.place).slice(0, 1);
      pts = f.length ? f : pts;
    }
    const S = this.terrain.size;
    let cx = 0, cz = 0, cy = 0;
    if (this.attract) {
      const a = this.time * 0.12;
      this.camPos.set(Math.cos(a) * S * 1.05, S * 0.55 + 3, Math.sin(a) * S * 1.05);
      this.camTarget.set(0, 0, 0);
    } else {
      if (pts.length) {
        for (const t of pts) { cx += t.x; cz += t.z; cy += Math.max(0, t.y); }
        cx /= pts.length; cz /= pts.length; cy /= pts.length;
      }
      let spread = 0;
      for (const t of pts) spread = Math.max(spread, Math.hypot(t.x - cx, t.z - cz * 1.0));
      const T = this.terrain.track;
      if (T && pts.length) {
        const c = chaseCamera(T, pts, this.chaseYaw, spread, dt, this.terrain.layered ? (x, z) => this.terrain.layeredHeight(x, z) : undefined, this.chaseSt);
        this.chaseYaw = c.yaw; this.chaseSt = { sp: c.sp, back: c.back };
        this.camTarget.lerp(new THREE.Vector3(c.tx, c.ty, c.tz), Math.min(1, dt * 6));
        this.camPos.lerp(new THREE.Vector3(c.px, c.py, c.pz), Math.min(1, dt * 5));
        this.camPos.y = Math.max(this.camPos.y, c.py - 0.3); // never lag below the rig's height (it already clears the road)
        if (this.camera.fov !== 62) { this.camera.fov = 62; this.camera.updateProjectionMatrix(); }
      } else {
        // fit every blade inside the part of the screen the HUD doesn't cover (works for portrait phones too)
        // adventure levels climb high: aim at the blades' real height, not half of it
        const quest = this.cfg.mode === 'quest';
        const tgt = new THREE.Vector3(cx, quest ? cy : cy * 0.5, cz);
        const base = Math.min(S * 2.2, Math.max(this.cfg.mode === 'quest' ? 17 : 11, spread * 1.7 + 8));
        const need = this.fitDistance(pts, tgt, cx, cz, base);
        this.fitDist = this.fitDist ? this.fitDist + (need - this.fitDist) * Math.min(1, dt * (need > this.fitDist ? 7 : 1.5)) : need;
        const dist = this.fitDist;
        // follow faster while blades are near the edge of the free band, gently otherwise
        const urgent = need > dist * 1.05 ? 2 : 1;
        this.camTarget.lerp(tgt, Math.min(1, dt * 3 * urgent));
        this.camPos.lerp(new THREE.Vector3(quest ? cx : cx * 0.9, tgt.y + dist * 0.82, cz + dist * 0.72), Math.min(1, dt * 2.2 * urgent));
      }
      // the ground must never hide your blade (e.g. the crest you just went over): lift the camera now, not after the lag
      if (pts.length && !T) this.camPos.y = this.clearSight(this.camPos, pts);
    }
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
      this.shake = Math.max(0, this.shake - dt * 3);
    }
    this.camera.lookAt(this.camTarget);
    if (!this.terrain.track && !this.attract && (this.safe.top || this.safe.bottom)) {
      const W = innerWidth, H = innerHeight;
      this.camera.setViewOffset(W, H, 0, ((this.safe.bottom - this.safe.top) / 2) * H, W, H);
    } else if (this.camera.view) this.camera.clearViewOffset();
    const fx = this.camTarget.x - this.camPos.x, fz = this.camTarget.z - this.camPos.z, fl = Math.hypot(fx, fz) || 1;
    this.camFwd.x = fx / fl; this.camFwd.z = fz / fl;
  }

  /**
   * The lowest camera height (at the camera's x,z) from which every point can be seen over the terrain:
   * for each spot along the sight line, the line must pass ~0.6m above the ground there.
   */
  clearSight(cam: THREE.Vector3, pts: { x: number; y: number; z: number }[]) {
    const ter = this.terrain;
    let need = cam.y;
    for (const t of pts) {
      // on bridge tracks only the roads at or below the blade count (decks above are handled by the chase camera)
      const hint = ter.layered ? t.y + 0.5 : undefined;
      // never inside / under the ground the camera is over (a lagging camera over a steep hill)
      const g = ter.height(cam.x, cam.z, hint);
      if (g > VOID) need = Math.max(need, g + 1.5);
      // the sight line clears the ground; only the camera's end of it (near the blade the ground is the blade's own slope)
      const by = t.y + 0.4;
      for (let f = 0.05; f <= 0.7; f += 0.05) {
        const h = ter.height(cam.x + (t.x - cam.x) * f, cam.z + (t.z - cam.z) * f, hint);
        if (h <= VOID) continue;
        need = Math.max(need, (h + 0.5 - by * f) / (1 - f));
      }
    }
    return need;
  }

  /** smallest camera distance (along the usual arena angle) that keeps all points inside the HUD-free band */
  private fitDistance(pts: { x: number; y: number; z: number }[], tgt: THREE.Vector3, cx: number, cz: number, base: number) {
    const c = this.fitCam, cam = this.camera;
    c.fov = cam.fov; c.aspect = cam.aspect; c.near = cam.near; c.far = cam.far;
    const top = this.safe.top, bot = this.safe.bottom;
    const ylim = Math.max(0.25, 1 - top - bot) * 0.86, xlim = this.camera.aspect < 1 ? 0.8 : 0.88; // extra margin so fast dashes stay in view
    // the view offset recentres the projection on the free band, so the fit is symmetric about the centre
    let d = base;
    for (let it = 0; it < 3; it++) {
      c.position.set(cx * 0.9, tgt.y + d * 0.82, cz + d * 0.72);
      c.lookAt(tgt);
      c.updateMatrixWorld();
      c.updateProjectionMatrix();
      let worst = 0;
      for (const p of pts) {
        for (const [ox, oz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
          const v = this.fitV.set(p.x + ox, Math.max(0, p.y), p.z + oz).project(c);
          worst = Math.max(worst, Math.abs(v.x) / xlim, Math.abs(v.y) / ylim);
        }
      }
      if (worst <= 0) break;
      d = Math.max(this.cfg.mode === 'quest' ? 17 : 11, Math.min(this.terrain.size * 3, d * Math.max(0.85, worst)));
    }
    return d;
  }

  perfVersion = -1;
  render() {
    if (this.perfVersion !== perf.version) {
      this.perfVersion = perf.version;
      this.renderer.setPixelRatio(perf.ratio());
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setPixelRatio(perf.ratio());
      this.composer.setSize(innerWidth, innerHeight);
    }
    if (this.splits.length > 1 && this.terrain.track) {
      // split-screen: render each racer's camera into its own viewport (no bloom — it's full-screen only)
      const r = this.renderer;
      r.setScissorTest(true);
      this.splitRects().forEach(([x, y, w, h], k) => {
        const cam = this.splits[k].cam;
        if (Math.abs(cam.aspect - w / h) > 1e-3) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
        r.setViewport(x, y, w, h);
        r.setScissor(x, y, w, h);
        r.render(this.scene, cam);
      });
      if (this.splits.length === 3) {
        // spare quadrant: overhead map of the whole track
        const W = innerWidth / 2, H = innerHeight / 2, S = this.terrain.size;
        this.camera.aspect = W / H; this.camera.updateProjectionMatrix();
        const cx = this.terrain.minX + (this.terrain.nx * this.terrain.cell) / 2, cz = this.terrain.minZ + (this.terrain.nz * this.terrain.cell) / 2;
        this.camera.position.set(cx, S * 1.9, cz + S * 0.35);
        this.camera.lookAt(cx, 0, cz);
        r.setViewport(W, 0, W, H);
        r.setScissor(W, 0, W, H);
        r.render(this.scene, this.camera);
      }
      r.setScissorTest(false);
      r.setViewport(0, 0, innerWidth, innerHeight);
      return;
    }
    if (settings.bloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
    });
    this.composer.dispose();
  }
}

/** Race chase camera: behind the leading followed blade, looking down the track (pure, unit-testable). */
/** checkered finish texture for quest goals */
/** stretch a decal's along-the-road texture coordinate (square checkers whatever the road width) */
function scaleV(g: THREE.BufferGeometry, k: number) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * k);
  uv.needsUpdate = true;
}

let checkerTex: THREE.CanvasTexture | null = null;
function checkerTexture() {
  if (checkerTex) return checkerTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#ffd23a'; g.fillRect(x * 8, y * 8, 8, 8); }
  checkerTex = new THREE.CanvasTexture(cv);
  checkerTex.colorSpace = THREE.SRGBColorSpace;
  return checkerTex;
}

export function chaseCamera(T: TrackSamples, pts: TopState[], prevYaw: number | null, spread: number, dt: number, deckAt?: (x: number, z: number) => number, st: { sp?: number; back?: number } = {}) {
  const lead = pts.reduce((a, b) => (b.lap * T.n + b.prog > a.lap * T.n + a.prog ? b : a));
  let cx = 0, cz = 0, cy = 0;
  for (const t of pts) { cx += t.x; cz += t.z; cy += Math.max(-2, t.y); }
  cx /= pts.length; cz /= pts.length; cy /= pts.length;
  // heading: the track direction a little ahead, blended with actual travel direction when moving fast
  let hx = 0, hz = 0;
  for (let k = 2; k < 22; k++) { const q = (lead.prog + k) % T.n; hx += T.tx[q]; hz += T.tz[q]; }
  const hl = Math.hypot(hx, hz) || 1;
  hx /= hl; hz /= hl;
  const rawSp = Math.hypot(lead.vx, lead.vz);
  // distances below scale with speed: smooth it, or every boost pad / bump yanks the camera
  const sp = st.sp === undefined ? rawSp : st.sp + (rawSp - st.sp) * Math.min(1, dt * 2);
  if (lead.off > 0 && rawSp > 1) { hx = lead.vx / rawSp; hz = lead.vz / rawSp; }
  else if (sp > 4 && rawSp > 1 && lead.alive) {
    const vx = lead.vx / rawSp, vz = lead.vz / rawSp;
    if (vx * hx + vz * hz > 0) { const w = Math.min(0.35, (sp - 4) / 30); hx = hx * (1 - w) + vx * w; hz = hz * (1 - w) + vz * w; }
  }
  const want = Math.atan2(hx, hz);
  let yaw = prevYaw ?? want;
  let d = want - yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  yaw += d * Math.min(1, dt * 3);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  // pull back and look further ahead the faster we go
  const backMax = Math.min(30, 8.5 + spread * 1.2 + sp * 0.25);
  const up = 4 + spread * 0.5 + sp * 0.08;
  const wrap = (i: number) => (T.open ? Math.max(0, Math.min(T.n - 1, i)) : ((i % T.n) + T.n) % T.n);
  // everything below is a continuous function of where you are (fractional sample, interpolated road heights): no steps,
  // no caps, so the camera can't jump or flicker on steep hills
  const along = (cx - T.x[lead.prog]) * T.tx[lead.prog] + (cz - T.z[lead.prog]) * T.tz[lead.prog];
  const pf = lead.prog + Math.max(-1, Math.min(1, along / 0.5));
  const roadY = (q: number) => { const i0 = Math.floor(q), u = q - i0; return T.y[wrap(i0)] * (1 - u) + T.y[wrap(i0 + 1)] * u; };
  // look at the road ahead, not a point level with the blade: downhill tips the view down the slope
  const ty = cy + 0.4 + Math.max(-10, Math.min(3, roadY(pf + (11 + sp * 0.4) / 0.5) - roadY(pf))) * 0.7;
  // camera height needed `b` metres back: above the road behind you, and with a sight line over every crest between
  const heightAt = (b: number) => {
    let h = Math.max(cy + up, roadY(pf - b / 0.5) + up * 0.7);
    for (let dd = 2.5; dd < b; dd += 0.5) {
      const ry = roadY(pf - dd / 0.5) + 1.2;
      if (ry > cy) h = Math.max(h, cy + ((ry - cy) * b) / dd);
    }
    return h;
  };
  // over a steep crest, come in closer (coaster style) rather than climbing sky-high: the furthest distance whose
  // height stays sensible; the distance itself glides (closes in fast, eases back out slowly) so nothing jumps
  let wantB = 6;
  for (let b = backMax; b >= 6; b -= 1) if (heightAt(b) <= cy + up + 5) { wantB = b; break; }
  const prevB = st.back ?? wantB;
  const back = Math.max(6, Math.min(backMax, prevB + Math.max(-dt * 30, Math.min(dt * 6, wantB - prevB))));
  let py = Math.min(heightAt(back), cy + up + back + 10); // (falling far below the road: don't fly off into the sky)
  const px = cx - fx * back, pz = cz - fz * back;
  // bridges: never put the camera inside (or above) a road deck that's above the blade
  // (a "deck" is a DIFFERENT stretch of road overhead: well above our own road at that point. The slope behind you
  // on a downhill is not a deck — mistaking it for one put the camera under the road.)
  if (deckAt) {
    for (const [qx, qz, dd] of [[px, pz, back], [(px + cx) / 2, (pz + cz) / 2, back / 2]]) {
      const deck = deckAt(qx, qz);
      const own = roadY(pf - dd / 0.5);
      if (deck > own + 3 && deck > cy + 1.8 && deck < py + 2) py = Math.max(cy + 1.6, deck - 1.4);
    }
  }
  // aim: down the road ahead, but never so far that your blade drops toward the bottom of the screen (steep drops,
  // where the camera sits high): keep it within ~13 degrees below centre
  const tx = cx + fx * (11 + sp * 0.4), tz = cz + fz * 11;
  const th = Math.hypot(tx - px, tz - pz) || 1;
  const toBlade = Math.atan2(py - cy, back), toTgt = Math.atan2(py - ty, th);
  const aimY = toBlade - toTgt > 0.23 ? py - Math.tan(toBlade - 0.23) * th : ty;
  return { yaw, fx, fz, tx, ty: aimY, tz, px, py, pz, sp, back };
}

function sync<T extends { id: number }>(map: Map<number, THREE.Mesh>, list: T[], make: () => THREE.Mesh, scene: THREE.Scene) {
  const ids = new Set(list.map((x) => x.id));
  for (const [id, m] of map) if (!ids.has(id)) { scene.remove(m); map.delete(id); }
  for (const x of list) if (!map.has(x.id)) { const m = make(); scene.add(m); map.set(x.id, m); }
}
