import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { User, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { api, type JiraIssue } from '@/lib/api';
import { formatRelative, truncate } from '@/lib/utils';
import { Badge, Button } from '@/components/ui';
import { SkeletonRow } from '@/components/shared/SkeletonCard';

const DEFAULT_VISIBLE = 5;

function priorityColor(p: string | null): string {
  if (!p) return '#6b7280';
  const l = p.toLowerCase();
  if (l.includes('blocker') || l.includes('critical')) return '#ef4444';
  if (l.includes('major')) return '#f97316';
  if (l.includes('normal') || l.includes('medium') || l.includes('minor')) return '#eab308';
  return '#6b7280';
}

function priorityLabel(p: string | null): string {
  if (!p) return '';
  const l = p.toLowerCase();
  if (l.includes('blocker')) return 'Blocker';
  if (l.includes('critical')) return 'Critical';
  if (l.includes('major')) return 'Major';
  if (l.includes('minor')) return 'Minor';
  if (l.includes('normal') || l.includes('medium')) return 'Normal';
  return p;
}

function statusVariant(s: string): 'danger' | 'info' | 'success' | 'default' {
  const n = s.toLowerCase();
  if (n.includes('block')) return 'danger';
  if (n.includes('progress') || n.includes('review') || n.includes('active')) return 'info';
  if (n.includes('done') || n.includes('complete') || n.includes('closed') || n.includes('resolv')) return 'success';
  return 'default';
}

export function MyIssuesSection() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['my-issues'],
    queryFn: () => api.myIssues(),
    refetchInterval: (query) =>
      query.state.data?.isRefreshing ? 3_000 : 300_000,
  });

  const handleRefresh = async () => {
    await api.myIssues({ refresh: true });
    qc.invalidateQueries({ queryKey: ['my-issues'] });
  };

  const issues: JiraIssue[] = data?.issues ?? [];
  const error = data?.error;
  const isRefreshing = data?.isRefreshing ?? false;
  const cachedAt = data?.cachedAt;
  const isFirstLoad = isLoading && issues.length === 0;
  const visible = expanded ? issues : issues.slice(0, DEFAULT_VISIBLE);
  const hasMore = issues.length > DEFAULT_VISIBLE;

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

      <div
        className="px-3 py-2 border-b flex items-center justify-between shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <User size={12} style={{ color: 'var(--muted)' }} />
          <h2 className="text-xs font-semibold truncate" style={{ color: 'var(--fg)' }}>Assigned to Me</h2>
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
          <Button variant="ghost" size="sm" onClick={handleRefresh} title="Refresh my issues" disabled={isRefreshing}>
            <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {error === 'browser_not_configured' ? (
        <div className="px-4 py-4 text-xs" style={{ background: 'rgba(245,158,11,0.08)', color: '#fbbf24' }}>
          Browser not configured — set <code className="font-mono">BROWSER_PROFILE_PATH</code> to enable.
        </div>
      ) : error === 'auth_expired' ? (
        <div className="px-4 py-4 text-xs" style={{ background: 'rgba(245,158,11,0.08)', color: '#fbbf24' }}>
          Jira session expired — re-open Jira in your browser to refresh.
        </div>
      ) : (
        <>
          {/* Mobile: card list; Desktop: table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Pri', 'Key', 'Title', 'Status', 'Updated'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isFirstLoad
                  ? Array.from({ length: DEFAULT_VISIBLE }).map((_, i) => (
                      <tr key={i}><td colSpan={5}><SkeletonRow className="px-3" /></td></tr>
                    ))
                  : visible.map((issue) => (
                      <tr
                        key={issue.key}
                        className="hover:bg-[var(--bg-3)] transition-colors"
                        style={{ borderBottom: '1px solid var(--border)' }}
                      >
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className="inline-flex items-center gap-1"
                            title={issue.priority ?? 'Unknown priority'}
                          >
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: priorityColor(issue.priority) }} />
                            <span className="hidden lg:inline" style={{ color: 'var(--muted)' }}>
                              {priorityLabel(issue.priority)}
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          <a href={issue.url} target="_blank" rel="noopener noreferrer"
                            className="hover:underline" style={{ color: 'var(--accent)' }}>
                            {issue.key}
                          </a>
                        </td>
                        <td className="px-3 py-2 max-w-[16rem]" style={{ color: 'var(--fg)' }}>
                          <span className="line-clamp-2">{issue.title}</span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <Badge variant={statusVariant(issue.status)}>{issue.status}</Badge>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                          {formatRelative(issue.updatedAt)}
                        </td>
                      </tr>
                    ))}
                {!isFirstLoad && issues.length === 0 && !error && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center" style={{ color: 'var(--muted)' }}>
                      {isRefreshing ? 'Fetching issues…' : 'No issues assigned to you'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden divide-y" style={{ borderColor: 'var(--border)' }}>
            {isFirstLoad
              ? Array.from({ length: DEFAULT_VISIBLE }).map((_, i) => <SkeletonRow key={i} className="px-4" />)
              : visible.map((issue) => (
                  <div key={issue.key} className="px-4 py-3 hover:bg-[var(--bg-3)] transition-colors">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: priorityColor(issue.priority) }} />
                        <a href={issue.url} target="_blank" rel="noopener noreferrer"
                          className="font-mono text-xs hover:underline shrink-0" style={{ color: 'var(--accent)' }}>
                          {issue.key}
                        </a>
                      </div>
                      <Badge variant={statusVariant(issue.status)}>{issue.status}</Badge>
                    </div>
                    <p className="text-xs leading-snug" style={{ color: 'var(--fg)' }}>{truncate(issue.title, 80)}</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{formatRelative(issue.updatedAt)}</p>
                  </div>
                ))}
          </div>

          {/* Footer: expand/collapse + link */}
          <div
            className="px-3 py-1.5 border-t flex items-center justify-between"
            style={{ borderColor: 'var(--border)' }}
          >
            <a href="https://jira.example.com/issues/?filter=-1" target="_blank" rel="noopener noreferrer"
              className="text-xs hover:underline" style={{ color: 'var(--accent)' }}>
              View all in Jira →
            </a>
            {hasMore && !isFirstLoad && (
              <button
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1 text-xs hover:underline transition-colors"
                style={{ color: 'var(--muted)' }}
              >
                {expanded
                  ? <><ChevronUp size={12} /> Show less</>
                  : <><ChevronDown size={12} /> {issues.length - DEFAULT_VISIBLE} more</>}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
