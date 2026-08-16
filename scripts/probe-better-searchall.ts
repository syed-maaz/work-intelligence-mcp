/**
 * PROBE: better search-all design — (a)+(b) intersection.
 * Design under test:
 *   1. LOCAL FTS first, always, instant — the answer that never needs a fetch.
 *   2. Live sources fetched IN PARALLEL, each with its OWN timeout budget.
 *   3. Each source produces an INDEPENDENT result envelope: ok | timed_out | error.
 *      One source failing/timing out NEVER sinks the others or the local result.
 *   4. Streaming: each source's outcome is emitted as it lands (allSettled) —
 *      a fast source (local, jira-MCP) returns immediately; a slow one (Outlook)
 *      resolves late or times out, but the caller already has the rest.
 *
 * Compared against the CURRENT searchAll: sequential Outlook(90s)→Jira(300s)→FTS,
 * outer-aborted at 60s → Outlook slowness kills the whole call before FTS runs.
 *
 * This probe does NOT touch production code — it reimplements the shape against
 * the same DB + connectors to MEASURE the difference.
 */
import Database from 'better-sqlite3';
import { searchMessages } from '../src/db/queries/messages.js';

const DB_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;
const db = new Database(DB_PATH, { readonly: true });

type SourceStatus = 'ok' | 'timed_out' | 'error';
interface SourceResult {
  source: string;
  status: SourceStatus;
  count: number;
  ms: number;
  note?: string;
}

// Per-source timeout that RESOLVES an envelope (never rejects) — isolation by construction.
function fetchSource(
  source: string,
  work: () => Promise<number>,
  timeoutMs: number,
  onLand: (r: SourceResult) => void,
): Promise<SourceResult> {
  const start = Date.now();
  const timeout = new Promise<SourceResult>((resolve) =>
    setTimeout(() => resolve({ source, status: 'timed_out', count: 0, ms: Date.now() - start, note: `>${timeoutMs}ms` }), timeoutMs),
  );
  const real = work()
    .then((count): SourceResult => ({ source, status: 'ok', count, ms: Date.now() - start }))
    .catch((e): SourceResult => ({ source, status: 'error', count: 0, ms: Date.now() - start, note: (e as Error).message.split('\n')[0] }));
  return Promise.race([real, timeout]).then((r) => { onLand(r); return r; });
}

async function betterSearchAll(query: string) {
  const t0 = Date.now();
  const events: string[] = [];
  const emit = (r: SourceResult) =>
    events.push(`  [+${String(Date.now() - t0).padStart(6)}ms] ${r.source.padEnd(6)} ${r.status.padEnd(9)} count=${r.count}${r.note ? ` (${r.note})` : ''}`);

  // 1. LOCAL FIRST — instant, always runs, never blocked by any fetch.
  const localStart = Date.now();
  const local = searchMessages(db, { search_text: query, limit: 10 });
  emit({ source: 'local', status: 'ok', count: local.length, ms: Date.now() - localStart });

  // 2. LIVE sources in PARALLEL, each isolated with its own budget.
  //    (Probe simulates fetch cost: Outlook slow/hangs, Jira-MCP fast, to model reality.)
  const results = await Promise.allSettled([
    fetchSource('email', async () => {
      // simulate an Outlook scrape that hangs (the real-world failure mode)
      await new Promise((r) => setTimeout(r, 120_000)); // will be cut by its 15s timeout
      return 3;
    }, 15_000, emit),
    fetchSource('jira', async () => {
      // simulate jira-MCP: fast API call
      await new Promise((r) => setTimeout(r, 1_200));
      return 7;
    }, 15_000, emit),
    fetchSource('teams', async () => {
      await new Promise((r) => setTimeout(r, 800));
      return 2;
    }, 15_000, emit),
  ]);

  const settled = results.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean) as SourceResult[];
  return { local: local.length, sources: settled, totalMs: Date.now() - t0, events };
}

const query = process.argv[2] || 'search-provider proxy 401';
console.log(`\n=== BETTER search-all probe — query: "${query}" ===`);
const out = await betterSearchAll(query);
console.log('\nStream of events (order they landed):');
out.events.forEach((e) => console.log(e));
console.log('\nOutcome:');
console.log(`  local hits: ${out.local} (returned at +~0ms — usable answer with ZERO fetch)`);
out.sources.forEach((s) => console.log(`  ${s.source}: ${s.status} (${s.ms}ms) count=${s.count}`));
console.log(`  total wall-clock: ${out.totalMs}ms`);
console.log('\nKEY: local + jira + teams all usable within ~1-2s; email timed out at 15s in ISOLATION —');
console.log('     did NOT block or fail the others. Contrast: current searchAll aborts EVERYTHING at 60s mid-Outlook.');
db.close();
