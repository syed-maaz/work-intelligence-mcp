import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';

interface Props {
  project?: string;
}

export function VelocityStrip({ project = 'PROJ' }: Props) {
  const { data } = useQuery({
    queryKey: ['jira-velocity', project],
    queryFn: () => api.jiraVelocity(project, 8),
    staleTime: 5 * 60_000,
  });

  const { data: stuckData } = useQuery({
    queryKey: ['jira-stuck', project],
    queryFn: () => api.jiraStuck(project, 3),
    staleTime: 5 * 60_000,
  });

  const stats = data?.stats ?? [];
  if (stats.length === 0) return null;

  const latest = stats[stats.length - 1];
  const avgVelocity = stats.length > 0
    ? (stats.reduce((s, r) => s + r.completed_count, 0) / stats.length).toFixed(1)
    : '—';
  const cycleDays = latest.avg_cycle_time_hours > 0
    ? (latest.avg_cycle_time_hours / 24).toFixed(1)
    : null;
  const stuckCount = stuckData?.count ?? 0;

  const TrendIcon = latest.completed_delta == null ? Minus
    : latest.completed_delta > 0 ? TrendingUp
    : latest.completed_delta < 0 ? TrendingDown
    : Minus;

  const trendColor = latest.completed_delta == null ? 'var(--muted)'
    : latest.completed_delta > 0 ? '#22c55e'
    : latest.completed_delta < 0 ? '#ef4444'
    : 'var(--muted)';

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 text-xs border-b"
      style={{ borderColor: 'var(--border)', color: 'var(--fg-2)', background: 'var(--bg-2)' }}
    >
      <span style={{ color: 'var(--muted)' }}>Sprint velocity</span>

      <span className="flex items-center gap-1 font-medium" style={{ color: 'var(--fg)' }}>
        <TrendIcon size={11} style={{ color: trendColor }} />
        {avgVelocity}/wk
      </span>

      {cycleDays && (
        <>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span>
            Avg cycle: <span className="font-medium" style={{ color: 'var(--fg)' }}>{cycleDays}d</span>
          </span>
        </>
      )}

      {stuckCount > 0 && (
        <>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span className="flex items-center gap-1" style={{ color: '#f59e0b' }}>
            <AlertTriangle size={10} />
            <span className="font-medium">{stuckCount} stuck</span>
          </span>
        </>
      )}
    </div>
  );
}
