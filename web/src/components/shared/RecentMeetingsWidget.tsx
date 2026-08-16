import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, RefreshCw } from 'lucide-react';
import { api, type Meeting } from '@/lib/api';

function SkeletonItem() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <div className="skeleton w-1.5 h-1.5 rounded-full shrink-0" />
      <div className="skeleton h-2.5 rounded w-2/3" />
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
}

function MeetingTopicChips({ meetingId }: { meetingId: number }) {
  const { data } = useQuery({
    queryKey: ['meeting-topic-links', meetingId],
    queryFn: () => api.getMeetingTopicLinks(meetingId),
    staleTime: 5 * 60 * 1000,
  });
  const confirmed = data?.suggestions.filter(s => s.confirmed === 1) ?? [];
  if (confirmed.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {confirmed.map(t => (
        <span
          key={t.topic_id}
          className="text-[9px] px-1.5 py-0.5 rounded-full"
          style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}
        >
          {t.topic_name}
        </span>
      ))}
    </div>
  );
}

export function RecentMeetingsWidget() {
  const queryClient = useQueryClient();
  const { data: meetings, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['meetings-recent'],
    queryFn: () => api.recentMeetings(5),
    staleTime: 60_000,
  });

  const lastSync = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <div className="rounded-xl border overflow-hidden flex flex-col" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-1.5 shrink-0" style={{ borderColor: 'var(--border)' }}>
        <Users size={12} style={{ color: 'var(--muted)' }} />
        <h2 className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)' }}>Meetings</h2>
        {lastSync && (
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{lastSync}</span>
        )}
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['meetings-recent'] })}
          className="p-0.5 rounded hover:bg-[var(--bg-3)] transition-colors"
          style={{ color: 'var(--muted)' }}
          title="Refresh meetings"
        >
          <RefreshCw size={10} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => <SkeletonItem key={i} />)
          : meetings?.map((m: Meeting) => (
              <div key={m.id} className="px-3 py-1.5 hover:bg-[var(--bg-3)] transition-colors">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-medium truncate flex-1" style={{ color: 'var(--fg)' }}>
                    {m.chat_name ?? 'Unnamed'}
                  </p>
                  <span className="text-[10px] shrink-0" style={{ color: 'var(--muted)' }}>
                    {formatDate(m.timestamp)}
                  </span>
                </div>
                {m.summary && (
                  <p className="text-[10px] line-clamp-1 mt-0.5" style={{ color: 'var(--muted)' }}>{m.summary}</p>
                )}
                <MeetingTopicChips meetingId={m.id} />
              </div>
            ))
        }
        {!isLoading && !meetings?.length && (
          <p className="px-3 py-3 text-xs" style={{ color: 'var(--muted)' }}>No meetings stored</p>
        )}
      </div>
    </div>
  );
}
