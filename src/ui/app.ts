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

export { MenuNav } from './nav';

const confirms = new Map<string, number>();
/** Destructive actions need a second press within 2.5s. Returns true when confirmed. */
export function confirmTwice(app: App, key: string, msg: string): boolean {
  const now = performance.now();
  const t = confirms.get(key);
  if (t && now - t < 2500) { confirms.delete(key); return true; }
  confirms.set(key, now);
  app.toast(msg);
  app.sfx.play('back');
  return false;
}
