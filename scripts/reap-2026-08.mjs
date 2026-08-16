#!/usr/bin/env node
/**
 * REAP 2026-08-06 — hung children + stale proactive queue archive.
 *
 * Usage:
 *   DATABASE_PATH=~/.wi-dev-g3-reap/data.db node scripts/reap-2026-08.mjs            # dry-run (default, read-only)
 *   DATABASE_PATH=~/.wi-dev-g3-reap/data.db node scripts/reap-2026-08.mjs --apply    # apply mode
 *
 * Env:
 *   DATABASE_PATH (required)  sqlite db path — never defaults to prod.
 *   KEEP_UNREAD (optional)    proactive_queue rows left unread after archive (default 4).
 *   STALE_DAYS (optional)     running-dispatch staleness cutoff in days (default 21).
 *
 * Exit codes: 0 ok, 1 error, 2 plan failed (schema drift).
 */
import { runReap, TASK } from "../src/reap/reap.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const help = args.includes("--help") || args.includes("-h");

if (help) {
  console.log(
    [
      `reap ${TASK.name}`,
      "",
      "  DATABASE_PATH=<path> node scripts/reap-2026-08.mjs [--apply]",
      "",
      "  --dry-run (default)  report planned changes, write nothing",
      "  --apply              execute the reaping transactions",
      "",
      "  env: DATABASE_PATH (required), KEEP_UNREAD (default 4), STALE_DAYS (default 21)",
    ].join("\n"),
  );
  process.exit(0);
}

const dbPath = process.env.DATABASE_PATH;
if (!dbPath) {
  console.error("reap: DATABASE_PATH env var required (refusing to guess a database)");
  process.exit(1);
}
if (dbPath.includes("~")) {
  console.error("reap: DATABASE_PATH must be an expanded path (no tilde)");
  process.exit(1);
}

const keepUnread = process.env.KEEP_UNREAD != null ? Number(process.env.KEEP_UNREAD) : TASK.keepUnread;
const staleDays = process.env.STALE_DAYS != null ? Number(process.env.STALE_DAYS) : TASK.staleRunningDays;
if (!Number.isFinite(keepUnread) || keepUnread < 0 || !Number.isFinite(staleDays) || staleDays <= 0) {
  console.error("reap: KEEP_UNREAD must be >= 0 and STALE_DAYS must be > 0");
  process.exit(1);
}

try {
  const summary = runReap(dbPath, { apply, keepUnread, staleDays });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.reap.ok || !summary.queue.ok) process.exit(2);
  process.exit(0);
} catch (err) {
  console.error(`reap: FAILED — ${err.message}`);
  process.exit(1);
}
