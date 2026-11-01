// IP matching for bans and the whitelist: every way an address can be written compares the same (IPv6 shortened with
// "::", leading zeros, upper / lower case, IPv4 inside IPv6 as ::ffff:1.2.3.4), and rules can be
//   an exact address        203.0.113.7 · 2001:db8::1
//   a range (CIDR)          203.0.113.0/24 · 2001:db8:1:2::/64
//   a prefix (older style)  203.0.113. · 2001:db8:1:2:   (whole groups — the same as /24, /64…)

type Parsed = { v: 4 | 6; n: bigint };

function parse4(s: string): bigint | null {
  const p = s.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((a, x) => (a << 8n) | BigInt(Number(x)), 0n);
}

function parse6(s: string): bigint | null {
  s = s.toLowerCase().replace(/%.*$/, ""); // (a zone like %eth0 doesn't matter here)
  // an IPv4 tail (::ffff:1.2.3.4) becomes two groups
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const n = parse4(v4[2]); if (n === null) return null; s = v4[1] + (n >> 16n).toString(16) + ":" + (n & 0xffffn).toString(16); }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** an address as a number (IPv4-mapped IPv6 counts as IPv4) */
export function parseIp(s: string): Parsed | null {
  s = s.trim();
  if (s.includes(":")) {
    const n = parse6(s);
    if (n === null) return null;
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn }; // (::ffff:a.b.c.d)
    return { v: 6, n };
  }
  const n = parse4(s);
  return n === null ? null : { v: 4, n };
}

/** a rule as an address + how many leading bits must match */
function parseRule(rule: string): (Parsed & { bits: number }) | null {
  rule = rule.trim();
  const cidr = rule.match(/^(.+)\/(\d{1,3})$/);
  if (cidr) {
    const p = parseIp(cidr[1]);
    if (!p) return null;
    const max = p.v === 4 ? 32 : 128;
    // (an IPv4-mapped range written as IPv6: /112 on ::ffff:… is /16 in IPv4 terms)
    let bits = Number(cidr[2]);
    if (p.v === 4 && cidr[1].includes(":")) bits -= 96;
    return bits >= 0 && bits <= max ? { ...p, bits } : null;
  }
  if (rule.endsWith(".")) {
    const parts = rule.slice(0, -1).split(".");
    if (parts.length < 1 || parts.length > 3) return null;
    const p = parseIp([...parts, ...Array(4 - parts.length).fill("0")].join("."));
    return p ? { ...p, bits: parts.length * 8 } : null;
  }
  if (rule.endsWith(":")) {
    const trimmed = rule.replace(/:+$/, "");
    const groups = trimmed ? trimmed.split(":") : [];
    if (groups.length < 1 || groups.length > 7 || rule.slice(0, -2).includes("::")) return null;
    const p = parseIp(trimmed + "::");
    return p ? { ...p, bits: groups.length * 16 } : null;
  }
  const p = parseIp(rule);
  return p ? { ...p, bits: p.v === 4 ? 32 : 128 } : null;
}

/** does this address fall under this rule (exact, range, or prefix)? */
export function ipMatches(ip: string, rule: string): boolean {
  const a = parseIp(ip), r = parseRule(rule);
  if (!a || !r || a.v !== r.v) return ip.trim() === rule.trim(); // (anything unparseable: only an exact match)
  const max = a.v === 4 ? 32 : 128;
  if (r.bits === 0) return true;
  const shift = BigInt(max - r.bits);
  return a.n >> shift === r.n >> shift;
}

/** your network, as a whitelist rule: IPv6 → its /64 (the part that stays the same while the rest rotates); IPv4 → the address */
export function networkRule(ip: string): string {
  const p = parseIp(ip);
  if (!p) return ip;
  if (p.v === 4) return ip.includes(":") ? [24, 16, 8, 0].map((s) => Number((p.n >> BigInt(s)) & 255n)).join(".") : ip;
  const g = [3, 2, 1, 0].map((i) => ((p.n >> BigInt(64 + i * 16)) & 0xffffn).toString(16));
  return `${g.join(":")}::/64`;
}
