/**
 * Code-graph re-entrancy lock — extracted from web-server.js so the
 * synchronous claim semantics can be deterministically unit-tested.
 *
 * Closes ADR-027 v2 Path B item #3 (deterministic race test).
 *
 * Why a dedicated module:
 *   - The original race fix (commit 7d1ce1f) introduced
 *     `tryAcquireCodeGraphLock` to atomically claim ALL of `repos` or NONE,
 *     which closes the window where two concurrent POSTs each pass
 *     `isCodeGraphBusy`, both write 202, then the second's withCodeGraphLock
 *     throws — but the response is already sent.
 *   - Smoke § 10c probes this race with two parallel POSTs, but the gate
 *     is timing-dependent: if the first POST's lock-claim-then-202 path
 *     finishes before the second's request lands, both legitimately return
 *     202 and the smoke can't tell that from a regression.
 *   - Extracting the lock into a pure module lets us call it twice
 *     synchronously from a test and assert "first wins, second gets
 *     `{ ok: false, busy: <repo> }`" without any timing.
 *
 * Behaviour is preserved verbatim — web-server.js imports these and
 * replaces its inline copies. The Map state is module-scoped (single
 * shared registry per process) which matches the previous module-scope
 * behaviour.
 */

/**
 * repo → true while a sweep is in flight. `true` is the only stored value;
 * absence of the key === not busy. Map (not Set) was chosen because the
 * original code probed `codeGraphBusy.get(r) === true` with a falsy default.
 */
const busy: Map<string, true> = new Map();

/**
 * Bounded ring buffer of busy-rejection events. The system-health handler
 * windows to the last 24h. 1000-entry cap so a wedged retry loop can't
 * grow this unboundedly.
 */
const busyRejections: Array<{ ts: number; repo: string }> = [];

export type AcquireResult =
  | { ok: true }
  | { ok: false; busy: string };   // `busy` carries the repo that lost

/**
 * Synchronously claim ALL of `repos` or NONE. Returns `{ ok: true }` if the
 * caller now owns the lock for every repo in the list; otherwise returns
 * `{ ok: false, busy: <first repo already taken> }` and changes nothing.
 *
 * The check-and-set is two passes (read all → write all), but it runs
 * synchronously inside one event-loop turn so concurrent JS callers cannot
 * interleave between the read and the write. That's the load-bearing
 * guarantee — every multi-repo claim is atomic from JS's perspective.
 */
export function tryAcquireCodeGraphLock(repos: readonly string[]): AcquireResult {
  for (const r of repos) {
    if (busy.get(r)) return { ok: false, busy: r };
  }
  for (const r of repos) {
    busy.set(r, true);
  }
  return { ok: true };
}

/**
 * Release the lock for every repo in the list. Idempotent — calling on a
 * non-held repo is a no-op (Map.delete returns false silently).
 */
export function releaseCodeGraphLock(repos: readonly string[]): void {
  for (const r of repos) busy.delete(r);
}

/** Whether a single repo is currently locked. */
export function isCodeGraphBusy(repo: string): boolean {
  return busy.get(repo) === true;
}

/**
 * Single-repo wrapper used by the CodeGraphIndexer agent tick. Throws if
 * the lock is already held — callers MUST gate with `isCodeGraphBusy`
 * first or use `tryAcquireCodeGraphLock` to get the all-or-none semantics.
 *
 * Behaviour preserved verbatim from the inline definition that previously
 * lived in web-server.js. Async because callers `await fn()`.
 */
export async function withCodeGraphLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  if (busy.get(repo)) {
    throw new Error(`code-graph busy for repo=${repo}`);
  }
  busy.set(repo, true);
  try {
    return await fn();
  } finally {
    busy.delete(repo);
  }
}

/**
 * Record a rejection event so /api/system-health.codeGraph can report
 * `busy_rejections_24h` (ADR-027 v2 item #4). Bounded to 1000 entries.
 */
export function recordCodeGraphBusyRejection(repo: string): void {
  busyRejections.push({ ts: Date.now(), repo });
  if (busyRejections.length > 1000) busyRejections.shift();
}

/**
 * Read-only snapshot of busy-rejection events. Used by the system-health
 * route to compute the rolling 24h window. Returns a defensive copy so
 * callers can't mutate internal state.
 */
export function getCodeGraphBusyRejections(): ReadonlyArray<{ ts: number; repo: string }> {
  return busyRejections.slice();
}

/**
 * TEST-ONLY hatch — clears the lock state. Production code paths never
 * reach this; only the unit test calls it between cases. We export it
 * rather than reset on import because vitest module isolation is
 * per-file, not per-test, so two `it()` blocks share the module
 * singleton.
 */
export function _resetCodeGraphLockForTesting(): void {
  busy.clear();
  busyRejections.length = 0;
}
