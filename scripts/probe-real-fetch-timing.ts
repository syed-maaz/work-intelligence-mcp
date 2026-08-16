/**
 * DIAGNOSTIC: time each REAL fetch source independently + capture the actual failure.
 * No simulation — calls the real connectors against the live system, one at a time,
 * each wrapped so we see: elapsed ms, result count, or the exact error/timeout.
 */
import Database from 'better-sqlite3';
import { getBrowserSession } from '../src/fetcher/sources/browser-session.js';
import { OutlookBrowserConnector } from '../src/fetcher/sources/outlook-browser.js';
import { createJiraDataSource } from '../src/fetcher/sources/jira-adapter.js';

const DB_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;
const db = new Database(DB_PATH);
const query = process.argv[2] || 'search-provider';
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

async function timed(label: string, work: () => Promise<unknown>, capMs: number) {
  const t0 = Date.now();
  let outcome: string;
  const cap = new Promise<string>((res) => setTimeout(() => res(`TIMED_OUT after ${capMs}ms (cap, not natural completion)`), capMs));
  const real = work()
    .then((r) => {
      const n = Array.isArray(r) ? r.length : (r && typeof r === 'object' ? Object.keys(r).length : 'n/a');
      return `OK count=${n}`;
    })
    .catch((e) => `ERROR: ${(e as Error).message.split('\n').slice(0, 2).join(' | ')}`);
  outcome = await Promise.race([real, cap]);
  console.log(`  ${label.padEnd(10)} ${String(Date.now() - t0).padStart(7)}ms  → ${outcome}`);
}

console.log(`\n=== REAL fetch diagnostic — query="${query}" ===\n`);

// JIRA — MCP-first (should be fast API call). Cap 45s.
const session = getBrowserSession();
await timed('jira', async () => {
  const jira = createJiraDataSource(session);
  return jira.fetchMessages(
    { boardUrl: process.env.JIRA_BOARD_URL, projectKey: process.env.JIRA_PROJECT_KEY },
    since,
  );
}, 45_000);

// OUTLOOK — browser scrape. Cap 45s to see if it even starts / where it stalls.
await timed('outlook', async () => {
  const ol = new OutlookBrowserConnector(session);
  return ol.fetchMessages({ folder: 'inbox', subjectFilter: query }, since);
}, 45_000);

console.log('\n(Interpretation: whichever hits the 45s cap is the culprit; the ERROR line shows WHY — auth wall, selector, launch, etc.)');
await session.close?.().catch(() => {});
db.close();
process.exit(0);
