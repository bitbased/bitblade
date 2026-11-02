// Someone shared a song with you (a #song= link): a card over the main menu — the song's name, play / stop, SAVE TO
// MY SONGS, OPEN IN MUSIC STUDIO, close. Nothing is saved unless you choose to.
import { h, type App } from './app';
import { icon } from './icons';
import { loadCustomSongs, saveCustomSongs, type Song } from '../game/music';
import { decodeSong, songLink, LONG_LINK } from '../game/songShare';
import { clean } from '../core/textFilter';

/** the shared song waiting for Music Studio to open it (OPEN IN MUSIC STUDIO) */
export const sharedForStudio: { song: Song | null } = { song: null };

export async function showSharedSong(app: App, encoded: string) {
  let song: Song;
  try { song = await decodeSong(encoded); } catch { app.toast('That song link is broken or incomplete'); return; }
  document.querySelector('.shared-song')?.remove();
  let playing = false;
  const same = (a: Song, b: Song) => JSON.stringify({ ...a, id: '', name: '' }) === JSON.stringify({ ...b, id: '', name: '' });
  const playBtn = h<HTMLButtonElement>('button.btn.primary.nav', { onclick: () => toggle() });
  const saveBtn = h<HTMLButtonElement>('button.btn.nav', { onclick: () => save() }, icon('save'), ' SAVE TO MY SONGS');
  const setPlay = () => { playBtn.replaceChildren(icon(playing ? 'pause' : 'play'), playing ? ' STOP' : ' PLAY'); };
  const toggle = () => {
    playing = !playing;
    const sfx = app.sfx;
    sfx.ensure?.();
    if (sfx.ctx && sfx.ctx.state !== 'running') void sfx.ctx.resume().catch(() => {});
    // (a song link skips the title screen, which is what normally turns music on — without this the song was
    //  queued but never scheduled, until something else like the radio switched music on)
    sfx.music(true);
    if (playing) { sfx.playSong(song, true); sfx.update(); } else sfx.useMusic('menu');
    setPlay();
  };
  const saved = () => loadCustomSongs().some((s) => same(s, song));
  const save = () => {
    if (!saved()) saveCustomSongs([{ ...song, custom: true }, ...loadCustomSongs()]);
    saveBtn.disabled = true;
    saveBtn.replaceChildren(icon('check'), ' SAVED TO MY SONGS');
    app.toast(`♪ ${clean(song.name)} saved — find it in Music Studio`);
  };
  const close = () => { if (playing) app.sfx.useMusic('menu'); el.remove(); };
  const el = h('div.shared-song.panel', null,
    h('div.ss-head', null, h('span.ss-tag', null, '♪ SHARED SONG'), h('button.ss-x', { title: 'Close', onclick: close }, icon('close'))),
    h('b.ss-name', null, clean(song.name)),
    h('span.ss-sub', null, `${song.bpm} BPM · someone shared this song with you — play it, keep it, or open it in Music Studio`),
    h('div.ss-btns', null, playBtn, saveBtn,
      h('button.btn.nav', { onclick: () => { sharedForStudio.song = song; close(); app.go('music'); } }, icon('gear'), ' OPEN IN MUSIC STUDIO')));
  setPlay();
  if (saved()) { saveBtn.disabled = true; saveBtn.replaceChildren(icon('check'), ' IN MY SONGS'); }
  document.body.append(el);
}

/** SHARE: a link with the whole song in it — the share sheet on phones, otherwise copied */
export async function shareSong(app: App, song: Song) {
  let url: string;
  try { url = await songLink(song); } catch (e) { app.toast(`Couldn't make a link: ${(e as Error).message}`); return; }
  const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
  if (nav.share && matchMedia('(pointer: coarse)').matches) {
    try { await nav.share({ title: `${song.name} — a BitBlade song`, url }); return; } catch { /* cancelled: copy instead */ }
  }
  try { await navigator.clipboard.writeText(url); }
  catch { prompt('Copy this link:', url); return; }
  app.toast(url.length > LONG_LINK ? `Link copied — it's long (${Math.round(url.length / 1000)}k characters): some chat apps may cut it, Export is safer` : 'Song link copied — anyone who opens it can play and save it');
}
