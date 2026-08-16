import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity, RefreshCw, AlertTriangle, CheckCircle2, Network,
  Database, Cpu, ChevronRight, X, Check, AlertCircle, Clock,
} from 'lucide-react';
import {
  api,
  type SystemHealth,
  type DataQualityIssue,
  type IngestionLogEntry,
  type AllRelationship,
} from '@/lib/api';
import { Badge, Button } from '@/components/ui';
import { EmptyState } from '@/components/shared/EmptyState';
import { SkeletonRow } from '@/components/shared/SkeletonCard';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

function relativeTime(iso: string | null) {
  if (!iso) return null;
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

// ── Stat Cards ─────────────────────────────────────────────────────────────

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  badge?: React.ReactNode;
  note?: string;
  action?: { label: string; onClick: () => void; loading?: boolean };
  linkTo?: string;
}

function StatCard({ icon, label, value, badge, note, action, linkTo }: StatCardProps) {
  const navigate = useNavigate();
  return (
    <div
      className="rounded-xl border p-3 flex flex-col gap-1.5"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{label}</span>
        {badge}
      </div>
      <p className="text-2xl font-semibold tabular-nums" style={{ color: 'var(--fg)' }}>{value}</p>
      {note && <p className="text-[10px]" style={{ color: 'var(--muted)' }}>{note}</p>}
      <div className="flex items-center gap-2 mt-auto pt-1">
        {action && (
          <button
            onClick={action.onClick}
            disabled={action.loading}
            className="text-xs flex items-center gap-1 px-2 py-0.5 rounded-md border transition-colors hover:bg-[var(--bg-3)] disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--accent)' }}
          >
            {action.loading ? <RefreshCw size={10} className="animate-spin" /> : null}
            {action.label}
          </button>
        )}
        {linkTo && (
          <button
            onClick={() => navigate(linkTo)}
            className="text-xs flex items-center gap-0.5 ml-auto"
            style={{ color: 'var(--muted)' }}
          >
            View <ChevronRight size={10} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Data Quality Section ────────────────────────────────────────────────────

function DataQualitySection() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');

  const { data, isLoading } = useQuery({
    queryKey: ['dataQuality', status],
    queryFn: () => api.dataQuality(status),
  });

  const resolveMut = useMutation({
    mutationFn: (id: number) => api.resolveDataQualityIssue(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dataQuality'] });
      qc.invalidateQueries({ queryKey: ['systemHealth'] });
      toast.success('Issue resolved');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const issues: DataQualityIssue[] = data?.issues ?? [];

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
        <AlertTriangle size={12} style={{ color: issues.some(i => i.severity === 'error') ? 'var(--danger)' : 'var(--muted)' }} />
        <span className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Data Quality Issues</span>
        <div className="flex gap-0.5 p-0.5 rounded-lg" style={{ background: 'var(--bg-3)' }}>
          {(['open', 'resolved'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className="px-2 py-0.5 rounded-md text-[10px] font-medium transition-all capitalize"
              style={{
                background: status === s ? 'var(--bg)' : 'transparent',
                color: status === s ? 'var(--fg)' : 'var(--muted)',
              }}
            >{s}</button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {[0, 1, 2].map(i => <SkeletonRow key={i} className="px-3" />)}
        </div>
      ) : issues.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={status === 'open' ? 'No open issues' : 'No resolved issues'}
          description={status === 'open' ? 'All data looks clean.' : 'Nothing resolved yet.'}
          className="border-0 rounded-none py-6"
        />
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {issues.map(issue => (
            <div key={issue.id} className="flex items-start gap-2 px-3 py-1.5 hover:bg-[var(--bg-3)] transition-colors">
              <span className="mt-0.5 shrink-0 text-xs font-mono" style={{ color: issue.severity === 'error' ? 'var(--danger)' : '#fbbf24' }}>
                {issue.severity === 'error' ? '✕' : '⚠'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium" style={{ color: 'var(--fg)' }}>{issue.rule}</p>
                <p className="text-[10px] truncate" style={{ color: 'var(--muted)' }}>
                  {issue.detail ?? '—'}
                  {issue.message_id ? ` · msg #${issue.message_id}` : ''}
                  {issue.meeting_id ? ` · meeting #${issue.meeting_id}` : ''}
                  {' · '}{relativeTime(issue.detected_at)}
                </p>
              </div>
              {status === 'open' && (
                <button
                  onClick={() => resolveMut.mutate(issue.id)}
                  disabled={resolveMut.isPending}
                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors hover:bg-[var(--bg-3)] disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  Resolve
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Relationships Section ───────────────────────────────────────────────────

function RelationshipsSection() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['allRelationships'],
    queryFn: api.allRelationships,
    staleTime: 5 * 60_000,
  });

  const detectMut = useMutation({
    mutationFn: api.detectRelationships,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['allRelationships'] });
      qc.invalidateQueries({ queryKey: ['systemHealth'] });
      toast.success(`Detected ${res.detected} relationship${res.detected !== 1 ? 's' : ''}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rels: AllRelationship[] = data?.relationships ?? [];

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
        <Network size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Cross-Topic Relationships</span>
        <button
          onClick={() => detectMut.mutate()}
          disabled={detectMut.isPending}
          className="text-xs flex items-center gap-1 px-2 py-0.5 rounded-md border transition-colors hover:bg-[var(--bg-3)] disabled:opacity-50"
          style={{ borderColor: 'var(--border)', color: 'var(--accent)' }}
        >
          {detectMut.isPending ? <RefreshCw size={10} className="animate-spin" /> : <Network size={10} />}
          Detect Now
        </button>
      </div>

      {isLoading ? (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {[0, 1, 2].map(i => <SkeletonRow key={i} className="px-3" />)}
        </div>
      ) : rels.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No relationships detected"
          description="Click 'Detect Now' to analyse Jira key overlap and shared people across topics."
          className="border-0 rounded-none py-6"
        />
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {rels.map((r, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-3)] transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
                  {r.topic_a}
                  <span style={{ color: 'var(--muted)' }}> ↔ </span>
                  {r.topic_b}
                </p>
                <p className="text-[10px] truncate" style={{ color: 'var(--muted)' }}>{r.evidence}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={r.type === 'jira_overlap' ? 'info' : 'default'}>
                  {r.type === 'jira_overlap' ? 'Jira' : 'People'}
                </Badge>
                <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-3)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.round(r.strength * 100)}%`, background: 'var(--accent)' }}
                  />
                </div>
                <span className="text-[10px] tabular-nums w-7 text-right" style={{ color: 'var(--muted)' }}>
                  {Math.round(r.strength * 100)}%
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Ingestion Log Section ──────────────────────────────────────────────────

function IngestionLogSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['ingestionLog'],
    queryFn: () => api.ingestionLog(20),
    refetchInterval: 60_000,
  });

  const logs: IngestionLogEntry[] = data?.logs ?? [];

  function elapsed(entry: IngestionLogEntry): string {
    if (!entry.completed_at || !entry.started_at) return '—';
    const ms = new Date(entry.completed_at).getTime() - new Date(entry.started_at).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
        <Database size={12} style={{ color: 'var(--muted)' }} />
        <span className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Ingestion Log</span>
        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>last 20 runs</span>
      </div>

      {isLoading ? (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {[0, 1, 2].map(i => <SkeletonRow key={i} className="px-3" />)}
        </div>
      ) : logs.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No ingestion runs yet"
          description="Sync runs will appear here after the first data pull."
          className="border-0 rounded-none py-6"
        />
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {logs.map(entry => {
            const ok = entry.status === 'completed' && !entry.error_message;
            return (
              <div key={entry.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-3)] transition-colors">
                <span style={{ color: ok ? '#34d399' : 'var(--danger)' }} className="shrink-0">
                  {ok ? <Check size={11} /> : <X size={11} />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
                    <span className="font-mono">{entry.source}</span>
                    {entry.topic_name && <span style={{ color: 'var(--muted)' }}> · {entry.topic_name}</span>}
                  </p>
                  {entry.error_message && (
                    <p className="text-[10px] truncate" style={{ color: 'var(--danger)' }}>{entry.error_message}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
                  {entry.records_fetched != null && (
                    <span>{entry.records_fetched}→{entry.records_inserted ?? '?'}</span>
                  )}
                  <span>{elapsed(entry)}</span>
                  <span>{relativeTime(entry.started_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Embeddings Section ─────────────────────────────────────────────────────

function EmbeddingsSection({ health }: { health: SystemHealth | undefined }) {
  const enabled = health?.embeddings.enabled ?? false;
  const indexed = health?.embeddings.indexed ?? 0;

  return (
    <div className="rounded-xl border p-3" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-2 mb-2">
        <Cpu size={12} style={{ color: 'var(--muted)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Semantic Search / Embeddings</span>
        <Badge variant={enabled ? 'success' : 'default'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
      </div>
      {enabled ? (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {indexed.toLocaleString()} message{indexed !== 1 ? 's' : ''} indexed with Ollama (<code className="text-[10px] px-1 rounded" style={{ background: 'var(--bg-3)', color: 'var(--fg)' }}>nomic-embed-text</code>).
          Hybrid search (BM25 + semantic) active.
        </p>
      ) : (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Semantic search uses <code className="text-[10px] px-1 rounded" style={{ background: 'var(--bg-3)', color: 'var(--fg)' }}>nomic-embed-text</code> via{' '}
          <code className="text-[10px] px-1 rounded" style={{ background: 'var(--bg-3)', color: 'var(--fg)' }}>Ollama</code> — free, runs locally, no API key needed.
          Install: <code className="text-[10px] px-1 rounded" style={{ background: 'var(--bg-3)', color: 'var(--fg)' }}>brew install ollama && ollama pull nomic-embed-text</code>.
          Currently falling back to FTS5 keyword search.
        </p>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function SystemHealthPage() {
  const qc = useQueryClient();

  const { data: health, isLoading: healthLoading } = useQuery<SystemHealth>({
    queryKey: ['systemHealth'],
    queryFn: api.systemHealth,
    refetchInterval: 30_000,
  });

  const detectMut = useMutation({
    mutationFn: api.detectRelationships,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['allRelationships'] });
      qc.invalidateQueries({ queryKey: ['systemHealth'] });
      toast.success(`Detected ${res.detected} relationship${res.detected !== 1 ? 's' : ''}`);
    },
  });

  const handleRunChecks = () => {
    qc.invalidateQueries({ queryKey: ['dataQuality'] });
    qc.invalidateQueries({ queryKey: ['ingestionLog'] });
    qc.invalidateQueries({ queryKey: ['systemHealth'] });
    detectMut.mutate();
    toast.info('Running checks…');
  };

  return (
    <div className="max-w-3xl space-y-3 animate-fade-in">
      {/* U-12: macOS-only connectors */}
      <div
        className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
        style={{
          background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
          color: 'var(--fg-2)',
          border: '1px solid var(--border)',
        }}
      >
        <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
        <span>
          <strong>macOS recommended.</strong> Calendar and Outlook live watchers use AppleScript and are not supported on Linux or Windows.
          Teams/Jira browser scraping works on any OS with <code className="font-mono text-[10px]">BROWSER_PROFILE_PATH</code>.
          See <a href="/setup" className="underline" style={{ color: 'var(--accent)' }}>Setup</a> and GETTING-STARTED.md.
        </span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-2">
        <Activity size={14} style={{ color: 'var(--accent)' }} />
        <h1 className="text-sm font-semibold flex-1" style={{ color: 'var(--fg)' }}>System Health</h1>
        {health?.lastSync && (
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
            Last sync {relativeTime(health.lastSync)}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={handleRunChecks} disabled={detectMut.isPending}>
          <RefreshCw size={11} className={detectMut.isPending ? 'animate-spin' : ''} />
          <span className="ml-1">Run Checks</span>
        </Button>
      </div>

      {/* 3-col stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          icon={<AlertTriangle size={11} style={{ color: (health?.dataQuality.errors ?? 0) > 0 ? 'var(--danger)' : 'var(--muted)' }} />}
          label="Data Quality"
          value={healthLoading ? '…' : health?.dataQuality.open ?? 0}
          badge={
            (health?.dataQuality.errors ?? 0) > 0
              ? <Badge variant="danger">{health!.dataQuality.errors} error{health!.dataQuality.errors !== 1 ? 's' : ''}</Badge>
              : health?.dataQuality.open === 0
              ? <Badge variant="success">Clean</Badge>
              : undefined
          }
          note="open issues"
        />
        <StatCard
          icon={<AlertCircle size={11} style={{ color: (health?.actionTriage.pending ?? 0) > 0 ? '#fbbf24' : 'var(--muted)' }} />}
          label="Action Triage"
          value={healthLoading ? '…' : health?.actionTriage.pending ?? 0}
          note="pending review"
          linkTo="/action-items"
        />
        <StatCard
          icon={<Network size={11} style={{ color: 'var(--accent)' }} />}
          label="Relationships"
          value={healthLoading ? '…' : health?.relationships.total ?? 0}
          note="cross-topic links"
          action={{ label: 'Detect Now', onClick: () => detectMut.mutate(), loading: detectMut.isPending }}
        />
      </div>

      <DataQualitySection />
      <RelationshipsSection />
      <IngestionLogSection />
      <EmbeddingsSection health={health} />
    </div>
  );
}
