// Game-style form widgets. Any native <input type=number> or <select> that appears under the UI root is
// upgraded in place: the native element stays (hidden or restyled) so existing 'input'/'change' listeners
// keep working, and the widget drives it. Opt out with data-native="1".

const upgraded = new Set<HTMLElement>();

function fire(el: HTMLElement) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function holdRepeat(btn: HTMLElement, fn: () => void) {
  let t: number | undefined, iv: number | undefined;
  const stop = () => { clearTimeout(t); clearInterval(iv); t = iv = undefined; };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fn();
    t = window.setTimeout(() => { iv = window.setInterval(fn, 70); }, 380);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
}

function upgradeNumber(inp: HTMLInputElement) {
  if (inp.dataset.gx || inp.dataset.native) return;
  inp.dataset.gx = '1';
  const wrap = document.createElement('span');
  wrap.className = 'gx-step nav';
  wrap.dataset.navx = '1';
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'gx-btn';
  minus.textContent = '−';
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'gx-btn';
  plus.textContent = '+';
  inp.parentNode?.insertBefore(wrap, inp);
  wrap.append(minus, inp, plus);
  inp.classList.remove('nav');
  inp.classList.add('gx-num');
  const step = (dir: number) => {
    const st = parseFloat(inp.step) || 1;
    const min = inp.min === '' ? -Infinity : parseFloat(inp.min);
    const max = inp.max === '' ? Infinity : parseFloat(inp.max);
    const cur = parseFloat(inp.value) || 0;
    const next = Math.max(min, Math.min(max, Math.round((cur + dir * st) / st) * st));
    if (next === cur) return;
    inp.value = String(+next.toFixed(4));
    fire(inp);
    wrap.classList.remove('gx-bump');
    void wrap.offsetWidth;
    wrap.classList.add('gx-bump');
  };
  holdRepeat(minus, () => step(-1));
  holdRepeat(plus, () => step(1));
  wrap.addEventListener('navx', (e) => step((e as CustomEvent).detail));
  upgraded.add(wrap);
}

let openPop: HTMLElement | null = null;
function closePop() { openPop?.remove(); openPop = null; }
addEventListener('pointerdown', (e) => { if (openPop && !openPop.contains(e.target as Node)) closePop(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) { closePop(); e.stopPropagation(); } }, true);

function upgradeSelect(sel: HTMLSelectElement) {
  if (sel.dataset.gx || sel.dataset.native || sel.multiple) return;
  sel.dataset.gx = '1';
  const wrap = document.createElement('span');
  wrap.className = 'gx-select nav';
  wrap.dataset.navx = '1';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'gx-btn';
  prev.textContent = '◀';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'gx-btn';
  next.textContent = '▶';
  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'gx-label';
  sel.parentNode?.insertBefore(wrap, sel);
  wrap.append(prev, label, next, sel);
  sel.classList.remove('nav');
  sel.style.display = 'none';
  if (sel.title) wrap.title = sel.title;
  const opts = () => Array.from(sel.options).filter((o) => !o.disabled);
  const refresh = () => { label.textContent = sel.options[sel.selectedIndex]?.textContent ?? '—'; };
  const pick = (v: string) => { if (sel.value === v) return; sel.value = v; refresh(); fire(sel); };
  const cycle = (d: number) => {
    const o = opts();
    if (!o.length) return;
    const i = o.findIndex((x) => x.value === sel.value);
    pick(o[(i + d + o.length) % o.length].value);
  };
  prev.addEventListener('click', () => cycle(-1));
  next.addEventListener('click', () => cycle(1));
  wrap.addEventListener('navx', (e) => cycle((e as CustomEvent).detail));
  label.addEventListener('click', () => {
    if (openPop) { closePop(); return; }
    const pop = document.createElement('div');
    pop.className = 'gx-pop';
    for (const o of opts()) {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'gx-opt' + (o.value === sel.value ? ' on' : '');
      it.textContent = o.textContent;
      it.addEventListener('click', () => { pick(o.value); closePop(); });
      pop.append(it);
    }
    document.body.append(pop);
    const r = wrap.getBoundingClientRect();
    const h = Math.min(320, opts().length * 30 + 8);
    const below = r.bottom + h < innerHeight;
    Object.assign(pop.style, { left: `${Math.max(8, Math.min(innerWidth - Math.max(r.width, 160) - 8, r.left))}px`, top: `${below ? r.bottom + 4 : r.top - h - 4}px`, minWidth: `${r.width}px`, maxHeight: `${h}px` });
    openPop = pop;
    pop.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'nearest' });
  });
  (wrap as unknown as { _refresh: () => void })._refresh = refresh;
  refresh();
  upgraded.add(wrap);
}

function scan(root: ParentNode) {
  root.querySelectorAll<HTMLInputElement>('input[type=number]').forEach(upgradeNumber);
  root.querySelectorAll<HTMLSelectElement>('select').forEach(upgradeSelect);
}

/** Watch a root for new form controls and upgrade them. Call once. */
export function enhanceInputs(root: HTMLElement) {
  scan(root);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of Array.from(m.addedNodes)) if (n instanceof HTMLElement) { if (n.matches('select, input[type=number]')) scan(n.parentElement ?? n); else scan(n); }
  }).observe(root, { childList: true, subtree: true });
  // keep select labels in sync when code changes .value programmatically
  setInterval(() => {
    for (const w of upgraded) {
      if (!w.isConnected) { upgraded.delete(w); continue; }
      (w as unknown as { _refresh?: () => void })._refresh?.();
    }
  }, 250);
}
