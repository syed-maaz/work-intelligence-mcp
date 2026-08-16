import { formatDistanceToNowStrict } from 'date-fns';
import { MessageSquare, Users } from 'lucide-react';
import type { ChatSummary } from '@/lib/api';

function activityDot(c: ChatSummary): string {
  if (c.last24hCount > 0) return '#10b981'; // green
  if (c.last7dCount > 0) return '#f59e0b';  // amber
  return 'var(--muted)';                     // gray
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  try { return formatDistanceToNowStrict(new Date(iso), { addSuffix: true }); }
  catch { return '—'; }
}

export default function ChatList({
  chats,
  selected,
  onSelect,
}: {
  chats: ChatSummary[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <div
      className="flex flex-col overflow-y-auto shrink-0"
      style={{
        width: '260px',
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-2)',
      }}
    >
      <div
        className="px-3 py-2 text-xs font-semibold shrink-0"
        style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted)' }}
      >
        Chats ({chats.length})
      </div>

      {chats.length === 0 && (
        <div className="px-3 py-6 text-center text-[11px]" style={{ color: 'var(--muted)' }}>
          No chats synced yet
        </div>
      )}

      {chats.map(c => {
        const isSelected = c.name === selected;
        return (
          <button
            key={c.name}
            onClick={() => onSelect(c.name)}
            className="text-left px-3 py-2 transition-colors hover:bg-[var(--bg-3)] w-full"
            style={{
              background: isSelected ? 'var(--bg-3)' : undefined,
              borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              {/* Activity dot */}
              <span
                className="shrink-0 rounded-full"
                style={{ width: 7, height: 7, background: activityDot(c) }}
              />
              <span
                className="text-xs font-medium truncate flex-1"
                style={{ color: 'var(--fg)' }}
              >
                {c.name}
              </span>
              {c.last24hCount > 0 && (
                <span
                  className="text-[10px] shrink-0 px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}
                >
                  {c.last24hCount} today
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5 pl-[15px]">
              <span className="text-[10px] truncate flex-1" style={{ color: 'var(--muted)' }}>
                {c.lastMessageAuthor
                  ? `${c.lastMessageAuthor.split(',')[0]}: ${c.lastMessagePreview.slice(0, 50)}`
                  : 'No messages yet'}
              </span>
            </div>

            <div className="flex items-center gap-3 mt-0.5 pl-[15px]">
              <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                <Users size={9} />
                {c.memberCount}
              </span>
              <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--muted)' }}>
                <MessageSquare size={9} />
                {c.messageCount}
              </span>
              <span className="text-[10px] ml-auto" style={{ color: 'var(--muted)' }}>
                {timeAgo(c.lastMessageAt)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
