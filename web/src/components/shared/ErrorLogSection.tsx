import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ErrorLog } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { Badge } from '@/components/ui';
import { AlertCircle, CheckCircle, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

const severityStyle: Record<string, { bg: string; color: string; label: string }> = {
  critical: { bg: 'rgba(239,68,68,0.15)', color: '#ef4444', label: 'Critical' },
  error:    { bg: 'rgba(239,68,68,0.08)', color: '#f97316', label: 'Error' },
  warning:  { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', label: 'Warning' },
  info:     { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6', label: 'Info' },
};

function ErrorRow({ err }: { err: ErrorLog }) {
  const [expanded, setExpanded] = useState(false);
  const qc = useQueryClient();

  const analyzeMut = useMutation({
    mutationFn: () => api.analyzeError(err.id),
    onSuccess: () => {
      toast.success('Analysis complete');
      qc.invalidateQueries({ queryKey: ['errors'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resolveMut = useMutation({
    mutationFn: () => api.resolveError(err.id),
    onSuccess: () => {
      toast.success('Marked resolved');
      qc.invalidateQueries({ queryKey: ['errors'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sev = severityStyle[err.severity] ?? severityStyle.error;
  const isResolved = err.resolved === 1;

  return (
    <div
      className="border-b last:border-0"
      style={{ borderColor: 'var(--border)', opacity: isResolved ? 0.5 : 1 }}
    >
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--bg-3)] transition-colors"
        onClick={() => setExpanded((x) => !x)}
      >
        <span style={{ marginTop: 2 }}>
          {expanded
            ? <ChevronDown size={13} style={{ color: 'var(--muted)' }} />
            : <ChevronRight size={13} style={{ color: 'var(--muted)' }} />}
        </span>
        <span
          className="text-xs px-1.5 py-0.5 rounded shrink-0"
          style={{ background: sev.bg, color: sev.color }}
        >
          {sev.label}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
            {err.message.slice(0, 100)}{err.message.length > 100 ? '…' : ''}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {err.source}
            {err.request_path ? ` · ${err.request_path}` : ''}
            {err.category ? ` · ${err.category}` : ''}
            {' · '}{formatRelative(err.occurred_at)}
          </p>
        </div>
        {isResolved && (
          <CheckCircle size={14} style={{ color: '#10b981', flexShrink: 0, marginTop: 2 }} />
        )}
      </div>

      {expanded && (
        <div
          className="px-4 pb-4 space-y-3"
          style={{ background: 'var(--bg-3)' }}
          onClick={(e) => e.stopPropagation()}
        >
          {err.stack && (
            <pre
              className="text-xs p-3 rounded-lg overflow-x-auto"
              style={{
                background: 'var(--bg)',
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                maxHeight: 160,
              }}
            >
              {err.stack.slice(0, 600)}
            </pre>
          )}

          {err.suggested_fix && (
            <div
              className="text-xs px-3 py-2 rounded-lg"
              style={{ background: 'rgba(59,130,246,0.08)', color: '#3b82f6' }}
            >
              <span className="font-medium">Suggested fix: </span>
              {err.suggested_fix}
            </div>
          )}

          <div className="flex items-center gap-2">
            {!err.suggested_fix && (
              <button
                disabled={analyzeMut.isPending}
                onClick={() => analyzeMut.mutate()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50"
                style={{
                  background: 'var(--bg-2)',
                  borderColor: 'var(--border)',
                  color: 'var(--fg)',
                }}
              >
                <Sparkles size={11} />
                {analyzeMut.isPending ? 'Analyzing…' : 'AI Analyze'}
              </button>
            )}
            {!isResolved && (
              <button
                disabled={resolveMut.isPending}
                onClick={() => resolveMut.mutate()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50"
                style={{
                  background: 'var(--bg-2)',
                  borderColor: 'var(--border)',
                  color: '#10b981',
                }}
              >
                <CheckCircle size={11} />
                {resolveMut.isPending ? 'Saving…' : 'Mark Resolved'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorLogSection() {
  const [showResolved, setShowResolved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['errors', showResolved],
    queryFn: () => api.listErrors({ limit: 50, resolved: showResolved ? undefined : false }),
    refetchInterval: 60_000,
  });

  const errors = data?.errors ?? [];
  const unresolvedCount = errors.filter((e) => e.resolved === 0).length;

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      <div
        className="px-4 py-3 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <AlertCircle size={15} style={{ color: unresolvedCount > 0 ? '#ef4444' : 'var(--muted)' }} />
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Error Log</h2>
          {unresolvedCount > 0 && (
            <Badge variant="danger">{unresolvedCount}</Badge>
          )}
        </div>
        <button
          onClick={() => setShowResolved((x) => !x)}
          className="text-xs px-2.5 py-1 rounded-lg border transition-colors"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }}
        >
          {showResolved ? 'Hide resolved' : 'Show resolved'}
        </button>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--muted)' }}>
          Loading…
        </div>
      ) : errors.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
          No errors logged
        </div>
      ) : (
        <div>
          {errors.map((e) => (
            <ErrorRow key={e.id} err={e} />
          ))}
        </div>
      )}
    </div>
  );
}
