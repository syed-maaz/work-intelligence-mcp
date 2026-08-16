import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, ChevronDown, ChevronRight, RefreshCw, FileText, Loader2, MessageSquare, Users, CheckSquare, Ticket, Sparkles } from 'lucide-react';
import { api, CalendarEvent, MeetingContext } from '../../lib/api';
import { MarkdownPanel } from './MarkdownPanel';
import { useUIStore } from '@/store/ui';

type ViewMode = 'today' | 'week';

const DOT_COLOR: Record<string, string> = {
  accepted: '#10b981',
  tentative: '#f59e0b',
  declined: '#6b7280',
  none: '#3b82f6',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function isToday(iso: string): boolean {
  return iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function groupByDay(events: CalendarEvent[]): Array<{ date: string; events: CalendarEvent[] }> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const day = ev.start_time.slice(0, 10);
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(ev);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, evs]) => ({ date, events: evs }));
}

// ── Meeting Context Panel ─────────────────────────────────────

function SectionHeader({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="text-[10px] font-semibold" style={{ color: 'var(--fg)' }}>{label}</span>
      {count > 0 && (
        <span
          className="text-[9px] px-1 rounded-full"
          style={{ background: 'var(--bg-3)', color: 'var(--muted)' }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex gap-2 items-center py-1 animate-pulse">
      <div className="w-2 h-2 rounded-full bg-[var(--border)] shrink-0" />
      <div className="flex-1 h-2.5 bg-[var(--border)] rounded" />
    </div>
  );
}

function MeetingContextPanel({ event }: { event: CalendarEvent }) {
  const sendToChat = useUIStore(s => s.sendToChat);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    messages: true, meetings: true, actions: true, jira: true,
  });

  const { data: ctx, isLoading } = useQuery<MeetingContext>({
    queryKey: ['meeting-context', event.id],
    queryFn: () => api.getMeetingContext(event.id),
    staleTime: 5 * 60 * 1000,
  });

  const toggle = (key: string) => setOpenSections(s => ({ ...s, [key]: !s[key] }));

  const handlePrepare = () => {
    const attendeeList = ctx?.attendees?.map(a => a.name).join(', ') ?? 'unknown attendees';
    const time = event.is_all_day ? 'All day' : formatTime(event.start_time);
    sendToChat(
      `Prepare me for my meeting: "${event.title}" at ${time} with ${attendeeList}. ` +
      `Give me key talking points, relevant context from recent messages, and any open action items.`
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-1.5 py-1">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  if (!ctx) return null;

  const sections = [
    {
      key: 'messages',
      label: 'Recent Messages',
      icon: <MessageSquare size={10} style={{ color: 'var(--muted)' }} />,
      items: ctx.recentMessages,
      render: (m: MeetingContext['recentMessages'][0]) => (
        <div key={m.id} className="py-0.5">
          <span className="font-medium" style={{ color: 'var(--fg)' }}>{m.author}: </span>
          <span style={{ color: 'var(--muted)' }}>{m.content.slice(0, 120)}{m.content.length > 120 ? '…' : ''}</span>
        </div>
      ),
    },
    {
      key: 'meetings',
      label: 'Past Meetings',
      icon: <Users size={10} style={{ color: 'var(--muted)' }} />,
      items: ctx.pastMeetings,
      render: (m: MeetingContext['pastMeetings'][0]) => (
        <div key={m.id} className="py-0.5">
          <span className="font-medium" style={{ color: 'var(--fg)' }}>{m.chat_name ?? m.title}: </span>
          {m.summary && <span style={{ color: 'var(--muted)' }}>{m.summary.slice(0, 100)}{m.summary.length > 100 ? '…' : ''}</span>}
        </div>
      ),
    },
    {
      key: 'actions',
      label: 'Open Action Items',
      icon: <CheckSquare size={10} style={{ color: 'var(--muted)' }} />,
      items: ctx.openActionItems,
      render: (a: MeetingContext['openActionItems'][0]) => (
        <div key={a.id} className="py-0.5">
          <span style={{ color: 'var(--fg)' }}>{a.title}</span>
          {a.assignee && <span className="ml-1" style={{ color: 'var(--muted)' }}>— {a.assignee}</span>}
        </div>
      ),
    },
    {
      key: 'jira',
      label: 'Jira Tickets',
      icon: <Ticket size={10} style={{ color: 'var(--muted)' }} />,
      items: ctx.jiraTickets,
      render: (t: MeetingContext['jiraTickets'][0]) => (
        <div key={t.issue_key} className="py-0.5">
          <span className="font-medium" style={{ color: 'var(--accent)' }}>{t.issue_key}: </span>
          <span style={{ color: 'var(--fg)' }}>{t.summary.slice(0, 80)}{t.summary.length > 80 ? '…' : ''}</span>
          <span className="ml-1" style={{ color: 'var(--muted)' }}>[{t.status}]</span>
        </div>
      ),
    },
  ] as const;

  const hasAny = sections.some(s => s.items.length > 0);

  return (
    <div className="space-y-2">
      {/* Prepare me button */}
      <button
        onClick={handlePrepare}
        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border transition-colors hover:bg-[var(--bg-3)]"
        style={{ color: 'var(--accent)', borderColor: 'var(--border)' }}
      >
        <Sparkles size={10} />
        Prepare me
      </button>

      {!hasAny && (
        <p className="text-[10px]" style={{ color: 'var(--muted)' }}>No context found for this meeting.</p>
      )}

      {sections.map(({ key, label, icon, items, render }) => {
        if (items.length === 0) return null;
        const open = openSections[key] ?? true;
        return (
          <div key={key}>
            <button
              className="flex items-center gap-1 w-full hover:opacity-80 transition-opacity"
              onClick={() => toggle(key)}
            >
              <SectionHeader icon={icon} label={label} count={items.length} />
              <span className="ml-auto" style={{ color: 'var(--muted)' }}>
                {open ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
              </span>
            </button>
            {open && (
              <div className="mt-1 pl-1 text-[10px] space-y-0.5" style={{ color: 'var(--muted)' }}>
                {(items as unknown[]).map((item) => render(item as never))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Event Row ─────────────────────────────────────────────────

function EventRow({ event }: { event: CalendarEvent }) {
  const [expanded, setExpanded] = useState<'brief' | 'context' | null>(null);
  const queryClient = useQueryClient();
  const status = event.response_status ?? 'none';
  const dot = DOT_COLOR[status] ?? DOT_COLOR.none;
  const faded = status === 'declined';
  const hasBrief = !!event.pre_brief;

  const regenMutation = useMutation({
    mutationFn: () => api.regeneratePreBrief(event.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });

  return (
    <div style={{ opacity: faded ? 0.45 : 1 }}>
      <div
        className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-[var(--bg-3)] rounded px-1 -mx-1 transition-colors"
        onClick={() => !event.is_all_day && setExpanded(e => e === 'context' ? null : 'context')}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
        <span className="w-16 shrink-0 text-right text-[10px] tabular-nums" style={{ color: 'var(--muted)' }}>
          {event.is_all_day ? 'All day' : formatTime(event.start_time)}
        </span>
        <span
          className="text-xs truncate flex-1"
          style={{ color: 'var(--fg)', textDecoration: status === 'declined' ? 'line-through' : 'none' }}
        >
          {event.title}
        </span>
        {/* Brief badge + controls */}
        <div className="flex items-center gap-1 shrink-0">
          {hasBrief && (
            <span
              className="text-[9px] px-1 py-0.5 rounded font-medium"
              style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}
            >
              Brief ready
            </span>
          )}
          {!hasBrief && !event.is_all_day && (
            <button
              onClick={e => { e.stopPropagation(); regenMutation.mutate(); }}
              disabled={regenMutation.isPending}
              className="text-[9px] px-1 py-0.5 rounded hover:bg-[var(--bg-3)] transition-colors"
              style={{ color: 'var(--muted)' }}
              title="Generate pre-meeting brief"
            >
              {regenMutation.isPending ? <Loader2 size={10} className="animate-spin" /> : <FileText size={10} />}
            </button>
          )}
          {hasBrief && (
            <button
              onClick={e => { e.stopPropagation(); setExpanded(x => x === 'brief' ? null : 'brief'); }}
              className="p-0.5 hover:bg-[var(--bg-3)] rounded transition-colors"
              style={{ color: 'var(--muted)' }}
            >
              {expanded === 'brief' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
          )}
          {!event.is_all_day && (
            <span style={{ color: 'var(--muted)' }}>
              {expanded === 'context' ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </span>
          )}
        </div>
      </div>

      {/* Pre-brief expand panel */}
      {expanded === 'brief' && hasBrief && (
        <div
          className="ml-5 mr-1 mb-2 p-2 rounded-lg border text-[11px]"
          style={{ background: 'var(--bg-3)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold" style={{ color: 'var(--muted)' }}>Pre-Meeting Brief</span>
            <button
              onClick={() => regenMutation.mutate()}
              disabled={regenMutation.isPending}
              className="text-[10px] flex items-center gap-0.5 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--muted)' }}
            >
              {regenMutation.isPending ? <Loader2 size={9} className="animate-spin" /> : <RefreshCw size={9} />}
              Regenerate
            </button>
          </div>
          <MarkdownPanel content={event.pre_brief!} />
        </div>
      )}

      {/* Meeting context panel */}
      {expanded === 'context' && !event.is_all_day && (
        <div
          className="ml-5 mr-1 mb-2 p-2 rounded-lg border"
          style={{ background: 'var(--bg-3)', borderColor: 'var(--border)' }}
        >
          <MeetingContextPanel event={event} />
        </div>
      )}
    </div>
  );
}

export function TodaysCalendarSection() {
  const [view, setView] = useState<ViewMode>('today');
  const days = view === 'today' ? 1 : 7;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['calendar', days],
    queryFn: () => api.upcomingCalendar({ days }),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });

  const allEvents = data?.events ?? [];
  const todayEvents = allEvents.filter(ev => isToday(ev.start_time) || ev.is_all_day);
  const filtered = view === 'today' ? todayEvents : allEvents;
  const grouped = groupByDay(filtered);
  const todayCount = todayEvents.length;

  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-1.5">
          <Calendar size={12} style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Calendar</span>
          {todayCount > 0 && (
            <span className="text-[10px] px-1 rounded" style={{ background: 'var(--bg-3)', color: 'var(--muted)' }}>
              {todayCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setView(v => v === 'today' ? 'week' : 'today')}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors hover:bg-[var(--bg-3)]"
            style={{ color: 'var(--muted)' }}
          >
            {view === 'today' ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {view === 'today' ? 'Today' : 'Week'}
          </button>
          <button
            onClick={() => refetch()}
            className="p-1 rounded transition-colors hover:bg-[var(--bg-3)]"
            style={{ color: 'var(--muted)' }}
            title="Refresh"
          >
            <RefreshCw size={11} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-3 py-1 min-h-0">
        {isLoading ? (
          <div className="space-y-2 py-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex gap-2 items-center animate-pulse">
                <div className="w-1.5 h-1.5 rounded-full bg-[var(--border)]" />
                <div className="w-12 h-3 bg-[var(--border)] rounded" />
                <div className="flex-1 h-3 bg-[var(--border)] rounded" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs py-3 text-center" style={{ color: 'var(--muted)' }}>
            No events {view === 'today' ? 'today' : 'this week'}
          </p>
        ) : (
          <div>
            {grouped.map(({ date, events: dayEvents }) => (
              <div key={date}>
                {view === 'week' && (
                  <p
                    className="text-xs font-semibold pt-2 pb-1"
                    style={{ color: isToday(date) ? 'var(--accent)' : 'var(--muted)' }}
                  >
                    {isToday(date) ? 'Today' : formatDayLabel(date)}
                  </p>
                )}
                {dayEvents.map(ev => <EventRow key={ev.id} event={ev} />)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
