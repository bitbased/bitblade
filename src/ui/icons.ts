// Custom SVG icon set (24x24 viewBox). Used both in DOM (inline SVG) and on canvases (Path2D) for blade emblems/decals.

interface IconDef { d: string; fill?: boolean }

export const ICONS: Record<string, IconDef> = {
  // emblems
  star: { d: 'M12 2l3 6.5 7 1-5 4.9 1.2 7L12 18l-6.2 3.4 1.2-7L2 9.5l7-1z', fill: true },
  bolt: { d: 'M13 2L4 14h7l-1 8 9-12h-7z', fill: true },
  skull: { d: 'M12 2a8 8 0 0 0-8 8c0 3 1.5 5 3 6v3h10v-3c1.5-1 3-3 3-6a8 8 0 0 0-8-8zM9 9.5a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2zM15 9.5a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2zM10 19v3M14 19v3' },
  crown: { d: 'M3 18h18l-2-11-4.5 4L12 4l-2.5 7L5 7zM4 21h16', fill: true },
  sparkle: { d: 'M12 2c1 5 5 9 10 10-5 1-9 5-10 10-1-5-5-9-10-10 5-1 9-5 10-10z', fill: true },
  yinyang: { d: 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20zM12 2a5 5 0 0 1 0 10 5 5 0 0 0 0 10M12 6.5v.01M12 17.5v.01' },
  target: { d: 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20zM12 6a6 6 0 1 0 0 12 6 6 0 1 0 0-12zM12 10a2 2 0 1 0 0 4 2 2 0 1 0 0-4z' },
  fang: { d: 'M3 4h18l-3.5 4-2 11-3.5-8-3.5 8-2-11z', fill: true },
  diamond: { d: 'M12 2l8 10-8 10-8-10z', fill: true },
  hex: { d: 'M12 2l8.7 5v10L12 22l-8.7-5V7z', fill: true },
  spade: { d: 'M12 2C8 7 4 9 4 13a4 4 0 0 0 7 2.5L10 21h4l-1-5.5A4 4 0 0 0 20 13c0-4-4-6-8-11z', fill: true },
  heart: { d: 'M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 6-8 11-8 11z', fill: true },
  club: { d: 'M12 2.5a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 1 0 0-7.2zM7 8.5a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 1 0 0-7.2zM17 8.5a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 1 0 0-7.2zM11 12h2l1.5 9h-5z', fill: true },
  swords: { d: 'M3 3l11 11M3 3v4M3 3h4M21 3L10 14M21 3v4M21 3h-4M6 15l-3 3 3 3 3-3M18 15l3 3-3 3-3-3' },
  sun: { d: 'M12 7a5 5 0 1 0 0 10 5 5 0 1 0 0-10zM12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1' },
  moon: { d: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', fill: true },
  flame: { d: 'M12 2c1 4 6.5 6 6.5 12a6.5 6.5 0 0 1-13 0c0-3 2-5 3-7 0 2 1 3 2 3 0-3 .5-5 1.5-8z', fill: true },
  wing: { d: 'M2 13c6-8 14-9 20-8.5-3 2-4 4-5 6 2 0 3 1 4 2-3 1-6 1-8 1 1 1 2 2 2 4.5-5 0-9-2-13-5z', fill: true },
  eye: { d: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7z' },
  claw: { d: 'M5 3c2.5 6 2.5 12-1 18M11 2c2.5 6 2.5 13-1 19M17 3c2.5 6 2.5 12-1 18' },
  infinity: { d: 'M6 8a4 4 0 1 0 0 8c3 0 9-8 12-8a4 4 0 1 1 0 8c-3 0-9-8-12-8z' },
  // items
  shield: { d: 'M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z', fill: true },
  burst: { d: 'M12 1l2.2 6 5.8-2.8-2.8 5.8 6 2-6 2.2 2.8 5.8-5.8-2.8L12 23l-2.2-6-5.8 2.8 2.8-5.8L1 12l6-2.2-2.8-5.8 5.8 2.8z', fill: true },
  swirl: { d: 'M12 12a1 1 0 1 1 2 0 3 3 0 1 1-6 0 5 5 0 1 1 10 0 7 7 0 1 1-14 0 9 9 0 0 1 9-9' },
  tornado: { d: 'M2 4h20M4 8h16M7 12h11M9 16h7M11 20h3' },
  arrowUp: { d: 'M12 2l8 9h-4.5v10h-7V11H4z', fill: true },
  comet: { d: 'M17 3a4 4 0 1 0 0 8 4 4 0 1 0 0-8zM13.5 10.5L3 21M12 7l-7 7M17 12l-7 7' },
  snowflake: { d: 'M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5M3 10.5l3.5-.5-1-3.5M21 13.5l-3.5.5 1 3.5' },
  gem: { d: 'M6 3h12l4 6-10 12L2 9zM2 9h20M9 3l3 6 3-6M12 9v12' },
  // ui
  keyboard: { d: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10' },
  mouse: { d: 'M12 2a6 6 0 0 0-6 6v8a6 6 0 0 0 12 0V8a6 6 0 0 0-6-6zM12 6v4' },
  gamepad: { d: 'M6 7h12a4 4 0 0 1 4 4l1 5.5a2.5 2.5 0 0 1-4.5 1.8L16 16H8l-2.5 2.3A2.5 2.5 0 0 1 1 16.5L2 11a4 4 0 0 1 4-4zM7 10v4M5 12h4M15 11h.01M18 13h.01' },
  phone: { d: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2' },
  link: { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
  lock: { d: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4' },
  dice: { d: 'M4 4h16v16H4zM8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01' },
  close: { d: 'M6 6l12 12M18 6L6 18' },
  save: { d: 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7' },
  radio: { d: 'M3.5 9h17v11h-17zM7 9l10-5.5M8.5 12.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM14 13h3.5M14 16.5h3.5' },
  check: { d: 'M5 12.5l4.5 4.5L19 7' },
  pause: { d: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z', fill: true },
  users: { d: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-4 3-6 7-6s7 2 7 6M16 3a4 4 0 0 1 0 8M18 15c2.5.5 4 2.5 4 6' },
  gear: { d: 'M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' },
  finish: { d: 'M4 22V3M4 3h16v10H4M8 3v10M12 3v10M16 3v10M4 8h16' },
  stadium: { d: 'M2 10a10 4 0 1 0 20 0 10 4 0 1 0-20 0zM2 10v4a10 4 0 0 0 20 0v-4' },
  ramp: { d: 'M2 20h20M2 20c8 0 12-4 12-14h8v14' },
  road: { d: 'M4 22L9 2M20 22L15 2M12 4v3M12 11v3M12 18v3' },
  trophy: { d: 'M7 3h10v5a5 5 0 0 1-10 0zM7 5H3v2a4 4 0 0 0 4 4M17 5h4v2a4 4 0 0 1-4 4M12 13v4M8 21h8M9 17h6v4H9z' },
  play: { d: 'M6 4l14 8-14 8z', fill: true },
  back: { d: 'M15 4l-8 8 8 8' },
};

/** Legacy unicode emblems → icon names (for designs saved before the icon set). */
export const LEGACY_GLYPH: Record<string, string> = {
  '★': 'star', '⚡': 'bolt', '☠': 'skull', '♛': 'crown', '✦': 'sparkle', '☯': 'yinyang', '✪': 'target', '❖': 'diamond', '⬢': 'hex',
  '♠': 'spade', '♥': 'heart', '♦': 'diamond', '♣': 'club', '⚔': 'swords', '☀': 'sun', '☾': 'moon', '✿': 'sparkle', '☢': 'target', '♞': 'fang', '∞': 'infinity',
};

export function resolveIcon(glyph: string): IconDef | null {
  return ICONS[glyph] ?? ICONS[LEGACY_GLYPH[glyph] ?? ''] ?? null;
}

const SVGNS = 'http://www.w3.org/2000/svg';

export function iconSvg(name: string, cls = 'ico') {
  const ic = resolveIcon(name);
  if (!ic) return `<span class="${cls} ico-text">${name}</span>`;
  return ic.fill
    ? `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="${ic.d}"/></svg>`
    : `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="${ic.d}"/></svg>`;
}

export function icon(name: string, cls = 'ico'): Element {
  const ic = resolveIcon(name);
  if (!ic) { const s = document.createElement('span'); s.className = `${cls} ico-text`; s.textContent = name; return s; }
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ic.d);
  if (ic.fill) { svg.setAttribute('fill', 'currentColor'); }
  else { svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.1'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); }
  svg.append(p);
  return svg;
}

const pathCache = new Map<string, Path2D>();

/** Draw an icon (or fallback text glyph) centered at cx,cy on a canvas. Returns false if it fell back to text. */
export function drawIcon(ctx: CanvasRenderingContext2D, name: string, cx: number, cy: number, size: number, color: string, outline = 'rgba(0,0,0,0.6)') {
  const ic = resolveIcon(name);
  if (!ic) return false;
  let p = pathCache.get(ic.d);
  if (!p) { p = new Path2D(ic.d); pathCache.set(ic.d, p); }
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (ic.fill) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = outline;
    ctx.stroke(p);
    ctx.fillStyle = color;
    ctx.fill(p);
  } else {
    ctx.lineWidth = 3.6;
    ctx.strokeStyle = outline;
    ctx.stroke(p);
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = color;
    ctx.stroke(p);
  }
  ctx.restore();
  return true;
}
