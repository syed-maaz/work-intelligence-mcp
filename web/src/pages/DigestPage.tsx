import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, DigestRecord } from '@/lib/api';
import { MarkdownPanel } from '@/components/shared/MarkdownPanel';
import { TokenStatsWidget } from '@/components/shared/TokenStatsWidget';
import { ErrorLogSection } from '@/components/shared/ErrorLogSection';
import { Button, Select } from '@/components/ui';
import { BookOpen, RefreshCw, Trash2, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { format, subDays, startOfWeek, parseISO } from 'date-fns';

function ResearchStatsWidget() {
  const { data } = useQuery({
    queryKey: ['research-stats'],
    queryFn: () => fetch('/api/research/stats').then(r => r.json()),
    refetchInterval: 60_000,
  });
  if (!data || !data.totalInvocations) return null;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
      <div className="px-3 py-2 text-xs font-semibold" style={{ color: 'var(--fg-2)' }}>Claude Code Research</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, fontSize: 12 }}>
        <div><span style={{ color: 'var(--muted)' }}>Invocations</span><div style={{ fontSize: 16, fontWeight: 600 }}>{data.totalInvocations}</div></div>
        <div><span style={{ color: 'var(--muted)' }}>Avg Quality</span><div style={{ fontSize: 16, fontWeight: 600 }}>{(data.avgQuality ?? 0).toFixed(2)}</div></div>
        <div><span style={{ color: 'var(--muted)' }}>Cache Hits</span><div style={{ fontSize: 16, fontWeight: 600 }}>{data.cacheHits ?? 0}</div></div>
        <div><span style={{ color: 'var(--muted)' }}>Total Cost</span><div style={{ fontSize: 16, fontWeight: 600 }}>${(data.totalCost ?? 0).toFixed(2)}</div></div>
      </div>
    </div>
  );
}

interface FormValues { topic: string; date: string; }

function dateShortcut(label: string, date: Date) {
  return { label, value: format(date, 'yyyy-MM-dd') };
}

const today = new Date();
const shortcuts = [
  dateShortcut('Today', today),
  dateShortcut('Yesterday', subDays(today, 1)),
  dateShortcut('2 days ago', subDays(today, 2)),
  dateShortcut('Last Mon', startOfWeek(today, { weekStartsOn: 1 })),
];

function RecentDigestRow({ d, onLoad }: { d: DigestRecord; onLoad: (md: string) => void }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteDigest(d.id),
    onSuccess: () => {
      toast.success('Digest deleted');
      qc.invalidateQueries({ queryKey: ['digests'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-3)] transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
          {d.topic_name === '__daily_summary__' ? 'Daily Summary' : d.topic_name}
          <span style={{ color: 'var(--muted)' }}> · {d.date}</span>
        </p>
        <p className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>
          {format(parseISO(d.generated_at.replace(' ', 'T')), 'MMM d, h:mm a')}
        </p>
      </div>
      <button
        onClick={() => onLoad(d.markdown)}
        className="text-xs px-2 py-0.5 rounded-lg border transition-colors hover:bg-[var(--bg-3)]"
        style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
      >
        Load
      </button>
      <button
        onClick={() => del.mutate()}
        disabled={del.isPending}
        className="p-1 rounded-lg transition-colors disabled:opacity-50 hover:bg-[var(--bg-3)]"
        style={{ color: 'var(--muted)' }}
        title="Delete"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export default function DigestPage() {
  const [result, setResult] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);

  const { data: topics } = useQuery({ queryKey: ['topics'], queryFn: api.topics });
  const { data: recentData } = useQuery({
    queryKey: ['digests'],
    queryFn: () => api.listDigests(20),
    enabled: showRecent,
  });

  const topicOptions = [
    { value: '', label: 'Select a topic…' },
    ...(topics?.map((t) => ({ value: t.name, label: t.name })) ?? []),
  ];

  const { register, handleSubmit, watch, setValue } = useForm<FormValues>({
    defaultValues: { topic: '', date: format(today, 'yyyy-MM-dd') },
  });
  const topic = watch('topic');
  const currentDate = watch('date');

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      api.digest({ topic: v.topic, date: v.date || undefined }),
    onSuccess: (d) => {
      setResult(d.markdown);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const regenerate = () => mutation.mutate({ topic: watch('topic'), date: watch('date') });

  return (
    <div className="max-w-2xl space-y-3 animate-fade-in">
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        AI-generated summary of all activity for a topic on a given day.
      </p>

      {/* Form */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
          <BookOpen size={12} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Generate Digest</span>
        </div>

        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Select
              id="topic"
              label="Topic *"
              options={topicOptions}
              {...register('topic', { required: true })}
            />
            <div className="space-y-1">
              <label htmlFor="date" className="block text-xs font-medium" style={{ color: 'var(--fg-2)' }}>
                Date
              </label>
              <input
                id="date"
                type="date"
                className="w-full rounded-lg px-2.5 py-1.5 text-xs border focus:outline-none focus:ring-1 focus:ring-accent/40"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                {...register('date')}
              />
            </div>
          </div>

          {/* Date shortcuts */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>Quick:</span>
            {shortcuts.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setValue('date', s.value)}
                className="text-[10px] px-2 py-0.5 rounded border transition-colors hover:bg-[var(--bg-3)]"
                style={{
                  borderColor: currentDate === s.value ? 'var(--accent)' : 'var(--border)',
                  color: currentDate === s.value ? 'var(--accent)' : 'var(--muted)',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between pt-1">
            {result && (
              <button
                type="button"
                onClick={regenerate}
                disabled={mutation.isPending}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-50 hover:bg-[var(--bg-3)]"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                <RefreshCw size={10} />
                Regenerate
              </button>
            )}
            <div className="ml-auto">
              <Button type="submit" size="sm" loading={mutation.isPending} disabled={!topic}>
                <BookOpen size={12} />
                Generate
              </Button>
            </div>
          </div>
        </form>
      </div>

      <MarkdownPanel
        content={result ?? ''}
        isLoading={mutation.isPending}
        error={mutation.error?.message ?? null}
        title="Daily Digest"
      />

      {/* Recent digests */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <button
          className="w-full flex items-center justify-between px-3 py-2"
          onClick={() => setShowRecent((x) => !x)}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Recent Digests</span>
          <ChevronDown
            size={12}
            style={{ color: 'var(--muted)', transform: showRecent ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
          />
        </button>
        {showRecent && (
          <div className="border-t divide-y" style={{ borderColor: 'var(--border)' }}>
            {!recentData?.digests?.length ? (
              <p className="px-3 py-4 text-center text-xs" style={{ color: 'var(--muted)' }}>
                No digests saved yet
              </p>
            ) : (
              recentData.digests
                .filter((d) => d.topic_name !== '__daily_summary__')
                .map((d) => (
                  <RecentDigestRow
                    key={d.id}
                    d={d}
                    onLoad={(md) => setResult(md)}
                  />
                ))
            )}
          </div>
        )}
      </div>

      {/* Token usage stats */}
      <TokenStatsWidget />

      {/* Research engine stats */}
      <ResearchStatsWidget />

      {/* Error log */}
      <ErrorLogSection />
    </div>
  );
}
