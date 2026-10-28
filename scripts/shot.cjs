// Dev helper: node_modules/.bin/electron scripts/shot.cjs <url> <out.png> [js-to-run] [waitMs]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [url, out, js, wait] = process.argv.slice(2);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1600, height: 900, show: false, backgroundColor: '#05060a', webPreferences: { backgroundThrottling: false } });
  const logs = [];
  w.webContents.on('console-message', (_e, level, msg) => logs.push(`[${level}] ${msg}`));
  await w.loadURL(url);
  await new Promise((r) => setTimeout(r, 1500));
  if (js) { try { await w.webContents.executeJavaScript(js); } catch (e) { logs.push('JSERR ' + e.message); } }
  await new Promise((r) => setTimeout(r, Number(wait || 2500)));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log(logs.filter((l) => !l.includes('Electron Security')).slice(-25).join('\n'));
  app.quit();
});
