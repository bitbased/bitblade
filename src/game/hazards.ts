// Kinematic hazards evaluated purely from marker + time, so host and clients agree without syncing.
import type { Marker } from './terrain';

export interface HazardPose {
  kind: 'arm' | 'saw' | 'bumper' | 'pillar';
  ax: number; az: number; // circle center or segment start
  bx: number; bz: number; // segment end (arm)
  r: number; // circle radius or segment half thickness
  w: number; // angular speed (arm)
  vx: number; vz: number; // linear velocity (saw)
  angle: number;
}

export function hazardPose(m: Marker, t: number): HazardPose | null {
  switch (m.kind) {
    case 'arm': {
      const a = (m.rot ?? 0) + (m.speed ?? 1) * t;
      const L = m.len ?? 4;
      return { kind: 'arm', ax: m.x, az: m.z, bx: m.x + Math.cos(a) * L, bz: m.z + Math.sin(a) * L, r: 0.32, w: m.speed ?? 1, vx: 0, vz: 0, angle: a };
    }
    case 'saw': {
      const w = m.speed ?? 0.5, R = m.r ?? 5;
      const a = (m.rot ?? 0) + w * t;
      return { kind: 'saw', ax: m.x + Math.cos(a) * R, az: m.z + Math.sin(a) * R, bx: 0, bz: 0, r: 0.75, w, vx: -Math.sin(a) * R * w, vz: Math.cos(a) * R * w, angle: t * 14 };
    }
    case 'bumper':
      return { kind: 'bumper', ax: m.x, az: m.z, bx: 0, bz: 0, r: m.r ?? 0.8, w: 0, vx: 0, vz: 0, angle: 0 };
    case 'pillar':
      return { kind: 'pillar', ax: m.x, az: m.z, bx: 0, bz: 0, r: m.r ?? 0.8, w: 0, vx: 0, vz: 0, angle: 0 };
    default:
      return null;
  }
}

/** closest point on segment ab to p */
export function closestOnSeg(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + dx * t, z: az + dz * t, t };
}
