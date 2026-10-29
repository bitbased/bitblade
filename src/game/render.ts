// Three.js scene for a match: heightfield arena, blades, hazards, objects, trails, trajectories, particles, bloom.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildBladeModel, type BladeModel } from '../core/bladeMesh';
import { computeStats } from '../core/blade';
import { Terrain, VOID, type Theme } from './terrain';
import type { TrackSamples } from './track';
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
export function buildArenaMesh(terrain: Terrain, theme: Theme): THREE.Group {
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
  const glowColor = new THREE.Color(theme.glow).multiplyScalar(2.2);
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
  boxMeshes: THREE.Mesh[] = [];
  crystalMeshes = new Map<number, THREE.Mesh>();
  gemMeshes = new Map<number, THREE.Mesh>();
  projMeshes = new Map<number, THREE.Mesh>();
  mineMeshes = new Map<number, THREE.Mesh>();
  flagViews: { pole: THREE.Group; orb: THREE.Mesh; base: THREE.Mesh }[] = [];
  zoneMesh: THREE.Mesh | null = null;
  boostMeshes: THREE.Mesh[] = [];
  camTarget = new THREE.Vector3();
  camPos = new THREE.Vector3();
  shake = 0;
  time = 0;
  attract = false;
  focus: number[] = []; // local player ids the camera should follow (race)
  camFwd = { x: 0, z: -1 }; // camera forward on the ground plane (controls are camera-relative)
  chaseYaw: number | null = null;
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
    const T = this.terrain.track;
    if (T) {
      // checkered start/finish line + gantry
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 32;
      const c = cv.getContext('2d')!;
      for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { c.fillStyle = (i + j) % 2 ? '#fff' : '#111'; c.fillRect(i * 16, j * 16, 16, 16); }
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const y0 = this.terrain.height(T.x[0], T.z[0]);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(T.width, 1.4), new THREE.MeshBasicMaterial({ map: tex }));
      line.rotation.order = 'YXZ';
      line.rotation.y = Math.atan2(T.tx[0], T.tz[0]);
      line.rotation.x = -Math.PI / 2;
      line.position.set(T.x[0], y0 + 0.05, T.z[0]);
      this.scene.add(line);
      const gate = new THREE.Mesh(new THREE.TorusGeometry(T.width * 0.62, 0.12, 8, 48, Math.PI), new THREE.MeshBasicMaterial({ color: theme.glow, toneMapped: false }));
      gate.rotation.y = Math.atan2(T.tx[0], T.tz[0]);
      gate.position.set(T.x[0], y0, T.z[0]);
      this.scene.add(gate);
      // direction chevrons every ~9m along the ribbon
      const chevMat = new THREE.MeshBasicMaterial({ map: chevronTexture(theme.glow, 2), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const chevGeo = new THREE.PlaneGeometry(T.width * 0.45, T.width * 0.45);
      for (let i = 10; i < T.n - 6; i += 18) {
        const h = this.terrain.height(T.x[i], T.z[i]);
        if (h <= VOID) continue;
        const m = new THREE.Mesh(chevGeo, chevMat);
        m.rotation.order = 'YXZ';
        m.rotation.y = planeYaw(T.tx[i], T.tz[i]);
        m.rotation.x = -Math.PI / 2;
        m.position.set(T.x[i], h + 0.04, T.z[i]);
        this.scene.add(m);
      }
      this.boostMeshes.push(new THREE.Mesh(new THREE.BufferGeometry(), chevMat)); // scroll the chevrons too
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
    const ring = new THREE.Mesh(new THREE.RingGeometry(st.radius * 1.05, st.radius * 1.2, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(st.radius * 1.1, 32), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.4, depthWrite: false }));
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
    const launchRing = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 48, 1, 0, Math.PI * 2), new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.9, toneMapped: false, side: THREE.DoubleSide }));
    launchRing.rotation.x = -Math.PI / 2;
    this.scene.add(root, ring, shadow, trail.mesh, arc, landing, launchRing);
    this.tops.push({ root, tilt, model, ring, shadow, blur, label, trail, shield, ice, aura, core, arc, arcPos, landing, launchRing, scale, color, burstDone: false, fallT: 0 });
  }

  buildMarkers() {
    const theme = this.cfg.arena.theme;
    const glow = new THREE.Color(theme.glow);
    this.cfg.arena.markers.forEach((m, mi) => {
      const y = this.groundY(m.x, m.z);
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
          const pad = new THREE.Mesh(new THREE.PlaneGeometry((m.r ?? 0.9) * 2, this.terrain.track ? 3.6 : 2.8), new THREE.MeshBasicMaterial({ map: chevronTexture('#ffe23a'), blending: THREE.AdditiveBlending, transparent: true, toneMapped: false, depthWrite: false }));
          const r = m.rot ?? 0;
          pad.rotation.order = 'YXZ';
          pad.rotation.y = planeYaw(Math.sin(r), Math.cos(r)); // sim pushes along (sin rot, cos rot)
          pad.rotation.x = -Math.PI / 2;
          pad.position.set(m.x, y + 0.05, m.z);
          this.scene.add(pad);
          this.boostMeshes.push(pad);
          break;
        }
        case 'spinpad': {
          const pad = new THREE.Mesh(new THREE.RingGeometry((m.r ?? 1.1) * 0.6, m.r ?? 1.1, 48), new THREE.MeshBasicMaterial({ color: '#38ffb0', transparent: true, opacity: 0.6, toneMapped: false, depthWrite: false }));
          pad.rotation.x = -Math.PI / 2;
          pad.position.set(m.x, y + 0.04, m.z);
          this.scene.add(pad);
          break;
        }
      }
      if (obj && (m.kind === 'arm' || m.kind === 'saw')) { this.scene.add(obj); this.hazardMeshes.push({ m: obj, mi }); }
      else if (obj) this.scene.add(obj);
    });
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
  groundPoint(ndc: { x: number; y: number }, y = 0) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
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
        case 'hazard': this.particles.burst(e.x, e.y, e.z, 25, 6, new THREE.Color('#ffb000'), 0.12, 0.4, 0.3); this.shake = Math.min(1, this.shake + 0.25); break;
        case 'dash': { const t = s.tops[e.id]; if (t) this.particles.burst(t.x, t.y + 0.2, t.z, 14, 3, this.tops[e.id].color, 0.2, 0.35, 0.1, 0.2); break; }
        case 'special': { const t = s.tops[e.id]; if (t) { this.ring(t.x, t.y + 0.1, t.z, '#' + this.tops[e.id].color.getHexString(), 4, 0.5); this.particles.burst(t.x, t.y + 0.5, t.z, 60, 7, this.tops[e.id].color, 0.2, 0.8, 0.8, 0.3); } break; }
        case 'use': { const t = s.tops[e.id]; if (t) this.particles.burst(t.x, t.y + 0.8, t.z, 20, 3, new THREE.Color(ITEMS[e.item].color), 0.18, 0.5, 1, 0.3); break; }
        case 'finish': if (e.type !== 'burst') this.shake = Math.min(1, this.shake + 0.5); break;
      }
    }
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
    });
    // hazards
    for (const h of this.hazardMeshes) {
      const m = this.cfg.arena.markers[h.mi];
      const p = hazardPose(m, s.t);
      if (!p) continue;
      if (p.kind === 'arm') h.m.rotation.y = -p.angle;
      else if (p.kind === 'saw') { h.m.position.set(p.ax, this.groundY(p.ax, p.az), p.az); h.m.rotation.y = p.angle; if (Math.random() < 0.3) this.particles.emit(p.ax, h.m.position.y + 0.35, p.az, (Math.random() - 0.5) * 6, 2, (Math.random() - 0.5) * 6, new THREE.Color('#ffc46b'), 0.07, 0.25); }
    }
    for (const b of this.boostMeshes) { const mat = b.material as THREE.MeshBasicMaterial; if (mat.map) mat.map.offset.y -= dt * 1.5; }
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
    v.ring.position.set(t.x, ground + 0.04, t.z);
    v.shadow.position.set(t.x, ground + 0.03, t.z);
    v.ring.visible = t.alive && gh > VOID;
    v.shadow.visible = gh > VOID;
    v.ring.scale.setScalar(t.scale * (1 + above * 0.15));
    (v.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.45 - above * 0.06);
    v.label.visible = t.alive && !this.attract;
    v.shield.visible = t.fx.shield > 0 && t.alive;
    v.shield.rotation.y += dt * 2;
    v.ice.visible = t.fx.frozen > 0;
    v.aura.visible = t.fx.special > 0 || t.fx.vortex > 0 || t.fx.turbo > 0;
    v.aura.rotation.y += dt * 5;
    (v.aura.material as THREE.MeshBasicMaterial).color.set(t.fx.turbo > 0 && t.fx.special <= 0 ? '#ff7b1c' : t.fx.vortex > 0 ? '#b46bff' : v.color);
    v.core.visible = t.flag >= 0;
    if (t.flag >= 0) (v.core.material as THREE.MeshBasicMaterial).color.set(t.flag === 0 ? '#ff3b4a' : '#3b8bff');
    // trail
    const speed = Math.hypot(t.vx, t.vy, t.vz);
    const tp = new THREE.Vector3(t.x, t.y + 0.25, t.z);
    v.trail.mesh.visible = t.alive || t.out === 'over' || t.out === 'xtreme';
    v.trail.update(tp, t.alive ? Math.min(0.55, speed * 0.035) * t.scale + (t.fx.dash > 0 ? 0.25 : 0) : 0.1, dt);
    // turbo flames, low-spin smoke
    if (t.alive && t.grounded && speed > 12 && Math.random() < 0.5) this.particles.emit(t.x + (Math.random() - 0.5) * 0.8, t.y + 0.3 + Math.random() * 0.5, t.z + (Math.random() - 0.5) * 0.8, -t.vx * 0.6, 0, -t.vz * 0.6, new THREE.Color('#ffffff'), 0.06, 0.25, 0);
    if (t.alive && t.fx.turbo > 0) this.particles.emit(t.x, t.y + 0.3, t.z, -t.vx * 0.2 + (Math.random() - 0.5), 1, -t.vz * 0.2 + (Math.random() - 0.5), new THREE.Color(Math.random() < 0.5 ? '#ff7b1c' : '#ffd23a'), 0.3, 0.35, -0.2);
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
      v.landing.scale.setScalar(1 + Math.sin(this.time * 12) * 0.15);
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
      v.launchRing.position.set(t.x, ground + 0.06, t.z);
      const pw = t.launchLocked ? t.launch : launchPower;
      v.launchRing.scale.setScalar(0.6 + pw * 1.2);
      (v.launchRing.material as THREE.MeshBasicMaterial).color.set(t.launchLocked ? (t.launch > 0.9 ? '#38ff7a' : '#ffffff') : pw > 0.9 ? '#38ff7a' : '#ffd23a');
    }
  }

  updateCamera(s: GameState, dt: number) {
    let pts = s.tops.filter((t) => t.alive || (s.phase !== 'battle' && t.out !== 'over' && t.out !== 'xtreme'));
    if (this.terrain.track) {
      const f = this.focus.length ? this.focus.map((i) => s.tops[i]).filter(Boolean) : [...s.tops].sort((a, b) => a.place - b.place).slice(0, 1);
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
        const c = chaseCamera(T, pts, this.chaseYaw, spread, dt);
        this.chaseYaw = c.yaw;
        this.camTarget.lerp(new THREE.Vector3(c.tx, c.ty, c.tz), Math.min(1, dt * 6));
        this.camPos.lerp(new THREE.Vector3(c.px, c.py, c.pz), Math.min(1, dt * 5));
        if (this.camera.fov !== 62) { this.camera.fov = 62; this.camera.updateProjectionMatrix(); }
      } else {
        const dist = Math.min(S * 2.2, Math.max(11, spread * 1.7 + 8));
        this.camTarget.lerp(new THREE.Vector3(cx, cy * 0.5, cz), Math.min(1, dt * 3));
        this.camPos.lerp(new THREE.Vector3(cx * 0.9, cy * 0.5 + dist * 0.82, cz + dist * 0.72), Math.min(1, dt * 2.2));
      }
    }
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
      this.shake = Math.max(0, this.shake - dt * 3);
    }
    this.camera.lookAt(this.camTarget);
    const fx = this.camTarget.x - this.camPos.x, fz = this.camTarget.z - this.camPos.z, fl = Math.hypot(fx, fz) || 1;
    this.camFwd.x = fx / fl; this.camFwd.z = fz / fl;
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
export function chaseCamera(T: TrackSamples, pts: TopState[], prevYaw: number | null, spread: number, dt: number) {
  const lead = pts.reduce((a, b) => (b.lap * T.n + b.prog > a.lap * T.n + a.prog ? b : a));
  let cx = 0, cz = 0, cy = 0;
  for (const t of pts) { cx += t.x; cz += t.z; cy += Math.max(-2, t.y); }
  cx /= pts.length; cz /= pts.length; cy /= pts.length;
  // heading: the track direction a little ahead, blended with actual travel direction when moving fast
  let hx = 0, hz = 0;
  for (let k = 2; k < 22; k++) { const q = (lead.prog + k) % T.n; hx += T.tx[q]; hz += T.tz[q]; }
  const hl = Math.hypot(hx, hz) || 1;
  hx /= hl; hz /= hl;
  const sp = Math.hypot(lead.vx, lead.vz);
  if (sp > 4 && lead.alive) {
    const vx = lead.vx / sp, vz = lead.vz / sp;
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
  const back = Math.min(30, 8.5 + spread * 1.2 + sp * 0.25);
  const up = 4 + spread * 0.5 + sp * 0.08;
  return { yaw, fx, fz, tx: cx + fx * (11 + sp * 0.4), ty: cy + 0.4, tz: cz + fz * 11, px: cx - fx * back, py: cy + up, pz: cz - fz * back };
}

function sync<T extends { id: number }>(map: Map<number, THREE.Mesh>, list: T[], make: () => THREE.Mesh, scene: THREE.Scene) {
  const ids = new Set(list.map((x) => x.id));
  for (const [id, m] of map) if (!ids.has(id)) { scene.remove(m); map.delete(id); }
  for (const x of list) if (!map.has(x.id)) { const m = make(); scene.add(m); map.set(x.id, m); }
}
