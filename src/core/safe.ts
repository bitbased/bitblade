// Values that came from another player (the party leader's match config and snapshots, other members' blades) on
// their way into the page. A patched client can send anything, so anything that ends up in HTML or CSS goes through
// these first: a "number" that's really markup, or a "colour" that's really url(https://tracker/…), becomes harmless.

/** a whole number for display (anything that isn't a finite number shows as 0) */
export function num(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

/** a CSS colour we drew ourselves: #rgb, #rrggbb or #rrggbbaa — anything else falls back */
export function safeColor(v: unknown, fallback = '#ffffff'): string {
  return typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : fallback;
}

/** a party / room code (what a leader's "go there" message may name) */
export const isPartyCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9]{4,10}$/.test(v);
