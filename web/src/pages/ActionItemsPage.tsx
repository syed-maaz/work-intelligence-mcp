import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ActionItem } from '@/lib/api';
import { SourceBadge } from '@/components/shared/SourceBadge';
import { SkeletonRow } from '@/components/shared/SkeletonCard';
import { EmptyState } from '@/components/shared/EmptyState';
import { Badge, Input, Select } from '@/components/ui';
import { CheckSquare, ChevronDown, ChevronRight, Clock, ThumbsUp, X } from 'lucide-react';
import { formatRelative, truncate } from '@/lib/utils';
import { toast } from 'sonner';

const STATUS_TABS = [
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Done' },
  { key: 'all', label: 'All' },
];

const STATUS_BADGE: Record<string, { variant: 'warning' | 'info' | 'success' | 'default'; label: string }> = {
  open:        { variant: 'warning', label: 'Open' },
  in_progress: { variant: 'info',    label: 'In Progress' },
  completed:   { variant: 'success', label: 'Done' },
};

function isOverdue(d: string | null) { return !!d && new Date(d) < new Date(); }
function isDueToday(d: string | null) {
  return !!d && d.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function ActionRow({ item }: { item: ActionItem }) {
  const [expanded, setExpanded] = useState(false);
  const s = STATUS_BADGE[item.status] ?? { variant: 'default' as const, label: item.status };
  const overdue = isOverdue(item.due_date);
  const today = isDueToday(item.due_date);

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--bg-3)] transition-colors"
      >
        <div className="mt-0.5 shrink-0">
          {expanded
            ? <ChevronDown size={11} style={{ color: 'var(--muted)' }} />
            : <ChevronRight size={11} style={{ color: 'var(--muted)' }} />
          }
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium leading-snug" style={{ color: 'var(--fg)' }}>
            {truncate(item.title, 100)}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <Badge variant={s.variant}>{s.label}</Badge>
            <SourceBadge source={item.source ?? ''} />
            {item.assignee && (
              <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{item.assignee}</span>
            )}
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{formatRelative(item.created_at)}</span>
          </div>
        </div>
        {item.due_date && (
          <span
            className="text-[10px] shrink-0 flex items-center gap-0.5"
            style={{ color: overdue ? '#ef4444' : today ? '#f59e0b' : 'var(--muted)' }}
          >
            <Clock size={9} />
            {overdue ? 'Overdue' : today ? 'Due today' : item.due_date}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-8 py-2 text-xs" style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>
          <p><strong>ID:</strong> {item.id}</p>
          {item.assignee && <p><strong>Assignee:</strong> {item.assignee}</p>}
          {item.due_date && <p><strong>Due:</strong> {item.due_date}</p>}
          <p><strong>Created:</strong> {formatRelative(item.created_at)}</p>
        </div>
      )}
    </div>
  );
}

function PendingReviewWidget() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['pendingReview'],
    queryFn: () => api.pendingReviewItems(),
    staleTime: 2 * 60 * 1000,
  });
  const items = data?.items ?? [];
  const confirmMut = useMutation({
    mutationFn: (id: number) => api.confirmActionItem(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pendingReview'] }); toast.success('Confirmed'); },
  });
  const dismissMut = useMutation({
    mutationFn: (id: number) => api.dismissActionItem(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pendingReview'] }); toast.success('Dismissed'); },
  });

  if (isLoading || items.length === 0) return null;

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <Clock size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Pending Review</span>
        <Badge variant="warning">{items.length}</Badge>
        <span className="text-[10px] ml-1" style={{ color: 'var(--muted)' }}>AI-extracted — confirm or dismiss</span>
      </div>
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {items.slice(0, 5).map(item => (
          <div key={item.id} className="flex items-start gap-2 px-3 py-1.5">
            <span className="flex-1 text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>
              {truncate(item.title, 120)}
              {item.assignee && <span className="ml-1.5 text-[10px]" style={{ color: 'var(--muted)' }}>→ {item.assignee}</span>}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => confirmMut.mutate(item.id)}
                disabled={confirmMut.isPending}
                className="p-1 rounded-md transition-colors hover:bg-[var(--bg-3)]"
                title="Confirm"
                style={{ color: 'var(--accent)' }}
              >
                <ThumbsUp size={11} />
              </button>
              <button
                onClick={() => dismissMut.mutate(item.id)}
                disabled={dismissMut.isPending}
                className="p-1 rounded-md transition-colors hover:bg-[var(--bg-3)]"
                title="Dismiss"
                style={{ color: 'var(--muted)' }}
              >
                <X size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ActionItemsPage() {
  const [status, setStatus] = useState('open');
  const [assignee, setAssignee] = useState('');
  const [topic, setTopic] = useState('');

  const { data: topics } = useQuery({ queryKey: ['topics'], queryFn: api.topics });

  const { data, isLoading } = useQuery({
    queryKey: ['action-items', status, assignee, topic],
    queryFn: () => api.actionItems({
      status,
      assignee: assignee || undefined,
      topic: topic || undefined,
    }),
  });

  const topicOptions = [
    { value: '', label: 'All topics' },
    ...(topics?.map((t) => ({ value: t.name, label: t.name })) ?? []),
  ];

  return (
    <div className="max-w-3xl space-y-3 animate-fade-in">
      {/* EP-35: Pending review widget */}
      <PendingReviewWidget />

      {/* Filters */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
          <CheckSquare size={12} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Action Items</span>
          {data && <Badge>{data.length}</Badge>}
        </div>

        {/* Filter row */}
        <div className="px-3 py-2 border-b flex flex-wrap items-end gap-2" style={{ borderColor: 'var(--border)' }}>
          <div className="flex-1 min-w-32">
            <Select
              id="topic"
              label="Topic"
              options={topicOptions}
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-32">
            <Input
              id="assignee"
              label="Assignee"
              placeholder="Filter by name…"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            />
          </div>
        </div>

        {/* Status tab strip */}
        <div className="flex border-b" style={{ borderColor: 'var(--border)' }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatus(tab.key)}
              className="px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                color: status === tab.key ? 'var(--accent)' : 'var(--muted)',
                borderBottom: status === tab.key ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Results */}
        {isLoading ? (
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} className="px-3" />)}
          </div>
        ) : !data?.length ? (
          <EmptyState
            icon={CheckSquare}
            title="No action items found"
            description="Try a different status filter or run a sync to populate data."
            className="border-0 rounded-none"
          />
        ) : (
          data.map((item) => <ActionRow key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}
