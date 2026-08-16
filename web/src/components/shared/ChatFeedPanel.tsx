import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { Loader2, RefreshCw, ExternalLink, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { linkifyChildren } from '@/lib/linkify'; // U-10 phase 1.5
import { api, type ChatSummary } from '@/lib/api';
import { Button } from '@/components/ui';
import { toast } from 'sonner';

const JIRA_BASE = 'https://jira.example.com/browse/';

function timeAgo(iso: string): string {
  try { return formatDistanceToNowStrict(new Date(iso), { addSuffix: true }); }
  catch { return iso.slice(0, 10); }
}

function JiraChip({ k }: { k: string }) {
  return (
    <a
      href={`${JIRA_BASE}${k}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium transition-colors hover:opacity-80"
      style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.25)' }}
    >
      {k}
      <ExternalLink size={8} />
    </a>
  );
}

function DigestCard({ digest, digestAge, chatName }: { digest: string | null; digestAge: number | null; chatName: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);

  const digestMutation = useMutation({
    mutationFn: () => api.generateChatDigest(chatName),
    onSuccess: () => {
      // Poll chat list to pick up new digest
      setTimeout(() => qc.invalidateQueries({ queryKey: ['teams-chats'] }), 3000);
      toast.success('Digest generated');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!digest) {
    return (
      <div
        className="rounded-lg border px-4 py-3 flex items-center justify-between"
        style={{ background: 'var(--bg-3)', borderColor: 'var(--border)' }}
      >
        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>No digest yet — generate a quick AI summary of this chat.</span>
        <Button size="sm" onClick={() => digestMutation.mutate()} disabled={digestMutation.isPending}>
          {digestMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          Generate
        </Button>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ background: 'var(--bg-3)', borderColor: 'var(--border)', borderLeft: '3px solid var(--accent)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-2">
          <Sparkles size={11} style={{ color: 'var(--accent)' }} />
          <span className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>AI Digest</span>
          {digestAge !== null && (
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
              · {digestAge < 2 ? 'just now' : `${digestAge}m ago`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="p-1 rounded hover:bg-[var(--bg-2)] transition-colors"
            style={{ color: 'var(--muted)' }}
            onClick={e => { e.stopPropagation(); digestMutation.mutate(); }}
            title="Refresh digest"
            disabled={digestMutation.isPending}
          >
            {digestMutation.isPending
              ? <Loader2 size={10} className="animate-spin" />
              : <RefreshCw size={10} />}
          </button>
          {open ? <ChevronUp size={12} style={{ color: 'var(--muted)' }} /> : <ChevronDown size={12} style={{ color: 'var(--muted)' }} />}
        </div>
      </div>
      {open && (
        <div className="px-3 pb-3 text-[11px] leading-relaxed" style={{ color: 'var(--fg)' }}>
          <ReactMarkdown
            components={{
              h1: ({ children }) => <h1 className="text-xs font-bold mt-2 mb-1" style={{ color: 'var(--fg)' }}>{children}</h1>,
              h2: ({ children }) => <h2 className="text-[11px] font-bold mt-2 mb-0.5" style={{ color: 'var(--fg)' }}>{children}</h2>,
              p: ({ children }) => <p className="mb-1.5 last:mb-0">{linkifyChildren(children)}</p>,
              ul: ({ children }) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>,
              li: ({ children }) => <li className="text-[11px]">{linkifyChildren(children)}</li>,
              strong: ({ children }) => <strong className="font-semibold" style={{ color: 'var(--fg)' }}>{linkifyChildren(children)}</strong>,
            }}
          >
            {digest}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export default function ChatFeedPanel({ chat }: { chat: ChatSummary }) {
  const { data, isLoading } = useQuery({
    queryKey: ['teams-chat-feed', chat.name],
    queryFn: () => api.teamsChatFeed(chat.name),
    staleTime: 60_000,
  });

  return (
    <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
      {/* Header */}
      <div
        className="px-4 py-2.5 shrink-0 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--border)', borderLeft: '3px solid var(--accent)' }}
      >
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{chat.name}</h2>
          <p className="text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>
            {chat.memberCount} members · {chat.messageCount} messages total
            {chat.last24hCount > 0 && ` · ${chat.last24hCount} today`}
          </p>
        </div>
        {chat.jiraLinks.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap justify-end">
            {chat.jiraLinks.slice(0, 5).map(k => <JiraChip key={k} k={k} />)}
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">
        {/* Digest card */}
        <DigestCard digest={chat.digest} digestAge={chat.digestAge} chatName={chat.name} />

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={18} className="animate-spin" style={{ color: 'var(--muted)' }} />
          </div>
        )}

        {data && (
          <>
            {/* Meetings */}
            {data.meetings.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold px-1 mb-2" style={{ color: 'var(--muted)' }}>
                  Meetings ({data.meetings.length})
                </h3>
                <div className="flex flex-col gap-2">
                  {data.meetings.map(m => (
                    <div
                      key={m.id}
                      className="rounded-lg border px-3 py-2"
                      style={{ background: 'var(--bg-3)', borderColor: 'var(--border)' }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>{m.title}</span>
                        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{m.date.slice(0, 10)}</span>
                      </div>
                      {m.summary && (
                        <p className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>{m.summary}</p>
                      )}
                      {m.decisions.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 space-y-0.5">
                          {m.decisions.map((d, i) => (
                            <li key={i} className="text-[10px]" style={{ color: 'var(--fg-2)' }}>{d}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Action items */}
            {data.actionItems.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold px-1 mb-2" style={{ color: 'var(--muted)' }}>
                  Action Items ({data.actionItems.length})
                </h3>
                <div className="flex flex-col gap-1">
                  {data.actionItems.map(ai => (
                    <div
                      key={ai.id}
                      className="flex items-start gap-2 px-3 py-1.5 rounded-lg"
                      style={{ background: 'var(--bg-3)' }}
                    >
                      <span
                        className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full"
                        style={{ background: ai.status === 'completed' ? '#10b981' : '#f59e0b', marginTop: 4 }}
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px]" style={{ color: 'var(--fg)' }}>{ai.title}</span>
                        {ai.assignee && (
                          <span className="text-[10px] ml-2" style={{ color: 'var(--muted)' }}>→ {ai.assignee}</span>
                        )}
                      </div>
                      {ai.due_date && (
                        <span className="text-[10px] shrink-0" style={{ color: 'var(--muted)' }}>
                          {ai.due_date.slice(0, 10)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Messages */}
            <section>
              <h3 className="text-xs font-semibold px-1 mb-2" style={{ color: 'var(--muted)' }}>
                Messages ({data.messages.length})
              </h3>
              <div className="flex flex-col gap-1">
                {data.messages.map(m => (
                  <div
                    key={m.id}
                    className="px-3 py-1.5 rounded-lg"
                    style={{ background: 'var(--bg-3)' }}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-medium" style={{ color: 'var(--accent)' }}>
                        {m.author.split(',')[0]}
                      </span>
                      <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                        {timeAgo(m.timestamp)}
                      </span>
                      {m.jiraLinks.map(k => <JiraChip key={k} k={k} />)}
                    </div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--fg)' }}>
                      {m.content.slice(0, 400)}{m.content.length > 400 ? '…' : ''}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
