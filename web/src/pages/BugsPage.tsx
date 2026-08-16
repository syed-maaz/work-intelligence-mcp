/**
 * BugsPage — ADR-030 Phase A.
 *
 * Browses the `bugs` table populated by the bridge's uncaughtException +
 * agent withAgentTick + web-UI ErrorBoundary capture hooks. Read-mostly
 * page; the only mutations are mark-resolved / mark-wont-fix.
 *
 * Density tokens follow .claude/rules/react-ui.md (px-3 py-1.5 text-xs for
 * table rows, px-3 py-2 text-xs font-semibold for section headers).
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bug, RefreshCw, X, Check, AlertCircle, AlertTriangle, RotateCcw, Wand2 } from 'lucide-react';
import { api, type BugRow, type BugStatus, type BugSource, type BugSeverity, type BugInvestigation, type BugResolution } from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { EmptyState } from '@/components/shared/EmptyState';
import { SkeletonRow } from '@/components/shared/SkeletonCard';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

const SEVERITY_VARIANT: Record<BugSeverity, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

const STATUS_VARIANT: Record<BugStatus, 'default' | 'info' | 'warning' | 'success' | 'danger'> = {
  new: 'warning',
  investigating: 'info',
  proposed: 'info',
  'auto-merged': 'info',
  resolved: 'success',
  'wont-fix': 'default',
  // v56 — Phase 76 resolver flow.
  resolving: 'info',
  'auto-resolved': 'success',
  'unable-to-resolve': 'danger',
};

export default function BugsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<BugStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<BugSource | 'all'>('all');
  const [severityFilter, setSeverityFilter] = useState<BugSeverity | 'all'>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const listQuery = useQuery({
    queryKey: ['bugs', { statusFilter, sourceFilter, severityFilter }],
    queryFn: () =>
      api.listBugs({
        status: statusFilter === 'all' ? undefined : statusFilter,
        source: sourceFilter === 'all' ? undefined : sourceFilter,
        severity: severityFilter === 'all' ? undefined : severityFilter,
        limit: 200,
      }),
    refetchInterval: 30_000,
  });

  const detailQuery = useQuery({
    queryKey: ['bug', selectedId],
    queryFn: () => (selectedId !== null ? api.getBug(selectedId) : Promise.resolve(null)),
    enabled: selectedId !== null,
    // Poll every 2s while the resolver is working so the badge + resolution
    // row refresh as soon as the agent lands. Stops polling once the bug
    // leaves 'resolving' (terminal: auto-resolved | unable-to-resolve).
    refetchInterval: (query) => {
      const data = query.state.data as { bug?: { status?: string } } | null | undefined;
      return data?.bug?.status === 'resolving' ? 2_000 : false;
    },
  });

  const resolveMut = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution: 'resolved' | 'wont-fix' }) =>
      api.resolveBug(id, resolution),
    onSuccess: () => {
      toast.success('Bug updated');
      qc.invalidateQueries({ queryKey: ['bugs'] });
      qc.invalidateQueries({ queryKey: ['bug', selectedId] });
    },
    onError: (err) => toast.error(`Resolve failed: ${(err as Error).message}`),
  });

  // ADR-030 Phase B (Plan 75-05): re-investigate. Resets the row so the
  // BugInvestigatorAgent picks it up on its next polling tick.
  const reinvestigateMut = useMutation({
    mutationFn: ({ id }: { id: number }) => api.reinvestigateBug(id),
    onSuccess: () => {
      toast.success('Re-investigation queued — agent will pick it up shortly');
      qc.invalidateQueries({ queryKey: ['bugs'] });
      qc.invalidateQueries({ queryKey: ['bug', selectedId] });
    },
    onError: (err) => toast.error(`Re-investigate failed: ${(err as Error).message}`),
  });

  // v55 — manual severity override (escalation UX). severity=null clears
  // the override and lets the ring-buffer recompute take over.
  const setSeverityMut = useMutation({
    mutationFn: ({ id, severity, reason }: { id: number; severity: BugSeverity | null; reason?: string }) =>
      api.setBugSeverity(id, severity, reason),
    onSuccess: (_, { severity }) => {
      toast.success(severity === null ? 'Severity override cleared' : `Severity set to ${severity}`);
      qc.invalidateQueries({ queryKey: ['bugs'] });
      qc.invalidateQueries({ queryKey: ['bug', selectedId] });
    },
    onError: (err) => toast.error(`Update severity failed: ${(err as Error).message}`),
  });

  // ADR-030 Phase C (Plan 76-04): user-clicked resolver attempt. Flips
  // status 'proposed' → 'resolving' on the server; the BugResolverAgent
  // drains the queue and lands either 'auto-resolved' (with a local commit
  // SHA) or 'unable-to-resolve' (with failure_reason). The UI polls
  // /api/bugs/:id while status='resolving' so the badge + resolution row
  // refresh as soon as the agent finishes.
  const resolveAttemptMut = useMutation({
    mutationFn: ({ id }: { id: number }) => api.resolveBugAttempt(id),
    onSuccess: () => {
      toast.success('Resolving — agent is working...');
      qc.invalidateQueries({ queryKey: ['bugs'] });
      qc.invalidateQueries({ queryKey: ['bug', selectedId] });
    },
    onError: (err) => {
      const msg = (err as Error).message;
      if (msg.includes('resolver_disabled')) {
        toast.error('Resolver disabled — set BUG_RESOLVER_ENABLED=1 and restart the bridge to enable.');
      } else {
        toast.error(`Resolve attempt failed: ${msg}`);
      }
    },
  });

  const bugs = listQuery.data?.bugs ?? [];
  const total = listQuery.data?.total ?? 0;
  const selected = detailQuery.data?.bug ?? null;

  return (
    <div className="flex h-full" data-test="bugs-page">
      {/* Main panel: filter strip + table */}
      <div className="flex-1 flex flex-col min-w-0" style={{ background: 'var(--bg)' }}>
        {/* Header strip */}
        <div
          className="px-3 py-2 text-xs font-semibold flex items-center gap-2 border-b"
          style={{ background: 'var(--bg-2)', color: 'var(--fg)', borderColor: 'var(--border)' }}
        >
          <Bug size={12} />
          <span>Bugs</span>
          <span className="font-normal" style={{ color: 'var(--muted)' }}>
            · {total} total {listQuery.isFetching ? '· refreshing…' : ''}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => listQuery.refetch()}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={12} className={listQuery.isFetching ? 'animate-spin' : ''} />
          </Button>
        </div>

        {/* Filter row */}
        <div
          className="px-3 py-2 flex flex-wrap items-center gap-2 border-b"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        >
          <FilterSelect
            label="Status"
            value={statusFilter}
            options={['all', 'new', 'investigating', 'proposed', 'resolved', 'wont-fix']}
            onChange={(v) => setStatusFilter(v as BugStatus | 'all')}
          />
          <FilterSelect
            label="Source"
            value={sourceFilter}
            options={['all', 'bridge', 'agent', 'web-ui', 'sync', 'bug-investigator']}
            onChange={(v) => setSourceFilter(v as BugSource | 'all')}
          />
          <FilterSelect
            label="Severity"
            value={severityFilter}
            options={['all', 'low', 'medium', 'high']}
            onChange={(v) => setSeverityFilter(v as BugSeverity | 'all')}
          />
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto" data-test="bugs-table">
          {listQuery.isLoading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3].map(i => <SkeletonRow key={i} />)}
            </div>
          ) : bugs.length === 0 ? (
            <EmptyState
              icon={Check}
              title="No bugs captured"
              description="Nothing's broken — or nothing's reported it yet. Phase A captures every uncaught bridge throw, agent crash, and web-UI render error."
            />
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0" style={{ background: 'var(--bg-2)', color: 'var(--muted)' }}>
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Severity</th>
                  <th className="px-3 py-1.5 text-left font-medium">Source</th>
                  <th className="px-3 py-1.5 text-left font-medium">Error</th>
                  <th className="px-3 py-1.5 text-left font-medium">Count</th>
                  <th className="px-3 py-1.5 text-left font-medium">Last seen</th>
                  <th className="px-3 py-1.5 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {bugs.map(b => (
                  <BugTableRow
                    key={b.id}
                    bug={b}
                    selected={b.id === selectedId}
                    onClick={() => setSelectedId(b.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Side panel: detail when a row is selected */}
      {selectedId !== null && (
        <aside
          className="w-96 flex-shrink-0 border-l overflow-auto flex flex-col"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
        >
          <div
            className="px-3 py-2 text-xs font-semibold border-b flex items-center gap-2"
            style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
          >
            <span>Bug #{selectedId}</span>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)} aria-label="Close">
              <X size={12} />
            </Button>
          </div>
          {detailQuery.isLoading ? (
            <div className="p-3"><SkeletonRow /></div>
          ) : selected ? (
            <BugDetailPanel
              bug={selected}
              recent_occurrences={detailQuery.data?.recent_occurrences ?? []}
              investigation={detailQuery.data?.investigation ?? null}
              latest_resolution={detailQuery.data?.latest_resolution ?? null}
              onResolve={(resolution) => resolveMut.mutate({ id: selected.id, resolution })}
              onReinvestigate={() => reinvestigateMut.mutate({ id: selected.id })}
              onSetSeverity={(severity, reason) => setSeverityMut.mutate({ id: selected.id, severity, reason })}
              onResolveAttempt={() => resolveAttemptMut.mutate({ id: selected.id })}
              isMutating={
                resolveMut.isPending ||
                reinvestigateMut.isPending ||
                setSeverityMut.isPending ||
                resolveAttemptMut.isPending
              }
            />
          ) : (
            <div className="p-3 text-xs" style={{ color: 'var(--muted)' }}>
              Bug not found.
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

function FilterSelect({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
      <span>{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-2 py-1 rounded text-xs"
        style={{
          background: 'var(--bg-3)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
        }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function BugTableRow({
  bug, selected, onClick,
}: {
  bug: BugRow;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className="cursor-pointer hover:bg-white/5"
      data-investigated={bug.last_investigation_id !== null ? 'true' : 'false'}
      style={{
        background: selected ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <td className="px-3 py-1.5">
        <Badge variant={SEVERITY_VARIANT[bug.severity]}>{bug.severity}</Badge>
      </td>
      <td className="px-3 py-1.5" style={{ color: 'var(--fg-2)' }}>
        {bug.source}
      </td>
      <td className="px-3 py-1.5 max-w-md truncate" style={{ color: 'var(--fg)' }} title={bug.message}>
        <span className="font-medium">{bug.error_name}</span>
        <span className="ml-2" style={{ color: 'var(--fg-2)' }}>{bug.message}</span>
      </td>
      <td className="px-3 py-1.5" style={{ color: 'var(--fg-2)' }}>
        {bug.occurrence_count}
      </td>
      <td className="px-3 py-1.5" style={{ color: 'var(--muted)' }}>
        {relativeTime(bug.last_seen_at)}
      </td>
      <td className="px-3 py-1.5">
        <Badge variant={STATUS_VARIANT[bug.status]}>{bug.status}</Badge>
      </td>
    </tr>
  );
}

function BugDetailPanel({
  bug, recent_occurrences, investigation, latest_resolution,
  onResolve, onReinvestigate, onSetSeverity, onResolveAttempt, isMutating,
}: {
  bug: BugRow;
  recent_occurrences: Array<{ seen_at: string }>;
  investigation: BugInvestigation | null;
  latest_resolution: BugResolution | null;
  onResolve: (resolution: 'resolved' | 'wont-fix') => void;
  onReinvestigate: () => void;
  onSetSeverity: (severity: BugSeverity | null, reason?: string) => void;
  onResolveAttempt: () => void;
  isMutating: boolean;
}) {
  const ctx = bug.context_json ? safeParseJson(bug.context_json) : null;
  return (
    <div className="flex-1 overflow-auto p-3 space-y-4 text-xs">
      <Section label="Error">
        <div className="font-medium" style={{ color: 'var(--fg)' }}>{bug.error_name}</div>
        <div style={{ color: 'var(--fg-2)' }}>{bug.message}</div>
      </Section>

      <Section label="Where">
        {bug.top_frame ? (
          <code style={{ color: 'var(--fg-2)' }}>{bug.top_frame}</code>
        ) : (
          <span style={{ color: 'var(--muted)' }}>(no application frame in stack)</span>
        )}
      </Section>

      <Section label="Stats">
        <Row k="Source"           v={bug.source} />
        <Row k="Severity"         v={bug.severity} />
        <Row k="Occurrences"      v={String(bug.occurrence_count)} />
        <Row k="First seen"       v={relativeTime(bug.first_seen_at)} />
        <Row k="Last seen"        v={relativeTime(bug.last_seen_at)} />
        <Row k="Status"           v={bug.status} />
        <Row k="Investig. attempts" v={String(bug.investigation_attempts)} />
      </Section>

      <Section label="Severity">
        <div className="flex flex-wrap items-center gap-2">
          <span style={{ color: 'var(--muted)' }}>Escalate:</span>
          {(['low', 'medium', 'high'] as const).map(s => (
            <Button
              key={s}
              size="sm"
              variant={bug.severity_override === s ? 'secondary' : 'ghost'}
              onClick={() => onSetSeverity(s)}
              disabled={isMutating || bug.severity_override === s}
            >
              {s}
            </Button>
          ))}
          {bug.severity_override !== null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSetSeverity(null)}
              disabled={isMutating}
              title="Clear manual override; severity falls back to ring-buffer recompute"
            >
              Clear
            </Button>
          ) : null}
        </div>
        {bug.severity_override !== null ? (
          <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            Manually escalated to <strong style={{ color: 'var(--fg-2)' }}>{bug.severity_override}</strong>
            {bug.severity_override_at ? <> · {relativeTime(bug.severity_override_at)}</> : null}
            {bug.severity_override_reason ? <> · {bug.severity_override_reason}</> : null}
          </div>
        ) : (
          <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
            No override — severity is derived from the occurrence ring buffer.
          </div>
        )}
      </Section>

      {ctx ? (
        <Section label="Context">
          <pre className="overflow-auto rounded p-2" style={{ background: 'var(--bg-2)', color: 'var(--fg-2)' }}>
            {JSON.stringify(ctx, null, 2)}
          </pre>
        </Section>
      ) : null}

      <Section label="Investigation">
        {investigation ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  investigation.confidence >= 0.8
                    ? 'success'
                    : investigation.confidence >= 0.5
                      ? 'warning'
                      : 'danger'
                }
              >
                confidence {(investigation.confidence * 100).toFixed(0)}%
              </Badge>
              <span style={{ color: 'var(--muted)' }}>
                Investigated {relativeTime(investigation.decided_at)}
              </span>
            </div>
            <div>
              <div className="font-medium" style={{ color: 'var(--fg)' }}>Root cause</div>
              <div style={{ color: 'var(--fg-2)' }}>{investigation.root_cause}</div>
            </div>
            {(() => {
              const files = safeParseJson(investigation.files_to_change);
              if (!Array.isArray(files) || files.length === 0) return null;
              return (
                <div>
                  <div className="font-medium" style={{ color: 'var(--fg)' }}>Files to change</div>
                  <ul className="list-disc list-inside" style={{ color: 'var(--fg-2)' }}>
                    {files.map((f, i) => (
                      <li key={i}><code>{String(f)}</code></li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {investigation.suggested_patch ? (
              <details>
                <summary className="cursor-pointer" style={{ color: 'var(--accent)' }}>
                  View suggested patch ({investigation.suggested_patch.split('\n').length} lines)
                </summary>
                <pre
                  className="overflow-auto rounded p-2 mt-2"
                  style={{ background: 'var(--bg-2)', color: 'var(--fg-2)' }}
                >
                  {investigation.suggested_patch}
                </pre>
              </details>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={onReinvestigate}
              disabled={isMutating}
            >
              <RotateCcw size={12} /> Re-investigate
            </Button>
          </div>
        ) : (
          <div
            className="px-3 py-2 rounded border text-xs flex items-start gap-2"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            <AlertCircle size={12} style={{ color: 'var(--muted)', marginTop: 2 }} />
            <div>
              Not investigated yet — agent will pick this up on the next tick (every 5 min).
            </div>
          </div>
        )}
      </Section>

      <Section label="Recent occurrences (last 50)">
        {recent_occurrences.length === 0 ? (
          <span style={{ color: 'var(--muted)' }}>(none)</span>
        ) : (
          <ul className="space-y-1 max-h-40 overflow-auto" style={{ color: 'var(--fg-2)' }}>
            {recent_occurrences.map((o, i) => (
              <li key={i}>{relativeTime(o.seen_at)}</li>
            ))}
          </ul>
        )}
      </Section>

      {/* v56 — Phase 76 BugResolverAgent surface. Two halves: */}
      {/*   1. Inline resolution row (when an attempt has happened).      */}
      {/*   2. "Resolve this" button (only on status='proposed').          */}
      {/* The resolving / unable-to-resolve states render the row only —  */}
      {/* clicking the button is the only path INTO 'resolving', and the  */}
      {/* terminal states aren't re-clickable (would need explicit user   */}
      {/* unstick via reinvestigate or mark-resolved).                    */}
      {latest_resolution !== null ? (
        <Section label="Resolver attempt">
          <ResolutionRow row={latest_resolution} status={bug.status} />
        </Section>
      ) : null}

      {bug.status === 'new' || bug.status === 'investigating' || bug.status === 'proposed' ? (
        <div className="flex flex-wrap gap-2 pt-2">
          {bug.status === 'proposed' ? (
            <Button
              size="sm"
              variant="primary"
              onClick={onResolveAttempt}
              disabled={isMutating}
              title="Run the BugResolverAgent — applies the proposed patch + commits locally (never pushes)"
            >
              <Wand2 size={12} /> Resolve this
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onResolve('resolved')}
            disabled={isMutating}
          >
            <Check size={12} /> Mark resolved
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onResolve('wont-fix')}
            disabled={isMutating}
          >
            <AlertTriangle size={12} /> Won&apos;t fix
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders the latest bug_resolutions row (the resolver attempt). Three
 * shapes:
 *   - status === 'auto-resolved' → success: commit SHA + files + reminder
 *   - status === 'unable-to-resolve' → danger: failure_reason + files
 *   - status === 'resolving' → info: animated "agent is working..." line
 *
 * Falls back to a generic outcome line when status doesn't match (older
 * rows, or in-flight transitions).
 */
function ResolutionRow({ row, status }: { row: BugResolution; status: BugStatus }) {
  const filesParsed = row.files_changed ? safeParseJson(row.files_changed) : null;
  const files = Array.isArray(filesParsed) ? (filesParsed as string[]) : [];

  if (status === 'resolving') {
    return (
      <div
        className="px-3 py-2 rounded border text-xs flex items-start gap-2"
        style={{ borderColor: 'var(--border)', color: 'var(--fg-2)' }}
      >
        <RefreshCw size={12} className="animate-spin mt-0.5" style={{ color: 'var(--accent)' }} />
        <div>Resolving — the BugResolverAgent is working. The page will refresh automatically.</div>
      </div>
    );
  }

  if (row.outcome === 'auto-resolved') {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="success">auto-resolved</Badge>
          <span style={{ color: 'var(--muted)' }}>{relativeTime(row.attempt_at)}</span>
        </div>
        {row.commit_sha ? (
          <div>
            <span style={{ color: 'var(--muted)' }}>Commit </span>
            <code title={row.commit_sha} style={{ color: 'var(--fg-2)' }}>
              {row.commit_sha.slice(0, 12)}
            </code>
          </div>
        ) : null}
        {files.length > 0 ? (
          <div>
            <div style={{ color: 'var(--muted)' }}>Files changed</div>
            <ul className="list-disc list-inside" style={{ color: 'var(--fg-2)' }}>
              {files.map((f, i) => (<li key={i}><code>{f}</code></li>))}
            </ul>
          </div>
        ) : null}
        <div
          className="px-2 py-1.5 rounded text-xs"
          style={{ background: 'var(--bg-2)', color: 'var(--fg-2)' }}
        >
          ⚠️ The fix is committed locally only. Run <code>git push</code> when you've reviewed it.
        </div>
      </div>
    );
  }

  // unable-to-resolve
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="danger">unable-to-resolve</Badge>
        <span style={{ color: 'var(--muted)' }}>{relativeTime(row.attempt_at)}</span>
      </div>
      {row.failure_reason ? (
        <div>
          <div style={{ color: 'var(--muted)' }}>Reason</div>
          <div style={{ color: 'var(--fg-2)' }}>{row.failure_reason}</div>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div>
          <div style={{ color: 'var(--muted)' }}>Patch touched</div>
          <ul className="list-disc list-inside" style={{ color: 'var(--fg-2)' }}>
            {files.map((f, i) => (<li key={i}><code>{f}</code></li>))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="text-xs uppercase tracking-wider font-medium mb-1"
        style={{ color: 'var(--muted)' }}
      >
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span style={{ color: 'var(--muted)' }}>{k}</span>
      <span style={{ color: 'var(--fg-2)' }}>{v}</span>
    </div>
  );
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
