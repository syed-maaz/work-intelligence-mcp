import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { MarkdownPanel } from '@/components/shared/MarkdownPanel';
import { Button, Input } from '@/components/ui';
import { Search } from 'lucide-react';
import { toastError } from '@/lib/notifications';

const SOURCES = [
  { key: 'email', label: 'Email', color: '#f59e0b' },
  { key: 'jira', label: 'Jira', color: '#3b82f6' },
  { key: 'teams', label: 'Teams', color: '#8b5cf6' },
];

interface FormValues { query: string; since: string; jiraBoardUrl: string; maxResults: string; }

export default function SearchAllPage() {
  const [result, setResult] = useState<string | null>(null);
  const [selectedSources, setSelectedSources] = useState<string[]>(['email', 'jira', 'teams']);
  const [sortBy, setSortBy] = useState<'relevance' | 'recency'>('relevance');

  const { register, handleSubmit, watch } = useForm<FormValues>({
    defaultValues: { query: '', since: '', jiraBoardUrl: '', maxResults: '50' },
  });
  const query = watch('query');

  function toggleSource(key: string) {
    setSelectedSources((s) =>
      s.includes(key) ? s.filter((x) => x !== key) : [...s, key]
    );
  }

  const mutation = useMutation({
    mutationFn: (v: FormValues) => api.searchAll({
      query: v.query,
      sources: selectedSources.length < 3 ? selectedSources : undefined,
      since: v.since || undefined,
      jiraBoardUrl: v.jiraBoardUrl || undefined,
      maxResults: parseInt(v.maxResults) || 50,
      sortBy,
    }),
    onSuccess: (d) => setResult(d.markdown),
    onError: (e: Error) => toastError(e.message),
  });

  return (
    <div className="max-w-2xl space-y-3 animate-fade-in">
      {/* Description */}
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Fetches live from Outlook and Jira, combines with stored Teams data.
        Requires <code className="font-mono text-[11px]">BROWSER_PROFILE_PATH</code>.
      </p>

      {/* Form */}
      <form
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        className="rounded-xl border overflow-hidden"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
          <Search size={12} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Search All Sources</span>
        </div>

        <div className="p-3 space-y-3">
          <Input
            id="query"
            label="Search query *"
            placeholder='e.g. "authentication migration" or "Q4 planning"'
            {...register('query', { required: true })}
          />

          {/* U-15: sort order */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>Sort:</span>
            {(['relevance', 'recency'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSortBy(mode)}
                className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all border"
                style={{
                  background: sortBy === mode ? 'var(--accent)22' : 'var(--bg-3)',
                  borderColor: sortBy === mode ? 'var(--accent)' : 'var(--border)',
                  color: sortBy === mode ? 'var(--accent)' : 'var(--muted)',
                }}
              >
                {mode === 'relevance' ? 'Relevance' : 'Newest first'}
              </button>
            ))}
          </div>

          {/* Source toggles */}
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>Sources:</span>
            {SOURCES.map((s) => {
              const active = selectedSources.includes(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => toggleSource(s.key)}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all border"
                  style={{
                    background: active ? `${s.color}22` : 'var(--bg-3)',
                    borderColor: active ? s.color : 'var(--border)',
                    color: active ? s.color : 'var(--muted)',
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Input id="since" label="Since (default: 7d ago)" type="date" {...register('since')} />
            <Input id="maxResults" label="Max results / source" type="number" {...register('maxResults')} />
          </div>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                id="jiraBoardUrl"
                label="Jira board URL (optional)"
                placeholder="https://jira.example.com/secure/RapidBoard.jspa?..."
                {...register('jiraBoardUrl')}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              loading={mutation.isPending}
              disabled={!query.trim() || selectedSources.length === 0}
            >
              <Search size={12} />
              Search
            </Button>
          </div>
        </div>
      </form>

      <MarkdownPanel
        content={result ?? ''}
        isLoading={mutation.isPending}
        error={mutation.error?.message ?? null}
        title="Cross-source Results"
      />
    </div>
  );
}
