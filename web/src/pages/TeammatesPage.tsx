import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, Plus, Star, StarOff, Trash2, RefreshCw, ChevronRight, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TeamMember, MemberFullProfile } from '@/lib/api';

function activityColor(level: string | null): string {
  switch (level) {
    case 'high': return 'var(--accent)';
    case 'medium': return '#f59e0b';
    case 'low': return 'var(--muted)';
    case 'new': return '#8b5cf6';
    default: return 'var(--muted)';
  }
}

function workloadBadge(signal: string | null) {
  const map: Record<string, { label: string; color: string }> = {
    available: { label: 'Available', color: '#10b981' },
    busy: { label: 'Busy', color: '#f59e0b' },
    overloaded: { label: 'Overloaded', color: 'var(--danger)' },
    unknown: { label: 'Unknown', color: 'var(--muted)' },
  };
  const s = signal ?? 'unknown';
  const { label, color } = map[s] ?? map.unknown;
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: `${color}20`, color }}>
      {label}
    </span>
  );
}

function AddMemberModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', github_handle: '', jira_username: '', teams_display_name: '' });
  const mutation = useMutation({
    mutationFn: () => api.addTeammate({
      name: form.name,
      email: form.email || undefined,
      github_handle: form.github_handle || undefined,
      jira_username: form.jira_username || undefined,
      teams_display_name: form.teams_display_name || undefined,
    }),
    onSuccess: () => { toast.success('Member added'); onAdded(); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const field = (label: string, key: keyof typeof form, required = false) => (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--fg-2)' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      <input
        className="w-full px-2.5 py-1.5 text-xs rounded-lg border"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={key === 'name' ? 'Alice Chen' : key === 'github_handle' ? 'alice-gh' : ''}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border p-5 space-y-4"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Add Team Member</h2>
          <button onClick={onClose} style={{ color: 'var(--muted)' }}><X size={14} /></button>
        </div>
        {field('Name', 'name', true)}
        {field('Email', 'email')}
        {field('GitHub Handle', 'github_handle')}
        {field('Jira Username', 'jira_username')}
        {field('Teams Display Name', 'teams_display_name')}
        <div className="flex gap-2 pt-1">
          <button
            className="flex-1 px-3 py-1.5 text-xs rounded-lg border transition-colors hover:bg-[var(--bg-3)]"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-2)' }}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="flex-1 px-3 py-1.5 text-xs rounded-lg font-medium transition-colors"
            style={{ background: 'var(--accent)', color: 'white' }}
            disabled={!form.name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Adding…' : 'Add Member'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfilePanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<MemberFullProfile>({
    queryKey: ['teammate-profile', id],
    queryFn: () => api.teammateProfile(id),
  });

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 w-full max-w-sm border-l flex flex-col"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Profile</span>
        <button onClick={onClose} style={{ color: 'var(--muted)' }}><X size={14} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {isLoading && <p className="text-xs" style={{ color: 'var(--muted)' }}>Loading…</p>}
        {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>Failed to load profile</p>}
        {data && (
          <>
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{data.member.name}</p>
              {data.member.email && <p className="text-xs" style={{ color: 'var(--muted)' }}>{data.member.email}</p>}
              {data.member.github_handle && (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>@{data.member.github_handle}</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              {workloadBadge(data.profile.workload_signal)}
              {data.profile.activity_level && (
                <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: `${activityColor(data.profile.activity_level)}20`, color: activityColor(data.profile.activity_level) }}>
                  {data.profile.activity_level}
                </span>
              )}
              {data.profile.activity_score != null && (
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  score: {data.profile.activity_score.toFixed(2)}
                </span>
              )}
            </div>

            {data.profile.summary && (
              <p className="text-xs leading-relaxed" style={{ color: 'var(--fg-2)' }}>{data.profile.summary}</p>
            )}

            {data.profile.domains.length > 0 && (
              <div>
                <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--fg)' }}>Domains</p>
                <div className="flex flex-wrap gap-1.5">
                  {data.profile.domains.map(d => (
                    <span key={d} className="text-xs px-2 py-0.5 rounded-full border" style={{ borderColor: 'var(--border)', color: 'var(--fg-2)' }}>{d}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="p-2.5 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--fg)' }}>Jira</p>
                <p className="text-xs" style={{ color: 'var(--fg-2)' }}>{data.profile.jira_open_count} open</p>
                {data.profile.jira_overdue_count > 0 && (
                  <p className="text-xs" style={{ color: 'var(--danger)' }}>{data.profile.jira_overdue_count} overdue</p>
                )}
              </div>
              {data.profile.top_topics.length > 0 && (
                <div className="p-2.5 rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                  <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--fg)' }}>Top Topic</p>
                  <p className="text-xs" style={{ color: 'var(--fg-2)' }}>{data.profile.top_topics[0]?.name}</p>
                </div>
              )}
            </div>

            {data.profile.code_files_owned.length > 0 && (
              <div>
                <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--fg)' }}>Code Ownership</p>
                {data.profile.code_files_owned.map(f => (
                  <p key={f} className="text-xs font-mono truncate" style={{ color: 'var(--muted)' }}>{f}</p>
                ))}
              </div>
            )}

            {data.profile.profile_content && (
              <div>
                <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--fg)' }}>AI Profile</p>
                <div
                  className="text-xs leading-relaxed whitespace-pre-wrap p-3 rounded-lg border"
                  style={{ borderColor: 'var(--border)', color: 'var(--fg-2)', background: 'var(--bg)' }}
                >
                  {data.profile.profile_content}
                </div>
              </div>
            )}

            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Updated {new Date(data.profile.last_updated).toLocaleDateString()}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function TeammatesPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: members = [], isLoading } = useQuery<TeamMember[]>({
    queryKey: ['teammates'],
    queryFn: api.teammates,
    refetchInterval: 60_000,
  });

  const markMutation = useMutation({
    mutationFn: ({ id, marked }: { id: number; marked: boolean }) => api.markTeammate(id, marked),
    onSuccess: () => { toast.success('Updated'); qc.invalidateQueries({ queryKey: ['teammates'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteTeammate(id),
    onSuccess: () => { toast.success('Member archived'); qc.invalidateQueries({ queryKey: ['teammates'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncMutation = useMutation({
    mutationFn: api.teammatesSync,
    onSuccess: (d) => toast.success(`Rebuilding ${d.count} profiles in background`),
    onError: (e: Error) => toast.error(e.message),
  });

  const marked = members.filter(m => m.marked === 1);
  const unmarked = members.filter(m => m.marked === 0);

  return (
    <div className="flex-1 overflow-y-auto p-4" style={{ color: 'var(--fg)' }}>
      {showAdd && (
        <AddMemberModal onClose={() => setShowAdd(false)} onAdded={() => qc.invalidateQueries({ queryKey: ['teammates'] })} />
      )}
      {selectedId != null && (
        <ProfilePanel id={selectedId} onClose={() => setSelectedId(null)} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Users size={14} style={{ color: 'var(--accent)' }} />
          <h1 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Team Members</h1>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{members.length} total</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors hover:bg-[var(--bg-3)]"
            style={{ borderColor: 'var(--border)', color: 'var(--fg-2)' }}
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            title="Rebuild all marked profiles"
          >
            <RefreshCw size={11} className={syncMutation.isPending ? 'animate-spin' : ''} />
            Sync
          </button>
          <button
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg font-medium"
            style={{ background: 'var(--accent)', color: 'white' }}
            onClick={() => setShowAdd(true)}
          >
            <Plus size={11} />
            Add Member
          </button>
        </div>
      </div>

      {isLoading && <p className="text-xs" style={{ color: 'var(--muted)' }}>Loading…</p>}

      {/* Marked members */}
      {marked.length > 0 && (
        <section className="mb-6">
          <p className="text-xs font-semibold px-1 mb-2" style={{ color: 'var(--muted)' }}>
            ● MARKED MEMBERS ({marked.length})
          </p>
          <div className="space-y-2">
            {marked.map(m => (
              <div
                key={m.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border"
                style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--fg)' }}>{m.name}</span>
                    {m.profile && workloadBadge(m.profile.workload_signal)}
                    {m.profile?.activity_level && (
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: activityColor(m.profile.activity_level) }} title={m.profile.activity_level} />
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {m.profile?.domains?.slice(0, 3).map(d => (
                      <span key={d}>{d}</span>
                    ))}
                    {m.profile && (
                      <>
                        <span>·</span>
                        <span>{m.profile.jira_open_count} open</span>
                        {m.profile.jira_overdue_count > 0 && (
                          <span style={{ color: 'var(--danger)' }}>{m.profile.jira_overdue_count} overdue</span>
                        )}
                      </>
                    )}
                    {m.last_active && (
                      <>
                        <span>·</span>
                        <span>active {new Date(m.last_active).toLocaleDateString()}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors hover:bg-[var(--bg-3)]"
                    style={{ borderColor: 'var(--border)', color: 'var(--fg-2)' }}
                    onClick={() => setSelectedId(m.id)}
                  >
                    View <ChevronRight size={10} />
                  </button>
                  <button
                    title="Unmark"
                    className="p-1 rounded transition-colors hover:bg-[var(--bg-3)]"
                    style={{ color: 'var(--accent)' }}
                    onClick={() => markMutation.mutate({ id: m.id, marked: false })}
                  >
                    <Star size={13} fill="currentColor" />
                  </button>
                  <button
                    title="Archive member"
                    className="p-1 rounded transition-colors hover:bg-[var(--bg-3)]"
                    style={{ color: 'var(--muted)' }}
                    onClick={() => deleteMutation.mutate(m.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Unmarked members */}
      {unmarked.length > 0 && (
        <section>
          <p className="text-xs font-semibold px-1 mb-2" style={{ color: 'var(--muted)' }}>
            ○ OTHER MEMBERS ({unmarked.length})
          </p>
          <div className="space-y-1.5">
            {unmarked.map(m => (
              <div
                key={m.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg border"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              >
                <div className="flex-1 min-w-0">
                  <span className="text-xs truncate" style={{ color: 'var(--fg-2)' }}>{m.name}</span>
                  {m.last_active && (
                    <span className="text-xs ml-2" style={{ color: 'var(--muted)' }}>
                      active {new Date(m.last_active).toLocaleDateString()}
                    </span>
                  )}
                  <span className="text-xs ml-2" style={{ color: 'var(--muted)' }}>
                    · {m.message_count} msgs
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    title="Mark for profiling"
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors hover:bg-[var(--bg-3)]"
                    style={{ borderColor: 'var(--border)', color: 'var(--fg-2)' }}
                    onClick={() => markMutation.mutate({ id: m.id, marked: true })}
                  >
                    <StarOff size={11} />
                    Mark
                  </button>
                  <button
                    title="Archive member"
                    className="p-1 rounded transition-colors hover:bg-[var(--bg-3)]"
                    style={{ color: 'var(--muted)' }}
                    onClick={() => deleteMutation.mutate(m.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!isLoading && members.length === 0 && (
        <div className="text-center py-16">
          <Users size={32} className="mx-auto mb-3" style={{ color: 'var(--border)' }} />
          <p className="text-xs" style={{ color: 'var(--muted)' }}>No team members yet. Add someone to get started.</p>
        </div>
      )}
    </div>
  );
}
