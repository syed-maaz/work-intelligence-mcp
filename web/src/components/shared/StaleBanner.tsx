/**
 * U-14: cross-page stale-data warning.
 *
 * Most read-only AI endpoints (digest, morning-brief, notebooks, weekly-report)
 * already return `stale: true` + `stale_reason` + `cached_at` when their
 * upstream call fails. Until this banner existed, only Topic Expert chose to
 * display that — every other page silently showed cached output, which
 * destroys trust ("why is this answer 4 hours old?").
 *
 * Drop this into any page that consumes a possibly-stale response:
 *
 *   <StaleBanner stale={data.stale} reason={data.stale_reason} cachedAt={data.cached_at} />
 *
 * It renders nothing when `stale` is falsy, so it's always safe to include.
 */

import { Clock } from 'lucide-react';

interface Props {
  stale?: boolean;
  reason?: string | null;
  cachedAt?: string | number | null;
  /** Inline (one-line) vs block (full-width banner). Default: 'block'. */
  variant?: 'inline' | 'block';
  /** warning = amber (default), danger = red for hard failures */
  tone?: 'warning' | 'danger';
  /** Optional trailing control (e.g. Retry) */
  action?: React.ReactNode;
  className?: string;
}

function formatCachedAt(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const TONE_STYLES = {
  warning: {
    bg: 'color-mix(in srgb, #f59e0b 12%, transparent)',
    fg: '#92400e',
    border: 'color-mix(in srgb, #f59e0b 30%, transparent)',
    inlineBg: 'color-mix(in srgb, #f59e0b 18%, transparent)',
  },
  danger: {
    bg: 'color-mix(in srgb, var(--danger) 10%, transparent)',
    fg: 'var(--danger)',
    border: 'color-mix(in srgb, var(--danger) 35%, transparent)',
    inlineBg: 'color-mix(in srgb, var(--danger) 15%, transparent)',
  },
} as const;

export function StaleBanner({
  stale,
  reason,
  cachedAt,
  variant = 'block',
  tone = 'warning',
  action,
  className = '',
}: Props) {
  if (!stale) return null;
  const age = formatCachedAt(cachedAt);
  const reasonText = reason ? ` (${reason})` : '';
  const palette = TONE_STYLES[tone];

  if (variant === 'inline') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
        style={{ background: palette.inlineBg, color: palette.fg }}
        title={`Stale${reasonText}${age ? ` — generated ${age}` : ''}`}
      >
        <Clock size={9} />
        Stale{age ? ` · ${age}` : ''}
      </span>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 text-xs rounded-lg mb-3 ${className}`.trim()}
      style={{
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
      }}
    >
      <Clock size={12} />
      <div className="flex-1 min-w-0">
        <strong>Showing cached version{reason ? ` — ${reason}` : ''}.</strong>
        {age && <span className="ml-1.5 opacity-75">Generated {age}.</span>}
      </div>
      {action}
    </div>
  );
}
