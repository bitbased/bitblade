// In-match HUD: timer, scores, per-player cards, announcer, countdown.
import { h } from './app';
import { ITEMS, MODES, type GameState, type MatchConfig } from '../game/types';
import { CONTROL_HELP } from '../input/input';
import { iconSvg } from './icons';

export const TEAM_COLORS = ['#ff3b4a', '#3b8bff', '#38ff7a', '#ffd23a', '#c77dff', '#ff8c00', '#00f5d4', '#ff5cf4', '#ffffff', '#ff2244'];

export class Hud {
  root = h('div.hud');
  timer = h('div.hud-timer');
  scores = h('div.hud-top');
  obj = h('div.hud-obj');
  cards = h('div.hud-cards');
  ann = h('div.announce');
  hint = h('div.launch-hint');
  wrong = h('div.wrong-way', null, 'WRONG WAY');
  cardEls: { el: HTMLElement; spin: HTMLElement; burst: HTMLElement; sp: HTMLElement; spBar: HTMLElement; item: HTMLElement; meta: HTMLElement; rpm: HTMLElement }[] = [];
  scoreEls: HTMLElement[] = [];
  annQueue: { text: string; sub?: string; color?: string }[] = [];
  annT = 0;
  cfg: MatchConfig;
  /** split-screen: one HUD box per viewport */
  vps: { id: number; tag: HTMLElement; wrong: HTMLElement }[] = [];
  standings: HTMLElement | null = null;

  constructor(parent: HTMLElement, cfg: MatchConfig) {
    this.cfg = cfg;
    parent.append(this.root);
    this.root.append(this.scores, this.obj, this.cards, this.ann, this.hint, this.wrong);
    const mode = MODES.find((m) => m.id === cfg.mode)!;
    const teams = Math.max(...cfg.players.map((p) => p.team)) + 1;
    const teamScores = mode.id !== 'gauntlet';
    for (let t = 0; t < teams && teamScores; t++) {
      const el = h('div.hud-score', { style: { background: this.teamColor(t) } });
      this.scoreEls.push(el);
    }
    if (this.scoreEls.length === 2) this.scores.append(this.scoreEls[0], this.timer, this.scoreEls[1]);
    else this.scores.append(this.timer, ...this.scoreEls);
    const objText: Record<string, string> = {
      duel: `FIRST TO ${cfg.target} POINTS`, tag: `TEAM BATTLE · FIRST TO ${cfg.target}`, ffa: `FREE-FOR-ALL · FIRST TO ${cfg.target}`,
      ctf: `CAPTURE ${cfg.target} CORES`, rush: 'MOST CRYSTALS WINS', koth: `HOLD THE ZONE · ${cfg.target}s TO WIN`, gauntlet: 'COLLECT THE GEMS · AVOID HAZARDS', race: `GRAND PRIX · ${cfg.target} LAPS`,
    };
    this.obj.textContent = objText[cfg.mode];
    cfg.players.forEach((p, i) => {
      const c = cfg.mode === 'tag' || cfg.mode === 'ctf' ? this.teamColor(p.team) : p.blade.glow;
      const spin = h('i'), burst = h('i'), spI = h('i');
      const spBar = h('div.bar.sp.thin', null, spI);
      const item = h('div.item');
      const meta = h('div.meta');
      const rpm = h('span.rpm');
      const el = h('div.pcard', { style: { '--c': c } as unknown as Record<string, string> },
        h('div.nm', null, `P${i + 1} ${p.name}`, rpm),
        h('div.bar', null, spin), h('div.bar.burst.thin', null, burst), spBar, meta, item);
      el.style.setProperty('--c', c);
      this.cards.append(el);
      this.cardEls.push({ el, spin, burst, sp: spI, spBar, item, meta, rpm });
    });
  }

  /** split-screen: each local racer's tag, card and warnings live inside their own viewport; other cards fold into a standings list */
  split(ids: number[]) {
    const n = Math.min(4, ids.length);
    const pos = n === 2 ? ['top', 'bottom'] : ['tl', 'tr', 'bl', 'br'];
    this.root.classList.add('split');
    this.root.prepend(h('div.split-lines' + (n > 2 ? '.quad' : '')));
    this.vps = ids.slice(0, 4).map((id, k) => {
      const tag = h('div.split-tag'), wrong = h('div.vp-wrong');
      const el = h('div.split-vp.vp-' + pos[k], null, tag, wrong);
      el.style.setProperty('--c', this.cfg.players[id].blade.glow);
      const card = this.cardEls[id]?.el;
      if (card) el.append(card);
      this.root.append(el);
      return { id, tag, wrong };
    });
    this.cards.style.display = 'none';
    if (n === 3) {
      // the spare quadrant shows the overhead map: put the full standings there
      this.standings = h('div.split-standings');
      this.root.append(h('div.split-vp.vp-br', null, this.standings));
    }
  }

  /** split-screen per-viewport text: tag line + warning (empty = hidden) */
  vpText(k: number, tag: string, warn: string) {
    const v = this.vps[k];
    if (!v) return;
    if (v.tag.textContent !== tag) v.tag.textContent = tag;
    if (v.wrong.textContent !== warn) v.wrong.textContent = warn;
    v.wrong.classList.toggle('on', !!warn);
  }

  teamColor(t: number) {
    if (this.cfg.mode === 'ffa' || this.cfg.mode === 'rush' || this.cfg.mode === 'koth' || this.cfg.mode === 'duel') {
      const p = this.cfg.players.find((pp) => pp.team === t);
      if (p) return p.blade.glow;
    }
    return TEAM_COLORS[t] ?? '#fff';
  }

  announce(text: string, sub?: string, color?: string) {
    this.annQueue.push({ text, sub, color });
    if (this.annQueue.length > 3) this.annQueue.splice(0, this.annQueue.length - 3);
  }

  wrongWay(on: boolean, off = 0, who = '') {
    this.wrong.classList.toggle('on', on || off > 0);
    const txt = who + (off > 0 ? `OFF COURSE — TURN BACK ${Math.max(0, Math.ceil(5 - off))}` : 'WRONG WAY');
    if (this.wrong.textContent !== txt) this.wrong.textContent = txt;
  }

  count(n: number) {
    const el = h('div.count', null, String(n));
    this.root.append(el);
    setTimeout(() => el.remove(), 800);
  }

  update(s: GameState, dt: number) {
    // announcer
    this.annT -= dt;
    if (this.annT <= 0 && this.annQueue.length) {
      const a = this.annQueue.shift()!;
      this.ann.innerHTML = '';
      const t = h('div.a-text', null, a.text);
      if (a.color) t.style.setProperty('--ac', a.color);
      this.ann.append(t);
      if (a.sub) this.ann.append(h('div.a-sub', null, a.sub));
      this.annT = this.annQueue.length ? 0.9 : 1.6;
    }
    const tl = Math.max(0, s.timeLeft);
    const m = Math.floor(tl / 60), sec = Math.floor(tl % 60);
    this.timer.textContent = s.phase === 'launch' ? (MODES.find((x) => x.id === this.cfg.mode)!.rounds ? `R${s.round}` : 'READY') : `${m}:${sec.toString().padStart(2, '0')}`;
    this.timer.classList.toggle('low', tl < 10 && s.phase === 'battle');
    this.scoreEls.forEach((el, i) => (el.textContent = this.cfg.mode === 'koth' ? Math.floor(s.teamScores[i] ?? 0).toString() : String(s.teamScores[i] ?? 0)));
    if (this.cfg.mode === 'gauntlet') this.obj.textContent = `GEMS ${s.teamScores[0] ?? 0} / ${this.cfg.target} · ${Math.ceil(tl)}s`;
    this.hint.style.display = s.phase === 'launch' ? '' : 'none';
    if (s.phase === 'launch') this.hint.textContent = s.phaseT < 3 ? 'PRESS DASH WHEN THE RING IS GREEN!' : '';
    if (this.standings) {
      const order = s.tops.map((t, i) => ({ t, i })).sort((a, b) => (a.t.place || 99) - (b.t.place || 99));
      const html = '<b>STANDINGS</b>' + order.map(({ t, i }) => `<div style="--c:${this.cfg.players[i].blade.glow}"><span>${t.place || '-'}</span>${this.cfg.players[i].name}<em>${t.finishT >= 0 ? 'FIN' : `L${Math.min(t.lap + 1, this.cfg.target)}`}</em></div>`).join('');
      if (this.standings.dataset.h !== html) { this.standings.dataset.h = html; this.standings.innerHTML = html; }
    }
    s.tops.forEach((t, i) => {
      const c = this.cardEls[i];
      if (!c) return;
      c.el.classList.toggle('out', !t.alive);
      c.spin.style.transform = `scaleX(${Math.max(0, Math.min(1, t.spin))})`;
      c.spin.parentElement!.classList.toggle('over', t.spin > 1.005 || t.fx.surge > 0);
      c.burst.style.transform = `scaleX(${Math.min(1, t.burst)})`;
      c.sp.style.transform = `scaleX(${t.special})`;
      c.spBar.classList.toggle('full', t.special >= 1);
      c.rpm.textContent = t.alive ? `${Math.round(t.spin * 9800)} RPM` : t.out ? t.out.toUpperCase() : '';
      const it = t.item ? ITEMS[t.item] : null;
      c.item.classList.toggle('on', !!it);
      c.item.classList.toggle('roll', t.roll > 0);
      const ik = t.roll > 0 ? Object.values(ITEMS)[Math.floor(s.t * 14) % 8] : it;
      if (ik && c.item.dataset.k !== ik.icon) { c.item.dataset.k = ik.icon; c.item.innerHTML = iconSvg(ik.icon); c.item.style.color = ik.color; }
      const bits: string[] = [];
      if (this.cfg.mode === 'rush') bits.push(`${iconSvg('gem')} ${t.crystals}`);
      if (this.cfg.mode === 'gauntlet') bits.push(`${iconSvg('heart')} ${t.lives}`, `${iconSvg('diamond')} ${t.score}`);
      if (this.cfg.mode === 'ctf' && t.flag >= 0) bits.push(`${iconSvg('hex')} CARRYING CORE`);
      if (this.cfg.mode === 'race') bits.push(`${iconSvg('finish')} LAP ${Math.min(t.lap + 1, this.cfg.target)}/${this.cfg.target}`, `<b class="place">P${t.place}</b>`);
      if (t.kos) bits.push(`KO ${t.kos}`);
      if (!t.alive && t.respawnT > 0) bits.push(`respawn ${t.respawnT.toFixed(1)}`);
      if (t.special >= 1) bits.push('SPECIAL READY');
      const html = bits.join(' · ');
      if (c.meta.dataset.h !== html) { c.meta.dataset.h = html; c.meta.innerHTML = html; }
    });
  }

  controlsHelp() {
    return h('div.controls-help', null, ...Object.entries(CONTROL_HELP).filter(([k]) => k !== 'cpu' && k !== 'remote').map(([k, v]) => h('div', null, h('span.kbd', null, k.toUpperCase()), ' ', v)));
  }

  dispose() { this.root.remove(); }
}
