// Build the game and deploy it with the worker to Cloudflare:  bun run worker:deploy [wrangler options]
//
// worker/wrangler.toml is generic: deployed as is, the game goes to the free https://bitblade.<account>.workers.dev.
// Your own settings go in worker/deploy.env (git-ignored), e.g.
//
//   DOMAIN=bitblade.example.com        a custom domain (its zone must be on the same Cloudflare account)
//   ADMIN_KV_ID=0123456789abcdef...    optional: KV copy of the admin settings (wrangler kv namespace create ADMIN_KV)
//
// With either set, this writes worker/wrangler.deploy.toml (git-ignored) = wrangler.toml + those, and deploys that.
// No deploy.env: it asks what to do (deploy to workers.dev / set one up now / cancel) — so a machine that's missing
// the file never quietly deploys a custom-domain site without its domain. Not at a terminal (CI): pass --workers-dev
// to deploy without one. After deploying it checks the admin password (ADMIN_TOKEN secret) and offers to set it.
//
// Our options: --workers-dev (no deploy.env is fine), --no-build (skip vite build). Anything else goes to wrangler
// (e.g. --dry-run).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const worker = join(root, 'worker');
const envFile = join(worker, 'deploy.env');
const args = process.argv.slice(2);
const flag = (f: string) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
const workersDev = flag('--workers-dev');
const noBuild = flag('--no-build');
const dryRun = args.includes('--dry-run');
const tty = !!process.stdin.isTTY || process.env.DEPLOY_ASK === '1'; // (DEPLOY_ASK=1: answer the questions from piped input)

const run = (cmd: string[], cwd = worker, quiet = false) => {
  const p = Bun.spawnSync(cmd, { cwd, stdio: quiet ? ['inherit', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'] });
  return { ok: p.exitCode === 0, out: (p.stdout?.toString() ?? '') + (p.stderr?.toString() ?? '') };
};
const ask = (q: string, def = '') => (prompt(q + (def ? ` [${def}]` : '')) ?? '').trim() || def;
const yes = (q: string, def: boolean) => /^y/i.test(ask(`${q} (y/n)`, def ? 'y' : 'n'));

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(envFile)) return env;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && m[2]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const cleanDomain = (d: string) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
const okDomain = (d: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d);

/** no deploy.env: ask what to do (or write one) */
function setup() {
  console.log('\nNo worker/deploy.env on this machine.');
  console.log('  1) Deploy to the free https://bitblade.<your-account>.workers.dev (no custom domain)');
  console.log('  2) Set up worker/deploy.env now (custom domain and/or KV)');
  console.log('  3) Cancel');
  const c = ask('Choose', '3');
  if (c === '1') return;
  if (c !== '2') { console.log('Cancelled — nothing built or deployed.'); process.exit(1); }
  let domain = '';
  for (;;) {
    domain = cleanDomain(ask('Custom domain (e.g. bitblade.example.com — its zone must be on this Cloudflare account; empty: none)'));
    if (!domain || okDomain(domain)) break;
    console.log(`  "${domain}" doesn't look like a hostname`);
  }
  let kv = '';
  if (yes('Keep the admin settings in KV too? (a copy that outlives the worker; optional)', false)) {
    kv = ask('Existing KV namespace id (empty: create one now)');
    if (!kv) {
      console.log('Creating KV namespace ADMIN_KV…');
      const r = run(['bun', 'x', 'wrangler', 'kv', 'namespace', 'create', 'ADMIN_KV'], worker, true);
      kv = r.out.match(/\b[0-9a-f]{32}\b/)?.[0] ?? '';
      if (!kv) { console.log(r.out); console.log('Couldn\'t create it (logged in? `bun x wrangler login`). Carrying on without KV.'); }
      else console.log(`  created: ${kv}`);
    }
  }
  writeFileSync(envFile, [
    '# Deploy settings for this machine (git-ignored) — read by scripts/deploy.ts (bun run worker:deploy)',
    `# custom domain (empty: the free workers.dev address)`,
    `DOMAIN=${domain}`,
    `# optional KV namespace id for the admin settings (bun x wrangler kv namespace create ADMIN_KV)`,
    `ADMIN_KV_ID=${kv}`,
    '',
  ].join('\n'));
  console.log(`Wrote worker/deploy.env${domain ? ` (domain ${domain})` : ''}${kv ? ' (with KV)' : ''}.\n`);
}

if (!existsSync(envFile) && !workersDev) {
  if (!tty) {
    console.error('No worker/deploy.env. Pass --workers-dev to deploy to the free workers.dev address without one, or create it (see scripts/deploy.ts).');
    process.exit(1);
  }
  setup();
}

const env = readEnv();
const domain = env.DOMAIN ? cleanDomain(env.DOMAIN) : '';
const kv = env.ADMIN_KV_ID ?? '';
if (domain && !okDomain(domain)) throw new Error(`deploy.env: DOMAIN doesn't look like a hostname: ${domain}`);
if (kv && !/^[0-9a-f]{32}$/i.test(kv)) throw new Error('deploy.env: ADMIN_KV_ID should be the 32-character id wrangler printed');

let config = 'wrangler.toml';
if (domain || kv) {
  let toml = readFileSync(join(worker, 'wrangler.toml'), 'utf8');
  // (routes is a top-level key, so it goes before the first [table])
  if (domain) toml = toml.replace(/^(compatibility_date\s*=.*)$/m, `$1\nroutes = [{ pattern = "${domain}", custom_domain = true }]`);
  if (kv) toml += `\n[[kv_namespaces]]\nbinding = "ADMIN_KV"\nid = "${kv}"\n`;
  config = 'wrangler.deploy.toml';
  writeFileSync(join(worker, config), `# GENERATED by scripts/deploy.ts from wrangler.toml + deploy.env — edit those, not this\n${toml}`);
}

if (!noBuild) {
  console.log('Building the game…');
  if (!run(['bun', 'x', 'vite', 'build'], root).ok) process.exit(1);
}
console.log(`\nDeploying to ${domain ? `https://${domain}` : 'the workers.dev address'}${kv ? ' with ADMIN_KV' : ''}${dryRun ? ' (dry run)' : ''}…`);
if (!run(['bun', 'x', 'wrangler', 'deploy', '-c', config, ...args]).ok) process.exit(1);

// the admin page is locked until there's a password: offer to set it
if (!dryRun && tty) {
  const r = run(['bun', 'x', 'wrangler', 'secret', 'list', '-c', config], worker, true);
  if (r.ok && !r.out.includes('ADMIN_TOKEN')) {
    console.log('\nNo admin password yet (the ADMIN_TOKEN secret): /admin stays locked until there is one.');
    if (yes('Set it now? (make up a long one, 20+ characters)', true)) run(['bun', 'x', 'wrangler', 'secret', 'put', 'ADMIN_TOKEN', '-c', config]);
  }
}
