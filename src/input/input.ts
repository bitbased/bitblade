// Unified input: two keyboard layouts, mouse, any number of gamepads, touch joystick + gyro tilt.
import type { Control, ControllerSpec } from '../game/types';

const K1 = { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], dash: ['Space'], jump: ['KeyF', 'ShiftLeft'], item: ['KeyE'], special: ['KeyQ'] };
const K2 = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], dash: ['Enter', 'Numpad0'], jump: ['ShiftRight', 'NumpadDecimal'], item: ['Slash', 'NumpadEnter'], special: ['Period', 'Numpad1'] };

export const CONTROL_HELP: Record<string, string> = {
  kb: 'WASD or arrows move · Space / Enter dash (hold: overdrive) · F / Shift jump · E or / item · Q or . special',
  kb1: 'WASD move · Space dash (hold: overdrive) · F/LShift jump · E item · Q special',
  kb2: 'Arrows move · Enter dash (hold: overdrive) · RShift jump · / item · . special',
  mouse: 'Hold LMB to steer to cursor · RMB dash (hold: overdrive) · Space jump · E item · Q special',
  pad: 'Stick move · A/RT dash (hold: overdrive) · B/LB jump · X/RB item · Y/LT special',
  touch: 'Left thumb joystick (or tilt) · right buttons: dash (hold: overdrive) / jump / item / special',
  cpu: 'Computer controlled',
  remote: 'Online player',
};

export type DeviceKey = string; // 'kb1' | 'kb2' | 'mouse' | 'pad0' | 'touch'

export function specKey(s: ControllerSpec): DeviceKey {
  return s.type === 'pad' ? `pad${s.index}` : s.type;
}

export function specLabel(s: ControllerSpec) {
  switch (s.type) {
    case 'kb': return 'Keyboard';
    case 'kb1': return 'Keyboard (WASD)';
    case 'kb2': return 'Keyboard (Arrows)';
    case 'mouse': return 'Mouse';
    case 'pad': return `Gamepad ${s.index + 1}`;
    case 'touch': return s.gyro ? 'Touch + Gyro' : 'Touch';
    case 'cpu': return `CPU ${['', 'Easy', 'Normal', 'Hard'][s.level]}`;
    case 'remote': return 'Online';
  }
}

export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  mouseNdc = { x: 0, y: 0 };
  mouseButtons = 0;
  mousePressed = 0;
  mouseMoved = false;
  padPrev: boolean[][] = [];
  padNow: boolean[][] = [];
  padAxes: number[][] = [];
  touch: TouchControls | null = null;
  gyro = { on: false, beta: 0, gamma: 0, b0: 0, g0: 0, calibrated: false };
  /** world-space ground point under mouse, provided by the renderer */
  mouseWorld: (() => { x: number; z: number } | null) | null = null;

  constructor() {
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Tab'].includes(e.code) && document.body.classList.contains('ingame')) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      this.mouseNdc.x = (e.clientX / innerWidth) * 2 - 1;
      this.mouseNdc.y = -(e.clientY / innerHeight) * 2 + 1;
      this.mouseMoved = true;
    });
    addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      this.mousePressed |= 1 << e.button;
    });
    addEventListener('mouseup', (e) => (this.mouseButtons &= ~(1 << e.button)));
    addEventListener('contextmenu', (e) => { if (document.body.classList.contains('ingame')) e.preventDefault(); });
    addEventListener('deviceorientation', (e) => {
      this.gyro.beta = e.beta ?? 0;
      this.gyro.gamma = e.gamma ?? 0;
      if (this.gyro.on && !this.gyro.calibrated) this.calibrateGyro();
    });
  }

  static isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  async enableGyro() {
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    try {
      if (DOE?.requestPermission) {
        const r = await DOE.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch { return false; }
    this.gyro.on = true;
    this.gyro.calibrated = false;
    return true;
  }

  calibrateGyro() {
    this.gyro.b0 = this.gyro.beta;
    this.gyro.g0 = this.gyro.gamma;
    this.gyro.calibrated = true;
  }

  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      this.padPrev[i] = this.padNow[i] ?? [];
      if (!p || !p.connected) { this.padNow[i] = []; this.padAxes[i] = []; continue; }
      this.padNow[i] = p.buttons.map((b) => b.pressed || b.value > 0.5);
      this.padAxes[i] = [...p.axes];
    }
  }

  endFrame() {
    this.pressed.clear();
    this.mousePressed = 0;
    this.touch?.endFrame();
  }

  connectedPads(): number[] {
    const out: number[] = [];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) if (pads[i]?.connected) out.push(i);
    return out;
  }

  padName(i: number) {
    const p = navigator.getGamepads?.()[i];
    return p ? p.id.replace(/\(.*?\)/g, '').trim().slice(0, 28) : `Gamepad ${i + 1}`;
  }

  private padBtn(i: number, b: number) { return !!this.padNow[i]?.[b]; }
  private padEdge(i: number, b: number) { return !!this.padNow[i]?.[b] && !this.padPrev[i]?.[b]; }
  private anyKey(list: string[]) { return list.some((k) => this.keys.has(k)); }
  private anyPressed(list: string[]) { return list.some((k) => this.pressed.has(k)); }

  rumble(spec: ControllerSpec, strength: number, ms = 120) {
    if (spec.type === 'pad') {
      const p = navigator.getGamepads?.()[spec.index] as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, o: object) => void } }) | null;
      p?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.6) });
    } else if (spec.type === 'touch' && navigator.vibrate) navigator.vibrate(Math.min(60, ms * strength));
  }

  read(spec: ControllerSpec, me?: { x: number; z: number }): Control {
    const c: Control = { mx: 0, mz: 0, dash: false, jump: false, item: false, special: false };
    const kb = (L: typeof K1) => {
      c.mx = (this.anyKey(L.right) ? 1 : 0) - (this.anyKey(L.left) ? 1 : 0);
      c.mz = (this.anyKey(L.down) ? 1 : 0) - (this.anyKey(L.up) ? 1 : 0);
      c.dash = this.anyPressed(L.dash);
      c.hold = this.anyKey(L.dash);
      // pinball flippers — several keys each side (5 Shift presses wake Windows Sticky Keys; Ctrl / Tab / Enter don't)
      c.flipL = this.anyKey(['ShiftLeft', 'ControlLeft', 'Tab', 'KeyZ']);
      c.flipR = this.anyKey(['ShiftRight', 'ControlRight', 'Enter', 'NumpadEnter', 'Slash']);
      c.jump = this.anyPressed(L.jump);
      c.item = this.anyPressed(L.item);
      c.special = this.anyPressed(L.special);
    };
    switch (spec.type) {
      case 'kb': { // (both layouts at once)
        kb(K1); const a = { ...c }; kb(K2);
        if (Math.hypot(a.mx, a.mz) > Math.hypot(c.mx, c.mz)) { c.mx = a.mx; c.mz = a.mz; }
        c.dash ||= a.dash; c.hold ||= a.hold; c.jump ||= a.jump; c.item ||= a.item; c.special ||= a.special;
        break;
      }
      case 'kb1': kb(K1); break;
      case 'kb2': kb(K2); break;
      case 'mouse': {
        const w = this.mouseWorld?.();
        if (w && me) {
          const dx = w.x - me.x, dz = w.z - me.z, d = Math.hypot(dx, dz) || 1;
          const mag = Math.min(1, d / 3);
          if (this.mouseButtons & 1) { c.mx = (dx / d) * mag; c.mz = (dz / d) * mag; }
          if (this.mousePressed & 4) { c.mx = dx / d; c.mz = dz / d; c.dash = true; }
          if (this.mousePressed & 2) { c.mx = dx / d; c.mz = dz / d; c.dash = true; }
          c.hold = !!(this.mouseButtons & 6);
        }
        c.jump = this.anyPressed(['Space']);
        c.item = this.anyPressed(['KeyE']) || !!(this.mousePressed & 8);
        c.special = this.anyPressed(['KeyQ']) || !!(this.mousePressed & 16);
        // WASD also works in mouse mode
        const kx = (this.anyKey(K1.right) ? 1 : 0) - (this.anyKey(K1.left) ? 1 : 0);
        const kz = (this.anyKey(K1.down) ? 1 : 0) - (this.anyKey(K1.up) ? 1 : 0);
        if (kx || kz) { c.mx = kx; c.mz = kz; }
        break;
      }
      case 'pad': {
        const i = spec.index;
        const ax = this.padAxes[i] ?? [];
        let x = ax[0] ?? 0, y = ax[1] ?? 0;
        const m = Math.hypot(x, y);
        if (m < 0.15) { x = 0; y = 0; } else { const k = (m - 0.15) / 0.85 / m; x *= k; y *= k; }
        if (this.padBtn(i, 14)) x = -1;
        if (this.padBtn(i, 15)) x = 1;
        if (this.padBtn(i, 12)) y = -1;
        if (this.padBtn(i, 13)) y = 1;
        c.mx = x; c.mz = y;
        c.dash = this.padEdge(i, 0) || this.padEdge(i, 7);
        c.hold = this.padBtn(i, 0) || this.padBtn(i, 7);
        c.flipL = this.padBtn(i, 4) || this.padBtn(i, 6);
        c.flipR = this.padBtn(i, 5) || this.padBtn(i, 7);
        c.jump = this.padEdge(i, 1) || this.padEdge(i, 4);
        c.item = this.padEdge(i, 2) || this.padEdge(i, 5);
        c.special = this.padEdge(i, 3) || this.padEdge(i, 6);
        break;
      }
      case 'touch': {
        const t = this.touch;
        if (t) {
          c.mx = t.jx; c.mz = t.jy;
          c.dash = t.edge.dash; c.jump = t.edge.jump; c.item = t.edge.item; c.special = t.edge.special;
          c.hold = t.dashHeld;
          c.flipL = t.flipLHeld; c.flipR = t.flipRHeld;
        }
        if (spec.gyro && this.gyro.on) {
          const gx = (this.gyro.gamma - this.gyro.g0) / 25, gz = (this.gyro.beta - this.gyro.b0) / 25;
          if (Math.hypot(gx, gz) > 0.12 && Math.hypot(c.mx, c.mz) < 0.1) { c.mx = Math.max(-1, Math.min(1, gx)); c.mz = Math.max(-1, Math.min(1, gz)); }
        }
        break;
      }
    }
    return c;
  }

  /** Devices that pressed their "join/confirm" button this frame. */
  joinPresses(): ControllerSpec[] {
    const out: ControllerSpec[] = [];
    if (this.pressed.has('Space')) out.push({ type: 'kb1' });
    if (this.pressed.has('Enter') || this.pressed.has('Numpad0')) out.push({ type: 'kb2' });
    for (let i = 0; i < this.padNow.length; i++) if (this.padEdge(i, 0) || this.padEdge(i, 9)) out.push({ type: 'pad', index: i });
    return out;
  }

  /** the device someone just used: a key (which layout it belongs to), a gamepad button or a stick push */
  deviceUsed(): ControllerSpec | null {
    for (const code of this.pressed) {
      if (/^(Arrow|Numpad)|^(Enter|ShiftRight|ControlRight|Slash|Period|Comma)$/.test(code)) return { type: 'kb2' };
      if (/^(Key|Digit|Space|ShiftLeft|ControlLeft|Tab)/.test(code)) return { type: 'kb1' };
    }
    for (let i = 0; i < this.padNow.length; i++) {
      for (let b = 0; b < (this.padNow[i]?.length ?? 0); b++) if (this.padEdge(i, b)) return { type: 'pad', index: i };
      const ax = this.padAxes[i] ?? [], was = this.padStickWas[i] ?? false, now = Math.abs(ax[0] ?? 0) > 0.6 || Math.abs(ax[1] ?? 0) > 0.6;
      this.padStickWas[i] = now;
      if (now && !was) return { type: 'pad', index: i };
    }
    return null;
  }
  private padStickWas: boolean[] = [];

  /** start/escape pressed on any device → pause */
  pausePressed() {
    if (this.pressed.has('Escape') || this.pressed.has('KeyP')) return true;
    for (let i = 0; i < this.padNow.length; i++) if (this.padEdge(i, 9)) return true;
    return false;
  }
}

/** On-screen joystick + buttons for phones/tablets. */
export class TouchControls {
  root: HTMLDivElement;
  jx = 0; jy = 0;
  edge = { dash: false, jump: false, item: false, special: false };
  dashHeld = false;
  /** pinball: the big flipper pads (held) */
  flipLHeld = false;
  flipRHeld = false;
  private stickId = -1;
  private cx = 0; private cy = 0;
  private knob: HTMLDivElement;
  private base: HTMLDivElement;

  constructor(parent: HTMLElement, pinball = false) {
    this.root = document.createElement('div');
    this.root.className = 'touch-ui' + (pinball ? ' pin' : '');
    this.root.innerHTML = `
      <div class="touch-stick-zone"><div class="touch-base"><div class="touch-knob"></div></div></div>
      <div class="touch-btns">
        <button data-b="special" class="tb tb-special">SP</button>
        <button data-b="item" class="tb tb-item">ITEM</button>
        <button data-b="jump" class="tb tb-jump">JUMP</button>
        <button data-b="dash" class="tb tb-dash">${pinball ? 'LAUNCH' : 'DASH'}</button>
      </div>${pinball ? '<button data-f="L" class="tf tf-l">◀ FLIP</button><button data-f="R" class="tf tf-r">FLIP ▶</button>' : ''}`;
    parent.appendChild(this.root);
    this.base = this.root.querySelector('.touch-base')!;
    this.knob = this.root.querySelector('.touch-knob')!;
    const zone = this.root.querySelector('.touch-stick-zone') as HTMLDivElement;
    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.stickId = t.identifier;
      this.cx = t.clientX; this.cy = t.clientY;
      // the base is positioned inside the stick zone, so convert from viewport to zone coordinates
      const r = zone.getBoundingClientRect();
      const half = this.base.offsetWidth / 2 || 60;
      this.base.style.left = `${t.clientX - r.left - half}px`;
      this.base.style.top = `${t.clientY - r.top - half}px`;
      this.base.style.bottom = 'auto';
      this.base.classList.add('on');
    }, { passive: false });
    zone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.stickId) continue;
        let dx = t.clientX - this.cx, dy = t.clientY - this.cy;
        const d = Math.hypot(dx, dy), max = 55;
        if (d > max) { dx = (dx / d) * max; dy = (dy / d) * max; }
        this.jx = dx / max; this.jy = dy / max;
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      }
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) if (t.identifier === this.stickId) {
        this.stickId = -1; this.jx = this.jy = 0;
        this.knob.style.transform = '';
        this.base.classList.remove('on');
      }
    };
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
    this.root.querySelectorAll<HTMLButtonElement>('.tb').forEach((b) => {
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const k = b.dataset.b as keyof TouchControls['edge'];
        this.edge[k] = true;
        if (k === 'dash') this.dashHeld = true;
        b.classList.add('down');
        navigator.vibrate?.(8);
      }, { passive: false });
      const up = () => { b.classList.remove('down'); if (b.dataset.b === 'dash') this.dashHeld = false; };
      b.addEventListener('touchend', up);
      b.addEventListener('touchcancel', up);
    });
    this.wireFlippers();
  }
  endFrame() { this.edge.dash = this.edge.jump = this.edge.item = this.edge.special = false; }
  /** pinball flipper pads: held while a finger is on them (several fingers at once is fine) */
  private wireFlippers() {
    this.root.querySelectorAll<HTMLButtonElement>('.tf').forEach((b) => {
      const set = (v: boolean) => { if (b.dataset.f === 'L') this.flipLHeld = v; else this.flipRHeld = v; b.classList.toggle('down', v); };
      b.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); navigator.vibrate?.(6); }, { passive: false });
      b.addEventListener('touchend', () => set(false));
      b.addEventListener('touchcancel', () => set(false));
    });
  }
  dispose() { this.root.remove(); }
}
