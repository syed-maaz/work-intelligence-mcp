#!/usr/bin/env node
/**
 * STEP 12 (OSS release) — one-command setup for a stranger clone:
 *   npm run setup
 *
 * 1. copy .env.example → .env (if absent)
 * 2. ensure wi.config.json (minimal default when missing)
 * 3. npm install (root + web)
 * 4. npm run build (dist/ needed by the bridge)
 * 5. create data/ + run migrations
 * 6. config:validate
 * 7. print next steps
 *
 * Plain-node only (no tsx) so it runs in a fresh clone before installs.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;

function sh(cmd, args, label) {
  process.stdout.write(`\n── ${label} ──\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: false });
  if (r.status !== 0) {
    console.error(`\n[setup] FAILED: ${label}`);
    process.exit(r.status ?? 1);
  }
}

// 1. .env
if (!existsSync(ROOT + '.env')) {
  copyFileSync(ROOT + '.env.example', ROOT + '.env');
  console.log('[setup] .env created from .env.example — fill in your keys.');
} else {
  console.log('[setup] .env already present — leaving as-is.');
}

// 2. wi.config.json
const CONFIG_SKELETON = {
  version: '1.0',
  connectors: {
    jira: { enabled: false, mode: 'mcp' },
    github: { enabled: false, mode: 'api' },
    slack: { enabled: false, mode: 'api' },
    linear: { enabled: false, mode: 'api' },
    teams: { enabled: false, mode: 'browser' },
    outlook: { enabled: false, mode: 'browser' },
  },
  repos: [],
};
if (!existsSync(ROOT + 'wi.config.json')) {
  writeFileSync(ROOT + 'wi.config.json', JSON.stringify(CONFIG_SKELETON, null, 2) + '\n');
  console.log('[setup] wi.config.json created (all connectors disabled).');
} else {
  console.log('[setup] wi.config.json already present — leaving as-is.');
}

// 3. installs
sh('npm', ['install'], 'npm install (root)');
sh('npm', ['install'], 'npm install (web)');

// 4. build
sh('npm', ['run', 'build'], 'npm run build');

// 5. data/ + migrations
mkdirSync(ROOT + 'data', { recursive: true });
process.stdout.write('\n── migrations ──\n');
const mig = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', "import('./dist/db/connection.js').then(m => { m.getDatabase(); m.closeDatabase(); })"],
  { cwd: ROOT, stdio: 'inherit' },
);
if (mig.status !== 0) {
  console.error('[setup] FAILED: migrations');
  process.exit(mig.status ?? 1);
}
console.log('[setup] data/ ready + migrations applied.');

// 6. config:validate
sh('npm', ['run', 'config:validate'], 'config:validate');

// 7. next steps
console.log(`
── setup complete ──
Next steps:
  1. Edit .env with real keys (or run the demo with fictional data):
       npm run demo                 # seed fictional data + prints next step
       WI_EMBED_STUB=1 npm run demo # same, with zero-vector embeddings (no Ollama)
       npm run demo:trace           # watch the Cypher loop reason over demo data
  2. Start the bridge + UI:
       BROWSER_PROFILE_PATH=/tmp/none npm run web:bridge   # API on :3132
       npm run web:dev              # UI on :5175 → open /setup
  3. Enable connectors on the Setup page — toggles write wi.config.json.
`);