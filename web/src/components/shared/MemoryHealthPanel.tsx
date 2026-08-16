import { useState, useEffect } from 'react';

interface HealthMetrics {
  staleFacts: number;
  orphanRate: number;
  topicCoverage: number;
  retrievalHitRate: number;
  computed: boolean;
  meta?: {
    totalTriples: number;
    totalEntities: number;
    orphans: number;
    staleCount: number;
    topicsChecked: number;
    topicsWithDrawers: number;
  };
}

const THRESHOLDS = {
  staleFacts:       { green: 0.10, yellow: 0.30 },
  orphanRate:       { green: 0.20, yellow: 0.50 },
  topicCoverage:    { green: 0.80, yellow: 0.50 },
  retrievalHitRate: { green: 0.60, yellow: 0.30 },
};

function getColor(metric: keyof typeof THRESHOLDS, value: number): string {
  const t = THRESHOLDS[metric];
  if (metric === 'topicCoverage' || metric === 'retrievalHitRate') {
    // Higher is better
    if (value >= t.green) return '#22c55e';
    if (value >= t.yellow) return '#eab308';
    return 'var(--danger)';
  }
  // Lower is better
  if (value <= t.green) return '#22c55e';
  if (value <= t.yellow) return '#eab308';
  return 'var(--danger)';
}

function MetricCard({ label, value, metric, subtitle }: {
  label: string;
  value: number;
  metric: keyof typeof THRESHOLDS;
  subtitle?: string;
}) {
  const color = getColor(metric, value);
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg" style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
      <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="text-lg font-bold" style={{ color }}>{(value * 100).toFixed(0)}%</span>
      {subtitle && <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{subtitle}</span>}
    </div>
  );
}

export function MemoryHealthPanel() {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchMetrics = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/palace/health/detailed');
      if (res.ok) setMetrics(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  const refresh = async () => {
    await fetch('/api/palace/health/refresh', { method: 'POST' });
    setTimeout(fetchMetrics, 2000);
  };

  useEffect(() => { fetchMetrics(); }, []);

  if (!metrics || !metrics.computed) return null;

  return (
    <details className="mt-4">
      <summary className="flex items-center gap-2 cursor-pointer select-none text-xs font-medium" style={{ color: 'var(--fg-2)' }}>
        Memory Health
        {loading && <span className="text-[10px]" style={{ color: 'var(--muted)' }}>loading...</span>}
        <button
          onClick={(e) => { e.preventDefault(); refresh(); }}
          className="ml-auto text-[10px] px-2 py-0.5 rounded"
          style={{ background: 'var(--bg-3)', color: 'var(--accent)', border: '1px solid var(--border)' }}
        >
          Refresh
        </button>
      </summary>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <MetricCard
          label="Stale Facts"
          value={metrics.staleFacts}
          metric="staleFacts"
          subtitle={metrics.meta ? `${metrics.meta.staleCount}/${metrics.meta.totalTriples} triples` : undefined}
        />
        <MetricCard
          label="Orphan Rate"
          value={metrics.orphanRate}
          metric="orphanRate"
          subtitle={metrics.meta ? `${metrics.meta.orphans}/${metrics.meta.totalEntities} entities` : undefined}
        />
        <MetricCard
          label="Topic Coverage"
          value={metrics.topicCoverage}
          metric="topicCoverage"
          subtitle={metrics.meta ? `${metrics.meta.topicsWithDrawers}/${metrics.meta.topicsChecked} topics` : undefined}
        />
        <MetricCard
          label="Retrieval Hit Rate"
          value={metrics.retrievalHitRate}
          metric="retrievalHitRate"
        />
      </div>
    </details>
  );
}
