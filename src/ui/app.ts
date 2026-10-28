// Screen/app contract shared by every UI screen.
import type { Input } from '../input/input';
import type { Sfx } from '../game/audio';

export type ScreenName = 'title' | 'menu' | 'modes' | 'lobby' | 'match' | 'results' | 'blades' | 'courses' | 'online' | 'settings';

export interface App {
  root: HTMLElement; // #ui overlay; screens render DOM in here
  canvas: HTMLCanvasElement; // shared WebGL canvas (use getRenderer(app.canvas) from game/render)
  input: Input;
  sfx: Sfx;
  go(screen: ScreenName, arg?: unknown): void;
  back(): void;
  toast(msg: string): void;
}

export interface Screen {
  mount(app: App, arg?: unknown): void;
  unmount(): void;
  update?(dt: number): void; // called every animation frame while mounted
  resize?(): void;
}

/** tiny DOM helper: h('div.cls#id', {attrs/on*}, ...children) */
export function h<T extends HTMLElement = HTMLElement>(sel: string, props: Record<string, unknown> | null = null, ...kids: (Node | string | null | undefined | false)[]): T {
  const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const tag = m?.[1] || 'div';
  const el = document.createElement(tag);
  const rest = m?.[2] ?? '';
  for (const part of rest.match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props)
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid as Node | string);
  return el as T;
}

/**
 * Gamepad/keyboard focus navigation for menus: arrows/dpad/stick move between `.nav` elements,
 * A/Enter/Space activates, B/Escape goes back. Call update() each frame.
 */
export class MenuNav {
  idx = 0;
  private cool = 0;
  constructor(private app: App, private container: HTMLElement, private onBack?: () => void) {}
  items() { return Array.from(this.container.querySelectorAll<HTMLElement>('.nav')).filter((e) => e.offsetParent !== null); }
  focus(i: number) {
    const it = this.items();
    if (!it.length) return;
    this.idx = (i + it.length) % it.length;
    it.forEach((e, k) => e.classList.toggle('focus', k === this.idx));
    it[this.idx].scrollIntoView({ block: 'nearest' });
  }
  update(dt: number) {
    const inp = this.app.input;
    this.cool -= dt;
    const it = this.items();
    if (!it.length) return;
    if (!it.some((e) => e.classList.contains('focus'))) this.focus(this.idx);
    let dy = 0, dx = 0;
    if (inp.pressed.has('ArrowDown') || inp.pressed.has('KeyS')) dy = 1;
    if (inp.pressed.has('ArrowUp') || inp.pressed.has('KeyW')) dy = -1;
    if (inp.pressed.has('ArrowRight') || inp.pressed.has('KeyD')) dx = 1;
    if (inp.pressed.has('ArrowLeft') || inp.pressed.has('KeyA')) dx = -1;
    let confirm = inp.pressed.has('Enter') || inp.pressed.has('Space');
    let back = inp.pressed.has('Escape') || inp.pressed.has('Backspace');
    for (let p = 0; p < inp.padNow.length; p++) {
      const now = inp.padNow[p] ?? [], prev = inp.padPrev[p] ?? [];
      const e = (b: number) => now[b] && !prev[b];
      if (e(13)) dy = 1;
      if (e(12)) dy = -1;
      if (e(15)) dx = 1;
      if (e(14)) dx = -1;
      if (e(0)) confirm = true;
      if (e(1)) back = true;
      const ax = inp.padAxes[p] ?? [];
      if (this.cool <= 0) {
        if ((ax[1] ?? 0) > 0.6) { dy = 1; this.cool = 0.22; }
        else if ((ax[1] ?? 0) < -0.6) { dy = -1; this.cool = 0.22; }
        else if ((ax[0] ?? 0) > 0.6) { dx = 1; this.cool = 0.22; }
        else if ((ax[0] ?? 0) < -0.6) { dx = -1; this.cool = 0.22; }
      }
    }
    const cur = it[this.idx];
    if (dx && cur?.dataset.navx !== undefined) {
      cur.dispatchEvent(new CustomEvent('navx', { detail: dx }));
      this.app.sfx.play('tick');
    } else if (dx) dy = dx;
    if (dy) { this.focus(this.idx + dy); this.app.sfx.play('tick'); }
    if (confirm && cur) { cur.click(); }
    if (back && this.onBack) { this.onBack(); this.app.sfx.play('back'); }
  }
}
