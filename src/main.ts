import './style.css';
import { Input } from './input/input';
import { Sfx } from './game/audio';
import { getRenderer } from './game/render';
import { h, type App, type Screen, type ScreenName } from './ui/app';
import { TitleScreen, MainMenu, ModeSelect, Results, SettingsScreen } from './ui/menus';
import { LobbyScreen } from './ui/lobby';
import { MatchScreen } from './ui/match';
import { OnlineScreen } from './ui/online';
import { bladeDesignerScreen } from './ui/bladeDesigner';
import { courseDesignerScreen } from './ui/courseDesigner';
import { updateBackdrop, resizeBackdrop, setBackdropVisible } from './ui/backdrop';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const root = document.getElementById('ui') as HTMLElement;
getRenderer(canvas);

const factories: Record<ScreenName, () => Screen> = {
  title: () => new TitleScreen(),
  menu: () => new MainMenu(),
  modes: () => new ModeSelect(),
  lobby: () => new LobbyScreen(),
  match: () => new MatchScreen(),
  results: () => new Results(),
  online: () => new OnlineScreen(),
  settings: () => new SettingsScreen(),
  blades: () => bladeDesignerScreen,
  courses: () => courseDesignerScreen,
};
const NO_BACKDROP = new Set<ScreenName>(['match', 'blades', 'courses']);

let current: Screen | null = null;
let currentName: ScreenName = 'title';
const history: ScreenName[] = [];

const app: App = {
  root, canvas,
  input: new Input(),
  sfx: new Sfx(),
  go(name, arg) {
    if (current) {
      try { current.unmount(); } catch (e) { console.error(e); }
      if (currentName !== name && currentName !== 'match' && currentName !== 'results') history.push(currentName);
      if (history.length > 20) history.shift();
    }
    if (NO_BACKDROP.has(name)) setBackdropVisible(false);
    currentName = name;
    current = factories[name]();
    current.mount(app, arg);
  },
  back() {
    const prev = history.pop() ?? 'menu';
    const name = prev === currentName ? 'menu' : prev;
    if (current) current.unmount();
    if (NO_BACKDROP.has(name)) setBackdropVisible(false);
    currentName = name;
    current = factories[name]();
    current.mount(app);
  },
  toast(msg) {
    const t = h('div.toast', null, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  },
};

addEventListener('resize', () => {
  const { renderer } = getRenderer(canvas);
  renderer.setSize(innerWidth, innerHeight);
  resizeBackdrop();
  current?.resize?.();
});

// deep link: /join/CODE or ?join=CODE  → straight to the online join flow
const m = location.pathname.match(/\/join\/([A-Za-z0-9]{5})/) || location.search.match(/[?&]join=([^&]+)/);
if (m) app.go('online', { join: location.protocol.startsWith('http') && location.pathname.includes('/join/') ? location.href : decodeURIComponent(m[1]) });
else app.go('title');

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  app.input.poll();
  if (!NO_BACKDROP.has(currentName)) updateBackdrop(dt);
  try { current?.update?.(dt); } catch (e) { console.error(e); }
  app.sfx.update(dt);
  app.input.endFrame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// PWA: offline cache when served over http(s) in production
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

(window as unknown as { bitbladeApp: App }).bitbladeApp = app;
