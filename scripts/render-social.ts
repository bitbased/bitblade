// Render the social / share images from their HTML templates in docs/social/:   bun run social [name…]
//
//   link-card    → public/social.jpg            the site's link preview (og:image; 1280×640, kept under ~300 KB)
//   share-2x2    → docs/social/share-2x2.png    a 2×2 of game modes for X / Twitter posts (1600×900, 16:9)
//   github-card  → docs/social/github-card.png  the repo's card (GitHub Settings → Social preview; 1280×640, 2:1)
//
// To update one: edit its HTML (or swap a screenshot in docs/screens/), then run this. Uses Google Chrome / Chromium
// (set CHROME=/path/to/chrome if it isn't found) and, for the JPEG, ImageMagick's `magick` if it's installed.
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '..');
const IMAGES: Record<string, { w: number; h: number; out: string; jpeg?: boolean }> = {
  'link-card': { w: 1280, h: 640, out: 'public/social.jpg', jpeg: true },
  'share-2x2': { w: 1600, h: 900, out: 'docs/social/share-2x2.png' },
  'github-card': { w: 1280, h: 640, out: 'docs/social/github-card.png' },
};

function findChrome() {
  const c = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    Bun.which('google-chrome'), Bun.which('chromium'), Bun.which('chromium-browser'), Bun.which('chrome'),
  ].filter((p): p is string => !!p && existsSync(p));
  if (!c.length) { console.error('Chrome not found — set CHROME=/path/to/chrome'); process.exit(1); }
  return c[0];
}

const chrome = findChrome();
const magick = Bun.which('magick');
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(IMAGES);
for (const name of names) {
  const img = IMAGES[name];
  if (!img) { console.error(`unknown: ${name} (have: ${Object.keys(IMAGES).join(', ')})`); process.exit(1); }
  const html = join(root, 'docs/social', `${name}.html`);
  const out = join(root, img.out);
  const png = img.jpeg ? out.replace(/\.jpe?g$/, '.png') : out;
  mkdirSync(join(png, '..'), { recursive: true });
  if (existsSync(png)) unlinkSync(png); // (so a failed render can't pass off the last one as new)
  // (the time budget lets the Google Fonts load before the shot)
  const p = Bun.spawnSync([chrome, '--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${img.w},${img.h}`,
    '--virtual-time-budget=6000', '--default-background-color=05060cff', `--user-data-dir=${join(root, '.private', 'chrome-social')}`,
    `--screenshot=${png}`, pathToFileURL(html).href], { stdout: 'pipe', stderr: 'pipe' });
  if (!existsSync(png)) { console.error(`${name}: Chrome didn't write the image\n${p.stderr.toString().slice(-600)}`); process.exit(1); }
  if (img.jpeg) {
    if (!magick) { console.log(`${name} → ${png} (install ImageMagick to get the JPEG at ${img.out})`); continue; }
    Bun.spawnSync([magick, png, '-strip', '-quality', '90', out]);
    unlinkSync(png);
  }
  console.log(`${name} → ${img.out} (${img.w}×${img.h}, ${Math.round(statSync(out).size / 1024)} KB)`);
}
