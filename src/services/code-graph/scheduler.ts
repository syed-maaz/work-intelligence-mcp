/**
 * Code-graph scheduler helpers — extracted from web-server.js so the
 * Sunday-sweep wall-clock semantics can be unit-tested without booting
 * the bridge.
 *
 * Closes ADR-027 v2 Path B item #2 (cron-style fast-forward unit test).
 *
 * Why a dedicated module:
 *   - The two-layer scheduler (60s heartbeat dispatcher + persisted UTC
 *     `due_at` sentinels in `sync_state`) is the load-bearing safety
 *     property of the CodeGraphIndexer agent. The Sunday 03:17 UTC sweep
 *     is the slowest-cadence heartbeat we have; if its wall-clock target
 *     drifts, we'd notice weeks later.
 *   - Inlining `nextSunday0317UTC` in web-server.js made it impossible to
 *     test in isolation. This module is pure (no DB, no agent, no clock —
 *     `now` is always passed in) so the test can fast-forward.
 *   - Extraction is a no-op behaviourally — web-server.js imports from
 *     `./dist/services/code-graph/scheduler.js` and replaces the inline
 *     arrow with the imported reference.
 */

/**
 * Compute the next Sunday 03:17 UTC strictly greater than `now`.
 *
 * UTC, not local — CorrelationAgent already paid for a DST incident;
 * CodeGraphIndexer inherits the wall-clock target without timezone
 * surprises.
 *
 * Invariants (asserted by the unit test):
 *   1. The returned Date is ALWAYS strictly greater than `now`.
 *   2. The returned Date is ALWAYS a Sunday (UTC day-of-week 0).
 *   3. The returned Date is ALWAYS at 03:17 UTC.
 *   4. If `now` is mid-week (Mon–Sat any time), the returned Sunday is
 *      ≤ 7 days away.
 *   5. If `now` is Sunday before 03:17 UTC, the returned Date is later
 *      the SAME day.
 *   6. If `now` is Sunday at-or-after 03:17 UTC, the returned Date is
 *      the FOLLOWING Sunday (7 days later).
 */
export function nextSunday0317UTC(now: Date): Date {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    3, 17, 0, 0,
  ));
  // If the computed time is in the past (or today is Sunday but we've
  // already passed 03:17 UTC), advance to next week.
  const dow = d.getUTCDay();
  const daysUntilSunday = (7 - dow) % 7;
  if (daysUntilSunday > 0) {
    d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  } else if (d.getTime() <= now.getTime()) {
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return d;
}
