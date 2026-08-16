/**
 * /cypher — Cypher visibility panel.
 *
 * Operator console for the skill-router agent. Layout philosophy:
 *
 *   1. Status strip up top — five high-signal numbers in a single
 *      horizontal row. Daily scan = "is anything wrong?" answered in 1s.
 *   2. Activity feed dominates below — 2/3 width left, with drill-down.
 *      It's the primary surface; everything else is reference.
 *   3. Right rail (1/3) holds quieter reference data: catalog + learning
 *      priors. Collapsible by default so the eye lands on activity first.
 *   4. Project-state panel at the bottom — sweep UI for stuck sessions,
 *      drift detail. Action surface, not scan surface.
 *
 * Phase history rendered here:
 *   81a — PM-AUTO autonomous writes (auto_actions feed in drill-down)
 *   81b — three health endpoints + drill-down + sidebar group
 *   82a — stale-pending sweep + skill_actually_invoked credit fix
 *   82b — skill-discovery (catalog) + candidate merge
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Brain, Activity, GitBranch, ChevronDown, ChevronRight, AlertTriangle,
  CheckCircle2, Info, X, Clock, BookOpen, TrendingUp, Zap, Search,
  ThumbsUp, ThumbsDown, HelpCircle, Target,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  api,
  type CypherSessionSummary,
  type CypherSessionDetail,
  type CypherCatalogRow,
  type CypherOutcomesResponse,
  type CypherUserVerdict,
} from '@/lib/api';
import { Badge } from '@/components/ui';

const STALE_TIME_MS = 30_000;
const EXPLAINER_DISMISSED_KEY = 'cypher-explainer-dismissed';

function relativeTime(iso: string | null) {
  if (!iso) return null;
  try { return formatDistanceToNow(new Date(iso.replace(' ', 'T') + 'Z'), { addSuffix: true }); } catch { return iso; }
}

function fmtMean(n: number): string {
  return n.toFixed(2);
}

function fmtRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

// ════════════════════════════════════════════════════════════════════════════
// Page shell
// ════════════════════════════════════════════════════════════════════════════

export function CypherPage() {
  return (
    <div className="px-3 py-3 space-y-3 max-w-[1600px] mx-auto">
      <PageHeader />
      <ExplainerBanner />
      <StatusStrip />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Primary: activity feed gets 2/3 width on wide screens */}
        <div className="lg:col-span-2 space-y-3">
          <ActivitySection />
          <ProjectStateSection />
        </div>

        {/* Right rail: reference data, collapsible, quieter */}
        <aside className="space-y-3">
          <CatalogSection />
          <LearningSection />
        </aside>
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <header className="flex items-baseline gap-3 px-1">
      <div className="flex items-center gap-2">
        <Brain size={16} className="text-[var(--accent)]" />
        <h1 className="text-sm font-semibold text-[var(--fg)] tracking-tight">Cypher</h1>
      </div>
      <span className="text-xs text-[var(--muted)] font-mono">skill router · learning agent · /cypher</span>
    </header>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Explainer banner — same pattern as before, slightly tightened
// ════════════════════════════════════════════════════════════════════════════

function ExplainerBanner() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(EXPLAINER_DISMISSED_KEY) !== '1'; } catch { return true; }
  });
  const dismiss = () => {
    try { localStorage.setItem(EXPLAINER_DISMISSED_KEY, '1'); } catch { /* ignore */ }
    setOpen(false);
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--fg)] px-1 transition-colors"
        title="Show what this page is for"
      >
        <Info size={12} /> What is this page?
      </button>
    );
  }
  return (
    <div className="border border-[var(--border)] rounded-sm bg-[var(--bg-2)] relative overflow-hidden">
      {/* Subtle accent stripe on the left edge to differentiate from cards below */}
      <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--accent)]" />
      <div className="flex items-start gap-2 px-3 py-2 pl-4">
        <Info size={14} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-xs text-[var(--fg-2)] space-y-1.5">
          <div className="font-semibold text-[var(--fg)]">What you're looking at</div>
          <p>
            <strong>Cypher</strong> is the agent that picks which skill to recommend when you run <code className="text-[var(--accent)]">/wi &lt;goal&gt;</code>.
            It learns from outcomes you record with <code className="text-[var(--accent)]">/wi-record-outcome</code> and auto-maintains the project work-item table.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1">
            <ExplainerSection title="Status strip" body="The five numbers above tell you if anything's wrong. Green = nothing. Amber/red = look at it." />
            <ExplainerSection title="Activity" body="Last 20 dispatches. Click any row for the 9-stage trace + linked work_items + Cypher's autonomous writes." />
            <ExplainerSection title="Project state" body="Work_item rollup + drift + stuck-pending sweep. Sweep stuck rows in batch from here." />
            <ExplainerSection title="Right rail" body="Reference data — what Cypher can see (catalog) and what it has learned (priors). Quieter on purpose." />
          </div>
          <p className="text-[var(--muted)] pt-1 italic">
            30-second daily scan: status strip → activity → done. Drill in only when something's amber.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-[var(--muted)] hover:text-[var(--fg)] flex-shrink-0 transition-colors"
          title="Dismiss (re-open with the i button)"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function ExplainerSection({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="font-semibold text-[var(--fg)] mb-0.5">{title}</div>
      <div className="text-[var(--muted)] leading-snug">{body}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Status strip — five high-signal numbers up top, scan in 1 second
// ════════════════════════════════════════════════════════════════════════════
//
// This is the load-bearing UX move. Pulls signals from four endpoints and
// renders them as one horizontal strip. Color says "is anything wrong":
//   - green  = healthy
//   - amber  = look at this when you have time
//   - red    = look at this now
//   - muted  = informational, no judgement

function StatusStrip() {
  const priors = useQuery({ queryKey: ['cypher-priors'], queryFn: api.cypherPriors, staleTime: STALE_TIME_MS, refetchOnWindowFocus: false });
  const sessions = useQuery({ queryKey: ['cypher-sessions', 5], queryFn: () => api.cypherSessions(5), staleTime: STALE_TIME_MS, refetchOnWindowFocus: false });
  const drift = useQuery({ queryKey: ['cypher-pm-drift'], queryFn: api.cypherPmDrift, staleTime: STALE_TIME_MS, refetchOnWindowFocus: false });
  const stale = useQuery({ queryKey: ['cypher-stale', 2, 50], queryFn: () => api.cypherStale(2, 50), staleTime: STALE_TIME_MS, refetchOnWindowFocus: false });
  const catalog = useQuery({ queryKey: ['cypher-skill-catalog'], queryFn: api.cypherSkillCatalog, staleTime: STALE_TIME_MS, refetchOnWindowFocus: false });

  const inFlight = (sessions.data?.sessions ?? []).filter(s => s.in_flight).length;
  const driftCount = drift.data?.total ?? 0;
  const stuckCount = stale.data?.total ?? 0;
  const catalogTotal = catalog.data?.total ?? 0;

  // Aggregate success rate across all skills with attempts.
  const rates = priors.data?.success_rate ?? [];
  const totalAttempts = rates.reduce((s, r) => s + r.attempts, 0);
  const totalSuccesses = rates.reduce((s, r) => s + r.successes, 0);
  const overallRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : null;

  return (
    <div className="border border-[var(--border)] rounded-sm bg-[var(--bg-2)] overflow-hidden">
      <div className="grid grid-cols-2 md:grid-cols-5 divide-x divide-[var(--border)]">
        <StatusCell
          icon={<AlertTriangle size={12} />}
          label="Drift"
          value={driftCount}
          tone={driftCount === 0 ? 'good' : driftCount < 5 ? 'warn' : 'bad'}
          hint={driftCount === 0 ? 'no rotted work_items' : 'work_items need attention'}
        />
        <StatusCell
          icon={<Clock size={12} />}
          label="Stuck"
          value={stuckCount}
          tone={stuckCount === 0 ? 'good' : stuckCount < 10 ? 'warn' : 'bad'}
          hint={stuckCount === 0 ? 'no stale pending sessions' : 'pending > 2h — sweep below'}
        />
        <StatusCell
          icon={<Zap size={12} />}
          label="Live"
          value={inFlight}
          tone={inFlight > 0 ? 'live' : 'muted'}
          hint={inFlight > 0 ? 'sessions in flight now' : 'nothing running'}
          pulse={inFlight > 0}
        />
        <StatusCell
          icon={<TrendingUp size={12} />}
          label="Success"
          value={overallRate !== null ? `${Math.round(overallRate * 100)}%` : '—'}
          subValue={overallRate !== null ? `${totalSuccesses}/${totalAttempts}` : undefined}
          tone={overallRate === null ? 'muted' : overallRate >= 0.7 ? 'good' : overallRate >= 0.5 ? 'warn' : 'bad'}
          hint="across all recorded outcomes"
        />
        <StatusCell
          icon={<BookOpen size={12} />}
          label="Catalog"
          value={catalogTotal}
          subValue={catalog.data ? `${catalog.data.in_priors_count} used` : undefined}
          tone="muted"
          hint="skills Cypher can see"
        />
      </div>
    </div>
  );
}

function StatusCell({
  icon, label, value, subValue, tone, hint, pulse,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  subValue?: string;
  tone: 'good' | 'warn' | 'bad' | 'live' | 'muted';
  hint: string;
  pulse?: boolean;
}) {
  const valueColor = {
    good: 'text-emerald-500',
    warn: 'text-amber-500',
    bad: 'text-[var(--danger)]',
    live: 'text-[var(--accent)]',
    muted: 'text-[var(--fg)]',
  }[tone];
  const iconColor = {
    good: 'text-emerald-500/60',
    warn: 'text-amber-500/70',
    bad: 'text-[var(--danger)]/70',
    live: 'text-[var(--accent)]',
    muted: 'text-[var(--muted)]',
  }[tone];
  return (
    <div className="px-3 py-2.5 group" title={hint}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--muted)] font-medium">
        <span className={`${iconColor} ${pulse ? 'animate-pulse' : ''}`}>{icon}</span>
        {label}
      </div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className={`font-mono text-xl tabular-nums leading-none ${valueColor}`}>{value}</span>
        {subValue && <span className="font-mono text-[10px] text-[var(--muted)]">{subValue}</span>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Activity — primary surface, dominant width
// ════════════════════════════════════════════════════════════════════════════

function ActivitySection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cypher-sessions', 20],
    queryFn: () => api.cypherSessions(20),
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'' | 'pending' | 'done' | 'failed' | 'live'>('');

  const filtered = (data?.sessions ?? []).filter(s => {
    if (!filter) return true;
    if (filter === 'live') return s.in_flight;
    if (filter === 'failed') return s.outcome === 'failed' || s.status === 'halted';
    if (filter === 'done') return s.status === 'done';
    if (filter === 'pending') return s.status === 'pending';
    return true;
  });

  return (
    <Card>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <Activity size={12} className="text-[var(--accent)]" />
        <h2 className="text-xs font-semibold text-[var(--fg)]">Activity</h2>
        <span className="text-xs text-[var(--muted)]">last 20 dispatches</span>
        <div className="ml-auto flex items-center gap-1">
          <FilterChip active={filter === ''} onClick={() => setFilter('')}>all</FilterChip>
          <FilterChip active={filter === 'live'} onClick={() => setFilter('live')}>live</FilterChip>
          <FilterChip active={filter === 'pending'} onClick={() => setFilter('pending')}>pending</FilterChip>
          <FilterChip active={filter === 'done'} onClick={() => setFilter('done')}>done</FilterChip>
          <FilterChip active={filter === 'failed'} onClick={() => setFilter('failed')}>failed</FilterChip>
        </div>
      </div>
      {isLoading && <SkeletonLines count={6} />}
      {error && <div className="px-3 py-3 text-xs text-[var(--danger)]">Failed: {(error as Error).message}</div>}
      {data && filtered.length === 0 && (
        <div className="px-3 py-6 text-xs text-[var(--muted)] text-center">
          {filter ? `No sessions match filter '${filter}'` : 'No Cypher sessions yet'}
        </div>
      )}
      {data && filtered.length > 0 && (
        <div className="text-xs">
          {filtered.map((s, idx) => (
            <SessionRow
              key={s.session_id}
              session={s}
              expanded={expandedId === s.session_id}
              onToggle={() => setExpandedId(expandedId === s.session_id ? null : s.session_id)}
              zebra={idx % 2 === 1}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[10px] px-1.5 py-0.5 rounded-sm transition-colors ${
        active
          ? 'bg-[var(--accent)] text-white'
          : 'text-[var(--muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-3)]'
      }`}
    >
      {children}
    </button>
  );
}

function SessionRow({
  session, expanded, onToggle, zebra,
}: {
  session: CypherSessionSummary;
  expanded: boolean;
  onToggle: () => void;
  zebra: boolean;
}) {
  return (
    <div className={`border-b border-[var(--border)] last:border-0 ${zebra ? 'bg-[var(--bg)]' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-3)] transition-colors flex items-start gap-2"
      >
        <span className="flex-shrink-0 mt-0.5 text-[var(--muted)]">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono truncate text-[var(--fg)]" title={session.goal}>
              {session.goal}
            </span>
            {session.in_flight && (
              <span className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)]">
                <span className="w-1 h-1 rounded-full bg-[var(--accent)] animate-pulse" />
                live
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--muted)] font-mono">
            <span title={session.started_at}>{relativeTime(session.started_at)}</span>
            <span>·</span>
            <span>{session.user}</span>
            <span>·</span>
            <span>{session.task_class ?? '*'}</span>
            {session.chosen_skill && (
              <>
                <span>·</span>
                <span className="text-[var(--fg-2)]">{session.chosen_skill}</span>
              </>
            )}
            {session.skill_actually_invoked && session.skill_actually_invoked !== session.chosen_skill && (
              <>
                <span>→</span>
                <span className="text-[var(--accent)]">{session.skill_actually_invoked}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <ThumbsControl sessionId={session.session_id} />
          <VerdictPill verdict={session.complexity_verdict} />
          <StatusPill status={session.status} outcome={session.outcome} />
        </div>
      </button>
      {expanded && (
        <div className="bg-[var(--bg-2)] border-t border-[var(--border)]">
          <SessionDetail sessionId={session.session_id} />
        </div>
      )}
    </div>
  );
}

function SessionDetail({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cypher-session', sessionId],
    queryFn: () => api.cypherSession(sessionId),
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
  if (isLoading) return <div className="px-3 py-2 text-xs text-[var(--muted)]">Loading detail…</div>;
  if (error) return <div className="px-3 py-2 text-xs text-[var(--danger)]">Failed: {(error as Error).message}</div>;
  if (!data) return null;
  return <SessionDetailBody detail={data} />;
}

function SessionDetailBody({ detail }: { detail: CypherSessionDetail }) {
  return (
    <div className="px-3 py-2.5 space-y-2.5 text-xs">
      <div className="flex items-center gap-2 text-[10px] text-[var(--muted)] font-mono">
        <span>{detail.session.session_id}</span>
        <span>·</span>
        <span>{detail.session.step_count} steps</span>
      </div>

      <UserVerdictControl
        sessionId={detail.session.session_id}
        sessionStatus={detail.session.status}
      />

      {/*
        Model-emitted rationale (loop.ts:2708). Populated when the model
        called cypher_record_outcome — the tool via which it self-reports
        the verdict. Persisted to cypher_sessions.outcome_note. Before
        2026-07-25 this was written but never rendered (F2 in the review);
        now it lives right below the user-verdict controls so the human
        reason for a 'failed'/'halted'/'mixed' verdict is visible.
      */}
      {detail.session.outcome_note && (
        <div>
          <SectionLabel>model rationale (outcome_note)</SectionLabel>
          <div className="mt-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--bg-2)] text-[11px] leading-relaxed text-[var(--fg-1)] whitespace-pre-wrap font-normal">
            {detail.session.outcome_note}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>9-stage pipeline</SectionLabel>
        <div className="grid grid-cols-9 gap-0.5 mt-1">
          {detail.steps.map((s, i) => (
            <div
              key={i}
              className="rounded-sm px-1.5 py-1 text-center font-mono text-[10px]"
              style={{
                background:
                  s.status === 'completed' ? 'var(--accent)' :
                  s.status === 'failed' ? 'var(--danger)' :
                  s.status === 'skipped' ? 'var(--bg-3)' : 'var(--bg-2)',
                color: s.status === 'completed' || s.status === 'failed' ? 'white' : 'var(--fg-2)',
                opacity: s.status === 'skipped' ? 0.4 : 1,
              }}
              title={`${s.stage} — ${s.status}`}
            >
              <div className="text-[8px] opacity-70">{s.stage_index}</div>
              <div className="truncate">{s.stage}</div>
            </div>
          ))}
        </div>
      </div>

      {detail.links.length > 0 && (
        <div>
          <SectionLabel>linked work_items</SectionLabel>
          <div className="flex flex-wrap gap-1 mt-1">
            {detail.links.map((l, i) => (
              <Badge key={i} variant="info">{l.work_item_id}</Badge>
            ))}
          </div>
        </div>
      )}

      {detail.auto_actions.length > 0 && (
        <div>
          <SectionLabel>cypher auto-actions ({detail.auto_actions.length})</SectionLabel>
          <ul className="space-y-0.5 mt-1 font-mono text-[11px]">
            {detail.auto_actions.map((a, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <Badge variant={a.action.startsWith('transition') ? 'success' : 'default'}>{a.action}</Badge>
                <span className="text-[var(--fg-2)]">{a.work_item_id}</span>
                <span className="text-[var(--muted)]">— {a.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">
      {children}
    </div>
  );
}

function VerdictPill({ verdict }: { verdict: 'light' | 'heavy' | 'borderline' | null }) {
  if (!verdict) return null;
  const map = {
    light: 'default',
    borderline: 'warning',
    heavy: 'danger',
  } as const;
  return <Badge variant={map[verdict]}>{verdict}</Badge>;
}

// ════════════════════════════════════════════════════════════════════════════
// ThumbsControl — ADR-034 L1.1 (phase 87) thumbs-up/down affordance.
//
// Renders 👍 / 👎 buttons when no thumbs row exists for this session+user
// (AC L1.1-A-01); collapses to a static badge + ↻ change affordance once
// a row is present (AC L1.1-A-02). Click-to-flip is a UPSERT in place
// (AC L1.1-A-04). Wraps clicks in stopPropagation so the row's expand-
// toggle button doesn't fire when the user clicks the thumb.
// ════════════════════════════════════════════════════════════════════════════
function ThumbsControl({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['cypher-outcomes', sessionId],
    queryFn: () => api.cypherOutcomes(sessionId),
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const [isEditing, setIsEditing] = useState(false);

  const mutation = useMutation({
    mutationFn: ({ value }: { value: 0.8 | -1.0 }) => api.cypherPostThumbs(sessionId, value),
    onSuccess: (resp) => {
      // Optimistically update the outcomes cache with the response so the
      // badge flips without waiting for the GET refetch.
      qc.setQueryData<CypherOutcomesResponse>(['cypher-outcomes', sessionId], {
        ok: true,
        session_id: sessionId,
        aggregate: resp.aggregate,
        signals: resp.signals,
      });
      setIsEditing(false);
    },
  });

  if (isLoading || !data) return null;

  // Find the thumbs row for the current user. We don't try to read the
  // user from the cache here — the badge shows whatever the latest
  // thumbs row says, regardless of who placed it. (Future: scope the
  // badge to the current user's row.)
  const thumbsRow = data.signals.find(s => s.kind === 'thumbs');
  const showButtons = !thumbsRow || isEditing;

  if (showButtons) {
    return (
      <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ value: 0.8 })}
          title="Mark this dispatch as helpful"
          className="p-1 rounded hover:bg-[var(--bg-3)] disabled:opacity-50 transition-colors text-[var(--muted)] hover:text-[var(--accent)]"
        >
          <ThumbsUp size={11} />
        </button>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ value: -1.0 })}
          title="Mark this dispatch as unhelpful"
          className="p-1 rounded hover:bg-[var(--bg-3)] disabled:opacity-50 transition-colors text-[var(--muted)] hover:text-[var(--danger)]"
        >
          <ThumbsDown size={11} />
        </button>
        {isEditing && (
          <button
            type="button"
            onClick={() => setIsEditing(false)}
            title="Cancel change"
            className="text-[10px] text-[var(--muted)] hover:text-[var(--fg-2)] px-1"
          >
            ×
          </button>
        )}
      </span>
    );
  }

  // Collapsed badge — clicking it toggles edit mode (AC L1.1-A-02).
  const isUp = thumbsRow!.value > 0;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
      title={`Recorded ${isUp ? '👍' : '👎'} — click to change`}
      className={`inline-flex items-center gap-0.5 px-1.5 py-0 text-[10px] rounded border transition-colors ${
        isUp
          ? 'text-[var(--accent)] border-[var(--accent)]/30 bg-[var(--accent)]/5 hover:bg-[var(--accent)]/10'
          : 'text-[var(--danger)] border-[var(--danger)]/30 bg-[var(--danger)]/5 hover:bg-[var(--danger)]/10'
      }`}
    >
      {isUp ? <ThumbsUp size={9} /> : <ThumbsDown size={9} />}
      <span className="ml-0.5 opacity-60">↻</span>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// UserVerdictControl — ADR-039 AC-15. SCOPE-phase prompt-clarity capture.
//
// Three buttons: 👍 Useful | ❓ Wrong question | 🎯 Wrong scope. POSTs to
// /api/cypher/sessions/:id/user-verdict which writes prompt_outcomes.user_verdict
// for the most-recent goal_refinement row matching this session's goal.
// After click, collapses to a "Recorded ✓ <verdict>" pill — disabled, no
// revoke in v1 (AC-15 explicitly v1).
//
// Backend can return 404 OUTCOME_ROW_NOT_FOUND when the SCOPE phase hasn't
// scored this session yet (typical until T8 wires scoreRefinedGoal into the
// loop). We surface that as a one-line hint instead of an error toast — it
// is the expected "no signal yet" state.
//
// The pill state lives in component state for v1: ADR-039 doesn't require
// reading the persisted verdict back, and there's no GET endpoint that
// returns it. If we add server-side read later, replace the local state
// with a useQuery on a /user-verdict GET. For now, the click → pill
// transition is the only UX surface.
// ════════════════════════════════════════════════════════════════════════════
function UserVerdictControl({
  sessionId, sessionStatus,
}: {
  sessionId: string;
  sessionStatus: 'pending' | 'done' | 'halted' | 'asked_user';
}) {
  const [recorded, setRecorded] = useState<CypherUserVerdict | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (verdict: CypherUserVerdict) => api.cypherPostUserVerdict(sessionId, verdict),
    onSuccess: (resp) => {
      setRecorded(resp.verdict);
      setErrorCode(null);
    },
    onError: (err: Error) => {
      // Server returns OUTCOME_ROW_NOT_FOUND when no goal_refinement
      // scoring row exists yet for this session's goal. Show a hint, not
      // a generic error toast — this is expected pre-T8.
      setErrorCode(err.message || 'UNKNOWN');
    },
  });

  // Only offer the affordance for closed sessions. ADR-039 explicitly
  // scopes user_verdict to "closed session" — mid-flight pending rows
  // don't get a verdict button.
  if (sessionStatus !== 'done' && sessionStatus !== 'halted') {
    return null;
  }

  if (recorded) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
        <span className="uppercase tracking-wider font-semibold">scope verdict</span>
        <Badge variant="success">Recorded ✓ {labelFor(recorded)}</Badge>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold">scope verdict</span>
      <VerdictButton
        onClick={() => mutation.mutate('useful')}
        disabled={mutation.isPending}
        title="The refined goal matched what I asked"
        icon={<ThumbsUp size={11} />}
        label="Useful"
      />
      <VerdictButton
        onClick={() => mutation.mutate('wrong_question')}
        disabled={mutation.isPending}
        title="Cypher interpreted the goal incorrectly"
        icon={<HelpCircle size={11} />}
        label="Wrong question"
      />
      <VerdictButton
        onClick={() => mutation.mutate('wrong_scope')}
        disabled={mutation.isPending}
        title="Right question but wrong bounds (too narrow / too wide)"
        icon={<Target size={11} />}
        label="Wrong scope"
      />
      {errorCode && (
        <span className="text-[10px] text-[var(--muted)] italic ml-1">
          {errorCode === 'OUTCOME_ROW_NOT_FOUND'
            ? '(no scope-phase scoring row yet for this goal)'
            : `(${errorCode})`}
        </span>
      )}
    </div>
  );
}

function VerdictButton({
  onClick, disabled, title, icon, label,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-[var(--border)] hover:bg-[var(--bg-3)] hover:border-[var(--accent)] disabled:opacity-50 transition-colors text-[var(--fg-2)]"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function labelFor(v: CypherUserVerdict): string {
  switch (v) {
    case 'useful': return 'useful';
    case 'wrong_question': return 'wrong question';
    case 'wrong_scope': return 'wrong scope';
    case 'unrated': return 'unrated';
  }
}

function StatusPill({
  status, outcome,
}: {
  status: 'pending' | 'done' | 'halted' | 'asked_user';
  outcome: CypherSessionSummary['outcome'];
}) {
  if (status === 'done' && outcome) {
    // Widened 2026-07-25 to admit the honest verdict enum: was
    // {success|mixed|failed}, now includes halted/abandoned/
    // rejected_non_interactive/captured_to_board (see reducer fix in
    // loop.ts:3013). Badge palette:
    //   success / captured_to_board          → green
    //   mixed / abandoned                     → amber
    //   failed / halted / rejected_non_interactive → red
    const map: Record<Exclude<CypherSessionSummary['outcome'], null>, 'success' | 'warning' | 'danger'> = {
      success: 'success',
      captured_to_board: 'success',
      mixed: 'warning',
      abandoned: 'warning',
      failed: 'danger',
      halted: 'danger',
      rejected_non_interactive: 'danger',
    };
    return <Badge variant={map[outcome]}>{outcome}</Badge>;
  }
  if (status === 'halted') return <Badge variant="danger">halted</Badge>;
  if (status === 'asked_user') return <Badge variant="warning">asked</Badge>;
  return <Badge variant="default">pending</Badge>;
}

// ════════════════════════════════════════════════════════════════════════════
// Project state — rollup + sweep UI (action surface)
// ════════════════════════════════════════════════════════════════════════════

function ProjectStateSection() {
  const rollup = useQuery({
    queryKey: ['cypher-pm-rollup'],
    queryFn: api.cypherPmRollup,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });

  const totals = (rollup.data?.rollup ?? []).reduce(
    (acc, r) => ({
      pending: acc.pending + r.pending,
      in_progress: acc.in_progress + r.in_progress,
      shipped: acc.shipped + r.shipped,
      blocked: acc.blocked + r.blocked,
      deferred: acc.deferred + r.deferred,
      total: acc.total + r.total,
    }),
    { pending: 0, in_progress: 0, shipped: 0, blocked: 0, deferred: 0, total: 0 },
  );
  const shipPct = totals.total > 0 ? totals.shipped / totals.total : 0;

  return (
    <Card>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <GitBranch size={12} className="text-[var(--accent)]" />
        <h2 className="text-xs font-semibold text-[var(--fg)]">Project state</h2>
        <span className="text-xs text-[var(--muted)]">work_items + stuck-pending sweep</span>
      </div>

      {/* Visual progress bar — shipped/total as a single horizontal */}
      <div className="px-3 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-baseline justify-between mb-1.5">
          <div className="text-xs text-[var(--muted)]">
            <span className="font-mono text-[var(--fg)] font-semibold">{totals.shipped}</span>
            <span> / </span>
            <span className="font-mono">{totals.total}</span>
            <span className="ml-1">shipped</span>
            <span className="ml-2 font-mono text-emerald-500">{Math.round(shipPct * 100)}%</span>
          </div>
          <div className="text-[10px] font-mono text-[var(--muted)]">
            {totals.in_progress} in-progress · {totals.pending} pending · {totals.blocked} blocked · {totals.deferred} deferred
          </div>
        </div>
        <div className="h-1.5 w-full bg-[var(--bg-3)] rounded-sm overflow-hidden flex">
          <div className="bg-emerald-500" style={{ width: `${shipPct * 100}%` }} />
          <div className="bg-[var(--accent)]/70" style={{ width: `${(totals.in_progress / Math.max(1, totals.total)) * 100}%` }} />
          <div className="bg-amber-500/40" style={{ width: `${(totals.blocked / Math.max(1, totals.total)) * 100}%` }} />
        </div>
      </div>

      <StalePendingPane />
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Stale-pending sweep (slice 82a-1) — refined UX
// ════════════════════════════════════════════════════════════════════════════

function StalePendingPane() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['cypher-stale', 2, 50],
    queryFn: () => api.cypherStale(2, 50),
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const sweep = useMutation({
    mutationFn: ({ ids, outcome }: { ids: string[]; outcome: 'mixed' | 'failed' }) =>
      api.cypherSweep(ids, outcome),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['cypher-stale'] });
      qc.invalidateQueries({ queryKey: ['cypher-priors'] });
      qc.invalidateQueries({ queryKey: ['cypher-sessions'] });
    },
  });

  const stale = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const allSelected = stale.length > 0 && stale.every(s => selected.has(s.session_id));

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <Clock size={12} className="text-[var(--muted)]" />
        <span className="text-xs font-semibold text-[var(--fg)]">Stuck sessions</span>
        <span className="text-xs text-[var(--muted)]">pending &gt; 2h</span>
        <span className="ml-auto font-mono text-xs">
          {total === 0 ? (
            <span className="text-emerald-500 inline-flex items-center gap-1">
              <CheckCircle2 size={10} /> clear
            </span>
          ) : (
            <span className="text-amber-500">{total} stuck</span>
          )}
        </span>
      </div>

      {isLoading && <SkeletonLines count={3} />}

      {!isLoading && total > 0 && (
        <>
          <div className="flex items-center gap-1.5 px-3 pb-2">
            <button
              type="button"
              onClick={() => {
                if (allSelected) setSelected(new Set());
                else setSelected(new Set(stale.map(s => s.session_id)));
              }}
              className="text-[10px] px-1.5 py-0.5 rounded-sm border border-[var(--border)] hover:bg-[var(--bg-3)] font-mono"
            >
              {allSelected ? 'deselect all' : `select all (${total})`}
            </button>
            {selected.size > 0 && (
              <span className="text-[10px] text-[var(--muted)] font-mono ml-1">
                {selected.size} selected
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                disabled={selected.size === 0 || sweep.isPending}
                onClick={() => sweep.mutate({ ids: [...selected], outcome: 'mixed' })}
                className="text-[10px] px-2 py-0.5 rounded-sm border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-mono"
              >
                mark mixed
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || sweep.isPending}
                onClick={() => sweep.mutate({ ids: [...selected], outcome: 'failed' })}
                className="text-[10px] px-2 py-0.5 rounded-sm border border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-mono"
              >
                mark failed
              </button>
            </div>
          </div>

          {sweep.isError && (
            <div className="px-3 pb-2 text-xs text-[var(--danger)]">
              Sweep failed: {(sweep.error as Error).message}
            </div>
          )}

          <div className="border-t border-[var(--border)] max-h-80 overflow-y-auto">
            {stale.map((s, idx) => (
              <label
                key={s.session_id}
                className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-3)] border-b border-[var(--border)] last:border-0 ${
                  idx % 2 === 1 ? 'bg-[var(--bg)]' : ''
                } ${selected.has(s.session_id) ? 'bg-[var(--accent)]/5' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.session_id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(s.session_id);
                    else next.delete(s.session_id);
                    setSelected(next);
                  }}
                  className="mt-0.5 flex-shrink-0"
                />
                <div className="flex-1 min-w-0 text-xs">
                  <div className="font-mono text-[var(--fg)] truncate" title={s.goal}>{s.goal}</div>
                  <div className="text-[10px] text-[var(--muted)] font-mono mt-0.5">
                    <span className="text-amber-500" title={s.started_at}>{relativeTime(s.started_at)}</span>
                    <span> · {s.task_class ?? '*'}</span>
                    {s.chosen_skill && <span> · {s.chosen_skill}</span>}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Right rail: Catalog (collapsed by default — quieter reference)
// ════════════════════════════════════════════════════════════════════════════

function CatalogSection() {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<'' | 'wi' | 'global' | 'plugin'>('');
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['cypher-skill-catalog'],
    queryFn: api.cypherSkillCatalog,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });

  const filtered = (data?.skills ?? []).filter(s => {
    if (filter && s.source !== filter) return false;
    if (search && !s.skill_name.toLowerCase().includes(search.toLowerCase()) &&
        !(s.description ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 px-3 py-2 w-full hover:bg-[var(--bg-3)] transition-colors text-left"
      >
        <BookOpen size={12} className="text-[var(--accent)]" />
        <h2 className="text-xs font-semibold text-[var(--fg)]">Catalog</h2>
        <span className="ml-auto inline-flex items-center gap-1.5">
          {data && (
            <span className="text-[10px] text-[var(--muted)] font-mono">
              <span className="text-[var(--fg)] font-semibold">{data.total}</span>
              <span> · </span>
              <span className="text-emerald-500">{data.in_priors_count} used</span>
            </span>
          )}
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)]">
          {isLoading && <SkeletonLines count={4} />}
          {error && <div className="px-3 py-2 text-xs text-[var(--danger)]">Failed: {(error as Error).message}</div>}
          {data && (
            <>
              <div className="grid grid-cols-3 gap-px bg-[var(--border)] border-b border-[var(--border)]">
                <SourceBadge label="wi" count={data.by_source.wi} active={filter === 'wi' || filter === ''} onClick={() => setFilter(filter === 'wi' ? '' : 'wi')} />
                <SourceBadge label="global" count={data.by_source.global} active={filter === 'global' || filter === ''} onClick={() => setFilter(filter === 'global' ? '' : 'global')} />
                <SourceBadge label="plugin" count={data.by_source.plugin} active={filter === 'plugin' || filter === ''} onClick={() => setFilter(filter === 'plugin' ? '' : 'plugin')} />
              </div>

              <div className="px-3 py-2 border-b border-[var(--border)]">
                <div className="relative">
                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="filter skills…"
                    className="w-full text-xs bg-[var(--bg)] border border-[var(--border)] rounded-sm pl-7 pr-2 py-1 focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--muted)] font-mono"
                  />
                </div>
              </div>

              <div className="max-h-96 overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-[var(--muted)] text-center">
                    No skills match
                  </div>
                ) : (
                  filtered.map((row, idx) => (
                    <CatalogEntry key={row.skill_name} row={row} zebra={idx % 2 === 1} />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function SourceBadge({
  label, count, active, onClick,
}: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-1.5 text-[10px] uppercase tracking-wider transition-colors ${
        active ? 'bg-[var(--bg-2)] text-[var(--fg)]' : 'bg-[var(--bg-3)] text-[var(--muted)] hover:text-[var(--fg)]'
      }`}
    >
      <div className="font-semibold">{label}</div>
      <div className="font-mono text-[var(--fg)] text-sm tabular-nums">{count}</div>
    </button>
  );
}

function CatalogEntry({ row, zebra }: { row: CypherCatalogRow; zebra: boolean }) {
  const dotColor = {
    wi: 'bg-emerald-500',
    global: 'bg-[var(--accent)]',
    plugin: 'bg-amber-500',
    builtin: 'bg-[var(--muted)]',
  }[row.source];
  return (
    <div
      className={`px-3 py-1.5 border-b border-[var(--border)] last:border-0 ${zebra ? 'bg-[var(--bg)]' : ''}`}
      title={row.description ?? ''}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0`} />
        <span className="font-mono text-[var(--fg)] truncate">{row.skill_name}</span>
        {row.in_priors && (
          <CheckCircle2 size={10} className="text-emerald-500 flex-shrink-0" aria-label="used by Cypher" />
        )}
      </div>
      {row.description && (
        <div className="text-[10px] text-[var(--muted)] mt-0.5 line-clamp-2 leading-snug pl-3.5">
          {row.description}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Right rail: Learning (collapsed by default — quieter reference)
// ════════════════════════════════════════════════════════════════════════════

function LearningSection() {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['cypher-priors'],
    queryFn: api.cypherPriors,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });

  const sortedPriors = data ? [...data.current].sort((a, b) => b.mean - a.mean) : [];

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 px-3 py-2 w-full hover:bg-[var(--bg-3)] transition-colors text-left"
      >
        <Brain size={12} className="text-[var(--accent)]" />
        <h2 className="text-xs font-semibold text-[var(--fg)]">Priors</h2>
        <span className="ml-auto inline-flex items-center gap-1.5">
          {data && (
            <span className="text-[10px] text-[var(--muted)] font-mono">
              <span className="text-[var(--fg)] font-semibold">{data.current.length}</span>
              <span> tracked</span>
            </span>
          )}
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)]">
          <div className="px-3 py-2 text-[10px] text-[var(--muted)] leading-snug">
            Beta(α,β) per skill × task_class. <span className="text-[var(--fg-2)]">Higher mean = more confidence.</span> Snapshot only — historical curves require schema migration.
          </div>
          {isLoading && <SkeletonLines count={4} />}
          {error && <div className="px-3 py-2 text-xs text-[var(--danger)]">Failed: {(error as Error).message}</div>}
          {data && data.current.length === 0 && (
            <div className="px-3 py-3 text-xs text-[var(--muted)] text-center">
              No priors yet. Cypher learns when /wi-record-outcome closes a session.
            </div>
          )}
          {data && data.current.length > 0 && (
            <div className="max-h-96 overflow-y-auto">
              {sortedPriors.map((p, idx) => {
                const rateRow = data.success_rate.find(r => r.chosen_skill === p.skill_name);
                return <PriorRow key={`${p.skill_name}-${p.task_class}-${idx}`} prior={p} rate={rateRow} zebra={idx % 2 === 1} />;
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function PriorRow({
  prior, rate, zebra,
}: {
  prior: { skill_name: string; task_class: string; alpha: number; beta: number; total_runs: number; mean: number };
  rate: { successes: number; attempts: number; rate: number | null } | undefined;
  zebra: boolean;
}) {
  const meanColor = prior.mean >= 0.7 ? 'text-emerald-500' : prior.mean >= 0.5 ? 'text-[var(--fg)]' : 'text-amber-500';
  return (
    <div className={`px-3 py-1.5 border-b border-[var(--border)] last:border-0 ${zebra ? 'bg-[var(--bg)]' : ''}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-[var(--fg)] truncate flex-1">{prior.skill_name}</span>
        <span className="text-[10px] font-mono text-[var(--muted)]">{prior.task_class}</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <div className="flex-1 h-1 bg-[var(--bg-3)] rounded-sm overflow-hidden">
          <div className="h-full bg-[var(--accent)]" style={{ width: `${prior.mean * 100}%` }} />
        </div>
        <span className={`font-mono text-[10px] tabular-nums ${meanColor}`}>{fmtMean(prior.mean)}</span>
      </div>
      <div className="text-[10px] text-[var(--muted)] font-mono mt-0.5 flex items-center gap-2">
        <span>α {prior.alpha.toFixed(1)}</span>
        <span>β {prior.beta.toFixed(1)}</span>
        <span>·</span>
        <span>{prior.total_runs} runs</span>
        {rate && rate.attempts > 0 && (
          <>
            <span>·</span>
            <span className="text-[var(--fg-2)]">{fmtRate(rate.rate)} ({rate.successes}/{rate.attempts})</span>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Card primitives + skeletons
// ════════════════════════════════════════════════════════════════════════════

function Card({ children }: { children: React.ReactNode }) {
  return <div className="border border-[var(--border)] rounded-sm bg-[var(--bg-2)] overflow-hidden">{children}</div>;
}

function SkeletonLines({ count }: { count: number }) {
  return (
    <div className="px-3 py-2 space-y-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-3 bg-[var(--bg-3)] rounded-sm animate-pulse" style={{ width: `${85 - (i % 3) * 15}%` }} />
      ))}
    </div>
  );
}
