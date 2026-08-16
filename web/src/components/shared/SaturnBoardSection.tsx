import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, type JiraIssue } from '@/lib/api';
import { formatRelative, truncate } from '@/lib/utils';
import { Badge, Button } from '@/components/ui';
import { SkeletonRow } from '@/components/shared/SkeletonCard';

type TabId = 'sprint' | 'all';

const SPRINT_STATUSES = ['in progress', 'in review', 'in testing', 'code review', 'active', 'dev in progress'];

function isInSprint(status: string): boolean {
  const s = status.toLowerCase();
  return SPRINT_STATUSES.some(k => s.includes(k));
}

function statusVariant(s: string): 'danger' | 'info' | 'success' | 'default' {
  const n = s.toLowerCase();
  if (n.includes('block')) return 'danger';
  if (n.includes('progress') || n.includes('review') || n.includes('active')) return 'info';
  if (n.includes('done') || n.includes('complete') || n.includes('closed') || n.includes('resolv')) return 'success';
  return 'default';
}

export function SaturnBoardSection() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('sprint');

  const { data, isLoading } = useQuery({
    queryKey: ['saturn-issues'],
    queryFn: () => api.saturnIssues(),
    refetchInterval: (query) =>
      query.state.data?.isRefreshing ? 3_000 : 600_000,
  });

  const handleRefresh = async () => {
    await api.saturnIssues({ refresh: true });
    qc.invalidateQueries({ queryKey: ['saturn-issues'] });
  };

  const allIssues: JiraIssue[] = data?.issues ?? [];
  const sprintIssues = allIssues.filter(i => isInSprint(i.status));
  const error = data?.error;
  const isRefreshing = data?.isRefreshing ?? false;
  const cachedAt = data?.cachedAt;
  const issues = tab === 'sprint' ? sprintIssues : allIssues;
  const isFirstLoad = isLoading && allIssues.length === 0;

  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {/* Refresh progress bar */}
      {isRefreshing && (
        <div className="h-0.5 w-full overflow-hidden" style={{ background: 'var(--bg-3)' }}>
          <div className="h-full animate-progress-bar" style={{ background: 'var(--accent)' }} />
        </div>
      )}

      {/* Header */}
      <div
        className="px-3 py-2 border-b flex items-center justify-between shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-xs font-semibold truncate" style={{ color: 'var(--fg)' }}>Saturn Board</h2>
          <Badge>{issues.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {isRefreshing ? (
            <span className="text-xs flex items-center gap-1.5" style={{ color: '#f59e0b' }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#f59e0b' }} />
              Syncing…
            </span>
          ) : cachedAt ? (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {formatRelative(cachedAt)}
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={handleRefresh} title="Refresh Saturn board" disabled={isRefreshing}>
            <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div
        className="flex border-b shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        {([['sprint', 'Current Sprint'], ['all', 'All Issues']] as [TabId, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="px-3 py-1.5 text-xs font-medium transition-colors relative"
            style={{
              color: tab === id ? 'var(--accent)' : 'var(--muted)',
              borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {label}
            {id === 'sprint' && sprintIssues.length > 0 && (
              <span
                className="ml-1.5 px-1 py-0.5 rounded text-xs"
                style={{ background: 'rgba(99,102,241,0.15)', color: 'var(--accent)' }}
              >
                {sprintIssues.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {error === 'browser_not_configured' ? (
        <div className="px-4 py-4 text-xs" style={{ background: 'rgba(245,158,11,0.08)', color: '#fbbf24' }}>
          Browser not configured — set <code className="font-mono">BROWSER_PROFILE_PATH</code> to enable.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Key', 'Title', 'Status', 'Assignee', 'Updated'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isFirstLoad
                  ? Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i}><td colSpan={5}><SkeletonRow className="px-3" /></td></tr>
                    ))
                  : issues.map((issue) => (
                      <tr
                        key={issue.key}
                        className="hover:bg-[var(--bg-3)] transition-colors"
                        style={{ borderBottom: '1px solid var(--border)' }}
                      >
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          <a href={issue.url} target="_blank" rel="noopener noreferrer"
                            className="hover:underline" style={{ color: 'var(--accent)' }}>
                            {issue.key}
                          </a>
                        </td>
                        <td className="px-3 py-2 max-w-[14rem]" style={{ color: 'var(--fg)' }}>
                          <span className="line-clamp-2">{issue.title}</span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Badge variant={statusVariant(issue.status)}>{issue.status}</Badge>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                          {issue.assignee ?? '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                          {formatRelative(issue.updatedAt)}
                        </td>
                      </tr>
                    ))}
                {!isFirstLoad && issues.length === 0 && !error && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center" style={{ color: 'var(--muted)' }}>
                      {isRefreshing ? 'Fetching issues…' : tab === 'sprint' ? 'No active sprint issues' : 'No issues found on Saturn board'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden divide-y" style={{ borderColor: 'var(--border)' }}>
            {isFirstLoad
              ? Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} className="px-4" />)
              : issues.map((issue) => (
                  <div key={issue.key} className="px-4 py-3 hover:bg-[var(--bg-3)] transition-colors">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <a href={issue.url} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-xs hover:underline" style={{ color: 'var(--accent)' }}>
                        {issue.key}
                      </a>
                      <Badge variant={statusVariant(issue.status)}>{issue.status}</Badge>
                    </div>
                    <p className="text-xs leading-snug" style={{ color: 'var(--fg)' }}>{truncate(issue.title, 70)}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                      {issue.assignee ?? '—'} · {formatRelative(issue.updatedAt)}
                    </p>
                  </div>
                ))}
            {!isFirstLoad && issues.length === 0 && (
              <p className="px-4 py-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
                {isRefreshing ? 'Fetching issues…' : tab === 'sprint' ? 'No active sprint issues' : 'No issues found'}
              </p>
            )}
          </div>

          {/* Footer link */}
          <div className="px-3 py-1.5 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
            <a
              href="https://jira.example.com/secure/RapidBoard.jspa?rapidView=1&projectKey=DEMO"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs hover:underline"
              style={{ color: 'var(--accent)' }}
            >
              Open Saturn board →
            </a>
          </div>
        </>
      )}
    </div>
  );
}
