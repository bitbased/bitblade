// A notice in the middle of the screen (not a toast that's gone in two seconds): a title, why, and OK.
// Enter / Space / Esc or a click outside closes it.
import { h, type App } from './app';

export function notice(app: App, title: string, text: string) {
  document.querySelector('.notice-overlay')?.remove();
  const close = () => { el.remove(); removeEventListener('keydown', key, true); app.sfx.play('back'); };
  const ok = h<HTMLButtonElement>('button.btn.primary', { onclick: close }, 'OK');
  const el = h('div.notice-overlay', { onclick: (e: Event) => { if (e.target === el) close(); } },
    h('div.notice.panel', null, h('h2', null, title), h('p', null, text), ok));
  const key = (e: KeyboardEvent) => { if (['Escape', 'Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); close(); } };
  addEventListener('keydown', key, true);
  document.body.append(el);
  ok.focus();
}
