import { useQuery } from '@tanstack/react-query';
import { GitPullRequest, ExternalLink, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import type { WatchedPRSummary } from '@/lib/api';

function staleDays(updatedAt: string | null, state: string): number | null {
  if (state !== 'OPEN' || !updatedAt) return null;
  const diff = Date.now() - new Date(updatedAt).getTime();
  const days = Math.floor(diff / 86400000);
  return days >= 3 ? days : null;
}

function relativeTime(iso: string | null) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function stateBadge(state: string) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    OPEN:   { label: 'Open',   color: '#10b981', bg: '#10b98118' },
    MERGED: { label: 'Merged', color: '#8b5cf6', bg: '#8b5cf618' },
    CLOSED: { label: 'Closed', color: 'var(--muted)', bg: 'var(--bg-3)' },
  };
  const s = map[state] ?? map['CLOSED'];
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium"
      style={{ background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}

function PRRow({ item }: { item: WatchedPRSummary }) {
  const stale = staleDays(item.updatedAt, item.state);
  return (
    <div className="px-3 py-1.5 flex items-start gap-2 border-b last:border-b-0"
      style={{ borderColor: 'var(--border)' }}>
      <GitPullRequest size={12} className="flex-shrink-0 mt-0.5"
        style={{ color: 'var(--accent)' }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium truncate" style={{ color: 'var(--fg)' }}>
            #{item.prNum} {item.title}
          </span>
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer"
              className="flex-shrink-0" style={{ color: 'var(--muted)' }}>
              <ExternalLink size={10} />
            </a>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{item.repo}</span>
          {stateBadge(item.state)}
          {stale !== null && (
            <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded font-medium"
              style={{ background: '#f59e0b18', color: '#f59e0b' }}>
              <Clock size={9} /> Stale {stale}d
            </span>
          )}
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            updated {relativeTime(item.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function MyPRsWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ['watched-prs-summary'],
    queryFn: () => api.watchedPRsSummary(),
    refetchInterval: 120_000,
  });

  const items = data?.items ?? [];
  const staleCount = items.filter(i => staleDays(i.updatedAt, i.state) !== null).length;

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      {/* Header */}
      <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
        <GitPullRequest size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Followed PRs</span>
        {items.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded ml-1"
            style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>
            {items.length}
          </span>
        )}
        {staleCount > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded ml-1 font-medium"
            style={{ background: '#f59e0b18', color: '#f59e0b' }}>
            {staleCount} stale
          </span>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="px-3 py-4 text-xs" style={{ color: 'var(--muted)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div className="px-3 py-4 text-xs" style={{ color: 'var(--muted)' }}>
          No followed PRs — follow PRs from the PR Review page
        </div>
      ) : (
        <div>
          {items.map(item => <PRRow key={`${item.repo}:${item.prNum}`} item={item} />)}
        </div>
      )}
    </div>
  );
}
