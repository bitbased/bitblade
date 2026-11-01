// Persisted user settings (graphics/gameplay toggles).
export const settings = {
  bloom: true,
  trajectories: true,
  pixelRatio: Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5),
  adaptive: true, // auto-lower resolution when the frame rate drops
  /** frames per second at most (0: as fast as the display refreshes). 60 by default: a 120 / 144 Hz screen would
   *  otherwise draw 2–2.4× as many frames — that much more battery, heat and fan — for little visible gain. */
  fpsCap: 60,
  playerName: 'Blader',
  /** rings under the other blades (yours always has its own): none, everyone (team colours in team games, each
   *  blade's own colour otherwise), only your team, or only the other side */
  rings: 'theirs' as 'off' | 'all' | 'mine' | 'theirs',
  /** other players' names / blade names / party names: offensive words shown as **** */
  filterWords: true,
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem('bitblade.settings') || '{}');
      if (!saved.v && saved.pixelRatio > 1.5) delete saved.pixelRatio; // old default was 2x on retina — too heavy
      // (the earlier team-ring setting carries over)
      if (saved.teamRings && !saved.rings) saved.rings = ({ enemy: 'theirs', team: 'mine', both: 'all' } as Record<string, string>)[saved.teamRings] ?? 'theirs';
      delete saved.teamRings;
      Object.assign(this, saved);
    } catch { /* ignore */ }
  },
  save() {
    const { bloom, trajectories, pixelRatio, playerName, adaptive, rings, filterWords, fpsCap } = this;
    try { localStorage.setItem('bitblade.settings', JSON.stringify({ bloom, trajectories, pixelRatio, playerName, adaptive, rings, filterWords, fpsCap, v: 2 })); } catch { /* ignore */ }
  },
};
settings.load();

/** Dynamic resolution: scales the pixel ratio down when frames are slow, back up when there's headroom. */
export const perf = {
  scale: 1,
  version: 0,
  acc: 0,
  frames: 0,
  slow: 0,
  sample(dt: number) {
    if (!settings.adaptive) { if (this.scale !== 1) { this.scale = 1; this.version++; } return; }
    this.acc += dt;
    this.frames++;
    if (this.acc < 1) return;
    const fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    // (measured against the frame cap: capped at 30, 30 fps is full speed, not a reason to drop the resolution)
    const want = settings.fpsCap > 0 ? Math.min(60, settings.fpsCap) : 60;
    if (fps < want * 0.83 && this.scale > 0.5) { this.scale = Math.max(0.5, this.scale - (fps < want * 0.58 ? 0.2 : 0.1)); this.version++; }
    else if (fps > want * 0.966 && this.scale < 1) { this.slow++; if (this.slow > 3) { this.scale = Math.min(1, this.scale + 0.1); this.version++; this.slow = 0; } }
    else this.slow = 0;
  },
  ratio() { return Math.max(0.5, settings.pixelRatio * this.scale); },
};
