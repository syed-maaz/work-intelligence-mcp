import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { Database, RefreshCw, Coins } from 'lucide-react';

export function StatusBar() {
  const { data, isFetching } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 30_000,
  });

  const { data: tokenStats } = useQuery({
    queryKey: ['token-stats-footer'],
    queryFn: () => api.tokenStats(30),
    refetchInterval: 120_000,
  });

  return (
    <footer
      className="flex items-center gap-3 px-3 sm:px-5 py-1.5 border-t text-xs shrink-0 overflow-hidden"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--muted)' }}
    >
      {/* Stats — hidden on smallest screens */}
      <span className="hidden sm:flex items-center gap-1.5">
        <Database size={11} />
        {data ? (
          <>
            <span>{data.messages.toLocaleString()} msgs</span>
            <span>·</span>
            <span>{data.openActions} open</span>
            <span>·</span>
            <span>{data.meetings} meetings</span>
          </>
        ) : (
          <span>Loading…</span>
        )}
      </span>

      {/* Token usage — hidden on smallest screens */}
      {tokenStats && tokenStats.total_cost_usd > 0 && (
        <span className="hidden sm:flex items-center gap-1.5">
          <Coins size={10} />
          <span>{((tokenStats.total_input_tokens + tokenStats.total_output_tokens) / 1000).toFixed(0)}k tokens</span>
          <span>·</span>
          <span>${tokenStats.total_cost_usd.toFixed(2)}</span>
        </span>
      )}

      <span className="hidden md:inline text-[10px]" style={{ color: 'var(--muted)' }} title="Keyboard shortcuts">
        ⌘K palette
      </span>

      <span className="ml-auto flex items-center gap-1.5">
        {isFetching && <RefreshCw size={10} className="animate-spin" />}
        {data?.lastSync ? (
          <span>Synced {formatRelative(data.lastSync)}</span>
        ) : (
          <span>Never synced</span>
        )}
      </span>
    </footer>
  );
}
