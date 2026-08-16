import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatRelative, truncate } from '@/lib/utils';
import { ConnectionGuard } from '@/components/shared/ConnectionGuard';
import { SaturnBoardSection } from '@/components/shared/SaturnBoardSection';
import { MyIssuesSection } from '@/components/shared/MyIssuesSection';
import { DailySummarySection } from '@/components/shared/DailySummarySection';
import { TodaysCalendarSection } from '@/components/shared/TodaysCalendarSection';
import { AlertFeed } from '@/components/shared/AlertFeed';
import { WorkloadSection } from '@/components/shared/WorkloadSection';
import { RecentMeetingsWidget } from '@/components/shared/RecentMeetingsWidget';
import { MyPRsWidget } from '@/components/shared/MyPRsWidget';
import { MemoryHealthPanel } from '@/components/shared/MemoryHealthPanel';
import { AlertTriangle, Clock, BarChart2, Coins } from 'lucide-react';
import { Badge } from '@/components/ui';

// ── Helpers ───────────────────────────────────────────────────

function isOverdue(d: string | null) { return !!d && new Date(d) < new Date(); }
function isDueToday(d: string | null) {
  return !!d && d.slice(0, 10) === new Date().toISOString().slice(0, 10);
}
function urgencyDot(d: string | null, s: string) {
  if (isOverdue(d)) return '#ef4444';
  if (isDueToday(d)) return '#f59e0b';
  if (s === 'open') return '#3b82f6';
  return '#6b7280';
}

// ── Mini skeleton line ────────────────────────────────────────
function SkeletonLine({ w = 'w-full' }: { w?: string }) {
  return <div className={`skeleton h-2.5 rounded ${w}`} />;
}
function SkeletonItem() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <div className="skeleton w-1.5 h-1.5 rounded-full shrink-0" />
      <SkeletonLine w="w-2/3" />
    </div>
  );
}

// ── Needs Attention ───────────────────────────────────────────

function NeedsAttentionSection() {
  const { data: actions, isLoading } = useQuery({
    queryKey: ['actions-open'],
    queryFn: () => api.actionItems({ status: 'open' }),
  });
  const { data: healthData } = useQuery({
    queryKey: ['topics-health'],
    queryFn: api.topicHealth,
    staleTime: 60_000,
  });

  const items = actions ?? [];
  const overdue = items.filter(a => isOverdue(a.due_date));
  const dueToday = items.filter(a => !isOverdue(a.due_date) && isDueToday(a.due_date));
  const rest = items.filter(a => !isOverdue(a.due_date) && !isDueToday(a.due_date));
  const prioritised = [...overdue, ...dueToday, ...rest].slice(0, 10);

  const unhealthyTopics = (healthData?.topics ?? []).filter(t => t.color !== 'green');

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      {/* Header */}
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <AlertTriangle size={12} style={{ color: overdue.length > 0 ? '#ef4444' : 'var(--muted)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Action Items</h2>
        {overdue.length > 0 && <Badge variant="danger">{overdue.length} overdue</Badge>}
        {dueToday.length > 0 && <Badge variant="warning">{dueToday.length} today</Badge>}
        {items.length > 0 && <Badge>{items.length}</Badge>}
      </div>

      {/* Rows */}
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => <SkeletonItem key={i} />)
          : prioritised.length === 0
          ? <p className="px-3 py-3 text-xs" style={{ color: 'var(--muted)' }}>All clear — no open items</p>
          : prioritised.map((a) => (
              <div key={a.id} className="flex items-start gap-2.5 px-3 py-1.5 hover:bg-[var(--bg-3)] transition-colors">
                <div className="w-1.5 h-1.5 rounded-full mt-1 shrink-0" style={{ background: urgencyDot(a.due_date, a.status) }} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs leading-snug" style={{ color: 'var(--fg)' }}>{truncate(a.title, 72)}</p>
                  <p className="text-[10px] flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--muted)' }}>
                    {a.assignee && <span>{a.assignee}</span>}
                    {a.due_date && (
                      <span className="flex items-center gap-0.5" style={{ color: isOverdue(a.due_date) ? '#ef4444' : isDueToday(a.due_date) ? '#f59e0b' : 'var(--muted)' }}>
                        <Clock size={8} />
                        {isOverdue(a.due_date) ? 'Overdue' : 'Due today'}
                      </span>
                    )}
                    {!a.due_date && <span>{formatRelative(a.created_at)}</span>}
                  </p>
                </div>
              </div>
            ))}
      </div>
      {!isLoading && items.length > 10 && (
        <div className="px-3 py-1.5 border-t text-[10px]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
          +{items.length - 10} more in Action Items
        </div>
      )}
      {unhealthyTopics.length > 0 && (
        <div className="border-t" style={{ borderColor: 'var(--border)' }}>
          <div className="px-3 py-1.5 text-[10px] font-semibold" style={{ color: 'var(--muted)' }}>
            Unhealthy Topics
          </div>
          {unhealthyTopics.slice(0, 5).map(t => (
            <div key={t.topic_name} className="flex items-center gap-2 px-3 py-1.5">
              <span style={{
                display: 'inline-block', width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: t.color === 'yellow' ? '#f59e0b' : '#ef4444',
              }} />
              <span className="text-xs truncate" style={{ color: 'var(--fg)' }}>{t.topic_name}</span>
              <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--muted)' }}>
                {(t.health_score * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Daily Token Usage ─────────────────────────────────────────

function fmtK(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function DailyTokenUsageWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ['token-stats', 7],
    queryFn: () => api.tokenStats(7),
    staleTime: 5 * 60 * 1000,
  });

  const todayKey = new Date().toISOString().slice(0, 10);
  const byDay = data?.by_day ?? [];
  const todayRow = byDay.find(r => r.day === todayKey);
  const maxCost = Math.max(...byDay.map(r => r.cost_usd), 0.0001);

  // Fill last 7 days in order (oldest → newest)
  const last7: { day: string; label: string; cost_usd: number; calls: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = i === 0 ? 'Today' : d.toLocaleDateString('en', { weekday: 'short' });
    const row = byDay.find(r => r.day === key);
    last7.push({ day: key, label, cost_usd: row?.cost_usd ?? 0, calls: row?.calls ?? 0 });
  }

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      {/* Header */}
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <BarChart2 size={12} style={{ color: 'var(--accent)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>AI Usage</h2>
        {!isLoading && todayRow && (
          <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
            <Coins size={9} />
            Today: {todayRow.calls} calls · ${todayRow.cost_usd.toFixed(3)}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="px-3 py-4 text-xs" style={{ color: 'var(--muted)' }}>Loading…</div>
      ) : (
        <>
          {/* Bar chart */}
          <div className="px-3 pt-3 pb-2 flex items-end gap-1.5" style={{ height: 72 }}>
            {last7.map(({ day, label, cost_usd, calls }) => {
              const isToday = day === todayKey;
              const heightPct = maxCost > 0 ? (cost_usd / maxCost) * 100 : 0;
              return (
                <div key={day} className="flex flex-col items-center gap-1 flex-1" title={`${label}: ${calls} calls · $${cost_usd.toFixed(4)}`}>
                  <div className="w-full rounded-sm" style={{
                    height: `${Math.max(heightPct, cost_usd > 0 ? 4 : 1)}%`,
                    maxHeight: 40,
                    minHeight: cost_usd > 0 ? 3 : 1,
                    background: isToday ? 'var(--accent)' : 'var(--bg-3)',
                    border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                    transition: 'height 0.3s ease',
                  }} />
                  <span className="text-[9px]" style={{ color: isToday ? 'var(--accent)' : 'var(--muted)' }}>{label}</span>
                </div>
              );
            })}
          </div>

          {/* Summary row */}
          <div className="grid grid-cols-3 border-t divide-x" style={{ borderColor: 'var(--border)' }}>
            {[
              { label: 'Today calls', value: todayRow ? String(todayRow.calls) : '—' },
              { label: '7d tokens', value: data ? fmtK(data.total_input_tokens + data.total_output_tokens) : '—' },
              { label: '7d cost', value: data ? `$${data.total_cost_usd.toFixed(3)}` : '—' },
            ].map(({ label, value }) => (
              <div key={label} className="px-2 py-1.5 text-center">
                <p className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{value}</p>
                <p className="text-[9px] mt-0.5" style={{ color: 'var(--muted)' }}>{label}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────

export default function DashboardPage() {
  return (
    <ConnectionGuard>
      <div className="space-y-3 max-w-6xl w-full animate-fade-in">

        {/* Alert feed — hidden when empty (EP-15-2) */}
        <AlertFeed />

        {/* Workload intensity per topic (EP-15-3) */}
        <WorkloadSection />

        {/* Daily AI briefing */}
        <DailySummarySection />

        {/* Three compact widgets side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <NeedsAttentionSection />
          <TodaysCalendarSection />
          <RecentMeetingsWidget />
        </div>

        {/* Daily AI token usage */}
        <DailyTokenUsageWidget />

        {/* Jira boards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <MyIssuesSection />
          <SaturnBoardSection />
        </div>

        {/* PR Follow row */}
        <div className="px-3 pb-3">
          <MyPRsWidget />
        </div>

        {/* Memory health metrics (EP-60) */}
        <MemoryHealthPanel />

      </div>
    </ConnectionGuard>
  );
}
