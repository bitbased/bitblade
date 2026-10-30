// Editor drafts (Music Studio, Track Studio, Course Builder): what you're working on is kept apart from your saved
// library — saved songs / tracks / courses only change when you press SAVE (DISCARD goes back to the saved copy) —
// and the draft lives in the browser's storage, so a refresh or a crash never loses an edit: the editor reopens on it.
import { confirmTwice, h, type App } from './app';

export type DraftKind = 'song' | 'track' | 'course';
/** work: the edited item · fresh: not in the library yet (a new one, a copy, an import) — SAVE adds it */
export interface Draft<T> { work: T; fresh: boolean; t: number }

const P = 'bitblade.draft.';
const key = (k: DraftKind, id: string) => `${P}${k}.${id}`;

export function getDraft<T>(k: DraftKind, id: string): Draft<T> | null {
  try { const s = localStorage.getItem(key(k, id)); return s ? (JSON.parse(s) as Draft<T>) : null; } catch { return null; }
}
export function putDraft<T>(k: DraftKind, id: string, work: T, fresh: boolean) {
  try { localStorage.setItem(key(k, id), JSON.stringify({ work, fresh, t: Date.now() })); } catch { /* storage full: the edit stays in memory */ }
  setLastOpen(k, id);
}
export function dropDraft(k: DraftKind, id: string) {
  try { localStorage.removeItem(key(k, id)); } catch { /* ignore */ }
}
/** every draft of this kind, newest first */
export function draftsOf<T>(k: DraftKind): { id: string; d: Draft<T> }[] {
  const out: { id: string; d: Draft<T> }[] = [];
  try {
    const pre = `${P}${k}.`;
    for (let i = 0; i < localStorage.length; i++) {
      const kk = localStorage.key(i);
      if (!kk?.startsWith(pre)) continue;
      const d = getDraft<T>(k, kk.slice(pre.length));
      if (d) out.push({ id: kk.slice(pre.length), d });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b.d.t - a.d.t);
}
/** which item each editor had open last (it reopens there) */
export function lastOpen(k: DraftKind): string | null {
  try { return localStorage.getItem(`${P}last.${k}`); } catch { return null; }
}
export function setLastOpen(k: DraftKind, id: string) {
  try { localStorage.setItem(`${P}last.${k}`, id); } catch { /* ignore */ }
}

/**
 * The SAVE / DISCARD bar every editor shows: "Saved", "● Unsaved changes" or "● New — not saved yet". `update()`
 * refreshes it in place (cheap: call it on every edit).
 */
export function draftBar(app: App, o: { state: () => { dirty: boolean; fresh: boolean }; onSave: () => void; onDiscard: () => void; what: string }) {
  const status = h('span.draft-status');
  const save = h<HTMLButtonElement>('button.btn.small.primary.nav.draft-save', { title: `Save your changes into your ${o.what}s (Ctrl+S)`, onclick: () => o.onSave() }, 'SAVE');
  const discard = h<HTMLButtonElement>('button.btn.small.nav.draft-discard', {
    title: 'Throw away your changes and go back to the saved version',
    onclick: () => {
      const s = o.state();
      if (!confirmTwice(app, 'draft-discard', s.fresh ? `Press again to throw away this unsaved ${o.what}` : 'Press again to discard your changes')) return;
      o.onDiscard();
    },
  }, 'DISCARD');
  const el = h('div.draft-bar', null, status, save, discard);
  const update = () => {
    const s = o.state(), unsaved = s.dirty || s.fresh;
    status.textContent = s.fresh ? '● New — not saved yet' : s.dirty ? '● Unsaved changes' : '✓ Saved';
    el.classList.toggle('unsaved', unsaved);
    save.disabled = !unsaved; discard.disabled = !unsaved;
  };
  update();
  return { el, update };
}
