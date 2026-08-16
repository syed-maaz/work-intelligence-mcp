/**
 * /cypher/cost — Pipeline vs Loop cost comparison.
 *
 * Phase 5 visibility surface. Backed by GET /api/cypher/cost-comparison.
 * Renders three blocks:
 *
 *   1. Summary strip — v1.4 baseline vs Phase 5 soak window in two cards.
 *      The single most-load-bearing number on the page: avg cost per call,
 *      before and after the loop went live.
 *
 *   2. Daily cost trend — bar chart, last N days. Bar height = total cost.
 *      Anchor line at 2026-06-23 (Phase 5 day 0) separates pre-loop from
 *      soak; bars after the anchor are tinted accent.
 *
 *   3. Engine split table — by day, total / loop_n / legacy_n. Shows
 *      dispatch volume + which engine handled each.
 *
 *   4. Top methods table — top 15 callers by spend in the window. Tells
 *      you where the money actually goes.
 *
 *   5. Loop outcomes table — verdict distribution across all loop
 *      dispatches ever. Phase 5 pass-criteria sanity check at a glance.
 *
 * Updates as the soak accumulates. Stale time 30s — the user is looking
 * at this WHILE dispatching, so faster than the dashboard default.
 */

import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import { BarChart2, Coins, Activity, TrendingUp, Layers, CheckCircle2, AlertTriangle, Info, GitCompare, LineChart, BarChart, History } from 'lucide-react';

type DailyRow = { day: string; cost_total: number; in_tokens: number; out_tokens: number; calls: number };
type DailySplitRow = { day: string; pipeline_cost: number; loop_cost: number; total_cost: number; calls: number };
type HistogramRow = {
  bucket: string; label: string; lo: number; hi: number;
  pipeline_calls: number; pipeline_cost: number;
  loop_calls: number; loop_cost: number;
};
type RecentDispatch = {
  session_id: string;
  started_at: string;
  engine: string;
  goal: string;
  user: string;
  task_class: string | null;
  outcome: string;
  duration_ms: number | null;
  total_tokens: number;
};
type MethodRow = { method: string; calls: number; total_cost: number; avg_cost: number; in_tokens: number; out_tokens: number };
type DispatchRow = { day: string; total: number; loop_n: number; legacy_n: number };
type OutcomeRow = { outcome: string; dispatches: number; avg_duration_ms: number; avg_tokens: number };
type CostResponse = {
  days: number;
  phase5_day0: string;
  daily: DailyRow[];
  daily_split: DailySplitRow[];
  cost_histogram: HistogramRow[];
  recent_dispatches: RecentDispatch[];
  by_method: MethodRow[];
  dispatches: DispatchRow[];
  loop_outcomes: OutcomeRow[];
  summary: {
    v14: { window: string; dispatches: number; total_cost: number; avg_per_call: number };
    phase5: { window: string; dispatches: number; total_cost: number; avg_per_call: number };
  };
};

// Engine palette — committed contrast: amber for the pipeline (past, warm),
// cyan for the loop (future, cool). Both readable on dark + light backgrounds.
const C_PIPELINE = '#e8a14b';
const C_LOOP = '#5fd1c7';

function fmt$(n: number, digits = 4): string {
  return `$${n.toFixed(digits)}`;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * InfoPopover — click-toggle popover anchored to the (i) icon on a
 * section header. Replaces the native browser `title=` attribute used
 * in v1 of this page; that attribute couldn't render structured lines,
 * couldn't surface source citations in monospace, and didn't work on
 * touch screens (hover-only).
 *
 * Content is four named slots with a fixed visual order:
 *
 *   What     — one short sentence: what this panel shows.
 *   Look for — one short sentence: heuristic for "is this good/bad?".
 *   Caveat   — one short sentence (optional): known data-quality gotcha.
 *   Source   — SQL fragment / endpoint field in monospace.
 *
 * Each slot is one row in a compact two-column key/value grid. The
 * popover closes on outside-click or Escape — standard popover UX.
 *
 * Convention codified in .claude/rules/react-ui.md § "Self-documenting
 * sections — (i) icon on every panel" — apply to every section header
 * on every dashboard / admin / Cypher / metrics page.
 */
export function InfoPopover({
  what,
  lookFor,
  caveat,
  source,
}: {
  what: string;
  lookFor: string;
  caveat?: string;
  source: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center rounded-full transition-colors"
        style={{
          width: 18,
          height: 18,
          background: open ? 'var(--bg-3)' : 'transparent',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          color: open ? 'var(--accent)' : 'var(--muted)',
          cursor: 'pointer',
        }}
        aria-label="What is this section?"
        aria-expanded={open}
        title="What is this section?"
      >
        <Info size={10} />
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute z-50 rounded-lg shadow-xl"
          style={{
            top: 'calc(100% + 6px)',
            right: 0,
            width: 340,
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          }}
        >
          <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
            <Info size={11} style={{ color: 'var(--accent)' }} />
            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg)' }}>
              About this section
            </span>
          </div>
          <dl className="px-3 py-2 space-y-1.5 text-[11px]" style={{ color: 'var(--fg-2)' }}>
            <div className="grid grid-cols-[auto_1fr] gap-x-2">
              <dt className="font-semibold text-[10px] uppercase tracking-wide pt-0.5" style={{ color: 'var(--muted)' }}>What</dt>
              <dd style={{ color: 'var(--fg)' }}>{what}</dd>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-2">
              <dt className="font-semibold text-[10px] uppercase tracking-wide pt-0.5" style={{ color: 'var(--muted)' }}>Look for</dt>
              <dd style={{ color: 'var(--fg)' }}>{lookFor}</dd>
            </div>
            {caveat && (
              <div className="grid grid-cols-[auto_1fr] gap-x-2">
                <dt className="font-semibold text-[10px] uppercase tracking-wide pt-0.5" style={{ color: 'var(--danger)' }}>Caveat</dt>
                <dd style={{ color: 'var(--fg)' }}>{caveat}</dd>
              </div>
            )}
            <div className="grid grid-cols-[auto_1fr] gap-x-2 pt-1 mt-1 border-t" style={{ borderColor: 'var(--border)' }}>
              <dt className="font-semibold text-[10px] uppercase tracking-wide pt-0.5" style={{ color: 'var(--muted)' }}>Source</dt>
              <dd className="font-mono text-[10px] leading-snug break-all" style={{ color: 'var(--accent)' }}>{source}</dd>
            </div>
          </dl>
        </div>
      )}
    </span>
  );
}

export default function CypherCostPage() {
  const { data, isLoading, error } = useQuery<CostResponse>({
    queryKey: ['cypher-cost-comparison', 14],
    queryFn: async () => {
      const r = await fetch('/api/cypher/cost-comparison?days=14');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  if (isLoading) {
    return (
      <div className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
        Loading cost comparison…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="px-3 py-2 text-xs flex items-center gap-1.5" style={{ color: 'var(--danger)' }}>
        <AlertTriangle size={12} />
        Cost comparison endpoint failed: {String(error)}
      </div>
    );
  }

  const maxCost = Math.max(...data.daily.map((d) => d.cost_total), 0.0001);
  const maxMethodCost = Math.max(...data.by_method.map((m) => m.total_cost), 0.0001);

  // Phase 5 cost gate values from plan § 5.4
  const TARGET_AVG = 0.5;
  const TARGET_P95 = 1.0;

  // Compute p95 from the by_method.avg_cost distribution (rough proxy —
  // real p95 would need per-call cost rows; this is "where does the
  // tail of method-level avg cost sit").
  const sortedAvgs = [...data.by_method.map((m) => m.avg_cost)].sort((a, b) => a - b);
  const p95Idx = Math.floor(sortedAvgs.length * 0.95);
  const p95 = sortedAvgs[p95Idx] ?? 0;

  return (
    <div className="space-y-3 max-w-6xl w-full animate-fade-in">
      {/* ── 1. Summary strip — the headline numbers ─────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* v1.4 baseline card */}
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
          <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
            <Layers size={12} style={{ color: 'var(--muted)' }} />
            <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>v1.4 Pipeline (baseline)</h2>
            <InfoPopover
              what="Pre-loop Anthropic spend over the last 14 days. The reference point — what we spent before ADR-037."
              lookFor="The avg/call number — the per-call cost the loop must not exceed by more than ~10x. Phase 5 gate is $0.50/call on loop dispatches."
              caveat="Aggregates ALL methods (updateNotebook, extractCalendarFromMessages, chatWithContext, etc.). Not isolated to /wi calls."
              source="token_usage WHERE recorded_at < phase5_day0"
            />
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{data.summary.v14.window}</span>
          </div>
          <div className="grid grid-cols-3 divide-x" style={{ borderColor: 'var(--border)' }}>
            <div className="px-3 py-2 text-center">
              <p className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{data.summary.v14.dispatches}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>API calls</p>
            </div>
            <div className="px-3 py-2 text-center">
              <p className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{fmt$(data.summary.v14.total_cost, 2)}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>total cost</p>
            </div>
            <div className="px-3 py-2 text-center">
              <p className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{fmt$(data.summary.v14.avg_per_call, 5)}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>avg / call</p>
            </div>
          </div>
        </div>

        {/* Phase 5 soak card */}
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--accent)' }}>
          <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
            <Activity size={12} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>ADR-037 Loop (Phase 5 soak)</h2>
            <InfoPopover
              what="Anthropic spend since Phase 5 day-0 (when CYPHER_LOOP_ENABLED=1 was flipped in dev .env). Side-by-side with v1.4 so per-call cost is directly comparable."
              lookFor="avg/call within ~10x of v1.4. Call count accumulating over time (a stagnant counter means /wi isn't being used). Total cost rising sublinearly with dispatches — cache hits should reduce marginal cost."
              caveat="Includes smoke-test probes (confirm_mode='reject') which cost $0. Real /wi calls are only a subset."
              source="token_usage WHERE recorded_at >= phase5_day0"
            />
            <span className="text-[10px]" style={{ color: 'var(--accent)' }}>{data.summary.phase5.window}</span>
          </div>
          <div className="grid grid-cols-3 divide-x" style={{ borderColor: 'var(--border)' }}>
            <div className="px-3 py-2 text-center">
              <p className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>{data.summary.phase5.dispatches}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>API calls</p>
            </div>
            <div className="px-3 py-2 text-center">
              <p className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>{fmt$(data.summary.phase5.total_cost, 4)}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>total cost</p>
            </div>
            <div className="px-3 py-2 text-center">
              <p className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>{fmt$(data.summary.phase5.avg_per_call, 5)}</p>
              <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>avg / call</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Phase 5 gate panel ────────────────────────────────────────── */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
          <CheckCircle2 size={12} style={{ color: 'var(--accent)' }} />
          <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Phase 5 pass-criteria gate</h2>
          <InfoPopover
            what="Live scoreboard against the four numeric gates from execution plan § 5.4. The Phase 6 PR cannot open until all four show ✓."
            lookFor="Hourglass (⧗) = counter not yet at target. ✓ = gate cleared. ✗ = stop condition fired — flag off, root-cause, re-spike."
            caveat="Dispatch counter includes smoke-test probes; real /wi rate is lower. p95 is from method-level avg-cost distribution (rough proxy for true per-call p95)."
            source="execution plan § 5.4 + in-memory p95 proxy"
          />
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>plan § 5.4</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x" style={{ borderColor: 'var(--border)' }}>
          <div className="px-3 py-2 text-center">
            <p className="text-xs font-semibold flex items-center justify-center gap-1" style={{
              color: data.summary.phase5.dispatches >= 20 ? 'var(--accent)' : 'var(--muted)',
            }}>
              {data.summary.phase5.dispatches >= 20 ? '✓' : '⧗'} {data.summary.phase5.dispatches} / 20
            </p>
            <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>dispatches</p>
          </div>
          <div className="px-3 py-2 text-center">
            <p className="text-xs font-semibold flex items-center justify-center gap-1" style={{
              color: data.summary.phase5.avg_per_call <= TARGET_AVG ? 'var(--accent)' : 'var(--danger)',
            }}>
              {data.summary.phase5.avg_per_call <= TARGET_AVG ? '✓' : '✗'} {fmt$(data.summary.phase5.avg_per_call, 4)}
            </p>
            <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>avg ≤ {fmt$(TARGET_AVG, 2)}</p>
          </div>
          <div className="px-3 py-2 text-center">
            <p className="text-xs font-semibold flex items-center justify-center gap-1" style={{
              color: p95 < TARGET_P95 ? 'var(--accent)' : 'var(--danger)',
            }}>
              {p95 < TARGET_P95 ? '✓' : '✗'} {fmt$(p95, 4)}
            </p>
            <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>p95 &lt; {fmt$(TARGET_P95, 2)}</p>
          </div>
          <div className="px-3 py-2 text-center">
            <p className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>hand-judgment</p>
            <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>surface quality</p>
          </div>
        </div>
      </div>

      {/* ── ✦ Visual comparison — engine-tagged charts (Phase 5 visibility) ── */}
      {/* Editorial precision: amber=pipeline (past, warm) vs cyan=loop (future, cool). */}

      <VisualComparisonHeader />

      {/* 2a. Stacked daily cost split — pipeline vs loop, per day */}
      <StackedDailyCostChart data={data} />

      {/* 2b. Cumulative spend twin-line — diverging lines tell the story */}
      <CumulativeSpendChart data={data} />

      {/* 2c. Per-call cost distribution histogram — mirrored side-by-side bars */}
      <CostHistogramChart data={data} />

      {/* 2d. Last 20 dispatches ledger — engine-tagged spot-check */}
      <RecentDispatchesLedger data={data} />

      {/* ── 2. Daily cost trend bar chart ────────────────────────────── */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
          <BarChart2 size={12} style={{ color: 'var(--accent)' }} />
          <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Daily cost trend</h2>
          <InfoPopover
            what="Total Anthropic spend per day across ALL methods. Accent-tinted bars are Phase 5 day-0 onward (soak window); gray bars are pre-loop baseline."
            lookFor="Accent-tinted bars should stay roughly comparable to gray bars at similar usage levels. A 5x+ spike on soak days vs pre-loop days at similar /wi volume signals the loop is structurally expensive."
            caveat="MIXES cron-driven methods (updateNotebook, extractCalendarFromMessages) with /wi dispatches. Big bars on either side can be cron, not Cypher."
            source="token_usage GROUP BY date(recorded_at)"
          />
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>last {data.days} days · bars accent-tinted from Phase 5 day-0 ({data.phase5_day0})</span>
        </div>
        <div className="px-3 pt-3 pb-2 flex items-end gap-1.5" style={{ height: 120 }}>
          {data.daily.map((d) => {
            const isSoak = d.day >= data.phase5_day0;
            const heightPct = maxCost > 0 ? (d.cost_total / maxCost) * 100 : 0;
            return (
              <div
                key={d.day}
                className="flex flex-col items-center gap-1 flex-1"
                title={`${d.day} · ${d.calls} calls · ${fmt$(d.cost_total, 4)}`}
              >
                <span className="text-[8px] font-mono" style={{ color: 'var(--muted)' }}>{fmt$(d.cost_total, 2)}</span>
                <div
                  className="w-full rounded-sm"
                  style={{
                    height: `${Math.max(heightPct, 2)}%`,
                    maxHeight: 80,
                    minHeight: 2,
                    background: isSoak ? 'var(--accent)' : 'var(--bg-3)',
                    border: `1px solid ${isSoak ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                />
                <span className="text-[9px]" style={{ color: isSoak ? 'var(--accent)' : 'var(--muted)' }}>
                  {d.day.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 3. Engine split + 4. Top methods ─────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Engine split */}
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
          <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
            <TrendingUp size={12} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Dispatches by engine (last {data.days} days)</h2>
            <InfoPopover
              what="cypher_sessions row counts per day, split by the `engine` column (loop vs legacy pipeline)."
              lookFor="loop column should be rising; legacy column should be 0 (or near-zero) post Phase 5 day-0."
              caveat="The v67 migration backfilled engine='loop' as default for ALL pre-existing rows. So days before 2026-06-22 falsely show loop_n=total, legacy_n=0. Only post-2026-06-22 rows reflect the real engine choice."
              source="cypher_sessions GROUP BY date(started_at)"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead style={{ background: 'var(--bg-3)' }}>
                <tr>
                  <th className="px-3 py-1.5 text-left font-semibold" style={{ color: 'var(--muted)' }}>day</th>
                  <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>total</th>
                  <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--accent)' }}>loop</th>
                  <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>legacy</th>
                </tr>
              </thead>
              <tbody>
                {data.dispatches.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-1.5 text-center" style={{ color: 'var(--muted)' }}>no dispatches in window</td></tr>
                ) : (
                  data.dispatches.map((d) => (
                    <tr key={d.day} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--fg)' }}>{d.day}</td>
                      <td className="px-3 py-1.5 text-right" style={{ color: 'var(--fg)' }}>{d.total}</td>
                      <td className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--accent)' }}>{d.loop_n}</td>
                      <td className="px-3 py-1.5 text-right" style={{ color: 'var(--muted)' }}>{d.legacy_n}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top methods */}
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
          <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
            <Coins size={12} style={{ color: 'var(--accent)' }} />
            <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Top spend by method (last {data.days} days)</h2>
            <InfoPopover
              what="Top 15 Anthropic callers ranked by total spend in the window. Each row is one `method` value (the per-call-site label AIAnalyzer uses when writing token_usage)."
              lookFor="If `runLoop` or `runCypher` appears in the top 3, the loop is now the biggest cost driver — Phase 5 cost gate is at risk. If `updateNotebook` and `extractCalendarFromMessages` are still on top, the loop is cheap relative to cron-driven work."
              caveat="avg/call is across the method's whole call distribution, including cache-hit fast paths. p95 (not shown) would be higher. The horizontal bar normalizes to the top entry."
              source="token_usage GROUP BY method ORDER BY SUM(cost_usd)"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead style={{ background: 'var(--bg-3)' }}>
                <tr>
                  <th className="px-3 py-1.5 text-left font-semibold" style={{ color: 'var(--muted)' }}>method</th>
                  <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>calls</th>
                  <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>total</th>
                  <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>avg</th>
                </tr>
              </thead>
              <tbody>
                {data.by_method.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-1.5 text-center" style={{ color: 'var(--muted)' }}>no calls in window</td></tr>
                ) : (
                  data.by_method.map((m) => {
                    const widthPct = (m.total_cost / maxMethodCost) * 100;
                    return (
                      <tr key={m.method} className="border-t" style={{ borderColor: 'var(--border)' }}>
                        <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--fg)' }}>
                          <div className="flex items-center gap-2">
                            <span className="flex-1">{m.method}</span>
                            <div className="flex-shrink-0 w-12 h-1 rounded-sm" style={{
                              background: `linear-gradient(to right, var(--accent) ${widthPct}%, var(--bg-3) ${widthPct}%)`,
                            }} />
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right" style={{ color: 'var(--fg)' }}>{m.calls}</td>
                        <td className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--fg)' }}>{fmt$(m.total_cost, 4)}</td>
                        <td className="px-3 py-1.5 text-right" style={{ color: 'var(--muted)' }}>{fmt$(m.avg_cost, 5)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── 5. Loop outcomes ──────────────────────────────────────────── */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
          <Info size={12} style={{ color: 'var(--accent)' }} />
          <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Loop dispatch outcomes (all time)</h2>
          <InfoPopover
            what="Verdict distribution across all cypher_sessions rows with engine='loop'. Six outcomes plus (open) for rows that haven't terminated."
            lookFor="success > mixed > failed, ideally. Lots of (open) = dispatches starting but not closing; could be the bridge crashing mid-loop. Lots of failed = tool errors escaping. avg_duration > 30s is a red flag for runaway loops."
            caveat="v67 backfilled engine='loop' on pre-existing rows so the (open) bucket is inflated by pre-Phase-3 sessions that predate the loop. Real loop dispatches start from 2026-06-22 onward."
            source="cypher_sessions WHERE engine='loop' GROUP BY outcome"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--bg-3)' }}>
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold" style={{ color: 'var(--muted)' }}>outcome</th>
                <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>dispatches</th>
                <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>avg duration</th>
                <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>avg tokens</th>
              </tr>
            </thead>
            <tbody>
              {data.loop_outcomes.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-1.5 text-center" style={{ color: 'var(--muted)' }}>no loop dispatches yet</td></tr>
              ) : (
                data.loop_outcomes.map((o) => (
                  <tr key={o.outcome} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--fg)' }}>{o.outcome}</td>
                    <td className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--fg)' }}>{o.dispatches}</td>
                    <td className="px-3 py-1.5 text-right" style={{ color: 'var(--muted)' }}>{(o.avg_duration_ms / 1000).toFixed(1)}s</td>
                    <td className="px-3 py-1.5 text-right" style={{ color: 'var(--muted)' }}>{fmtK(o.avg_tokens)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Help text ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border px-3 py-2 text-[11px]" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--muted)' }}>
        <strong style={{ color: 'var(--fg)' }}>Phase 5 protocol:</strong> let the loop accumulate ≥20 dispatches with avg ≤ ${TARGET_AVG} / call and p95 &lt; ${TARGET_P95} / call before flipping
        the Phase 6 default in <code style={{ background: 'var(--bg-3)', padding: '1px 4px', borderRadius: 2 }}>web-server.js</code>. Bars after the Phase 5 day-0 anchor ({data.phase5_day0}) are tinted accent
        to call out which days contributed to the soak window. Daily-trend cost reflects ALL Anthropic calls (not just loop) — use the dispatches table to isolate engine='loop' rows.
        Raw data:{' '}
        <code style={{ background: 'var(--bg-3)', padding: '1px 4px', borderRadius: 2 }}>bash scripts/cost-compare.sh</code>.
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Visual comparison section components — editorial precision design
// ────────────────────────────────────────────────────────────────────────

/**
 * Section divider that opens the visual-comparison block. A single
 * horizontal-rule + heading + legend strip sets the tone for everything
 * that follows: amber = pipeline (past), cyan = loop (future). Used as a
 * navigational anchor; the four charts below all reference this palette.
 */
function VisualComparisonHeader() {
  return (
    <div className="rounded-xl border overflow-hidden" style={{
      background: `linear-gradient(135deg, ${C_PIPELINE}11 0%, ${C_LOOP}11 100%)`,
      borderColor: 'var(--border)',
    }}>
      <div className="px-4 py-3 flex items-center gap-3">
        <GitCompare size={14} style={{ color: 'var(--fg)' }} />
        <div className="flex-1">
          <h2 className="text-sm font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>
            Visual comparison
          </h2>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>
            Pipeline vs Loop · four lenses · pre / post Phase 5 day-0 anchor
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px]" style={{ color: 'var(--fg-2)' }}>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C_PIPELINE }} />
            pipeline
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: C_LOOP }} />
            loop
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * 2a — Stacked daily cost bar chart.
 *
 * One bar per day, two stacked segments: pipeline (amber) on the bottom
 * + loop (cyan) on top. Bar height = total cost; segment proportions
 * reveal which engine drove the day's spend.
 */
function StackedDailyCostChart({ data }: { data: CostResponse }) {
  const split = data.daily_split;
  const maxTotal = Math.max(...split.map((d) => d.total_cost), 0.0001);

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <BarChart size={12} style={{ color: 'var(--accent)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Daily cost — engine split</h2>
        <InfoPopover
          what="One bar per day. Bottom segment (amber) is pipeline-attributed cost; top segment (cyan) is loop-attributed cost. Bar height = total daily spend."
          lookFor="On Phase 5 soak days (2026-06-23+), cyan should dominate — that's the loop running. If amber persists on soak days, the legacy pipeline is still active (env flag not actually flipped). A single day's bar 5x+ larger than its neighbors warrants investigation."
          caveat="token_usage rows aren't joined to cypher_sessions today, so engine is approximated by date relative to the Phase 5 day-0 anchor (2026-06-23). Pre-anchor = pipeline; post-anchor = loop. Cron-driven methods count toward the engine of the day they ran."
          source="/api/cypher/cost-comparison.daily_split"
        />
        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>last {data.days} days</span>
      </div>
      <div className="px-3 pt-4 pb-2 flex items-end gap-1" style={{ height: 140 }}>
        {split.map((d) => {
          const pipelinePct = maxTotal > 0 ? (d.pipeline_cost / maxTotal) * 100 : 0;
          const loopPct = maxTotal > 0 ? (d.loop_cost / maxTotal) * 100 : 0;
          const isAnchor = d.day === data.phase5_day0;
          return (
            <div
              key={d.day}
              className="flex flex-col items-stretch gap-1 flex-1 relative"
              title={`${d.day} · pipeline ${fmt$(d.pipeline_cost, 4)} · loop ${fmt$(d.loop_cost, 4)} · ${d.calls} calls`}
            >
              <div className="flex flex-col items-stretch justify-end" style={{ height: 90, gap: 1 }}>
                {/* Loop segment — top */}
                {d.loop_cost > 0 && (
                  <div style={{
                    height: `${Math.max(loopPct, 1.5)}%`,
                    background: C_LOOP,
                    borderTopLeftRadius: 2,
                    borderTopRightRadius: 2,
                    transition: 'height 0.3s ease',
                  }} />
                )}
                {/* Pipeline segment — bottom */}
                {d.pipeline_cost > 0 && (
                  <div style={{
                    height: `${Math.max(pipelinePct, 1.5)}%`,
                    background: C_PIPELINE,
                    borderTopLeftRadius: d.loop_cost > 0 ? 0 : 2,
                    borderTopRightRadius: d.loop_cost > 0 ? 0 : 2,
                    borderBottomLeftRadius: 2,
                    borderBottomRightRadius: 2,
                    transition: 'height 0.3s ease',
                  }} />
                )}
                {d.pipeline_cost === 0 && d.loop_cost === 0 && (
                  <div style={{
                    height: '2%',
                    background: 'var(--bg-3)',
                    borderRadius: 2,
                  }} />
                )}
              </div>
              <span className="text-[8px] text-center font-mono" style={{
                color: isAnchor ? C_LOOP : 'var(--muted)',
                fontWeight: isAnchor ? 600 : 400,
              }}>
                {d.day.slice(5)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 2b — Cumulative spend twin-line chart (SVG).
 *
 * Two lines on the same axis: pipeline cumulative cost vs loop cumulative
 * cost over the window. If the lines diverge, one engine costs more
 * cumulatively. Hand-drawn SVG, no library; animates polyline length on
 * mount via stroke-dasharray.
 */
function CumulativeSpendChart({ data }: { data: CostResponse }) {
  const split = data.daily_split;
  if (split.length === 0) return null;

  // Compute running totals per engine.
  let pipelineCum = 0;
  let loopCum = 0;
  const cumulative = split.map((d) => {
    pipelineCum += d.pipeline_cost;
    loopCum += d.loop_cost;
    return { day: d.day, pipeline: pipelineCum, loop: loopCum };
  });

  const W = 600;
  const H = 140;
  const PAD = 24;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const maxCum = Math.max(pipelineCum, loopCum, 0.0001);
  const xStep = innerW / Math.max(cumulative.length - 1, 1);

  const pointsFor = (key: 'pipeline' | 'loop') =>
    cumulative
      .map((c, i) => `${PAD + i * xStep},${PAD + innerH - (c[key] / maxCum) * innerH}`)
      .join(' ');

  // Anchor x-position (Phase 5 day 0).
  const anchorIdx = cumulative.findIndex((c) => c.day >= data.phase5_day0);
  const anchorX = anchorIdx >= 0 ? PAD + anchorIdx * xStep : null;

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <LineChart size={12} style={{ color: 'var(--accent)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Cumulative spend — twin lines</h2>
        <InfoPopover
          what="Running cumulative spend across the window for each engine. Amber line = pipeline, cyan line = loop. Vertical dashed line marks Phase 5 day-0."
          lookFor="Lines tracking parallel = engines costing the same. Lines diverging after the anchor = one engine pulling ahead. Cyan steeper than amber after the anchor = the loop is more expensive than the pipeline was at the same usage volume."
          caveat="Same engine-attribution caveat as the stacked chart — engine is approximated by date relative to the anchor. The cyan line is 0 before the anchor by construction."
          source="/api/cypher/cost-comparison.daily_split (running sum)"
        />
        <span className="text-[10px] flex items-center gap-2" style={{ color: 'var(--muted)' }}>
          <span>pipeline {fmt$(pipelineCum, 2)}</span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span style={{ color: C_LOOP }}>loop {fmt$(loopCum, 4)}</span>
        </span>
      </div>
      <div className="px-3 pt-3 pb-2">
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block' }}>
          {/* Grid: 4 horizontal lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
            <line
              key={i}
              x1={PAD} x2={W - PAD}
              y1={PAD + innerH * (1 - t)} y2={PAD + innerH * (1 - t)}
              stroke="var(--border)"
              strokeWidth="0.5"
              strokeDasharray={t === 0 || t === 1 ? undefined : '2,3'}
            />
          ))}

          {/* Y-axis tick labels */}
          {[0, 0.5, 1].map((t, i) => (
            <text
              key={i}
              x={PAD - 4}
              y={PAD + innerH * (1 - t) + 3}
              textAnchor="end"
              fontSize="8"
              fill="var(--muted)"
              fontFamily="monospace"
            >
              ${(maxCum * t).toFixed(t === 0 ? 0 : 2)}
            </text>
          ))}

          {/* Phase 5 day-0 anchor line */}
          {anchorX !== null && (
            <g>
              <line
                x1={anchorX} x2={anchorX}
                y1={PAD} y2={PAD + innerH}
                stroke="var(--muted)"
                strokeWidth="1"
                strokeDasharray="4,3"
                opacity="0.6"
              />
              <text
                x={anchorX + 4}
                y={PAD + 9}
                fontSize="8"
                fill="var(--muted)"
                fontFamily="monospace"
              >
                day 0
              </text>
            </g>
          )}

          {/* Pipeline cumulative line */}
          <polyline
            fill="none"
            stroke={C_PIPELINE}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={pointsFor('pipeline')}
          />
          {/* Pipeline dots at endpoints */}
          <circle cx={PAD} cy={PAD + innerH - (cumulative[0].pipeline / maxCum) * innerH} r="2" fill={C_PIPELINE} />
          <circle cx={PAD + (cumulative.length - 1) * xStep} cy={PAD + innerH - (cumulative[cumulative.length - 1].pipeline / maxCum) * innerH} r="3" fill={C_PIPELINE} />

          {/* Loop cumulative line */}
          <polyline
            fill="none"
            stroke={C_LOOP}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={pointsFor('loop')}
          />
          <circle cx={PAD + (cumulative.length - 1) * xStep} cy={PAD + innerH - (cumulative[cumulative.length - 1].loop / maxCum) * innerH} r="3" fill={C_LOOP} />

          {/* X-axis: first + middle + last day */}
          {[0, Math.floor(cumulative.length / 2), cumulative.length - 1].map((i) => (
            <text
              key={i}
              x={PAD + i * xStep}
              y={H - 4}
              textAnchor="middle"
              fontSize="8"
              fill="var(--muted)"
              fontFamily="monospace"
            >
              {cumulative[i].day.slice(5)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

/**
 * 2c — Per-call cost distribution histogram.
 *
 * Six buckets ($0-0.01 to $1.00+). Each bucket row has two horizontal
 * bars — pipeline left, loop right — both anchored to a shared central
 * baseline. The longer the bar, the more calls fell in that bucket.
 * Mirrored layout makes shape differences visible at a glance.
 */
function CostHistogramChart({ data }: { data: CostResponse }) {
  const hist = data.cost_histogram;
  // Max calls across all buckets+engines — normalizes bar length.
  const maxCalls = Math.max(
    ...hist.map((b) => Math.max(b.pipeline_calls, b.loop_calls)),
    1,
  );

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <BarChart2 size={12} style={{ color: 'var(--accent)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Per-call cost distribution</h2>
        <InfoPopover
          what="Histogram of individual API call cost. Each row is one cost bucket ($0–0.01, $0.01–0.05, …). Amber bar (left) = pipeline call count; cyan bar (right) = loop call count."
          lookFor="Most calls should sit in $0–0.01 and $0.01–0.05 — routine Haiku extraction calls. Any loop activity in $0.50–$1.00 or $1.00+ means individual loop dispatches are expensive — investigate which goals trigger those. Cost gate is $0.50/dispatch; tail-bucket calls indicate trouble."
          caveat="Per-call cost is one Anthropic API call, NOT one /wi dispatch. A heavy dispatch can include 5–10 calls each in the $0.01–$0.05 bucket and still cost $0.50/dispatch total. The histogram doesn't directly read out dispatch cost."
          source="/api/cypher/cost-comparison.cost_histogram"
        />
      </div>
      <div className="px-3 py-3 space-y-1.5">
        {hist.map((b) => {
          const pipelinePct = (b.pipeline_calls / maxCalls) * 100;
          const loopPct = (b.loop_calls / maxCalls) * 100;
          return (
            <div key={b.bucket} className="flex items-center gap-2 text-[10px]">
              {/* Bucket label */}
              <div className="w-24 text-right font-mono" style={{ color: 'var(--fg-2)' }}>
                {b.label}
              </div>

              {/* Pipeline bar — right-anchored on the left half */}
              <div className="flex-1 flex justify-end relative" style={{ height: 14 }}>
                <div
                  className="h-full rounded-sm transition-all"
                  style={{
                    width: `${Math.max(pipelinePct, b.pipeline_calls > 0 ? 1 : 0)}%`,
                    background: C_PIPELINE,
                  }}
                  title={`pipeline · ${b.pipeline_calls} calls · ${fmt$(b.pipeline_cost, 4)}`}
                />
                {b.pipeline_calls > 0 && (
                  <span className="absolute right-1 top-1/2 -translate-y-1/2 font-mono font-semibold text-[9px]" style={{
                    color: pipelinePct > 30 ? 'var(--bg)' : 'var(--fg-2)',
                  }}>
                    {b.pipeline_calls}
                  </span>
                )}
              </div>

              {/* Central divider — visual zero axis */}
              <div className="w-px h-3.5" style={{ background: 'var(--border)' }} />

              {/* Loop bar — left-anchored on the right half */}
              <div className="flex-1 flex justify-start relative" style={{ height: 14 }}>
                <div
                  className="h-full rounded-sm transition-all"
                  style={{
                    width: `${Math.max(loopPct, b.loop_calls > 0 ? 1 : 0)}%`,
                    background: C_LOOP,
                  }}
                  title={`loop · ${b.loop_calls} calls · ${fmt$(b.loop_cost, 4)}`}
                />
                {b.loop_calls > 0 && (
                  <span className="absolute left-1 top-1/2 -translate-y-1/2 font-mono font-semibold text-[9px]" style={{
                    color: loopPct > 30 ? 'var(--bg)' : 'var(--fg-2)',
                  }}>
                    {b.loop_calls}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-3 py-1.5 border-t flex items-center justify-between text-[9px] font-mono" style={{
        borderColor: 'var(--border)',
        color: 'var(--muted)',
      }}>
        <span>← pipeline · {hist.reduce((s, b) => s + b.pipeline_calls, 0)} calls total</span>
        <span>cost gate: $0.50/dispatch (~$0.05/call × 10 calls)</span>
        <span>loop · {hist.reduce((s, b) => s + b.loop_calls, 0)} calls total →</span>
      </div>
    </div>
  );
}

/**
 * 2d — Recent dispatches ledger.
 *
 * Last 20 dispatches across both engines as a tabular row list. Each row
 * carries an engine badge (amber pipeline / cyan loop), the goal, cost +
 * duration, and verdict. Spot-check tool for "which dispatches blew the
 * budget?" — sort by token count and pick the outliers.
 */
function RecentDispatchesLedger({ data }: { data: CostResponse }) {
  const rows = data.recent_dispatches;

  // Outcome color mapping — keep within the project's --danger / --accent palette,
  // not new hues. Engine badge owns the amber/cyan story; outcome stays neutral.
  const outcomeColor = (o: string): string => {
    if (o === 'success') return 'var(--accent)';
    if (o === 'failed') return 'var(--danger)';
    if (o === '(open)') return 'var(--muted)';
    return 'var(--fg-2)'; // mixed, halted, abandoned, rejected_non_interactive
  };

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <History size={12} style={{ color: 'var(--accent)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Recent dispatches ledger (last 20)</h2>
        <InfoPopover
          what="Most recent 20 cypher_sessions rows in chronological-descending order. Each row carries an engine badge (amber pipeline / cyan loop), goal snippet, dispatcher, duration, token count, and outcome verdict."
          lookFor="Outliers — rows where duration_ms > 30s or total_tokens > 50k. Those are heavy dispatches; cross-reference the session id on /cypher to see what tools fired. A cluster of loop rows with outcome='failed' means the loop is breaking on real work."
          caveat="total_tokens is the cypher_sessions tally, which may be 0 for rows that haven't been written-back yet (the loop writes outcome via recordOutcomeSignal, not directly to the session row). Duration NULL means the session is still open."
          source="/api/cypher/cost-comparison.recent_dispatches"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead style={{ background: 'var(--bg-3)' }}>
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold" style={{ color: 'var(--muted)' }}>when</th>
              <th className="px-3 py-1.5 text-left font-semibold" style={{ color: 'var(--muted)' }}>engine</th>
              <th className="px-3 py-1.5 text-left font-semibold" style={{ color: 'var(--muted)' }}>goal</th>
              <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>duration</th>
              <th className="px-3 py-1.5 text-right font-semibold" style={{ color: 'var(--muted)' }}>tokens</th>
              <th className="px-3 py-1.5 text-left font-semibold" style={{ color: 'var(--muted)' }}>outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-center" style={{ color: 'var(--muted)' }}>
                  No dispatches recorded yet.
                </td>
              </tr>
            ) : (
              rows.map((d) => {
                const engineColor = d.engine === 'loop' ? C_LOOP : C_PIPELINE;
                const durationStr = d.duration_ms === null ? '—' : `${(d.duration_ms / 1000).toFixed(1)}s`;
                return (
                  <tr key={d.session_id} className="border-t hover:bg-opacity-50 transition-colors" style={{ borderColor: 'var(--border)' }}>
                    <td className="px-3 py-1.5 font-mono text-[10px]" style={{ color: 'var(--muted)' }}>
                      {d.started_at.slice(5, 16)}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase"
                        style={{
                          background: `${engineColor}22`,
                          color: engineColor,
                          border: `1px solid ${engineColor}44`,
                        }}
                      >
                        <span className="inline-block w-1 h-1 rounded-full" style={{ background: engineColor }} />
                        {d.engine}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 truncate max-w-md" style={{ color: 'var(--fg)' }} title={d.goal}>
                      {d.goal}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono" style={{ color: 'var(--fg-2)' }}>
                      {durationStr}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono" style={{ color: 'var(--fg-2)' }}>
                      {d.total_tokens > 0 ? fmtK(d.total_tokens) : '—'}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10px]" style={{ color: outcomeColor(d.outcome) }}>
                      {d.outcome}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
