/**
 * Code-graph indexer hard deadline — closes ADR-027 v2 audit finding F-027-1.
 *
 * Why this exists:
 *   The CodeGraphIndexer holds a per-repo lock for the duration of
 *   indexer.indexRepo() / indexer.indexChangedSince(). If the indexer
 *   wedges (ts-morph stall, FS hang, runaway mtime walk, etc.) the lock
 *   is never released and every subsequent POST /api/code-graph/index
 *   returns 409 until the bridge is restarted.
 *
 *   Same class of bug as the Jira-analyse spinner (commit 49be41c) —
 *   a long-running async operation with no upper bound. Same shape of
 *   fix: race the inner promise against a configurable deadline so the
 *   surrounding `.finally(releaseLock)` always fires within a bounded
 *   window.
 *
 *   The lock release path is unchanged. This helper only ensures the
 *   inner promise terminates (resolve or reject) so the surrounding
 *   `.finally(...)` in the caller can run.
 *
 * Default: 600000 ms (10 min). Override via env var
 * CODE_GRAPH_INDEX_TIMEOUT_MS (parsed at call time so tests / restarts
 * pick up changes without rebuilding).
 */

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Read the configured timeout from the environment. Falls back to the
 * default when unset, empty, or NaN. Negative or zero values fall back
 * too — a deadline of 0 ms would be a footgun.
 */
export function getCodeGraphIndexTimeoutMs(): number {
  const raw = process.env.CODE_GRAPH_INDEX_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return n;
}

/**
 * Race `inner` against a deadline. Resolves with the inner value if it
 * resolves first; rejects with a labelled timeout error if the deadline
 * fires first. The pending timer is always cleared so the Node event
 * loop can drain.
 *
 * @param inner The indexer promise to wrap.
 * @param label Human-readable label for the timeout error (e.g.
 *              "indexRepo <repo-name>" or "indexChangedSince <repo-name>").
 * @param timeoutMsOverride Test-only override that bypasses the env var.
 */
export function withCodeGraphIndexDeadline<T>(
  inner: Promise<T>,
  label: string,
  timeoutMsOverride?: number,
): Promise<T> {
  const timeoutMs =
    typeof timeoutMsOverride === 'number' && Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0
      ? timeoutMsOverride
      : getCodeGraphIndexTimeoutMs();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `code-graph indexer deadline exceeded (${timeoutMs}ms): ${label}`,
        ),
      );
    }, timeoutMs);
    // Don't keep the process alive just for this timer.
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  });

  return Promise.race([inner, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
