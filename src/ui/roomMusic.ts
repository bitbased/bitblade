// Room music for online lobbies: whoever controls the room picks a song from THEIR library (presets + their own
// songs); the whole song travels with the room, so everyone hears it — and anyone can copy a custom one into
// their own library (how songs get shared).
import { h, type App } from './app';
import { allSongs, loadCustomSongs, sanitizeSong, saveCustomSongs, type Song } from '../game/music';

/** biggest song we'll accept over the network (a full 4-pattern, 32-part song is ~4KB) */
export const MAX_SONG_BYTES = 24000;

/** a song that arrived over the network: repaired and size-checked, or null */
export function acceptSong(raw: unknown): Song | null {
  if (!raw || typeof raw !== 'object') return null;
  try {
    if (JSON.stringify(raw).length > MAX_SONG_BYTES) return null;
    return sanitizeSong(raw as Partial<Song>);
  } catch { return null; }
}

export function inMyLibrary(s: Song) {
  return !s.custom || loadCustomSongs().some((x) => x.id === s.id);
}

export function copyToMySongs(s: Song) {
  const mine = loadCustomSongs().filter((x) => x.id !== s.id);
  mine.unshift({ ...JSON.parse(JSON.stringify(s)), custom: true });
  saveCustomSongs(mine);
}

/**
 * The ROOM MUSIC row: ◀ song ▶ (when you're allowed to set it; cycles YOUR library, "Auto" first) and a
 * "Copy to my songs" button when the room song is someone's custom song you don't have yet.
 */
export function roomMusicRow(app: App, o: { song: Song | null; by?: string; canSet: boolean; onSet: (s: Song | null) => void; onCopied?: () => void }) {
  const choices: (Song | null)[] = [null, ...allSongs()];
  const cycle = (d: number) => {
    const k = choices.findIndex((c) => (c?.id ?? null) === (o.song?.id ?? null));
    o.onSet(choices[(Math.max(0, k) + d + choices.length) % choices.length]);
  };
  const s = o.song;
  const sub = s ? `${s.custom ? 'custom song' : 'preset'}${o.by ? ` · picked by ${o.by}` : ''}` : 'room music';
  const row = h('div.selector.panel' + (o.canSet ? '.nav' : ''), { 'data-navx': o.canSet ? '1' : undefined },
    h('span.lbl', null, 'MUSIC'),
    o.canSet ? h('button.arrow', { onclick: () => cycle(-1) }, '◀') : null,
    h('div.val', null, h('b', null, s ? `♪ ${s.name}` : 'AUTO'), h('span', null, sub)),
    o.canSet ? h('button.arrow', { onclick: () => cycle(1) }, '▶') : null);
  if (o.canSet) row.addEventListener('navx', (e) => cycle((e as CustomEvent).detail));
  // one fixed-height status line, whatever it holds — so clicking through songs never shifts the room UI
  const status = h('div.rm-status', null,
    s && !inMyLibrary(s)
      ? h('button.btn.small.nav', { title: 'Save this song to your Music Studio library', onclick: () => { copyToMySongs(s); app.toast(`♪ ${s.name} saved to your songs`); o.onCopied?.(); } }, '⬇ Copy song to my library')
      : h('span', null, s && s.custom ? '✓ This song is in your library' : s ? 'Preset — everyone has it' : 'Auto: each track plays its own song'));
  return h('div.room-music', null, row, status);
}
