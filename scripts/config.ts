// Your private settings (deploy target, admin password) in a private GitHub repo, so another computer can get them:
//
//   bun run config:pull     fetch them into place (first time: clones the private repo into .private/)
//   bun run config:push     save the ones here to it (creates the private repo if it doesn't exist yet)
//   bun run config:status   what differs between here and the private repo
//
// The private repo is <owner>/<repo>-private of this checkout's `origin` (bitbased/bitblade → bitbased/bitblade-private),
// or name it: bun run config:pull someone/somewhere. Uses the GitHub CLI's login (`gh auth login` once per computer).
// The files are git-ignored here; the public repo never sees them.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** what's kept: paths relative to the project, the same in the private repo */
const FILES = [
  'worker/deploy.env', // custom domain + KV id (scripts/deploy.ts)
  'worker/.dev.vars', // wrangler dev: ADMIN_TOKEN for the local worker
  'worker/.prod.vars', // ADMIN_TOKEN for production (bun x wrangler secret bulk .prod.vars)
  '.env.production.local', // desktop builds: VITE_CLOUD_RELAY override
];

const root = join(import.meta.dir, '..');
const priv = join(root, '.private', 'settings'); // (.private/ also holds the social renderer's Chrome profile)
const [cmd = 'status', repoArg] = process.argv.slice(2);
const gh = Bun.which('gh') ?? (existsSync('C:/Program Files/GitHub CLI/gh.exe') ? 'C:/Program Files/GitHub CLI/gh.exe' : '');

const run = (c: string[], cwd = root) => {
  const p = Bun.spawnSync(c, { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
  return { ok: p.exitCode === 0, out: (p.stdout?.toString() ?? '') + (p.stderr?.toString() ?? '') };
};
const must = (c: string[], cwd = root) => { const r = run(c, cwd); if (!r.ok) { console.error(r.out.trim()); process.exit(1); } return r.out; };
const same = (a: string, b: string) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

function repoName() {
  if (repoArg) return repoArg;
  const url = must(['git', 'remote', 'get-url', 'origin']).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (!m) { console.error(`origin isn't a GitHub repo (${url}) — name the private repo: bun run config:${cmd} owner/name`); process.exit(1); }
  return `${m[1]}/${m[2]}-private`;
}
function needGh() {
  if (!gh) { console.error('Needs the GitHub CLI: winget install GitHub.cli (or brew install gh), then gh auth login'); process.exit(1); }
  if (!run([gh, 'auth', 'status']).ok) { console.error('Not signed in to GitHub: gh auth login'); process.exit(1); }
}
/** the private repo, cloned into .private/ (up to date). false: it doesn't exist yet */
function clone(repo: string): boolean {
  if (existsSync(join(priv, '.git'))) {
    // (a brand-new private repo has nothing to pull yet)
    if (run(['git', 'ls-remote', '--heads', 'origin'], priv).out.trim()) must(['git', 'pull', '--ff-only', '-q'], priv);
    return true;
  }
  if (!run([gh!, 'repo', 'view', repo, '--json', 'name']).ok) return false;
  must([gh!, 'repo', 'clone', repo, priv, '--', '-q']);
  return true;
}

needGh();
const repo = repoName();

if (cmd === 'pull') {
  if (!clone(repo)) { console.error(`No private repo ${repo} yet — make it from a computer that has the files: bun run config:push`); process.exit(1); }
  let n = 0;
  for (const f of FILES) {
    const src = join(priv, f), dst = join(root, f);
    if (!existsSync(src)) continue;
    if (same(src, dst)) { console.log(`  = ${f}`); continue; }
    if (existsSync(dst)) { copyFileSync(dst, dst + '.bak'); console.log(`  ↓ ${f}  (yours was different: kept as ${f}.bak)`); }
    else console.log(`  ↓ ${f}`);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    n++;
  }
  console.log(n ? `Pulled ${n} file(s) from ${repo}.` : `Up to date with ${repo}.`);
} else if (cmd === 'push') {
  if (!clone(repo)) {
    console.log(`Creating the private repo ${repo}…`);
    must([gh, 'repo', 'create', repo, '--private', '--description', 'Private settings for the game repo (scripts/config.ts): deploy target, admin password']);
    must([gh, 'repo', 'clone', repo, priv, '--', '-q']);
  }
  if (!existsSync(join(priv, 'README.md'))) writeFileSync(join(priv, 'README.md'), `# Private settings\n\nPrivate files for the game repo, kept in sync by its \`scripts/config.ts\`:\n\n- \`bun run config:pull\` — fetch them into a checkout\n- \`bun run config:push\` — save a checkout's copies here\n\nKeep this repo **private**: it holds the admin password.\n`);
  let n = 0;
  for (const f of FILES) {
    const src = join(root, f), dst = join(priv, f);
    if (!existsSync(src) || same(src, dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    console.log(`  ↑ ${f}`);
    n++;
  }
  must(['git', 'add', '-A'], priv);
  if (run(['git', 'diff', '--cached', '--quiet'], priv).ok) { console.log(`Nothing new — ${repo} is up to date.`); process.exit(0); }
  // (commit as whoever this checkout commits as — the machine may have no global git identity)
  const who = (k: string, d: string) => run(['git', 'config', k]).out.trim() || d;
  must(['git', '-c', `user.name=${who('user.name', 'bitblade config')}`, '-c', `user.email=${who('user.email', 'config@localhost')}`, 'commit', '-q', '-m', `config:push (${n} file${n === 1 ? '' : 's'})`], priv);
  must(['git', 'push', '-q', '-u', 'origin', 'HEAD'], priv);
  console.log(`Pushed to ${repo} (private).`);
} else if (cmd === 'status') {
  const there = clone(repo);
  console.log(`Private repo: ${repo}${there ? '' : ' (not created yet: bun run config:push)'}`);
  for (const f of FILES) {
    const here = existsSync(join(root, f)), up = there && existsSync(join(priv, f));
    if (!here && !up) continue;
    console.log(`  ${!up ? '↑ only here    ' : !here ? '↓ only there   ' : same(join(root, f), join(priv, f)) ? '= same         ' : '≠ different    '} ${f}`);
  }
} else {
  console.error('usage: bun run config:pull | config:push | config:status [owner/repo]');
  process.exit(1);
}
