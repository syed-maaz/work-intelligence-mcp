/**
 * EP-15-3: Workload Intensity Section
 * Per-topic cards showing message velocity and Jira churn.
 * Pure SQL — no AI. Updates after each sync.
 */

import { useQuery } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Minus, BarChart2 } from 'lucide-react';
import { api, type WorkloadTopic } from '../../lib/api';

const INTENSITY_COLORS: Record<string, { dot: string; bg: string; label: string }> = {
  intense: { dot: '#ef4444', bg: 'rgba(239,68,68,0.08)', label: 'INTENSE' },
  active:  { dot: '#f59e0b', bg: 'rgba(245,158,11,0.08)', label: 'ACTIVE'  },
  calm:    { dot: '#10b981', bg: 'rgba(16,185,129,0.08)', label: 'CALM'    },
};

function TrendIcon({ trend }: { trend: string }) {
  if (trend === 'up') return <TrendingUp size={10} style={{ color: '#ef4444' }} />;
  if (trend === 'down') return <TrendingDown size={10} style={{ color: '#10b981' }} />;
  return <Minus size={10} style={{ color: '#6b7280' }} />;
}

function TopicCard({ topic }: { topic: WorkloadTopic }) {
  const meta = INTENSITY_COLORS[topic.intensity] ?? INTENSITY_COLORS.calm;

  return (
    <div
      className="rounded-lg p-3 flex flex-col gap-1.5 border"
      style={{ background: meta.bg, borderColor: 'var(--border)', minWidth: 0 }}
    >
      {/* Topic name + badge */}
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-semibold truncate" style={{ color: 'var(--fg)' }}>
          {topic.name}
        </span>
        <span
          className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
          style={{ background: meta.dot, color: '#fff', letterSpacing: '0.05em' }}
        >
          {meta.label}
        </span>
      </div>

      {/* Messages this week with trend */}
      <div className="flex items-center gap-1">
        <TrendIcon trend={topic.messageTrend} />
        <span className="text-[11px]" style={{ color: 'var(--fg)' }}>
          {topic.messagesThisWeek} msgs
        </span>
        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
          this week
        </span>
      </div>

      {/* Action items */}
      <div className="flex items-center gap-2.5">
        {topic.overdueItems > 0 && (
          <span className="text-[10px] font-medium" style={{ color: '#ef4444' }}>
            {topic.overdueItems} overdue
          </span>
        )}
        {topic.openActionItems > 0 && (
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
            {topic.openActionItems} open
          </span>
        )}
        {topic.overdueItems === 0 && topic.openActionItems === 0 && (
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>No open items</span>
        )}
      </div>
    </div>
  );
}

export function WorkloadSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['workload'],
    queryFn: () => api.workload(),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });

  const topics = data?.topics ?? [];

  // Hide section if no topics
  if (!isLoading && topics.length === 0) return null;

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {/* Header */}
      <div
        className="px-3 py-2 border-b flex items-center gap-1.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <BarChart2 size={12} style={{ color: 'var(--accent)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>
          Workload Intensity
        </h2>
        {data?.generatedAt && (
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
            Updated {new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
      </div>

      {/* Topic cards */}
      <div className="p-3">
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="rounded-lg p-3 animate-pulse" style={{ background: 'var(--bg-3)', height: 72 }} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {topics.map(t => <TopicCard key={t.name} topic={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}
