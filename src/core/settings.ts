// Persisted user settings (graphics/gameplay toggles).
export const settings = {
  bloom: true,
  trajectories: true,
  pixelRatio: Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2),
  playerName: 'Blader',
  load() {
    try { Object.assign(this, JSON.parse(localStorage.getItem('bitblade.settings') || '{}')); } catch { /* ignore */ }
  },
  save() {
    const { bloom, trajectories, pixelRatio, playerName } = this;
    try { localStorage.setItem('bitblade.settings', JSON.stringify({ bloom, trajectories, pixelRatio, playerName })); } catch { /* ignore */ }
  },
};
settings.load();
