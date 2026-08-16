/**
 * Fingerprint + normalization for ADR-030 Phase A bug capture.
 *
 * Pure functions only — no DB, no fs, no network, no Date.now(). Determinism
 * is the contract: same input → same fingerprint, byte-for-byte. The
 * fingerprint is used as a UNIQUE key in the `bugs` table, so any drift
 * here would manifest as duplicated rows with different fingerprints.
 *
 * Five normalization rules (locked in ADR-030):
 *   1. Digit runs ≥ 3 → <N>
 *   2. UUIDs and SHA-shaped hex (≥ 8 contiguous hex chars) → <HASH>
 *   3. Absolute paths under /Users/, /home/, C:\Users\ → ~
 *   4. Whitespace trim + leading-verb lowercase
 *   5. Top frame = first stack frame outside node_modules and outside the
 *      wrapper-allowlist (withAgentTick, express error middleware, React
 *      ErrorBoundary, the bridge uncaught/unhandled shim itself)
 *
 * Final hash:
 *   sha256(`${source}|${errorName}|${normalizedMessage}|${topFrame ?? ''}`)
 *     .slice(0, 16)
 *
 * 16-char prefix gives 2^64 collision space. Real collisions get caught by
 * the SQLite UNIQUE constraint and degrade to a single row sharing two
 * actually-distinct errors — acceptable for Phase A.
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § "Fingerprint
 *       normalization (deterministic, applied before hashing)"
 */
import { createHash } from 'node:crypto';
import type { BugSource } from '../../types/bugs.js';

export interface FingerprintInput {
  source: BugSource;
  errorName: string;
  message: string;
  stack: string | null;
}

export interface FingerprintResult {
  fingerprint: string;
  normalizedMessage: string;
  topFrame: string | null;
}

/**
 * Wrapper frames we never blame as the top frame, because every bug routed
 * through the capture path passes through one of them. Order matters only
 * for performance: most-common first.
 */
const WRAPPER_PATTERNS: readonly RegExp[] = [
  /\bwithAgentTick\b/,
  /\bnode_modules\/express\b/,
  /\bcomponentDidCatch\b/,
  /\bErrorBoundary\b/,
  /\buncaughtException\b/,
  /\bunhandledRejection\b/,
  /\bcaptureToInternalEndpoint\b/,
];

const NODE_MODULES = /\bnode_modules\b/;

const HEX_RUN = /\b[0-9a-fA-F]{8,}\b/g;

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

const DIGIT_RUN = /\d{3,}/g;

const PATH_RE = /(\/Users\/[^\s'"]+|\/home\/[^\s'"]+|[Cc]:\\Users\\[^\s'"]+)/gi;

/**
 * Apply the five normalization rules to a raw error message. Pure; safe to
 * snapshot in tests.
 *
 * Order matters: paths first (so the digits in the user's home path don't
 * become <N>), then UUIDs (so we don't tag their hex sub-runs as <HASH>),
 * then remaining hex runs, then digit runs, then whitespace+lowercase.
 */
export function normalizeMessage(raw: string): string {
  let s = raw;

  // 4 (early). Whitespace trim + lowercase BEFORE placeholder substitution
  // so that the sentinels <N> and <HASH> survive in their canonical uppercase
  // form (lowercase-of-no-text is a no-op for them).
  s = s.trim().toLowerCase().replace(/\s+/g, ' ');

  // 3. Paths first among substitutions (digit runs inside paths shouldn't be <N>).
  s = s.replace(PATH_RE, (match) => {
    // Strip the prefix; keep what's after Users/<name>/ or home/<name>/.
    const m = match.match(/(?:\/users\/[^/]+\/?|\/home\/[^/]+\/?|c:\\users\\[^\\]+\\?)(.*)/);
    if (m && m[1]) return `~/${m[1].replace(/\\/g, '/')}`;
    return '~';
  });

  // 2a. Full UUIDs first.
  s = s.replace(UUID_RE, '<HASH>');

  // 2b. Hex runs ≥ 8 (after UUIDs are gone).
  s = s.replace(HEX_RUN, '<HASH>');

  // 1. Digit runs ≥ 3.
  s = s.replace(DIGIT_RUN, '<N>');

  return s;
}

/**
 * Walk a JS stack trace string and return the first frame that is NOT in
 * node_modules AND NOT a wrapper. Returns the file:line slice, e.g.
 * "src/routes/pr.ts:89".
 *
 * Returns null when only wrapper / node_modules frames are present (the
 * "everything is library code" case).
 */
export function extractTopFrame(stack: string | null): string | null {
  if (!stack) return null;
  const lines = stack.split('\n').map(l => l.trim()).filter(l => l.startsWith('at '));
  for (const line of lines) {
    if (NODE_MODULES.test(line)) continue;
    if (WRAPPER_PATTERNS.some(p => p.test(line))) continue;

    // Extract file:line from formats:
    //   "at fnName (file.ts:42:7)"  →  file.ts:42
    //   "at file.ts:42:7"            →  file.ts:42
    //   "at file.ts:42"              →  file.ts:42
    const parened = line.match(/\(([^)]+)\)/);
    const target = parened ? parened[1] : line.replace(/^at\s+/, '');
    const m = target.match(/^(.+?):(\d+)(?::\d+)?$/);
    if (m) return `${m[1]}:${m[2]}`;
    return target;
  }
  return null;
}

/**
 * Combine source, errorName, normalized message, and top frame into a
 * deterministic 16-char hex fingerprint plus the artifacts that produced
 * it (so callers can persist them next to the fingerprint in the bugs row).
 */
export function computeFingerprint(input: FingerprintInput): FingerprintResult {
  const normalizedMessage = normalizeMessage(input.message);
  const topFrame = extractTopFrame(input.stack);
  const fingerprint = createHash('sha256')
    .update(`${input.source}|${input.errorName}|${normalizedMessage}|${topFrame ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return { fingerprint, normalizedMessage, topFrame };
}
