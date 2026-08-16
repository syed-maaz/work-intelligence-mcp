import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Topic, type TopicSuggestion, type TopicHealth } from '@/lib/api';
import { SkeletonRow } from '@/components/shared/SkeletonCard';
import { EmptyState } from '@/components/shared/EmptyState';
import { Badge, Button, Input, Textarea } from '@/components/ui';
import { Settings, Plus, X, Check, Lightbulb, MessageSquare, Users, Pencil, Trash2, AlertTriangle, FolderOpen, UploadCloud } from 'lucide-react';
import { formatRelative } from '@/lib/utils';
import { toast } from 'sonner';

interface FormValues {
  name: string;
  teamsChannels: string;
  emailFilter: string;
  jiraProjects: string;
}

// ── Delete Confirmation Dialog ────────────────────────────────

function DeleteConfirmDialog({
  topic,
  onConfirm,
  onCancel,
  isPending,
}: {
  topic: Topic;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-xl border p-6 w-full max-w-sm shadow-2xl space-y-4"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(239,68,68,0.1)' }}>
            <AlertTriangle size={15} style={{ color: '#ef4444' }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Delete topic?</h3>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
              This will permanently delete <span className="font-semibold" style={{ color: 'var(--fg)' }}>{topic.name}</span> and all its action items, sync state, notebooks, and digests. This cannot be undone.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            variant="secondary"
            loading={isPending}
            onClick={onConfirm}
            style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}
          >
            <Trash2 size={12} />
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Topic Suggestions Section ────────────────────────────────

function TopicSuggestionsSection({ onConfigure }: { onConfigure: (keyword: string) => void }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['topic-suggestions'],
    queryFn: api.topicSuggestions,
  });

  const dismissMutation = useMutation({
    mutationFn: (id: number) => api.dismissTopicSuggestion(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topic-suggestions'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const suggestions = data?.suggestions ?? [];

  if (!isLoading && suggestions.length === 0) return null;

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)' }}>
        <Lightbulb size={12} style={{ color: '#f59e0b' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Suggested Topics</h2>
        {suggestions.length > 0 && <Badge variant="warning">{suggestions.length} new</Badge>}
      </div>

      {isLoading ? (
        <div>{Array.from({ length: 2 }).map((_, i) => <SkeletonRow key={i} className="px-3" />)}</div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {suggestions.map((s: TopicSuggestion) => (
            <div key={s.id} className="px-3 py-2 hover:bg-[var(--bg-3)] transition-colors">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold font-mono" style={{ color: 'var(--fg)' }}>{s.keyword}</span>
                    <span className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--muted)' }}>
                      <MessageSquare size={9} /> {s.message_count}
                    </span>
                    <span className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--muted)' }}>
                      <Users size={9} /> {s.author_count} people
                    </span>
                  </div>
                  {s.sample_msgs.length > 0 && (
                    <p className="text-[10px] mt-0.5 line-clamp-1 italic" style={{ color: 'var(--muted)' }}>
                      "{s.sample_msgs[0]}"
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="secondary" onClick={() => onConfigure(s.keyword)}>
                    <Plus size={10} />
                    Configure
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={dismissMutation.isPending && dismissMutation.variables === s.id}
                    onClick={() => dismissMutation.mutate(s.id)}
                  >
                    <X size={10} />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Topics Page ──────────────────────────────────────────────

function VaultStatusCard() {
  const { data: vaultStatus } = useQuery({
    queryKey: ['vaultStatus'],
    queryFn: () => api.getVaultStatus(),
    staleTime: 30 * 1000,
  });

  const exportMutation = useMutation({
    mutationFn: () => api.exportVault(),
    onSuccess: (result) => {
      toast.success(`Exported ${result.exported} notes to vault`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-3)' }}>
        <FolderOpen size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Obsidian Vault</span>
      </div>
      <div className="px-3 py-3">
        {!vaultStatus ? (
          <div className="h-8 animate-pulse rounded" style={{ background: 'var(--border)' }} />
        ) : vaultStatus.configured ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-xs" style={{ color: 'var(--fg)' }}>
                Connected · {vaultStatus.noteCount} notes
              </span>
            </div>
            <p className="text-[10px] font-mono truncate" style={{ color: 'var(--muted)' }}>
              {vaultStatus.vaultPath}
            </p>
            <button
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
              style={{ background: 'var(--bg-3)', color: 'var(--fg)', border: '1px solid var(--border)' }}
            >
              <UploadCloud size={11} className={exportMutation.isPending ? 'animate-pulse' : ''} />
              {exportMutation.isPending ? 'Exporting…' : 'Export Now'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />
              <span className="text-xs" style={{ color: 'var(--muted)' }}>Not configured</span>
            </div>
            <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
              Set <code className="text-[10px] px-1 rounded" style={{ background: 'var(--bg-3)' }}>OBSIDIAN_VAULT_PATH</code> in .env to mirror notebooks to an Obsidian vault
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TopicsPage() {
  const [showForm, setShowForm] = useState(false);
  const [editingTopic, setEditingTopic] = useState<Topic | null>(null);
  const [deletingTopic, setDeletingTopic] = useState<Topic | null>(null);
  const qc = useQueryClient();

  const { data: topics, isLoading } = useQuery({
    queryKey: ['topics'], queryFn: api.topics,
  });
  const { data: syncState } = useQuery({
    queryKey: ['sync-state'], queryFn: api.syncState,
  });
  const { data: healthData } = useQuery({
    queryKey: ['topics-health'], queryFn: api.topicHealth,
    staleTime: 60_000,
  });
  const healthByName = (healthData?.topics ?? []).reduce<Record<string, TopicHealth>>((acc, h) => {
    acc[h.topic_name] = h;
    return acc;
  }, {});

  const syncByTopic = (syncState ?? []).reduce<Record<string, typeof syncState>>((acc, s) => {
    const key = s.topic_id;
    if (!acc[key]) acc[key] = [];
    acc[key]!.push(s);
    return acc;
  }, {});

  const { register, handleSubmit, reset, setValue, formState: { errors } } = useForm<FormValues>({
    defaultValues: { name: '', teamsChannels: '', emailFilter: '', jiraProjects: '' },
  });

  const saveMutation = useMutation({
    mutationFn: async (v: FormValues): Promise<Topic | { topic: Topic }> => {
      const sources = {
        ...(v.teamsChannels ? { teams: { channels: v.teamsChannels.split('\n').map((s) => s.trim()).filter(Boolean) } } : {}),
        ...(v.emailFilter ? { email: { filters: v.emailFilter } } : {}),
        ...(v.jiraProjects ? { jira: { projects: v.jiraProjects.split(',').map((s) => s.trim()).filter(Boolean) } } : {}),
      };
      if (editingTopic) {
        return api.updateTopic(editingTopic.id, { name: v.name, config: sources });
      }
      return api.configureTopic({ name: v.name, sources });
    },
    onSuccess: () => {
      toast.success(editingTopic ? 'Topic updated' : 'Topic configured');
      closeForm();
      qc.invalidateQueries({ queryKey: ['topics'] });
      qc.invalidateQueries({ queryKey: ['sync-state'] });
      qc.invalidateQueries({ queryKey: ['topic-suggestions'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteTopic(id),
    onSuccess: () => {
      toast.success('Topic deleted');
      setDeletingTopic(null);
      qc.invalidateQueries({ queryKey: ['topics'] });
      qc.invalidateQueries({ queryKey: ['sync-state'] });
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setDeletingTopic(null);
    },
  });

  function closeForm() {
    reset();
    setShowForm(false);
    setEditingTopic(null);
  }

  function handleEdit(topic: Topic) {
    setEditingTopic(topic);
    setValue('name', topic.name);
    if (topic.config) {
      try {
        const cfg = typeof topic.config === 'string' ? JSON.parse(topic.config) : topic.config;
        setValue('teamsChannels', (cfg?.teams?.channels as string[] | undefined)?.join('\n') ?? '');
        setValue('emailFilter', (cfg?.email?.filters as string | undefined) ?? '');
        setValue('jiraProjects', (cfg?.jira?.projects as string[] | undefined)?.join(', ') ?? '');
      } catch {
        // ignore parse errors
      }
    } else {
      setValue('teamsChannels', '');
      setValue('emailFilter', '');
      setValue('jiraProjects', '');
    }
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleConfigureSuggestion(keyword: string) {
    setEditingTopic(null);
    setValue('name', keyword);
    setValue('teamsChannels', '');
    setValue('emailFilter', '');
    setValue('jiraProjects', '');
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="max-w-2xl space-y-3 animate-fade-in">
      {deletingTopic && (
        <DeleteConfirmDialog
          topic={deletingTopic}
          onConfirm={() => deleteMutation.mutate(deletingTopic.id)}
          onCancel={() => setDeletingTopic(null)}
          isPending={deleteMutation.isPending}
        />
      )}

      {/* Auto-discovered suggestions at top */}
      <TopicSuggestionsSection onConfigure={handleConfigureSuggestion} />

      {/* New / Edit topic form */}
      {showForm && (
        <form
          onSubmit={handleSubmit((v) => saveMutation.mutate(v))}
          className="rounded-xl border overflow-hidden"
          style={{ background: 'var(--bg-2)', borderColor: editingTopic ? 'var(--accent)' : 'var(--border)' }}
        >
          <div className="px-3 py-2 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-1.5">
              {editingTopic ? <Pencil size={11} style={{ color: 'var(--accent)' }} /> : <Plus size={11} style={{ color: 'var(--muted)' }} />}
              <span className="text-xs font-semibold" style={{ color: editingTopic ? 'var(--accent)' : 'var(--fg)' }}>
                {editingTopic ? `Editing "${editingTopic.name}"` : 'New Topic'}
              </span>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={closeForm}>
              <X size={11} />
            </Button>
          </div>
          <div className="p-3 space-y-2">
            <Input
              id="name"
              label="Topic name *"
              placeholder="PROJ, Project Alpha…"
              {...register('name', { required: 'Required' })}
            />
            {errors.name && <p className="text-xs" style={{ color: 'var(--danger)' }}>{errors.name.message}</p>}

            <Input
              id="emailFilter"
              label="Email subject filter"
              placeholder="PROJ, Project Alpha…"
              {...register('emailFilter')}
            />

            <Input
              id="jiraProjects"
              label="Jira project keys (comma-separated)"
              placeholder="PROJ, INFRA, PLATFORM"
              {...register('jiraProjects')}
            />

            <Textarea
              id="teamsChannels"
              label="Teams channel URLs (one per line)"
              placeholder="https://teams.microsoft.com/..."
              rows={2}
              {...register('teamsChannels')}
            />

            <div className="flex justify-end">
              <Button type="submit" size="sm" loading={saveMutation.isPending}>
                <Check size={11} />
                {editingTopic ? 'Update Topic' : 'Save Topic'}
              </Button>
            </div>
          </div>
        </form>
      )}

      {/* Topics list */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <div className="px-3 py-2 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-1.5">
            <Settings size={12} style={{ color: 'var(--muted)' }} />
            <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Configured Topics</span>
            {topics && <Badge>{topics.length}</Badge>}
          </div>
          <Button size="sm" variant="secondary" onClick={() => { if (showForm && !editingTopic) closeForm(); else { setEditingTopic(null); reset(); setShowForm(true); } }}>
            {showForm && !editingTopic ? <X size={11} /> : <Plus size={11} />}
            {showForm && !editingTopic ? 'Cancel' : 'New Topic'}
          </Button>
        </div>

        {isLoading ? (
          <div>{Array.from({ length: 3 }).map((_, i) => <SkeletonRow key={i} className="px-3" />)}</div>
        ) : !topics?.length ? (
          <EmptyState
            icon={Settings}
            title="No topics configured"
            description='Click "New Topic" to set up your first project to monitor.'
            className="border-0 rounded-none"
          />
        ) : (
          topics.map((t) => {
            const syncs = syncByTopic[String(t.id)] ?? [];
            const lastSync = syncs.reduce((acc: string | null, s) =>
              !acc || s.last_synced_at > acc ? s.last_synced_at : acc, null);
            const isBeingEdited = editingTopic?.id === t.id;
            return (
              <div
                key={t.id}
                className="px-3 py-2 hover:bg-[var(--bg-3)] transition-colors group"
                style={{
                  borderBottom: '1px solid var(--border)',
                  background: isBeingEdited ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : undefined,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {healthByName[t.name] && (
                      <span
                        style={{
                          display: 'inline-block',
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: healthByName[t.name]!.color === 'green'
                            ? 'var(--success, #22c55e)'
                            : healthByName[t.name]!.color === 'yellow'
                            ? '#f59e0b'
                            : '#ef4444',
                        }}
                        title={`Health: ${(healthByName[t.name]!.health_score * 100).toFixed(0)}%`}
                      />
                    )}
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--fg)' }}>{t.name}</span>
                    {isBeingEdited && (
                      <span className="text-[9px] px-1 py-0.5 rounded font-mono shrink-0" style={{ background: 'rgba(99,102,241,0.15)', color: 'var(--accent)' }}>
                        editing
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                      {lastSync ? `Synced ${formatRelative(lastSync)}` : 'Never synced'}
                    </span>
                    {/* Action buttons — visible on hover */}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleEdit(t)}
                        title="Edit topic"
                      >
                        <Pencil size={11} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeletingTopic(t)}
                        title="Delete topic"
                        style={{ color: '#ef4444' }}
                      >
                        <Trash2 size={11} />
                      </Button>
                    </div>
                  </div>
                </div>
                {syncs.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {syncs.map((s) => (
                      <span
                        key={s.source}
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono"
                        style={{ background: 'var(--bg-3)', color: 'var(--muted)' }}
                      >
                        {s.source} · {s.last_message_count.toLocaleString()} msgs
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <VaultStatusCard />
    </div>
  );
}
