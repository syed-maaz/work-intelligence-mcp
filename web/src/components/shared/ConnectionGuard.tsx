import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { AlertTriangle } from 'lucide-react';

export function ConnectionGuard({ children }: { children: React.ReactNode }) {
  const { error, isLoading } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    retry: 1,
    retryDelay: 1000,
  });

  if (isLoading) return <>{children}</>;

  if (error) {
    return (
      <div
        className="rounded-xl border p-5 flex items-start gap-3"
        style={{ background: 'var(--bg-2)', borderColor: '#7c2d12', color: 'var(--fg)' }}
      >
        <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-sm mb-1">Bridge server not reachable</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Start the HTTP bridge first:
          </p>
          <pre
            className="mt-2 text-xs rounded px-3 py-2 font-mono"
            style={{ background: 'var(--bg-3)', color: 'var(--fg)' }}
          >
            node --env-file=.env web-server.js
          </pre>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
