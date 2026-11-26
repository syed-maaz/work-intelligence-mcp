import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function regularPath(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new Error('demo database must be inside this checkout');
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor, {throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('demo paths must not contain a symlink');
  }
}

/** Construct a fresh process environment before importing any runtime code. */
export function createDemoEnvironment(root = ROOT, inherited = process.env) {
  root = realpathSync(root);
  if (inherited.WI_DEMO_BROWSER_PROFILE) throw new Error('live browser profile overrides are forbidden in demos');
  const scratch = join(root, '.wi-release');
  regularPath(root, scratch);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const state = mkdtempSync(join(scratch, 'demo-'));
  const db = inherited.DATABASE_PATH ? resolve(root, inherited.DATABASE_PATH) : join(state, 'demo.db');
  regularPath(root, db);
  // Explicit paths are constrained to data/*.db or this demo scratch tree.
  const rel = relative(root, db).split(sep).join('/');
  if (!/^data\/[^/]+\.db$/.test(rel) && !rel.startsWith('.wi-release/demo-')) throw new Error('demo database path must be data/<name>.db or demo scratch');
  const marker = db + '.wi-demo.json';
  regularPath(root, marker);
  for (const suffix of ['-wal', '-shm']) regularPath(root, db + suffix);
  if (existsSync(db) && (!existsSync(marker) || !lstatSync(marker).isFile())) throw new Error('unmarked existing database cannot be used for a demo');
  mkdirSync(dirname(db), { recursive: true });
  const id = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).id : randomUUID();
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid demo database marker');
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ id }), { mode: 0o600, flag: 'wx' });
  const home = join(state, 'home'), browser = join(state, 'empty-browser');
  mkdirSync(home); mkdirSync(browser);
  const config = join(state, 'wi.config.json');
  const maintained = join(root, 'release/public/wi.config.json');
  const neutral = existsSync(maintained) ? maintained : join(root, 'wi.config.json');
  const cfg = existsSync(neutral) ? JSON.parse(readFileSync(neutral, 'utf8')) : { version:'1.0', connectors:{}, repos:[] };
  for (const connector of Object.values(cfg.connectors)) connector.enabled = false;
  cfg.repos = [];
  cfg.database = { path: db };
  cfg.mempalace = { enabled: false, pythonPath: '', scriptPath: '', chromaPath: join(state, 'chroma') };
  writeFileSync(config, JSON.stringify(cfg));
  const env = { PATH: inherited.PATH, HOME: home, TMPDIR: state, DATABASE_PATH: db,
    WI_DEMO_DATABASE_ID: id, WI_DEMO_STATE: state, WI_CONFIG_PATH: config,
    WI_DEMO_MODE:'1', WI_EMBED_STUB:'1', WI_STAGE1_ENABLED:'0', CYPHER_REFINEMENT_ENABLED:'0',
    BROWSER_PROFILE_PATH: browser, WI_CHROMA_PATH:join(state,'chroma'), WI_DB_PATH:db,
    MEM_PALACE_DB_PATH:join(state,'palace.db'), OBSIDIAN_VAULT_PATH:join(state,'vault'),
    CYPHER_SUBAGENT_ENABLED:'0', CI:'1' };
  // Only model/proxy authentication may cross the demo boundary.
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL']) if (inherited[key]) env[key]=inherited[key];
  return env;
}

export function launchDemo(worker, args = []) {
  try {
    const env=createDemoEnvironment();
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(ROOT,'scripts/demo-worker.mjs'), worker, ...args],
      { cwd:ROOT, env, encoding:'utf8', maxBuffer:16*1024*1024 });
    const output=redactDemoOutput((result.stdout??'')+(result.stderr??''),env);
    if (/live.connector|outlook\.office\.com/i.test(output)) throw new Error('live output rejected');
    process.stdout.write(output);
    process.exitCode = result.status ?? 1;
  } catch { console.error('[demo] sandbox rejected the configuration; no live data was opened'); process.exitCode=1; }
}

export function redactDemoOutput(output,env) {
  if (env.ANTHROPIC_API_KEY) output=output.split(env.ANTHROPIC_API_KEY).join('[REDACTED]');
  return output.split(ROOT).join('<demo-checkout>');
}

export function publicPath(rel) {
  return join(ROOT, existsSync(join(ROOT,'release/public')) ? 'release/public' : '', rel);
}
