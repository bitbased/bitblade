// Keyboard + gamepad menu navigation used by every screen.
//  - spatial: arrows / d-pad / stick move to the nearest `.nav` element in that direction (grids, rows, panels)
//  - hold to repeat (keys, d-pad and stick), stick speed scales with tilt
//  - focus follows the element, so it survives screens re-rendering their DOM
//  - A / Enter / Space activates; B / Esc goes back (never Backspace: that deletes things)
//  - text fields are navigable: Enter types with the keyboard, A on a pad opens an on-screen keyboard
//  - LB / RB (or Q / E) flip tabs or step the screen's [data-shoulder] selector; START hits the primary button
//  - right stick scrolls long panels; mouse hover moves the focus too
//  - a prompt bar shows the buttons for whatever device you're using
import type { App } from './app';

/** 'key' = keyboard + mouse (one device, like PC games), 'pad' = controller, 'mouse' = touch-only (no prompts) */
type Device = 'key' | 'pad' | 'mouse';
let lastDevice: Device = 'mouse';
/** the bottom prompt bar appears once someone actually drives menus with keys or a pad */
let navUsed = false;
let padFamily: 'xbox' | 'ps' = 'xbox';
let lastPad = -1;
/** remembered focus per screen, so going Back lands where you left off */
const memory = new Map<string, string>();

function setDevice(d: Device, pad?: number) {
  if (pad !== undefined && pad !== lastPad) {
    lastPad = pad;
    const id = (typeof navigator !== 'undefined' && navigator.getGamepads?.()[pad]?.id) || '';
    padFamily = /054c|playstation|dualsense|dualshock|wireless controller/i.test(id) ? 'ps' : 'xbox';
  }
  if (typeof document === 'undefined') { lastDevice = d; return; }
  const b = document.body.classList;
  if (d === lastDevice && (d !== 'pad' || b.contains('pad-' + padFamily))) return;
  lastDevice = d;
  b.toggle('dev-pad', d === 'pad'); b.toggle('dev-key', d === 'key'); b.toggle('dev-mouse', d === 'mouse'); b.toggle('dev-touch', d === 'mouse');
  b.toggle('pad-ps', d === 'pad' && padFamily === 'ps'); b.toggle('pad-xbox', d === 'pad' && padFamily === 'xbox');
}

const PS: Record<string, string> = { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', START: 'OPTIONS', SELECT: 'SHARE' };
/** a button / key badge for prompts: glyph('A', 'ENTER') shows A on a pad, ENTER on a keyboard */
export function glyph(padBtn: string, key: string) {
  if (lastDevice === 'pad') {
    const lbl = padFamily === 'ps' ? PS[padBtn] ?? padBtn : padBtn;
    return `<i class="g g-${padBtn.toLowerCase()}${lbl.length > 2 ? ' wide' : ''}">${lbl}</i>`;
  }
  return key ? key.split(' ').map((k) => `<i class="g key">${k}</i>`).join('') : '';
}
let installed = false;
let hintsEl: HTMLElement | null = null;
let activeNav: MenuNav | null = null;
let touched = false;

const TEXT_SEL = 'input[type=text], input[type=url], input[type=search], input:not([type]), textarea';
const ITEM_SEL = `.nav, ${TEXT_SEL}`;

function isText(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'url', 'search', ''].includes((el as HTMLInputElement).type)));
}

function installGlobal() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const NAV_KEYS = /^(Arrow|Key[WASDQEZC]$|Enter$|Space$|Escape$|Backspace$|Tab$)/;
  addEventListener('keydown', (e) => {
    // only menu keys switch the prompts to keyboard (typing a name on a phone must not)
    if (!isText(e.target as Element) && NAV_KEYS.test(e.code)) { navUsed = true; setDevice('key'); document.body.classList.add('kb-nav'); }
    // typing in a field: Enter / Esc hand control back to the menu
    if (isText(e.target as Element) && (e.key === 'Escape' || (e.key === 'Enter' && (e.target as Element).tagName !== 'TEXTAREA'))) {
      (e.target as HTMLElement).blur();
      if (e.key === 'Escape') e.stopPropagation();
    }
  });
  // a real mouse keeps keyboard prompts (same device); a finger switches to touch (no prompts)
  addEventListener('pointermove', (e) => { if (e.isTrusted && e.pointerType === 'mouse' && lastDevice !== 'key' && Math.abs(e.movementX) + Math.abs(e.movementY) > 6) setDevice('key'); }, { passive: true });
  // kb-nav: focus came from menu keys (show focus rings); any click / tap / real mouse move clears it
  addEventListener('pointerdown', () => document.body.classList.remove('kb-nav'), { passive: true });
  addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' || Math.abs(e.movementX) + Math.abs(e.movementY) > 6) document.body.classList.remove('kb-nav'); }, { passive: true });
  addEventListener('pointerdown', (e) => { if (!e.isTrusted) return; setDevice(e.pointerType === 'touch' || e.pointerType === 'pen' ? 'mouse' : 'key'); }, { passive: true });
  // desktop starts with keyboard+mouse prompts, phones/tablets with none
  setDevice(typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches ? 'key' : 'mouse');
  // the mouse wheel only ever scrolls: it never changes a setting under the pointer (a focused number box lets go,
  // so the browser doesn't step it either)
  addEventListener('wheel', (e) => { const t = e.target as HTMLInputElement; if (t?.tagName === 'INPUT' && t.type === 'number' && document.activeElement === t) t.blur(); }, { passive: true });
  // a mouse click leaves the button DOM-focused; drop it so Enter/Space don't double-fire with the menu's own confirm
  addEventListener('click', (e) => { if ((e as MouseEvent).detail > 0) (e.target as HTMLElement)?.closest?.('button')?.blur(); }, true);
}

function visible(el: HTMLElement) {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function keyOf(el: HTMLElement) {
  let txt = el.textContent ?? '';
  el.querySelectorAll('.gb').forEach((b) => { txt = txt.replace(b.textContent ?? '', ''); });
  return `${el.tagName}|${(el.getAttribute('class') ?? '').replace(/\bfocus\b/g, '').trim()}|${txt.trim().slice(0, 40)}|${(el as HTMLInputElement).placeholder ?? ''}`;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return null;
}

// ------------------------------------------------------------------ on-screen keyboard (gamepad text entry)
const OSK_ROWS = ['1234567890', 'QWERTYUIOP', "ASDFGHJKL'", 'ZXCVBNM-_.'];

class Osk {
  el: HTMLElement;
  keys: HTMLElement[][] = [];
  r = 1; c = 0;
  lower = false;
  constructor(private app: App, private input: HTMLInputElement | HTMLTextAreaElement, private done: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'osk';
    const title = document.createElement('div');
    title.className = 'osk-title';
    title.textContent = (input.closest('.field')?.querySelector('label')?.textContent || input.placeholder || 'ENTER TEXT').toUpperCase();
    this.el.append(title);
    const preview = document.createElement('div');
    preview.className = 'osk-preview';
    this.el.append(preview);
    const rows = [...OSK_ROWS.map((r) => [...r]), ['⇧', 'SPACE', '⌫', 'DONE']];
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'osk-row';
      const keys: HTMLElement[] = [];
      for (const k of row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'osk-key' + (k.length > 1 ? ' wide' : '');
        b.textContent = k;
        b.onclick = () => this.press(k);
        b.onpointerenter = () => { this.r = rows.indexOf(row); this.c = row.indexOf(k); this.paint(); };
        line.append(b);
        keys.push(b);
      }
      this.keys.push(keys);
      this.el.append(line);
    }
    const hint = document.createElement('div');
    hint.className = 'osk-hint';
    hint.innerHTML = '<b>Ⓐ</b> type · <b>Ⓑ</b> delete · <b>Ⓨ</b> space · <b>LB</b> shift · <b>START</b> done';
    this.el.append(hint);
    document.body.append(this.el);
    this.paint();
  }
  get value() { return this.input.value; }
  set value(v: string) {
    const max = this.input.maxLength > 0 ? this.input.maxLength : 64;
    this.input.value = v.slice(0, max);
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
    this.paint();
  }
  press(k: string) {
    this.app.sfx.play('tick');
    if (k === 'DONE') return this.close();
    if (k === '⌫') { this.value = this.value.slice(0, -1); return; }
    if (k === '⇧') { this.lower = !this.lower; this.paint(); return; }
    if (k === 'SPACE') { this.value = this.value + ' '; return; }
    this.value = this.value + (this.lower ? k.toLowerCase() : k);
  }
  paint() {
    this.keys.forEach((row, r) => row.forEach((b, c) => {
      b.classList.toggle('focus', r === this.r && c === this.c);
      if (b.textContent!.length === 1 && /[A-Z]/i.test(b.textContent!)) b.textContent = this.lower ? b.textContent!.toLowerCase() : b.textContent!.toUpperCase();
    }));
    (this.el.querySelector('.osk-preview') as HTMLElement).textContent = this.value + '▏';
  }
  move(dx: number, dy: number) {
    if (dy) {
      const frac = (this.c + 0.5) / this.keys[this.r].length;
      this.r = (this.r + dy + this.keys.length) % this.keys.length;
      this.c = Math.min(this.keys[this.r].length - 1, Math.floor(frac * this.keys[this.r].length));
    }
    if (dx) this.c = (this.c + dx + this.keys[this.r].length) % this.keys[this.r].length;
    this.app.sfx.play('tick');
    this.paint();
  }
  close() {
    this.el.remove();
    this.input.dispatchEvent(new Event('change', { bubbles: true }));
    this.done();
  }
}

// ------------------------------------------------------------------ the navigator
export class MenuNav {
  private cur: HTMLElement | null = null;
  private curKey = '';
  private lastRect: { x: number; y: number } | null = null;
  private repDir = '';
  private repT = 0;
  private osk: Osk | null = null;
  /** extra prompt text for this screen, e.g. 'LB/RB tabs' (auto-detected when omitted) */
  hints: string | null = null;

  private memKey = '';
  private first = true;
  /** pads to ignore (e.g. lobby pads that drive their own player slot) */
  ignorePads = new Set<number>();

  constructor(private app: App, private container: HTMLElement, private onBack?: () => void) {
    installGlobal();
    this.memKey = `${container.className}|${container.querySelector('.screen-title, .menu-logo, h2')?.textContent ?? ''}`;
    activeNav = this;
    container.addEventListener('pointermove', (e) => {
      if ((e as PointerEvent).pointerType !== 'mouse') return;
      const t = (e.target as HTMLElement).closest?.(ITEM_SEL) as HTMLElement | null;
      if (t && t !== this.cur && container.contains(t) && !t.parentElement?.closest('.nav')) this.setCur(t, false);
    });
  }

  items() {
    return Array.from(this.container.querySelectorAll<HTMLElement>(ITEM_SEL)).filter((e) =>
      !(e as HTMLInputElement).disabled && visible(e) && !(e.parentElement?.closest('.nav') && isText(e)));
  }

  /** index of the focused element (kept for screens that rebuild and restore focus by index) */
  get idx() { const it = this.items(); return Math.max(0, this.cur ? it.indexOf(this.cur) : 0); }

  focus(i: number) {
    const it = this.items();
    if (!it.length) return;
    // first focus on a screen you've been to: land on what you had selected last time
    if (this.first) {
      this.first = false;
      const k = memory.get(this.memKey);
      const prev = k ? it.find((e) => keyOf(e) === k) : undefined;
      if (prev) { this.setCur(prev, true); return; }
    }
    this.setCur(it[((i % it.length) + it.length) % it.length], true);
  }

  private setCur(el: HTMLElement, scroll: boolean) {
    if (this.cur && this.cur !== el) this.cur.classList.remove('focus');
    this.cur = el;
    el.classList.add('focus');
    this.curKey = keyOf(el);
    memory.set(this.memKey, this.curKey);
    const r = el.getBoundingClientRect();
    this.lastRect = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (scroll) {
      const sp = scrollParent(el);
      if (sp) {
        const pr = sp.getBoundingClientRect(), er = el.getBoundingClientRect();
        // only when it's (partly) out of view — then bring it in with a little of what's next showing
        const pad = Math.min(40, pr.height * 0.12);
        if (er.top < pr.top) sp.scrollTop -= pr.top + pad - er.top;
        else if (er.bottom > pr.bottom) sp.scrollTop += er.bottom - (pr.bottom - pad);
      } else {
        const er = el.getBoundingClientRect();
        if (er.bottom > innerHeight || er.top < 0 || er.right > innerWidth || er.left < 0) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  /** after a re-render: same element if it survived, else its twin (same key), else the nearest one */
  private restore(it: HTMLElement[]) {
    if (this.cur && this.cur.isConnected && it.includes(this.cur)) { this.cur.classList.add('focus'); return; }
    const twin = it.find((e) => keyOf(e) === this.curKey);
    if (twin) { this.setCur(twin, false); return; }
    if (this.lastRect) {
      const lr = this.lastRect;
      let best = it[0], bd = Infinity;
      for (const e of it) { const r = e.getBoundingClientRect(); const d = Math.hypot(r.left + r.width / 2 - lr.x, r.top + r.height / 2 - lr.y); if (d < bd) { bd = d; best = e; } }
      this.setCur(best, false);
    } else this.setCur(it[0], false);
  }

  /** nearest item in a direction; wraps vertically like a list when nothing is further that way */
  private step(it: HTMLElement[], dx: number, dy: number) {
    const cur = this.cur!;
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bs = Infinity;
    for (const e of it) {
      if (e === cur) continue;
      const b = e.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      // must be past our edge in that direction (a little overlap allowed)
      const along = dx ? (dx > 0 ? b.left - a.right : a.left - b.right) : (dy > 0 ? b.top - a.bottom : a.top - b.bottom);
      if (along < -Math.min(a.width, a.height) * 0.4) continue;
      const main = dx ? (bx - ax) * dx : (by - ay) * dy;
      if (main <= 0) continue;
      // perpendicular distance, ignoring the part that already overlaps
      const ov = dx ? Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) : Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
      const off = dx ? Math.abs(by - ay) : Math.abs(bx - ax);
      const score = Math.max(0, along) + main * 0.3 + (ov > 0 ? ov * 2.5 + off * 0.5 : off * 0.15);
      if (score < bs) { bs = score; best = e; }
    }
    if (best) return best;
    if (dy) {
      // wrap round to the far end (down past the last row → the top row), in the column nearest where you are
      const ends = it.filter((e) => e !== cur).map((e) => ({ e, r: e.getBoundingClientRect() }));
      if (!ends.length) return null;
      const edge = dy > 0 ? Math.min(...ends.map((o) => o.r.top)) : Math.max(...ends.map((o) => o.r.bottom));
      const row = ends.filter((o) => (dy > 0 ? o.r.top - edge : edge - o.r.bottom) < Math.min(12, o.r.height * 0.5));
      row.sort((p, q) => Math.abs((p.r.left + p.r.right) / 2 - ax) - Math.abs((q.r.left + q.r.right) / 2 - ax));
      return row[0].e;
    }
    return null;
  }

  private padEdge(b: number) {
    const inp = this.app.input;
    for (let p = 0; p < inp.padNow.length; p++) if (!this.ignorePads.has(p) && inp.padNow[p]?.[b] && !inp.padPrev[p]?.[b]) { navUsed = true; setDevice('pad', p); return true; }
    return false;
  }

  private padHeld(b: number) {
    const inp = this.app.input;
    for (let p = 0; p < inp.padNow.length; p++) if (!this.ignorePads.has(p) && inp.padNow[p]?.[b]) return true;
    return false;
  }

  private axis(i: number) {
    const inp = this.app.input;
    let v = 0;
    for (let p = 0; p < inp.padAxes.length; p++) { if (this.ignorePads.has(p)) continue; const a = inp.padAxes[p]?.[i] ?? 0; if (Math.abs(a) > Math.abs(v)) v = a; }
    return v;
  }

  /** a direction key / d-pad button pressed since the last frame (edge, not hold) */
  private tapDir(): { dx: number; dy: number } | null {
    const p = this.app.input.pressed;
    const k = (...c: string[]) => c.some((x) => p.has(x));
    if (k('ArrowDown', 'KeyS') || this.padEdge(13)) return { dx: 0, dy: 1 };
    if (k('ArrowUp', 'KeyW') || this.padEdge(12)) return { dx: 0, dy: -1 };
    if (k('ArrowRight', 'KeyD') || this.padEdge(15)) return { dx: 1, dy: 0 };
    if (k('ArrowLeft', 'KeyA') || this.padEdge(14)) return { dx: -1, dy: 0 };
    return null;
  }

  /** held direction from any device, with how hard (stick tilt speeds up repeats) */
  private heldDir(): { dx: number; dy: number; mag: number } {
    const inp = this.app.input;
    const k = (...c: string[]) => c.some((x) => inp.keys.has(x));
    let dx = 0, dy = 0, mag = 1;
    if (k('ArrowDown', 'KeyS') || this.padHeld(13)) dy = 1;
    else if (k('ArrowUp', 'KeyW') || this.padHeld(12)) dy = -1;
    else if (k('ArrowRight', 'KeyD') || this.padHeld(15)) dx = 1;
    else if (k('ArrowLeft', 'KeyA') || this.padHeld(14)) dx = -1;
    else {
      const ax = this.axis(0), ay = this.axis(1);
      if (Math.max(Math.abs(ax), Math.abs(ay)) > 0.55) {
        setDevice('pad');
        // on a selector, only a clearly sideways push changes it — anything near vertical moves on (easy to leave)
        const sideways = this.cur?.dataset.navx !== undefined ? Math.abs(ax) > Math.abs(ay) * 1.6 : Math.abs(ax) > Math.abs(ay);
        if (!sideways) dy = Math.sign(ay); else dx = Math.sign(ax);
        mag = Math.max(Math.abs(ax), Math.abs(ay));
      }
    }
    return { dx, dy, mag };
  }

  update(dt: number) {
    const inp = this.app.input;
    activeNav = this;
    touched = true;
    if (this.osk) { this.updateOsk(dt); return; }
    // while typing in a field, the keyboard belongs to the field
    if (isText(document.activeElement) && this.container.contains(document.activeElement)) { this.renderHints(true); return; }
    const it = this.items();
    if (!it.length) { this.renderHints(); return; }
    this.restore(it);

    // directions with hold-to-repeat; key/d-pad taps are read as press events too, so a quick tap between two
    // slow frames is never lost
    const d = this.heldDir();
    const tap = this.tapDir();
    if (tap) { d.dx = tap.dx; d.dy = tap.dy; d.mag = 1; }
    const dir = d.dx || d.dy ? `${d.dx},${d.dy}` : '';
    let fire = false;
    if (tap) { fire = true; this.repT = 0.36; }
    else if (dir && dir !== this.repDir) { fire = true; this.repT = 0.36; }
    else if (dir) { this.repT -= dt; if (this.repT <= 0) { fire = true; this.repT = 0.11 / Math.max(0.6, d.mag) - 0.03; } }
    this.repDir = dir;
    if (fire) this.move(it, d.dx, d.dy);

    const cur = this.cur;
    const confirm = inp.pressed.has('Enter') || inp.pressed.has('Space') || this.padEdge(0);
    const back = inp.pressed.has('Escape') || this.padEdge(1);
    if (confirm && cur) {
      if (isText(cur)) this.editText(cur as HTMLInputElement);
      else cur.click();
    }
    if (back && this.onBack) { this.onBack(); this.app.sfx.play('back'); }

    // shoulders: tabs or the screen's main selector
    const lb = this.padEdge(4) || inp.pressed.has('KeyQ'), rb = this.padEdge(5) || inp.pressed.has('KeyE');
    if (lb || rb) this.shoulder(rb ? 1 : -1);
    const lt = this.padEdge(6) || inp.pressed.has('KeyZ'), rt = this.padEdge(7) || inp.pressed.has('KeyC');
    if (lt || rt) this.trigger(rt ? 1 : -1, it);
    // START: the screen's primary action
    if (this.padEdge(9)) {
      const prim = this.container.querySelector<HTMLElement>('[data-start]') ?? Array.from(this.container.querySelectorAll<HTMLElement>('.btn.primary')).find(visible);
      if (prim) { this.setCur(prim, true); prim.click(); }
    }
    // right stick scrolls the panel under the focus
    const ry = this.axis(3);
    if (Math.abs(ry) > 0.25) {
      setDevice('pad');
      const sp = scrollParent(this.cur) ?? (this.container.scrollHeight > this.container.clientHeight ? this.container : null);
      if (sp) sp.scrollTop += ry * 900 * dt;
    }
    this.renderHints();
  }

  private move(it: HTMLElement[], dx: number, dy: number) {
    const cur = this.cur;
    if (!cur) return;
    // left/right on a stepper/selector changes its value instead of moving
    if (dx && cur.dataset.navx !== undefined) {
      cur.dispatchEvent(new CustomEvent('navx', { detail: dx }));
      this.app.sfx.play('tick');
      return;
    }
    const next = this.step(it, dx, dy);
    if (next && next !== cur) { this.setCur(next, true); this.app.sfx.play('tick'); }
  }

  private shoulder(dir: number) {
    // a tab strip: the button marked as on/active, step to its neighbour
    const strip = this.container.querySelector<HTMLElement>('[data-tabs]');
    if (strip) {
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.nav, button')).filter(visible);
      const on = tabs.findIndex((t) => /\b(on|bd-on|cd-on|active)\b/.test(t.className));
      const nx = tabs[((on < 0 ? 0 : on) + dir + tabs.length) % tabs.length];
      if (nx) { nx.click(); this.app.sfx.play('tick'); return; }
    }
    const sel = this.container.querySelector<HTMLElement>('[data-shoulder]');
    if (sel) { sel.dispatchEvent(new CustomEvent('navx', { detail: dir })); this.app.sfx.play('tick'); }
  }

  private trigger(dir: number, it: HTMLElement[]) {
    const sel = this.container.querySelector<HTMLElement>('[data-trigger]');
    if (sel) { sel.dispatchEvent(new CustomEvent('navx', { detail: dir })); this.app.sfx.play('tick'); return; }
    // no secondary selector: jump a page through the list
    const i = this.cur ? it.indexOf(this.cur) : 0;
    const n = it[Math.max(0, Math.min(it.length - 1, i + dir * 6))];
    if (n && n !== this.cur) { this.setCur(n, true); this.app.sfx.play('tick'); }
  }

  private editText(el: HTMLInputElement) {
    if (lastDevice === 'pad') {
      this.osk = new Osk(this.app, el, () => { this.osk = null; this.renderHints(); });
      return;
    }
    el.focus();
    el.select?.();
  }

  private updateOsk(dt: number) {
    const o = this.osk!;
    const d = this.heldDir();
    const dir = d.dx || d.dy ? `${d.dx},${d.dy}` : '';
    if (dir && dir !== this.repDir) { o.move(d.dx, d.dy); this.repT = 0.34; }
    else if (dir) { this.repT -= dt; if (this.repT <= 0) { o.move(d.dx, d.dy); this.repT = 0.08; } }
    this.repDir = dir;
    if (this.padEdge(0)) o.press(o.keys[o.r][o.c].textContent!);
    if (this.padEdge(1)) o.press('⌫');
    if (this.padEdge(3)) o.press('SPACE');
    if (this.padEdge(4)) o.press('⇧');
    if (this.padEdge(9) || this.app.input.pressed.has('Escape') || this.app.input.pressed.has('Enter')) o.close();
    this.renderHints();
  }

  private renderHints(typing = false) {
    if (typeof document === 'undefined') return;
    if (!hintsEl) { hintsEl = document.createElement('div'); hintsEl.className = 'nav-hints'; document.body.append(hintsEl); }
    if (activeNav !== this) return;
    // (keyboard / pad navigation only — clicking into a text box with the mouse or a finger shows nothing, and so
    // never shifts the screen under you)
    const show = !this.osk && lastDevice !== 'mouse' && navUsed && this.container.isConnected;
    hintsEl.classList.toggle('on', show);
    document.body.classList.toggle('hints-on', show);
    if (!show) return;
    const pad = lastDevice === 'pad';
    const parts: string[] = [];
        if (typing) parts.push(`${glyph('A', 'ENTER')} done`, `${glyph('B', 'ESC')} cancel`);
    else {
      parts.push(`${pad ? '<i class="g stick">L</i>' : glyph('', 'W A S D')} move`);
      if (this.cur && isText(this.cur)) parts.push(`${glyph('A', 'ENTER')} type`);
      else if (this.cur?.dataset.navx !== undefined) parts.push(`${pad ? '<i class="g stick">◀▶</i>' : glyph('', 'A D')} change`);
      else parts.push(`${glyph('A', 'ENTER')} select`);
      if (this.onBack) parts.push(`${glyph('B', 'ESC')} back`);
      if (pad && (this.container.querySelector('[data-start]') || this.container.querySelector('.btn.primary'))) parts.push(`${glyph('START', '')} ${this.primaryLabel()}`);
      if (this.hints) parts.push(this.hints);
    }
    const html = parts.join('<span class="sep"></span>');
    if (hintsEl.dataset.h !== html) { hintsEl.dataset.h = html; hintsEl.innerHTML = html; }
  }

  private primaryLabel() {
    const p = this.container.querySelector<HTMLElement>('[data-start]') ?? this.container.querySelector<HTMLElement>('.btn.primary');
    const t = Array.from(p?.childNodes ?? []).filter((n) => !(n as HTMLElement).classList?.contains('gb')).map((n) => n.textContent).join('');
    return t.replace(/[▶◀↻]/g, '').trim().toLowerCase().slice(0, 18) || 'go';
  }

  /** call once per frame after screens update: hides the prompt bar when no menu is active (in-game, editors) */
  static endFrame() { if (!touched) { hintsEl?.classList.remove('on'); document.body.classList.remove('hints-on'); } touched = false; }
  static hideHints() { hintsEl?.classList.remove('on'); }
  static device() { return lastDevice; }
  static padFamily() { return padFamily; }
}
