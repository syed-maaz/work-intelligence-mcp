/**
 * Phase 71-02 — code-grep verifier adapter.
 *
 * Verifies a claim by running `git grep -l <pattern>` inside a repo under
 * `./repos/<name>` (the connected-repos workspace described in CLAUDE.md).
 * Returns the count of matching files plus a sample of paths for evidence.
 *
 * Inputs:
 *   - `pattern`: literal string searched with fixed-strings (`-F`) by default.
 *     Set `regex: true` to switch to extended regex.
 *   - `repo`: the directory name under `./repos/` (e.g. the primary app
 *     repo or the ops repo). The current repo (`.`) is also allowed via the
 *     special name `self`.
 *
 * Owns its own circuit breaker (3 fails → 30s open) — independent from the
 * github and jira adapters. A repo that doesn't exist counts as a failure.
 *
 * Path-safety: the resolved repo directory MUST be inside the allowed roots
 * (`./repos/*` or the current working directory); any attempt to escape is
 * rejected without spawning git.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type VerifierResult,
} from './circuit-breaker.js';

export interface CodeGrepVerifierInput {
  pattern: string;
  repo: string;
  /** Treat pattern as ERE regex instead of fixed string. */
  regex?: boolean;
  /** Max files to include in the sample (default 5). */
  sampleLimit?: number;
}

const breaker = new CircuitBreaker('code-grep');

/**
 * Resolve `<repo>` to an absolute directory inside the allow-list:
 *   - `self` → current cwd.
 *   - any other name → `./repos/<name>` resolved against cwd.
 *
 * Rejects names containing `/`, `..`, or null bytes — the directory MUST
 * be a single path segment.
 */
function resolveRepoDir(repo: string): string | null {
  if (typeof repo !== 'string' || repo.length === 0) return null;
  if (repo.includes('\0') || repo.includes('/') || repo.includes('\\') || repo === '..') {
    return null;
  }
  if (repo === 'self') return process.cwd();
  const target = resolve(process.cwd(), 'repos', repo);
  const allowed = resolve(process.cwd(), 'repos');
  if (!target.startsWith(allowed + '/') && target !== allowed) return null;
  if (!existsSync(target)) return null;
  return target;
}

/** Run `git grep -l` with a 10s timeout. Resolves to list of paths. */
async function gitGrep(
  cwd: string,
  pattern: string,
  regex: boolean,
): Promise<string[]> {
  return new Promise<string[]>((resolveP, reject) => {
    const args = ['grep', '-l', '--no-color'];
    if (regex) args.push('-E');
    else args.push('-F');
    args.push('--', pattern);
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('git grep timed out after 10s'));
    }, 10_000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // git grep exits 0 with matches, 1 with no matches, >1 on error.
      if (code === 0 || code === 1) {
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolveP(lines);
      } else {
        reject(new Error(`git grep exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

export async function verifyCodeGrep(
  input: CodeGrepVerifierInput,
): Promise<VerifierResult> {
  try {
    return await breaker.run(async () => {
      const repoDir = resolveRepoDir(input.repo);
      if (!repoDir) {
        // Resolution failure isn't recorded as a breaker failure on the same
        // path that "remote API down" would be — we surface it as a low-
        // confidence false. The breaker still counts the surrounding throw,
        // which is intentional: a misconfigured request is still noise.
        throw new Error(`unknown or invalid repo: ${input.repo}`);
      }
      const files = await gitGrep(repoDir, input.pattern, Boolean(input.regex));
      const sampleLimit = Math.max(1, Math.min(20, input.sampleLimit ?? 5));
      const sample = files.slice(0, sampleLimit);
      const verified = files.length > 0;
      const evidence = verified
        ? `code_grep "${input.pattern}" in ${input.repo} → ${files.length} matches; sample: ${sample.join(', ')}`
        : `code_grep "${input.pattern}" in ${input.repo} → no matches`;
      return {
        verified,
        evidence,
        // High confidence on direct match; low (but non-zero) on miss because
        // the absence is itself meaningful.
        confidence: verified ? 0.9 : 0.6,
      };
    });
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      return {
        verified: false,
        evidence: `code-grep verifier circuit open (retry ${new Date(err.retryAt).toISOString()})`,
        confidence: 0,
      };
    }
    return {
      verified: false,
      evidence: `code-grep verifier error: ${err instanceof Error ? err.message : String(err)}`,
      confidence: 0,
    };
  }
}

/** Test hook — exposes the breaker so tests can assert state without spying. */
export const __codeGrepBreaker = breaker;
