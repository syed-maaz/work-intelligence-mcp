import { useQuery } from '@tanstack/react-query';
import { api, TokenStats } from '@/lib/api';
import { BarChart2, Coins, TrendingUp } from 'lucide-react';

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

export function TokenStatsWidget({ days = 30 }: { days?: number }) {
  const { data, isLoading } = useQuery<TokenStats>({
    queryKey: ['token-stats', days],
    queryFn: () => api.tokenStats(days),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading || !data) {
    return (
      <div className="rounded border" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
          <BarChart2 size={12} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Token Usage ({days}d)</span>
        </div>
        <div className="px-3 py-4 text-xs" style={{ color: 'var(--muted)' }}>Loading…</div>
      </div>
    );
  }

  return (
    <div className="rounded border" style={{ borderColor: 'var(--border)' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}>
        <BarChart2 size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Token Usage</span>
        <span className="text-xs ml-1" style={{ color: 'var(--muted)' }}>last {days}d</span>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-4 gap-0 border-b" style={{ borderColor: 'var(--border)' }}>
        {[
          { label: 'Total calls', value: fmt(data.total_calls), icon: <TrendingUp size={10} /> },
          { label: 'Input tokens', value: fmt(data.total_input_tokens), icon: null },
          { label: 'Output tokens', value: fmt(data.total_output_tokens), icon: null },
          { label: 'Est. cost', value: fmtCost(data.total_cost_usd), icon: <Coins size={10} /> },
        ].map(({ label, value, icon }) => (
          <div key={label} className="flex flex-col items-center px-2 py-2 border-r last:border-0" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-1" style={{ color: 'var(--accent)' }}>
              {icon}
              <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{value}</span>
            </div>
            <span className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Cache savings */}
      {data.total_cache_read_tokens > 0 && (
        <div className="px-3 py-1.5 border-b text-xs flex items-center gap-1.5" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
          <span
            className="inline-block px-1.5 py-0.5 rounded text-xs"
            style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981' }}
          >
            cache hit
          </span>
          {fmt(data.total_cache_read_tokens)} tokens read from cache · {fmt(data.total_cache_creation_tokens)} written
        </div>
      )}

      {/* Per-method breakdown */}
      {data.by_method.length > 0 && (
        <div>
          <div className="px-3 py-1.5 text-xs font-semibold border-b" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
            By method
          </div>
          {data.by_method.slice(0, 8).map((row) => (
            <div
              key={row.method}
              className="flex items-center px-3 py-1.5 border-b last:border-0 gap-2"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="text-xs flex-1 truncate font-mono" style={{ color: 'var(--fg-2)' }}>{row.method}</span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{fmt(row.calls)} calls</span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{fmt(row.input_tokens + row.output_tokens)} tok</span>
              <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{fmtCost(row.cost_usd)}</span>
            </div>
          ))}
        </div>
      )}

      {data.total_calls === 0 && (
        <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--muted)' }}>
          No AI calls tracked yet
        </div>
      )}
    </div>
  );
}
