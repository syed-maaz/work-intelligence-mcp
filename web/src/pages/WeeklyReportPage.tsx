import { useQuery } from '@tanstack/react-query';
import { api, WeeklyReport } from '@/lib/api';
import { MarkdownPanel } from '@/components/shared/MarkdownPanel';
import { BarChart2, RefreshCw, AlertTriangle, Lightbulb, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui';
import { StaleBanner } from '@/components/shared/StaleBanner';
import { toastAction } from '@/lib/notifications';
import { useQueryClient } from '@tanstack/react-query';

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div
      className="rounded-xl border px-3 py-2 flex flex-col gap-0.5"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
    >
      <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{label}</p>
      <p className="text-lg font-semibold tabular-nums" style={{ color: 'var(--fg)' }}>{value}</p>
    </div>
  );
}

function PillList({ items, color }: { items: string[]; color: string }) {
  if (!items?.length) return <p className="text-xs" style={{ color: 'var(--muted)' }}>None</p>;
  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 items-start text-xs" style={{ color: 'var(--fg)' }}>
          <span style={{ color }} className="mt-0.5 shrink-0">▸</span>
          {item}
        </li>
      ))}
    </ul>
  );
}

export default function WeeklyReportPage() {
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<WeeklyReport>({
    queryKey: ['weekly-report'],
    queryFn: () => api.weeklyReport(),
    staleTime: 30 * 60 * 1000, // 30 min
  });

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['weekly-report'] });
    toastAction('Refreshing weekly report…');
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 gap-4" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart2 size={16} style={{ color: 'var(--accent)' }} />
          <h1 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Weekly Pattern Analysis</h1>
          {data?.cached && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-3)', color: 'var(--muted)' }}>
              cached
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isLoading}>
          <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
          <span className="ml-1">Refresh</span>
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <RefreshCw size={12} className="animate-spin" />
          Generating weekly report…
        </div>
      )}

      {isError && (
        <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-2)', color: 'var(--danger)' }}>
          {(error as Error).message}
        </div>
      )}

      {data && (
        <>
          <StaleBanner
            stale={data.cached}
            reason="AI generation used cached weekly report"
            cachedAt={data.generatedAt}
          />
          {/* Stats row */}
          {data.stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatCard label="Messages" value={data.stats.totalMessages} />
              <StatCard label="Meetings" value={data.stats.totalMeetings} />
              <StatCard label="Open Actions" value={data.stats.totalActionItems} />
              <StatCard label="Active Topics" value={data.stats.topicsActive} />
            </div>
          )}

          {/* Top topics */}
          {data.stats?.topTopics && data.stats.topTopics.length > 0 && (
            <div
              className="rounded-xl border p-3"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
            >
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--fg)' }}>
                <TrendingUp size={11} className="inline mr-1" />
                Most Active Topics
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.stats.topTopics.map(t => (
                  <span
                    key={t.name}
                    className="text-xs px-2 py-0.5 rounded-full border"
                    style={{ borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--bg-3)' }}
                  >
                    {t.name} · {t.msg_count}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* AI summary */}
          {data.summary && (
            <div
              className="rounded-xl border p-3"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
            >
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--fg)' }}>Summary</p>
              <MarkdownPanel content={data.summary} />
            </div>
          )}

          {/* Three columns: themes / risks / recommendations */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}>
              <p className="text-xs font-semibold mb-2 flex items-center gap-1" style={{ color: 'var(--fg)' }}>
                <TrendingUp size={11} />
                Top Themes
              </p>
              <PillList items={data.topThemes} color="var(--accent)" />
            </div>

            <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}>
              <p className="text-xs font-semibold mb-2 flex items-center gap-1" style={{ color: 'var(--fg)' }}>
                <AlertTriangle size={11} />
                Risks
              </p>
              <PillList items={data.risks} color="var(--danger)" />
            </div>

            <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}>
              <p className="text-xs font-semibold mb-2 flex items-center gap-1" style={{ color: 'var(--fg)' }}>
                <Lightbulb size={11} />
                Recommendations
              </p>
              <PillList items={data.recommendations} color="var(--muted)" />
            </div>
          </div>

          {data.generatedAt && (
            <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
              Generated {new Date(data.generatedAt).toLocaleString()}
            </p>
          )}
        </>
      )}
    </div>
  );
}
