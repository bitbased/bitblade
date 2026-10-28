// Builds a Three.js model from a BladeDesign: attack ring, weight disc, driver tip, face bolt + painted decals.
import * as THREE from 'three';
import type { BladeDesign } from './blade';
import { drawIcon } from '../ui/icons';

export function seeded(seedStr: string) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ring outline radius as function of angle. Exported so physics/preview can reuse. */
export function ringProfile(d: BladeDesign) {
  const core = 0.55 + d.ringRadius * 0.15;
  const span = (Math.PI * 2) / d.wings;
  const w = 0.25 + d.wingWidth * 0.65;
  const len = 0.08 + d.wingLength * 0.42;
  return { core, span, w, len, outer: core + len };
}

export function ringPoints(d: BladeDesign, samples = 360): THREE.Vector2[] {
  const { core, span, w, len } = ringProfile(d);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < samples; i++) {
    const th = (i / samples) * Math.PI * 2;
    let phi = (th % span) / span; // 0..1 within wing slot
    if (d.spinDir < 0) phi = 1 - phi; // leading edge follows spin
    let h = 0;
    if (phi < w) {
      const t = phi / w;
      const round = Math.sin(Math.PI * t);
      // asymmetric spike: slow rise, sharp drop at leading edge
      const spike = Math.pow(t, 0.6 + (1 - d.wingSharp) * 0.8) * (t < 0.92 ? 1 : (1 - t) / 0.08);
      h = len * (round * (1 - d.wingSharp) + spike * d.wingSharp);
    } else {
      // small serration between wings
      const t = (phi - w) / (1 - w);
      h = len * 0.06 * Math.sin(Math.PI * t);
    }
    const r = core + h;
    // sweep: rotate outer points
    const a = th + d.wingCurve * (r - core) * 1.6 * -d.spinDir;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return pts;
}

function drawPattern(ctx: CanvasRenderingContext2D, S: number, d: BladeDesign, emissive: boolean) {
  const rnd = seeded(d.id + d.pattern);
  const c = S / 2;
  const col = emissive ? d.glow : d.secondary;
  const col2 = emissive ? d.glow : d.accent;
  ctx.save();
  ctx.translate(c, c);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (d.pattern) {
    case 'stripes': {
      ctx.fillStyle = col;
      const n = 6 + d.wings;
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate((i / n) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(S * 0.12, -S * 0.02);
        ctx.quadraticCurveTo(S * 0.3, S * 0.06 * d.spinDir, S * 0.5, S * 0.02);
        ctx.lineTo(S * 0.5, S * 0.07);
        ctx.quadraticCurveTo(S * 0.3, S * 0.11 * d.spinDir, S * 0.12, S * 0.02);
        ctx.fill();
        ctx.restore();
      }
      break;
    }
    case 'flames': {
      const n = 14;
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate((i / n) * Math.PI * 2 + rnd() * 0.2);
        const L = S * (0.25 + rnd() * 0.22);
        const g = ctx.createLinearGradient(S * 0.1, 0, S * 0.1 + L, 0);
        g.addColorStop(0, emissive ? d.glow : d.accent);
        g.addColorStop(1, emissive ? '#000' : d.secondary);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(S * 0.12, -S * 0.05);
        ctx.bezierCurveTo(S * 0.2, -S * 0.1, S * 0.25, S * 0.04 * d.spinDir, S * 0.1 + L, S * 0.03 * d.spinDir);
        ctx.bezierCurveTo(S * 0.25, S * 0.08, S * 0.2, S * 0.05, S * 0.12, S * 0.05);
        ctx.fill();
        ctx.restore();
      }
      break;
    }
    case 'stars': {
      ctx.fillStyle = col2;
      for (let i = 0; i < 70; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * S * 0.5, s = 1 + rnd() * S * 0.012;
        ctx.globalAlpha = 0.4 + rnd() * 0.6;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r, s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.font = `${S * 0.06}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < 10; i++) {
        const a = rnd() * Math.PI * 2, r = (0.2 + rnd() * 0.28) * S;
        drawIcon(ctx, 'sparkle', Math.cos(a) * r, Math.sin(a) * r, S * 0.06, d.accent, 'rgba(0,0,0,0)');
      }
      break;
    }
    case 'circuit': {
      ctx.strokeStyle = col2;
      ctx.fillStyle = col2;
      ctx.lineWidth = S * 0.006;
      for (let i = 0; i < 28; i++) {
        let a = rnd() * Math.PI * 2, r = S * (0.12 + rnd() * 0.15);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        for (let k = 0; k < 3; k++) {
          if (rnd() < 0.5) r += S * (0.04 + rnd() * 0.08);
          else a += (rnd() - 0.5) * 0.5;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r, S * 0.009, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'camo': {
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = [d.secondary, d.accent, d.primary][i % 3];
        if (emissive) ctx.fillStyle = i % 5 === 0 ? d.glow : '#000';
        const x = (rnd() - 0.5) * S, y = (rnd() - 0.5) * S;
        ctx.beginPath();
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2, rr = S * (0.03 + rnd() * 0.06);
          ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        ctx.fill();
      }
      break;
    }
    case 'carbon': {
      const t = S / 40;
      for (let x = -20; x < 20; x++)
        for (let y = -20; y < 20; y++) {
          ctx.fillStyle = emissive ? ((x + y) % 7 === 0 ? d.glow : '#000') : (x + y) % 2 ? d.secondary : '#2a2a2a';
          ctx.fillRect(x * t, y * t, t, t);
        }
      break;
    }
    case 'scales': {
      ctx.strokeStyle = col2;
      ctx.lineWidth = S * 0.005;
      const t = S / 16;
      for (let y = -9; y < 9; y++)
        for (let x = -9; x < 9; x++) {
          ctx.beginPath();
          ctx.arc(x * t + (y % 2 ? t / 2 : 0), y * t * 0.7, t * 0.55, 0, Math.PI);
          ctx.stroke();
        }
      break;
    }
    case 'radial': {
      ctx.strokeStyle = col2;
      for (let i = 1; i < 8; i++) {
        ctx.lineWidth = S * 0.004 * (i % 2 ? 1 : 2.5);
        ctx.beginPath();
        ctx.arc(0, 0, (i / 8) * S * 0.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = col;
      const n = 24;
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate((i / n) * Math.PI * 2);
        ctx.fillRect(S * 0.15, -S * 0.004, S * 0.35, S * 0.008);
        ctx.restore();
      }
      break;
    }
    case 'lightning': {
      ctx.strokeStyle = col2;
      ctx.lineWidth = S * 0.012;
      ctx.shadowColor = d.glow;
      ctx.shadowBlur = S * 0.02;
      for (let i = 0; i < 9; i++) {
        let a = (i / 9) * Math.PI * 2, r = S * 0.12;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        while (r < S * 0.5) {
          r += S * (0.04 + rnd() * 0.05);
          a += (rnd() - 0.5) * 0.45;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.stroke();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

function drawGlyph(ctx: CanvasRenderingContext2D, glyph: string, x: number, y: number, size: number, rot: number, color: string, glow?: string) {
  if (!glyph) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.15; }
  if (drawIcon(ctx, glyph, 0, 0, size * 0.92, color)) { ctx.restore(); return; }
  ctx.font = `900 ${size}px "Orbitron", "Segoe UI Symbol", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = size * 0.15;
  }
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText(glyph, 0, 0);
  ctx.fillStyle = color;
  ctx.fillText(glyph, 0, 0);
  ctx.restore();
}

/** Paints the top-face texture. extent = world half-size the canvas covers. */
export function makeFaceTextures(d: BladeDesign, S = 512) {
  const mk = () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    return cv;
  };
  const base = mk();
  const ctx = base.getContext('2d')!;
  // base gradient
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, d.primary);
  g.addColorStop(1, shade(d.primary, -0.35));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  drawPattern(ctx, S, d, false);
  for (const dc of d.decals) drawGlyph(ctx, dc.glyph, S / 2 + dc.x * S * 0.5, S / 2 + dc.y * S * 0.5, dc.size * S * 0.5, dc.rot, dc.color);

  const em = mk();
  const ectx = em.getContext('2d')!;
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, S, S);
  ectx.globalAlpha = 0.7;
  drawPattern(ectx, S, d, true);
  ectx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(base);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const etex = new THREE.CanvasTexture(em);
  etex.colorSpace = THREE.SRGBColorSpace;
  return { tex, etex };
}

export function makeEmblemTexture(d: BladeDesign, S = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, shade(d.secondary, 0.25));
  g.addColorStop(0.85, d.secondary);
  g.addColorStop(1, d.accent);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  drawGlyph(ctx, d.emblem, S / 2, S / 2 + S * 0.02, S * 0.62, 0, d.emblemColor, d.glow);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function shade(hex: string, amt: number) {
  const c = new THREE.Color(hex);
  if (amt < 0) c.lerp(new THREE.Color(0, 0, 0), -amt);
  else c.lerp(new THREE.Color(1, 1, 1), amt);
  return '#' + c.getHexString();
}

export interface BladeModel {
  group: THREE.Group; // origin at tip contact point
  spinner: THREE.Group; // rotate this around Y
  glowRing: THREE.Mesh;
  height: number;
  outer: number;
  dispose(): void;
}

/** Build a blade model in blade units (outer radius ~1). Caller scales it. */
export function buildBladeModel(d: BladeDesign): BladeModel {
  const group = new THREE.Group();
  const spinner = new THREE.Group();
  group.add(spinner);
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  const tipH = 0.22 + d.tipHeight * 0.25;
  const discY = tipH + 0.06;
  const discT = 0.1 + d.discWeight * 0.06;
  const ringY = discY + discT + 0.01;
  const ringT = 0.1 + d.ringThickness * 0.12;

  // ---- tip / driver
  const tipMat = track(new THREE.MeshStandardMaterial({ color: d.tip === 'rubber' ? '#222' : shade(d.secondary, 0.15), metalness: 0.4, roughness: d.tip === 'rubber' ? 0.9 : 0.35 }));
  const prof: THREE.Vector2[] = [];
  const bodyR = 0.32;
  switch (d.tip) {
    case 'sharp': prof.push(new THREE.Vector2(0.001, 0), new THREE.Vector2(0.08, 0.1), new THREE.Vector2(0.2, tipH * 0.75)); break;
    case 'needle': prof.push(new THREE.Vector2(0.001, 0), new THREE.Vector2(0.03, 0.12), new THREE.Vector2(0.06, tipH * 0.6), new THREE.Vector2(0.2, tipH * 0.8)); break;
    case 'ball': for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI * 0.5; prof.push(new THREE.Vector2(Math.sin(a) * 0.15 + 0.001, 0.15 - Math.cos(a) * 0.15)); } prof.push(new THREE.Vector2(0.22, tipH * 0.8)); break;
    case 'flat': prof.push(new THREE.Vector2(0.001, 0), new THREE.Vector2(0.17, 0), new THREE.Vector2(0.19, 0.04), new THREE.Vector2(0.22, tipH * 0.8)); break;
    case 'rubber': prof.push(new THREE.Vector2(0.001, 0), new THREE.Vector2(0.21, 0), new THREE.Vector2(0.24, 0.05), new THREE.Vector2(0.24, tipH * 0.8)); break;
    case 'wheel': for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; prof.push(new THREE.Vector2(0.12 + Math.sin(a) * 0.1, 0.1 - Math.cos(a) * 0.1)); } prof.push(new THREE.Vector2(0.22, tipH * 0.8)); break;
  }
  prof.push(new THREE.Vector2(bodyR, tipH), new THREE.Vector2(bodyR, discY), new THREE.Vector2(0.001, discY));
  const tipMesh = new THREE.Mesh(track(new THREE.LatheGeometry(prof, 32)), tipMat);
  tipMesh.castShadow = true;
  spinner.add(tipMesh);

  // ---- weight disc
  const discR = 0.55 + d.discSize * 0.35;
  const discMat = track(new THREE.MeshStandardMaterial({ color: '#b8c0cc', metalness: 0.95, roughness: 0.22 }));
  const dprof = [
    new THREE.Vector2(0.001, discY),
    new THREE.Vector2(discR * 0.95, discY),
    new THREE.Vector2(discR, discY + discT * 0.3),
    new THREE.Vector2(discR, discY + discT * 0.8),
    new THREE.Vector2(discR * 0.92, discY + discT),
    new THREE.Vector2(0.001, discY + discT),
  ];
  const disc = new THREE.Mesh(track(new THREE.LatheGeometry(dprof, 48)), discMat);
  disc.castShadow = true;
  spinner.add(disc);
  for (let i = 0; i < d.discNotches; i++) {
    const a = (i / d.discNotches) * Math.PI * 2;
    const bump = new THREE.Mesh(track(new THREE.BoxGeometry(0.12, discT * 0.9, 0.08)), discMat);
    bump.position.set(Math.cos(a) * discR, discY + discT * 0.5, Math.sin(a) * discR);
    bump.rotation.y = -a;
    spinner.add(bump);
  }

  // ---- attack ring
  const pts = ringPoints(d);
  const shape = new THREE.Shape(pts);
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.2, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = track(new THREE.ExtrudeGeometry(shape, { depth: ringT, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 2, curveSegments: 4 }));
  geo.rotateX(-Math.PI / 2); // extrude now goes +Y; shape y -> -z
  // wing tilt: lift outer edges
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const core = ringProfile(d).core;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    pos.setY(i, pos.getY(i) + Math.max(0, r - core) * d.wingTilt * 0.35);
  }
  geo.computeVertexNormals();
  const outer = ringProfile(d).outer;
  const { tex, etex } = makeFaceTextures(d);
  const ext = outer + 0.05;
  for (const t of [tex, etex]) {
    t.repeat.set(1 / (2 * ext), 1 / (2 * ext));
    t.offset.set(0.5, 0.5);
    track(t);
  }
  const capMat = track(new THREE.MeshStandardMaterial({ map: tex, emissiveMap: etex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.9, metalness: d.metal, roughness: d.rough }));
  const sideMat = track(new THREE.MeshStandardMaterial({ color: shade(d.primary, -0.2), metalness: Math.min(1, d.metal + 0.2), roughness: d.rough }));
  const ring = new THREE.Mesh(geo, [capMat, sideMat]);
  ring.position.y = ringY;
  ring.castShadow = true;
  spinner.add(ring);

  // glowing edge ring
  const glowMat = track(new THREE.MeshBasicMaterial({ color: d.glow, transparent: true, opacity: 0.9, toneMapped: false }));
  const glowRing = new THREE.Mesh(track(new THREE.TorusGeometry(core * 0.98, 0.022, 8, 64)), glowMat);
  glowRing.rotation.x = Math.PI / 2;
  glowRing.position.y = ringY + ringT + 0.04;
  spinner.add(glowRing);

  // ---- face bolt with emblem
  const etexE = track(makeEmblemTexture(d));
  const boltSide = track(new THREE.MeshStandardMaterial({ color: d.accent, metalness: 0.8, roughness: 0.25 }));
  const boltTop = track(new THREE.MeshStandardMaterial({ map: etexE, metalness: 0.3, roughness: 0.4, emissive: new THREE.Color(d.glow), emissiveIntensity: 0.15 }));
  const bolt = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 0.33, 0.12, 40)), [boltSide, boltTop, boltSide]);
  bolt.position.y = ringY + ringT + 0.09;
  bolt.rotation.y = Math.PI;
  bolt.castShadow = true;
  spinner.add(bolt);

  const height = bolt.position.y + 0.06;
  return {
    group, spinner, glowRing, height, outer,
    dispose() { for (const x of disposables) x.dispose(); },
  };
}
