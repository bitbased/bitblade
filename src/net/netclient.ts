// Client-side latency hiding for online guests:
//  - other blades are drawn INTERP_DELAY in the past, interpolated between host snapshots (smooth, no jumps)
//  - our own blades are PREDICTED with a local copy of the sim, then reconciled against each snapshot by
//    replaying the inputs the host hasn't acknowledged yet; residual error is blended out over a few frames.
import { Sim } from '../game/sim';
import type { Control, GameEvent, GameState, MatchConfig, TopState } from '../game/types';

const INTERP_DELAY = 0.1; // seconds behind the newest snapshot for remote entities
const STEP = 1 / 120;

interface Snap { t: number; s: GameState }
interface InputRec { seq: number; i: number; c: Control; dt: number }

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

export class NetClient {
  pred: Sim;
  mine: number[];
  snaps: Snap[] = [];
  inputs: InputRec[] = [];
  seq = 0;
  renderT = -1;
  correction = new Map<number, { x: number; y: number; z: number }>();
  latest: GameState;

  constructor(cfg: MatchConfig, mine: number[]) {
    this.pred = new Sim(cfg);
    this.mine = mine;
    this.latest = this.pred.s;
  }

  private canPredict(i: number) {
    const st = this.latest.tops[i];
    return this.latest.phase === 'battle' && !!st?.alive && !!this.pred.s.tops[i]?.alive;
  }

  /** Feed a host snapshot. Returns its gameplay events for sfx/vfx. */
  onSnap(s: GameState, ack: Record<string, number> | undefined): GameEvent[] {
    const ev = s.events ?? [];
    s.events = [];
    this.latest = s;
    this.snaps.push({ t: s.t, s });
    while (this.snaps.length > 30) this.snaps.shift();
    // keep the render clock just behind the newest snapshot
    const target = s.t - INTERP_DELAY;
    if (this.renderT < 0 || Math.abs(this.renderT - target) > 0.3) this.renderT = target;
    else this.renderT += (target - this.renderT) * 0.1;
    this.reconcile(s, ack ?? {});
    return ev;
  }

  private reconcile(s: GameState, ack: Record<string, number>) {
    const P = this.pred;
    // non-own world state comes straight from the host
    const keepOwn = new Map<number, TopState>();
    for (const i of this.mine) if (P.s.tops[i]) keepOwn.set(i, P.s.tops[i]);
    P.s = JSON.parse(JSON.stringify({ ...s, events: [] }));
    for (const i of this.mine) {
      const before = keepOwn.get(i);
      const acked = ack[i] ?? -1;
      this.inputs = this.inputs.filter((r) => r.i !== i || r.seq > acked);
      if (!s.tops[i]?.alive || s.phase !== 'battle') { this.correction.delete(i); continue; }
      // replay unacknowledged inputs on top of the authoritative state
      for (const r of this.inputs) if (r.i === i) this.simulate(i, r.c, r.dt);
      const now = P.s.tops[i];
      if (before && now) {
        const c = this.correction.get(i) ?? { x: 0, y: 0, z: 0 };
        const dx = before.x + c.x - now.x, dy = before.y + c.y - now.y, dz = before.z + c.z - now.z;
        if (Math.hypot(dx, dz) < 3) this.correction.set(i, { x: dx, y: dy, z: dz });
        else this.correction.delete(i); // too far off (respawn / knock-out): snap
      }
    }
  }

  private simulate(i: number, c: Control, dt: number) {
    const n = Math.max(1, Math.round(dt / STEP));
    const P = this.pred;
    for (let k = 0; k < n; k++) {
      P.setControl(i, { ...c, dash: k === 0 && c.dash, jump: k === 0 && c.jump, item: k === 0 && c.item, special: k === 0 && c.special });
      if (i === this.mine[0]) P.s.t += dt / n;
      P.predictStep(i, dt / n);
    }
  }

  /** Record a local input for blade i, apply it to the prediction immediately. Returns the sequence number to send. */
  input(i: number, c: Control, dt: number) {
    const seq = ++this.seq;
    if (this.canPredict(i)) {
      this.inputs.push({ seq, i, c, dt });
      if (this.inputs.length > 240) this.inputs.shift();
      this.simulate(i, c, dt);
    }
    return seq;
  }

  /** State to render this frame. */
  frame(dt: number): GameState {
    this.renderT += dt;
    const L = this.latest;
    let a: Snap | null = null, b: Snap | null = null;
    for (let k = this.snaps.length - 1; k >= 0; k--) {
      if (this.snaps[k].t <= this.renderT) { a = this.snaps[k]; b = this.snaps[k + 1] ?? null; break; }
    }
    const tops = L.tops.map((t, i) => {
      if (this.mine.includes(i) && this.canPredict(i)) {
        const p = this.pred.s.tops[i];
        const c = this.correction.get(i);
        if (c) { const k = Math.exp(-12 * dt); c.x *= k; c.y *= k; c.z *= k; }
        return { ...t, ...p, x: p.x + (c?.x ?? 0), y: p.y + (c?.y ?? 0), z: p.z + (c?.z ?? 0), item: t.item, roll: t.roll, special: t.special, score: t.score, kos: t.kos };
      }
      const ta = a?.s.tops[i], tb = b?.s.tops[i];
      if (ta && tb && b && a && tb.alive === ta.alive) {
        const f = Math.max(0, Math.min(1, (this.renderT - a.t) / Math.max(1e-4, b.t - a.t)));
        return { ...t, x: lerp(ta.x, tb.x, f), y: lerp(ta.y, tb.y, f), z: lerp(ta.z, tb.z, f), tx: lerp(ta.tx, tb.tx, f), tz: lerp(ta.tz, tb.tz, f), angle: lerp(ta.angle, tb.angle, f), vx: tb.vx, vy: tb.vy, vz: tb.vz };
      }
      // past the newest snapshot: extrapolate briefly
      const src = (a ?? this.snaps[this.snaps.length - 1])?.s.tops[i] ?? t;
      const age = Math.max(0, Math.min(0.1, this.renderT - (a?.t ?? L.t)));
      return { ...t, x: src.x + src.vx * age, y: src.y + src.vy * age, z: src.z + src.vz * age };
    });
    return { ...L, tops };
  }
}
