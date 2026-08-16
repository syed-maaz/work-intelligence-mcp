#!/usr/bin/env node
/**
 * STEP 12 (OSS release) — minimal loop trace for the demo:
 *   npm run demo:trace
 *
 * Imports runLoop, runs ONE goal over the demo database, dumps every tool
 * call step to stdout. STEP 13's first-run DoD and STEP 15's annotated
 * version extend this file.
 *
 * Requires ANTHROPIC_API_KEY (runLoop throws without it — we print the
 * friendly message instead).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getDatabase } from '../src/db/connection.js';
import { runLoop } from '../src/services/cypher/loop.js';

const GOAL =
  process.env.DEMO_GOAL ??
  'What happened with the PROJ-101 widget rollout on acme/widgets? Summarize the work and any open items.';

export async function runDemoTrace() {
  const db = getDatabase({ path: process.env.DATABASE_PATH || './data/demo.db' });
  const result = await runLoop({
    db,
    palace: null,
    goal: GOAL,
    user: 'demo',
    session_id: `cyp_demo_${randomUUID()}`,
    posture: 'generic',
    task_class: 'generic',
    confirm_mode: 'auto',
    is_interactive: false,
    halt_flag: { get halted() { return false; }, halt() {} },
    max_iterations: 10,
  });

  console.log(`\n── demo loop trace ── (${result.duration_ms}ms, verdict=${result.verdict})`);
  for (const step of result.tool_calls) {
    console.log(`  [${step.name}] ${JSON.stringify(step.input)} → ${step.ok ? 'ok' : `ERROR: ${step.error}`} (${step.duration_ms}ms)`);
  }
  console.log(`\n${result.surface}\n`);
  db.close();
  return result;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runDemoTrace().catch((e) => {
    console.error(`[demo:trace] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}