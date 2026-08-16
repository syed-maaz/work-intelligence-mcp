/**
 * Phase 71-02 — verify orchestrator (POST /api/brain/verify backend).
 *
 * Atlas's biggest gap, closed: turn a free-form claim into a fact backed by
 * concrete evidence. The orchestrator fans out across the 3 adapter modules
 * (`github`, `jira`, `code-grep`) — and a `build_log` placeholder — based on
 * the caller's `evidence_needed` array. Each adapter is independent and has
 * its own circuit breaker, so one bad upstream doesn't cascade.
 *
 * Aggregation rules:
 *   - `verified` is the AND of every adapter result (true only if all pass).
 *   - `evidence` is a `\n`-joined human-readable transcript of every check.
 *   - `confidence` is the MIN across results — a single weak adapter pulls
 *     the whole verification down (ADR-024 Pillar 5 — verify before assert).
 *
 * Persistence: every verification (including failed ones) is written to
 * `brain_verifications` so future /api/brain/recall calls can surface "you
 * tried this exact claim 5 minutes ago and it was already false".
 *
 * `evidence_needed` syntax:
 *   - `code_grep:<pattern>[@<repo>]` — defaults repo to `self`.
 *   - `code_grep_re:<regex>[@<repo>]` — same but treats pattern as ERE.
 *   - `github:<endpoint>#<expectedField>[=<value>]`
 *     e.g. `github:repos/org/repo/pulls/123#merged=true`
 *   - `jira:<issueKey>#<expectedField>[=<value>]`
 *     e.g. `jira:JIRA-15257#fields.status.name=Done`
 *   - `build_log:<query>` — placeholder; always returns verified=false with
 *     evidence "build_log adapter not yet implemented" and confidence 0.
 *
 * Anything else returns a single failed result describing the parse error.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { verifyGithub } from './verifiers/github-verifier.js';
import { verifyJira } from './verifiers/jira-verifier.js';
import { verifyCodeGrep } from './verifiers/code-grep-verifier.js';
import type { VerifierResult } from './verifiers/circuit-breaker.js';

export interface VerifyClaimArgs {
  db: Database.Database;
  claim: string;
  evidence_needed: readonly string[];
}

export interface VerifyClaimResult {
  id: string;
  claim: string;
  verified: boolean;
  evidence: string;
  confidence: number;
  checked_at: number;
  results: Array<{ spec: string } & VerifierResult>;
}

export class InvalidVerifyArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVerifyArgsError';
  }
}

interface ParsedSpec {
  kind: 'github' | 'jira' | 'code_grep' | 'code_grep_re' | 'build_log' | 'unknown';
  raw: string;
  // kind-specific fields:
  pattern?: string;
  repo?: string;
  endpoint?: string;
  issueKey?: string;
  expectedField?: string;
  expectedValue?: unknown;
  query?: string;
  parseError?: string;
}

/**
 * Parse a single `evidence_needed` spec. Never throws — returns
 * `{kind:'unknown', parseError}` for malformed input so the orchestrator can
 * record it as a failed verification rather than a 500.
 */
export function parseSpec(raw: string): ParsedSpec {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { kind: 'unknown', raw, parseError: 'empty spec' };
  }
  const colon = raw.indexOf(':');
  if (colon === -1) {
    return { kind: 'unknown', raw, parseError: 'missing ":" separator' };
  }
  const kind = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  switch (kind) {
    case 'code_grep':
    case 'code_grep_re': {
      const at = rest.lastIndexOf('@');
      const pattern = at === -1 ? rest : rest.slice(0, at);
      const repo = at === -1 ? 'self' : rest.slice(at + 1);
      if (!pattern) return { kind: 'unknown', raw, parseError: 'code_grep: empty pattern' };
      return { kind: kind as 'code_grep' | 'code_grep_re', raw, pattern, repo };
    }
    case 'github':
    case 'jira': {
      const hash = rest.indexOf('#');
      if (hash === -1) {
        return { kind: 'unknown', raw, parseError: `${kind}: missing "#field"` };
      }
      const left = rest.slice(0, hash);
      const right = rest.slice(hash + 1);
      const eq = right.indexOf('=');
      const expectedField = eq === -1 ? right : right.slice(0, eq);
      const expectedValue = eq === -1 ? undefined : coerceValue(right.slice(eq + 1));
      if (!left) return { kind: 'unknown', raw, parseError: `${kind}: missing target` };
      if (!expectedField) return { kind: 'unknown', raw, parseError: `${kind}: empty field` };
      if (kind === 'github') {
        return { kind: 'github', raw, endpoint: left, expectedField, expectedValue };
      }
      return { kind: 'jira', raw, issueKey: left, expectedField, expectedValue };
    }
    case 'build_log':
      return { kind: 'build_log', raw, query: rest };
    default:
      return { kind: 'unknown', raw, parseError: `unknown adapter: ${kind}` };
  }
}

/** Coerce string suffix into boolean / number / string. */
function coerceValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

async function dispatch(
  db: Database.Database,
  spec: ParsedSpec,
): Promise<VerifierResult> {
  switch (spec.kind) {
    case 'code_grep':
    case 'code_grep_re':
      return verifyCodeGrep({
        pattern: spec.pattern!,
        repo: spec.repo ?? 'self',
        regex: spec.kind === 'code_grep_re',
      });
    case 'github':
      return verifyGithub(db, {
        endpoint: spec.endpoint!,
        expectedField: spec.expectedField!,
        expectedValue: spec.expectedValue,
      });
    case 'jira':
      return verifyJira(db, {
        issueKey: spec.issueKey!,
        expectedField: spec.expectedField!,
        expectedValue: spec.expectedValue,
      });
    case 'build_log':
      return {
        verified: false,
        evidence: `build_log adapter not yet implemented (query=${spec.query ?? ''})`,
        confidence: 0,
      };
    case 'unknown':
    default:
      return {
        verified: false,
        evidence: `parse error: ${spec.parseError ?? 'unknown'} (raw=${spec.raw})`,
        confidence: 0,
      };
  }
}

/**
 * Fan out across the requested adapters, aggregate, persist.
 *
 * Empty `evidence_needed` is treated as a 400-class error — there is nothing
 * to verify, so we refuse rather than silently returning verified=true.
 */
export async function verifyClaim(args: VerifyClaimArgs): Promise<VerifyClaimResult> {
  const { db, claim, evidence_needed } = args;
  if (typeof claim !== 'string' || claim.trim().length === 0) {
    throw new InvalidVerifyArgsError('claim is required');
  }
  if (!Array.isArray(evidence_needed) || evidence_needed.length === 0) {
    throw new InvalidVerifyArgsError('evidence_needed must be a non-empty array');
  }

  const specs = evidence_needed.map(parseSpec);

  // Promise.allSettled so a thrown adapter doesn't kill the orchestrator —
  // adapters already swallow their internal errors into VerifierResult, but
  // this is belt-and-suspenders for any future adapter that forgets to.
  const settled = await Promise.allSettled(specs.map((s) => dispatch(db, s)));
  const results: Array<{ spec: string } & VerifierResult> = settled.map((s, i) => {
    if (s.status === 'fulfilled') return { spec: specs[i].raw, ...s.value };
    const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
    return {
      spec: specs[i].raw,
      verified: false,
      evidence: `dispatch error: ${reason}`,
      confidence: 0,
    };
  });

  const verified = results.every((r) => r.verified);
  const confidence = results.length === 0 ? 0 : Math.min(...results.map((r) => r.confidence));
  const evidence = results.map((r) => `[${r.spec}] ${r.evidence}`).join('\n');
  const id = randomUUID();
  const checked_at = Date.now();

  db.prepare(
    `INSERT INTO brain_verifications
       (id, claim, verified, evidence_json, confidence, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    claim,
    verified ? 1 : 0,
    JSON.stringify(results),
    confidence,
    checked_at,
  );

  return {
    id,
    claim,
    verified,
    evidence,
    confidence,
    checked_at,
    results,
  };
}
