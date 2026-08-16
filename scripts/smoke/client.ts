/**
 * Typed bridge client for the TS smoke runner — PM-2.5 (2026-06-13).
 *
 * Replaces the bash + curl + python3-c-heredoc pattern from
 * scripts/smoke-bridge.sh. Each helper is a typed wrapper over a real
 * bridge endpoint; tests import these and get refactor-safe shape checks.
 *
 * Why a separate client (vs. importing src/services/cypher/pm.ts directly):
 *   The smoke is a black-box probe of the live bridge — it should hit
 *   real HTTP endpoints, not call the in-process helpers. That's the
 *   actual surface external callers (n8n, /wi, MCP) hit. Importing
 *   pm.ts in tests would skip the route layer + JSON serialization +
 *   error contract.
 *
 * Why no abstract HTTP framework (axios, ky, etc.):
 *   The smoke gate runs in CI without `npm install`. Native fetch
 *   (Node 22+) is the right primitive. One file, zero deps.
 */

import { setTimeout as delay } from 'node:timers/promises';

export interface ClientOptions {
  /** Bridge base URL. Defaults to env BRIDGE_URL or http://localhost:3132 */
  baseUrl?: string;
  /** Per-call timeout in ms. Default 10_000 — protects smoke from slow paths. */
  timeoutMs?: number;
}

const DEFAULT_BASE = process.env.BRIDGE_URL ?? 'http://localhost:3132';
const DEFAULT_TIMEOUT_MS = 10_000;

async function request<T>(
  path: string,
  init: RequestInit,
  opts: ClientOptions,
): Promise<{ ok: boolean; status: number; body: T | null; error?: string }> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}${path}`, { ...init, signal: ac.signal });
    let body: T | null = null;
    try {
      body = await resp.json() as T;
    } catch {
      // Response wasn't JSON — leave body null. Tests can assert on status/error.
    }
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function getStatus(opts: ClientOptions = {}) {
  return request<{ ok?: boolean }>('/api/status', { method: 'GET' }, opts);
}

/**
 * Wait for the bridge to come up. Useful when smoke runs immediately after
 * `npm run web:bridge &`. Returns true when /api/status returns 200.
 */
export async function waitForBridge(
  opts: ClientOptions & { maxAttempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const max = opts.maxAttempts ?? 15;
  const interval = opts.intervalMs ?? 1_000;
  for (let i = 0; i < max; i++) {
    const r = await getStatus({ ...opts, timeoutMs: 2_000 });
    if (r.ok) return true;
    await delay(interval);
  }
  return false;
}

// ─── Cypher PM lens (backed by src/services/cypher/pm.ts) ─────────────────────

export type WorkItemStatus = 'pending' | 'in_progress' | 'shipped' | 'blocked' | 'deferred';
export type EvidenceKind = 'commit_sha' | 'cypher_session_id' | 'smoke_section' | 'file_path' | 'pr_url';

export interface WorkItem {
  id: string;
  phase: string;
  wave: string | null;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  priority: number;
  depends_on: string[];
  smoke_section: string | null;
  blocker_reason: string | null;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemLink {
  id: number;
  work_item_id: string;
  evidence_kind: EvidenceKind;
  evidence_value: string;
  note: string | null;
  created_at: string;
}

export interface NextResponse  { items: WorkItem[]; total: number }
export interface StatusResponse { item: WorkItem; evidence: WorkItemLink[] }
export interface RollupRow {
  phase: string; wave: string | null;
  pending: number; in_progress: number; shipped: number; blocked: number; deferred: number;
  total: number;
}
export interface RollupResponse { rollup: RollupRow[] }
export interface ImpactResponse  { items: WorkItem[]; total: number }
export interface LinkResponse    { ok: true; work_item_id: string; evidence_kind: EvidenceKind; evidence_value: string }
export interface ErrorResponse   { error: string }

export async function pmNext(limit = 5, opts: ClientOptions = {}) {
  return request<NextResponse>(`/api/cypher/pm/next?limit=${limit}`, { method: 'GET' }, opts);
}

export async function pmStatus(id: string, opts: ClientOptions = {}) {
  return request<StatusResponse | ErrorResponse>(
    `/api/cypher/pm/status?id=${encodeURIComponent(id)}`, { method: 'GET' }, opts,
  );
}

export async function pmRollup(opts: ClientOptions = {}) {
  return request<RollupResponse>('/api/cypher/pm/rollup', { method: 'GET' }, opts);
}

export async function pmImpact(kind: EvidenceKind, value: string, opts: ClientOptions = {}) {
  const qs = new URLSearchParams({ kind, value }).toString();
  return request<ImpactResponse | ErrorResponse>(
    `/api/cypher/pm/impact?${qs}`, { method: 'GET' }, opts,
  );
}

export async function pmLink(
  body: { work_item_id: string; evidence_kind: EvidenceKind | string; evidence_value: string; note?: string },
  opts: ClientOptions = {},
) {
  return request<LinkResponse | ErrorResponse>('/api/cypher/pm/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, opts);
}

// ─── Drift detector (slice 2, 2026-06-14) ─────────────────────────────────────

export type DriftReason = 'stale_in_progress' | 'shipped_no_commit' | 'dead_file_path';

export interface DriftItem {
  id: string;
  title: string;
  status: string;
  reason: DriftReason;
  detail: string;
  updated_at: string;
}

export interface DriftBucket { count: number; items: DriftItem[] }

export interface DriftResponse {
  stale_in_progress: DriftBucket;
  shipped_no_commit: DriftBucket;
  dead_file_path:    DriftBucket;
  total: number;
  generated_at: string;
}

export async function pmDrift(staleDays?: number, opts: ClientOptions = {}) {
  const qs = staleDays !== undefined ? `?staleDays=${staleDays}` : '';
  return request<DriftResponse | ErrorResponse>(
    `/api/cypher/pm/drift${qs}`, { method: 'GET' }, opts,
  );
}

// ─── Cypher dispatch (wi_dispatch) ────────────────────────────────────────────

export interface DispatchInput {
  goal: string;
  context?: string;
  user?: string;
  candidate_skills?: string[];
  outcome?: 'success' | 'mixed' | 'failed';
  session_id?: string;
  task_class?: string;
  auto_execute?: boolean;
  /** PM-3-PRIME-A: clarifying answers when complexity verdict is borderline. */
  answers?: Record<string, string>;
}

export interface RankedSkill { skill: string; mean: number; runs: number }
export interface DispatchResponse {
  session_id: string;
  status: 'pending' | 'done' | 'halted' | 'asked_user';
  outcome?: 'success' | 'mixed' | 'failed';
  goal: string;
  task_class: string;
  chosen_skill?: string;
  ranked_skills: RankedSkill[];
  questions?: Array<{ id: string; question: string; default: string }>;
  pending_confirmation?: { path: string; action: string; verdict: string; reason: string };
  trace: Array<{ stage: string; status: string; payload?: unknown; duration_ms: number }>;
  summary: string;
  memory_actions: Array<{ kind: string; tier: string; reason: string; wrote: boolean }>;
  execution?: {
    skill: string;
    category: 'read' | 'write' | 'unknown';
    requires_confirmation?: boolean;
    result?: { ok: boolean; status: number; body?: unknown; error?: string; duration_ms: number };
    note: string;
  };
}

export async function dispatch(input: DispatchInput, opts: ClientOptions = {}) {
  return request<DispatchResponse>('/api/wi/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, opts);
}
