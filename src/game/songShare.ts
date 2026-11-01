// Share a song as a link: the whole song, compressed, in the link's #fragment — bitblade.bitbased.net/#song=…
// The part after # never reaches the server, so nothing is uploaded or stored anywhere: the link IS the song. A
// generated song is ~600–700 characters; a long hand-made one a few thousand. Sharing again after edits makes a new
// link (each one is a snapshot).
import { newSong, sanitizeSong, type Song } from './music';

/** past this the link gets unwieldy for some apps (it still works in browsers) */
export const LONG_LINK = 8000;

const b64url = (b: Uint8Array) => { let bin = ''; for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** the song as link text: "1" + deflated (or "0" + plain, where the browser can't compress) */
export async function encodeSong(song: Song): Promise<string> {
  const { id: _id, custom: _c, ...rest } = song as Song & { custom?: boolean };
  const raw = new TextEncoder().encode(JSON.stringify(rest));
  if (typeof CompressionStream === 'undefined') return '0' + b64url(raw);
  return '1' + b64url(await pipe(raw, new CompressionStream('deflate-raw')));
}

/** link text → a song (a new id, ready to save as your own) — throws if it isn't one */
export async function decodeSong(text: string): Promise<Song> {
  const kind = text[0], body = unb64url(text.slice(1));
  const raw = kind === '1' ? await pipe(body, new DecompressionStream('deflate-raw')) : kind === '0' ? body : null;
  if (!raw || raw.length > 200_000) throw new Error('Not a song link');
  const s = sanitizeSong(JSON.parse(new TextDecoder().decode(raw)));
  s.id = newSong().id;
  s.custom = true;
  return s;
}

/** the full link for a song */
export async function songLink(song: Song) {
  return `${location.origin}/#song=${await encodeSong(song)}`;
}

/** a song link opened: the encoded song from the address (and the address cleaned up), or null */
export function takeSongFromUrl(): string | null {
  const m = location.hash.match(/^#song=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return m[1];
}
