// Room music for online lobbies: whoever controls the room picks a song from THEIR library (presets + their own
// songs); the whole song travels with the room, so everyone hears it — and anyone can copy a custom one into
// their own library (how songs get shared).
import { h, type App } from './app';
import { allSongs, loadCustomSongs, PRESET_SONGS, sanitizeSong, saveCustomSongs, surpriseSong, type Song } from '../game/music';
import { icon } from './icons';
import { clean } from '../core/textFilter';
import { clientRoom, hostRoom } from '../net/room';

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

/**
 * 📻 Room radio: whoever switches it on keeps the songs coming for the whole room — from their own songs (their
 * library; presets if they have none) or brand-new surprise songs. It runs on that player's game: each pick is shared
 * with the room like a hand-picked song, once the current one has had 45s and comes round to its start.
 */
export const roomRadio = { mode: 'off' as 'off' | 'mine' | 'surprise' };
/** whose radio picked the room song: the host (-1), a guest (their room id), or nobody (null: picked by hand) */
export const RADIO_HOST = -1;
export function myRadioId(): number | null { return hostRoom.t ? RADIO_HOST : clientRoom.t ? clientRoom.t.id : null; }
/**
 * The host's way to set the room song from anywhere — the lobby registers it; a match uses it for picks made
 * mid-match (it plays the song, shares it with the room — in a match too — and keeps the radio going).
 */
export const roomSongHost = { set: null as null | ((s: Song | null, by: string, radioBy: number | null) => void), radioBy: (): number | null => null };
/**
 * Everyone, whenever a new room song starts playing here: only one radio runs — if the song came from someone
 * else's radio, or was picked by hand, mine switches off; if it's mine, the next pick comes on schedule.
 */
export function onRoomSong(app: App, radioBy: number | null | undefined, onPick: (s: Song) => void) {
  if (roomRadio.mode !== 'off' && (radioBy ?? null) !== myRadioId()) {
    roomRadio.mode = 'off';
    app.toast(radioBy == null ? '📻 Your radio stopped — someone picked a song' : '📻 Another player\'s radio took over');
  }
  if (roomRadio.mode !== 'off') armRadio(app, onPick);
}
export const RADIO_LABEL = { off: 'Radio off', mine: '📻 Radio: my songs', surprise: '📻 Radio: generated songs' };
export function radioPick(current?: string | null): Song {
  if (roomRadio.mode === 'surprise') return surpriseSong();
  const mine = loadCustomSongs(), pool = (mine.length ? mine : PRESET_SONGS).filter((s) => s.id !== current);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : PRESET_SONGS[0];
}
/** after a room song starts playing here: if my radio's on, the next pick comes when it's had 45s and loops */
export function armRadio(app: App, onPick: (s: Song) => void) {
  const p = app.sfx.player, ctx = app.sfx.ctx;
  if (!p || !ctx || roomRadio.mode === 'off') return;
  const since = ctx.currentTime;
  p.onLoop = () => { if (roomRadio.mode !== 'off' && ctx.currentTime - since >= 45) onPick(radioPick(p.song?.id)); };
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
 * The ROOM MUSIC row: ◀ song ▶ (when you're allowed to set it; cycles YOUR library, "Auto" first), 🎲 (a brand-new
 * surprise song for the whole room) and a "Copy to my songs" button when the room song is someone's custom song you
 * don't have yet.
 */
export function roomMusicRow(app: App, o: { song: Song | null; by?: string; canSet: boolean; onSet: (s: Song | null, radio?: boolean) => void; onCopied?: () => void; onRadio?: () => void }) {
  const choices: (Song | null)[] = [null, ...allSongs()];
  const cycle = (d: number) => {
    const k = choices.findIndex((c) => (c?.id ?? null) === (o.song?.id ?? null));
    o.onSet(choices[(Math.max(0, k) + d + choices.length) % choices.length]);
  };
  const s = o.song;
  const sub = roomRadio.mode !== 'off' && o.canSet ? RADIO_LABEL[roomRadio.mode] : s ? `${s.custom ? 'custom song' : 'preset'}${o.by ? ` · ${o.by.startsWith('📻') ? o.by : `picked by ${clean(o.by)}`}` : ''}` : 'room music';
  const row = h('div.selector.panel' + (o.canSet ? '.nav' : ''), { 'data-navx': o.canSet ? '1' : undefined },
    h('span.lbl', null, 'MUSIC'),
    o.canSet ? h('button.arrow', { onclick: () => cycle(-1) }, '◀') : null,
    h('div.val', null, h('b', null, s ? `♪ ${clean(s.name)}` : 'AUTO'), h('span', null, sub)),
    o.canSet ? h('button.arrow', { onclick: () => cycle(1) }, '▶') : null,
    o.canSet ? h('button.arrow.rm-dice', { title: 'Generate a brand-new song for the room, shared with everyone (press again for another)', onclick: (e: Event) => { e.stopPropagation(); o.onSet(surpriseSong()); } }, icon('dice')) : null,
    o.canSet ? h('button.arrow.rm-dice.rm-radio' + (roomRadio.mode !== 'off' ? '.on' : ''), {
      title: 'Room radio — keeps new songs coming for everyone: off → your songs → generated songs → off',
      onclick: (e: Event) => {
        e.stopPropagation();
        roomRadio.mode = roomRadio.mode === 'off' ? 'mine' : roomRadio.mode === 'mine' ? 'surprise' : 'off';
        app.toast(RADIO_LABEL[roomRadio.mode]);
        if (roomRadio.mode !== 'off') o.onSet(radioPick(s?.id), true); else o.onRadio?.(); // (on: a fresh song right away)
      },
    }, icon('radio')) : null);
  if (o.canSet) row.addEventListener('navx', (e) => cycle((e as CustomEvent).detail));
  // one fixed-height status line, whatever it holds — so clicking through songs never shifts the room UI
  const status = h('div.rm-status', null,
    s && !inMyLibrary(s)
      ? h('button.btn.small.nav', { title: 'Save this song to your Music Studio library', onclick: () => { copyToMySongs(s); app.toast(`♪ ${clean(s.name)} saved to your songs`); o.onCopied?.(); } }, '⬇ Copy song to my library')
      : h('span', null, s && s.custom ? '✓ This song is in your library' : s ? 'Preset — everyone has it' : 'Auto: each track plays its own song'));
  return h('div.room-music', null, row, status);
}
