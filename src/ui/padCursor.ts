// Gamepad "mouse" for pointer-driven screens (the course editor): the left stick moves an on-screen cursor,
// buttons press / drag / release real pointer events on whatever is under it, so every click target —
// canvas painting, toolbar buttons, palettes, steppers — works with a controller without special-casing.
import type { App } from './app';

export class PadCursor {
  el: HTMLElement;
  x = innerWidth / 2;
  y = innerHeight / 2;
  active = false;
  private held: { button: number; target: Element } | null = null;
  private idle = 0;

  constructor(private app: App, parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'pad-cursor';
    parent.append(this.el);
  }

  private axis(i: number) {
    const inp = this.app.input;
    let v = 0;
    for (let p = 0; p < inp.padAxes.length; p++) { const a = inp.padAxes[p]?.[i] ?? 0; if (Math.abs(a) > Math.abs(v)) v = a; }
    return v;
  }

  btn(b: number) { const inp = this.app.input; for (let p = 0; p < inp.padNow.length; p++) if (inp.padNow[p]?.[b]) return true; return false; }
  edge(b: number) { const inp = this.app.input; for (let p = 0; p < inp.padNow.length; p++) if (inp.padNow[p]?.[b] && !inp.padPrev[p]?.[b]) return true; return false; }
  released(b: number) { const inp = this.app.input; for (let p = 0; p < inp.padNow.length; p++) if (!inp.padNow[p]?.[b] && inp.padPrev[p]?.[b]) return true; return false; }

  private under() {
    this.el.style.display = 'none';
    const t = document.elementFromPoint(this.x, this.y);
    this.el.style.display = '';
    return t;
  }

  private fire(type: string, target: Element, button: number, buttons: number) {
    const init: PointerEventInit = { bubbles: true, cancelable: true, clientX: this.x, clientY: this.y, button, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window };
    target.dispatchEvent(typeof PointerEvent !== 'undefined' ? new PointerEvent(type, init) : new MouseEvent(type, init));
  }

  /** A = left button, X = right button. Returns true while the cursor is in use this frame. */
  update(dt: number) {
    const ax = this.axis(0), ay = this.axis(1);
    const mag = Math.hypot(ax, ay);
    if (mag > 0.14) {
      this.active = true;
      this.idle = 0;
      const sp = 260 + 1300 * Math.pow(Math.min(1, (mag - 0.14) / 0.86), 2); // fine control near centre, fast at full tilt
      this.x = Math.max(0, Math.min(innerWidth - 1, this.x + (ax / mag) * sp * dt * Math.min(1, mag)));
      this.y = Math.max(0, Math.min(innerHeight - 1, this.y + (ay / mag) * sp * dt * Math.min(1, mag)));
      const t = this.held?.target ?? this.under();
      if (t) this.fire('pointermove', t, -1, this.held ? (this.held.button === 2 ? 2 : 1) : 0);
    } else this.idle += dt;
    for (const [pb, mb] of [[0, 0], [2, 2]] as const) {
      if (this.edge(pb) && !this.held) {
        this.active = true;
        const t = this.under();
        if (t) { this.held = { button: mb, target: t }; this.fire('pointerdown', t, mb, mb === 2 ? 2 : 1); }
      }
      if (this.released(pb) && this.held?.button === mb) {
        const t = this.held.target;
        this.held = null;
        this.fire('pointerup', t, mb, 0);
        // a press+release on the same DOM control is a click (canvas tools act on down/up instead)
        if (mb === 0 && t.tagName !== 'CANVAS' && this.under() && (t === this.under() || t.contains(this.under()!))) { (t as HTMLElement).click?.(); if ((t as HTMLElement).matches?.('input, textarea, select')) (t as HTMLElement).focus(); }
      }
    }
    this.el.classList.toggle('on', this.active && this.idle < 8);
    this.el.classList.toggle('down', !!this.held);
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
    return this.active;
  }

  dispose() { this.el.remove(); }
}
