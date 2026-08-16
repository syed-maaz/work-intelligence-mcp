/**
 * DreamPage — the Dream Gate (/dream feature).
 *
 * Reads the latest nightly dream report (GET /api/dream/report) and lets the
 * user Approve / Reject each proposed memory change, then Submit (POST
 * /api/dream/apply). Applied items report their git commit sha. Read-only
 * generate happens in the bridge scheduler; this page is the human gate.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Moon, Check, X, GitCommit, RefreshCw } from 'lucide-react';
import { api, type DreamItem, type DreamApplyResult } from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { EmptyState } from '@/components/shared/EmptyState';

type Choice = 'approve' | 'reject' | null;

const TYPE_VARIANT: Record<DreamItem['type'], 'success' | 'warning' | 'danger'> = {
  add: 'success',
  update: 'warning',
  prune: 'danger',
};

export default function DreamPage() {
  const qc = useQueryClient();
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [results, setResults] = useState<DreamApplyResult[]>([]);

  const reportQuery = useQuery({ queryKey: ['dream-report'], queryFn: api.dreamReport });

  const applyMutation = useMutation({
    mutationFn: () => {
      const approved = Object.entries(choices).filter(([, c]) => c === 'approve').map(([id]) => Number(id));
      const rejected = Object.entries(choices).filter(([, c]) => c === 'reject').map(([id]) => Number(id));
      return api.dreamApply({ approved, rejected });
    },
    onSuccess: (res) => {
      setResults(res.results || []);
      qc.invalidateQueries({ queryKey: ['dream-report'] });
    },
  });

  const report = reportQuery.data;
  const pending = (report?.items || []).filter((i) => i.status === 'pending');
  const chosen = Object.values(choices).some((c) => c !== null);

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      {/* header strip */}
      <div className="px-3 py-2 text-xs font-semibold flex items-center gap-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <Moon size={12} />
        <span>Dream Gate</span>
        <span style={{ color: 'var(--muted)' }}>
          {report?.generated_at ? `· report ${new Date(report.generated_at).toLocaleString()}` : '· no report yet'}
        </span>
        <button
          className="ml-auto inline-flex items-center gap-1"
          style={{ color: 'var(--muted)' }}
          onClick={() => reportQuery.refetch()}
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 py-2">
        {reportQuery.isLoading && <div className="text-xs" style={{ color: 'var(--muted)' }}>Loading…</div>}

        {!reportQuery.isLoading && pending.length === 0 && (
          <EmptyState
            title="No pending dream proposals"
            description="The nightly dream pass found nothing durable to add — or you've already reviewed everything. Proposals appear here after the 07:00 run."
          />
        )}

        {pending.map((item) => (
          <div
            key={item.id}
            className="mb-2 border rounded"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
          >
            <div className="px-3 py-1.5 text-xs flex items-center gap-2 border-b" style={{ borderColor: 'var(--border)' }}>
              <span style={{ color: 'var(--muted)' }}>#{item.id}</span>
              <Badge variant={TYPE_VARIANT[item.type]}>{item.type}</Badge>
              <span className="font-mono">{item.target}</span>
              <div className="ml-auto flex gap-1">
                <Button
                  variant={choices[item.id] === 'approve' ? 'primary' : 'ghost'}
                  onClick={() => setChoices((c) => ({ ...c, [item.id]: c[item.id] === 'approve' ? null : 'approve' }))}
                >
                  <Check size={12} /> Approve
                </Button>
                <Button
                  variant={choices[item.id] === 'reject' ? 'danger' : 'ghost'}
                  onClick={() => setChoices((c) => ({ ...c, [item.id]: c[item.id] === 'reject' ? null : 'reject' }))}
                >
                  <X size={12} /> Reject
                </Button>
              </div>
            </div>
            <div className="px-3 py-2 text-xs space-y-1">
              <div>
                <span style={{ color: 'var(--muted)' }}>Evidence (you typed): </span>
                <span className="italic">"{item.evidence}"</span>
              </div>
              <div>
                <span style={{ color: 'var(--muted)' }}>Why: </span>
                {item.rationale}
              </div>
              {item.body && (
                <pre className="mt-1 p-2 rounded overflow-auto text-[11px]" style={{ background: 'var(--bg-3)' }}>
                  {item.body}
                </pre>
              )}
            </div>
          </div>
        ))}

        {results.length > 0 && (
          <div className="mt-3 border-t pt-2 text-xs" style={{ borderColor: 'var(--border)' }}>
            <div className="font-semibold mb-1">Applied:</div>
            {results.map((r) => (
              <div key={r.id} className="flex items-center gap-2 py-0.5">
                <span style={{ color: 'var(--muted)' }}>#{r.id}</span>
                <span>{r.action}</span>
                {r.target && <span className="font-mono">{r.target}</span>}
                {r.commit && (
                  <span className="inline-flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                    <GitCommit size={11} /> {r.commit}
                  </span>
                )}
                {r.error && <span style={{ color: 'var(--danger)' }}>{r.error}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <div className="px-3 py-2 border-t flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
          <Button variant="primary" disabled={!chosen || applyMutation.isPending} onClick={() => applyMutation.mutate()}>
            {applyMutation.isPending ? 'Applying…' : 'Submit choices'}
          </Button>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {Object.values(choices).filter((c) => c === 'approve').length} approve ·{' '}
            {Object.values(choices).filter((c) => c === 'reject').length} reject
          </span>
        </div>
      )}
    </div>
  );
}
