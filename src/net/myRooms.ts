// "My Rooms": named rooms you keep. Each has a fixed code claimed with a secret owner key, so the same
// code / invite link works every time you open it, and nobody else can host under it.
const KEY = 'bitblade.myRooms';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface SavedRoom {
  code: string;
  key: string;
  name: string;
  public: boolean;
  openControl: boolean;
  /** needed to join (empty: none) */
  password?: string;
  mode: string;
  arenaId: string;
  lastUsed: number;
}

export function loadMyRooms(): SavedRoom[] {
  try { return (JSON.parse(localStorage.getItem(KEY) || '[]') as SavedRoom[]).sort((a, b) => b.lastUsed - a.lastUsed); } catch { return []; }
}

function store(list: SavedRoom[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

export function saveMyRoom(r: SavedRoom) {
  store([r, ...loadMyRooms().filter((x) => x.code !== r.code)]);
}

export function deleteMyRoom(code: string) {
  store(loadMyRooms().filter((x) => x.code !== code));
}

export function findMyRoom(code: string) {
  return loadMyRooms().find((x) => x.code === code.toUpperCase()) ?? null;
}

const rand = (n: number, chars: string) => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => chars[x % chars.length]).join(''); };
export const newRoomCode = () => rand(6, CODE_CHARS);
export const newOwnerKey = () => rand(32, 'abcdefghijklmnopqrstuvwxyz0123456789');

/** custom codes: 4-10 letters/digits */
export function cleanCode(s: string) { return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); }
