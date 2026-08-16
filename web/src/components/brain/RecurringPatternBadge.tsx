import { CheckCircle2, History, XCircle } from 'lucide-react';

export interface PastOutcome {
  /** Outcome label written by /api/brain/learn (success | failed | abandoned). */
  outcome: string;
  /** Number of prior brain_decisions rows with this outcome + signature. */
  count: number;
  /** Epoch ms of MAX(created_at) across rows in this group (decision-time, not learn-time). */
  last_at: number;
}

interface Props {
  /** Aggregated past outcomes for the current decision's cluster_signature. */
  outcomes: PastOutcome[];
  /** Optional cluster signature for the tooltip (decision_id of the prior cluster). */
  signature?: string;
  className?: string;
}

interface Variant {
  label: (n: number) => string;
  icon: typeof CheckCircle2;
  bg: string;
  color: string;
  border: string;
}

// Three locked variants. Anything outside this map renders the default grey pill
// (e.g. an unfamiliar outcome string from a future migration).
const VARIANTS: Record<string, Variant> = {
  success: {
    label: (n) => `worked ${n} ${n === 1 ? 'time' : 'times'}`,
    icon: CheckCircle2,
    bg: '#064e3b',
    color: '#34d399',
    border: '#065f46',
  },
  failed: {
    label: (n) => `failed ${n} ${n === 1 ? 'time' : 'times'}`,
    icon: XCircle,
    bg: '#450a0a',
    color: '#f87171',
    border: '#7f1d1d',
  },
  abandoned: {
    label: (n) => `tried, abandoned ${n}×`,
    icon: History,
    bg: 'var(--bg-3)',
    color: 'var(--muted)',
    border: 'var(--border)',
  },
};

const DEFAULT_VARIANT: Variant = {
  label: (n) => `${n}×`,
  icon: History,
  bg: 'var(--bg-3)',
  color: 'var(--muted)',
  border: 'var(--border)',
};

function formatLastAt(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return 'unknown';
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

/**
 * Visual feedback for the learning loop (Phase 71-04).
 *
 * Renders one pill per past-outcome group attached to the current decision's
 * cluster_signature. The backend join in /api/brain/decide aggregates prior
 * brain_decisions rows GROUP BY outcome and surfaces them as a synthetic
 * evidence row of source='past_outcome'. DecisionCard consumes that row and
 * passes the outcomes array here.
 *
 * Tooltip shows the prior cluster signature + last decision date so a curious
 * user can chase the source decision; main pill exposes count for trust calibration.
 */
export function RecurringPatternBadge({ outcomes, signature, className }: Props) {
  if (!outcomes || outcomes.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`.trim()}
      data-testid="recurring-pattern-badge"
    >
      <span
        className="text-[9px] uppercase font-semibold tracking-wide"
        style={{ color: 'var(--muted)' }}
      >
        This pattern has been seen before
      </span>
      {outcomes.map((o, i) => {
        const v = VARIANTS[o.outcome] ?? DEFAULT_VARIANT;
        const Icon = v.icon;
        const tooltip = signature
          ? `cluster ${signature} · last ${formatLastAt(o.last_at)}`
          : `last ${formatLastAt(o.last_at)}`;
        return (
          <span
            key={`${o.outcome}-${i}`}
            className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: v.bg, color: v.color, borderColor: v.border }}
            title={tooltip}
            data-outcome={o.outcome}
          >
            <Icon size={10} />
            {v.label(o.count)}
          </span>
        );
      })}
    </div>
  );
}
