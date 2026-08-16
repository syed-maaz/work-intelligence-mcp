import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare, Star, Plus, X, ChevronDown, ChevronUp,
  Search, Settings2, Copy, Check, Loader2, Activity,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api, type TeamsFavKeyword, type ChatSummary } from '@/lib/api';
import { linkifyChildren } from '@/lib/linkify'; // U-10 phase 1.5
import { Button } from '@/components/ui';
import { toast } from 'sonner';
import ChatList from '@/components/shared/ChatList';
import ChatFeedPanel from '@/components/shared/ChatFeedPanel';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResultEntry {
  id: string;
  query: string;
  markdown: string;
  timestamp: Date;
  isOpen: boolean;
}

// ── Markdown renderer ──────────────────────────────────────────────────────────

function MdBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => <h1 className="text-sm font-bold mt-3 mb-1.5" style={{ color: 'var(--fg)' }}>{children}</h1>,
        h2: ({ children }) => <h2 className="text-xs font-bold mt-2 mb-1" style={{ color: 'var(--fg)' }}>{children}</h2>,
        h3: ({ children }) => <h3 className="text-[11px] font-semibold mt-2 mb-0.5" style={{ color: 'var(--fg)' }}>{children}</h3>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{linkifyChildren(children)}</p>,
        ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-[11px]">{linkifyChildren(children)}</li>,
        code: ({ children, className }) => {
          const isBlock = className?.startsWith('language-');
          return isBlock
            ? <code className="block px-3 py-2 rounded text-[10px] font-mono overflow-x-auto" style={{ background: 'var(--bg-3)' }}>{children}</code>
            : <code className="px-1 py-0.5 rounded text-[10px] font-mono" style={{ background: 'var(--bg-3)' }}>{children}</code>;
        },
        pre: ({ children }) => <pre className="mb-2 rounded overflow-x-auto" style={{ background: 'var(--bg-3)' }}>{children}</pre>,
        strong: ({ children }) => <strong className="font-semibold" style={{ color: 'var(--fg)' }}>{linkifyChildren(children)}</strong>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent)' }}>{children}</a>,
        hr: () => <hr className="my-2" style={{ borderColor: 'var(--border)' }} />,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 pl-3 my-2 italic" style={{ borderColor: 'var(--accent)', color: 'var(--muted)' }}>
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── Favourite keyword chip ─────────────────────────────────────────────────────

function FavChip({
  kw, isActive, onClick, onRemove,
}: {
  kw: TeamsFavKeyword; isActive: boolean; onClick: () => void; onRemove: () => void;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors cursor-pointer select-none"
      style={{
        background: isActive ? 'rgba(99,102,241,0.15)' : 'var(--bg-3)',
        color: isActive ? 'var(--accent)' : 'var(--fg)',
        border: `1px solid ${isActive ? 'rgba(99,102,241,0.4)' : 'var(--border)'}`,
      }}
      onClick={onClick}
      title="Click to fill search box"
    >
      {kw.keyword}
      <button
        className="ml-0.5 rounded-full hover:bg-red-500/20 transition-colors p-0.5"
        style={{ color: 'var(--muted)' }}
        onClick={e => { e.stopPropagation(); onRemove(); }}
        title="Remove favourite"
      >
        <X size={9} />
      </button>
    </span>
  );
}

// ── Result card ───────────────────────────────────────────────────────────────

function timeAgo(d: Date): string {
  const diff = Date.now() - d.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function ResultCard({ entry, onToggle, onRemove }: { entry: ResultEntry; onToggle: () => void; onRemove: () => void; }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(entry.markdown).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div
        className="flex items-center justify-between px-4 py-2.5 cursor-pointer hover:bg-[var(--bg-3)] transition-colors"
        style={{ borderBottom: entry.isOpen ? '1px solid var(--border)' : undefined, borderLeft: '3px solid #8b5cf6' }}
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 min-w-0">
          {entry.isOpen ? <ChevronUp size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} /> : <ChevronDown size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
          <MessageSquare size={12} style={{ color: '#8b5cf6', flexShrink: 0 }} />
          <span className="text-xs font-medium truncate" style={{ color: 'var(--fg)' }}>{entry.query}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{timeAgo(entry.timestamp)}</span>
          {entry.isOpen && (
            <button className="p-1 rounded hover:bg-[var(--bg-2)] transition-colors" style={{ color: 'var(--muted)' }}
              onClick={e => { e.stopPropagation(); handleCopy(); }} title="Copy markdown">
              {copied ? <Check size={11} style={{ color: '#10b981' }} /> : <Copy size={11} />}
            </button>
          )}
          <button className="p-1 rounded hover:bg-red-500/10 transition-colors" style={{ color: 'var(--muted)' }}
            onClick={e => { e.stopPropagation(); onRemove(); }} title="Remove result">
            <X size={11} />
          </button>
        </div>
      </div>
      {entry.isOpen && (
        <div className="px-4 py-3 text-[11px] leading-relaxed overflow-y-auto" style={{ color: 'var(--fg)', maxHeight: '500px' }}>
          <MdBlock content={entry.markdown} />
        </div>
      )}
    </div>
  );
}

// ── Activity tab ──────────────────────────────────────────────────────────────

function ActivityTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['teams-chats'],
    queryFn: () => api.teamsChats(),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const chats = data?.chats ?? [];
  const [selectedChat, setSelectedChat] = useState<string | null>(null);

  // Auto-select first chat once loaded
  useEffect(() => {
    if (!selectedChat && chats.length > 0) {
      setSelectedChat(chats[0].name);
    }
  }, [chats.length, selectedChat]);

  const selected: ChatSummary | null = chats.find(c => c.name === selectedChat) ?? null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin" style={{ color: 'var(--muted)' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border px-6 py-8 text-center" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <p className="text-xs" style={{ color: 'var(--danger)' }}>Failed to load chats: {(error as Error).message}</p>
      </div>
    );
  }

  if (chats.length === 0) {
    return (
      <div className="rounded-xl border px-6 py-10 text-center" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <Activity size={28} className="mx-auto mb-2" style={{ color: 'var(--muted)' }} />
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          No Teams chats synced yet. Run a sync to pull in your chats.
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border overflow-hidden flex"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', minHeight: '600px', maxHeight: 'calc(100vh - 160px)' }}
    >
      <ChatList chats={chats} selected={selectedChat} onSelect={setSelectedChat} />
      {selected
        ? <ChatFeedPanel chat={selected} />
        : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs" style={{ color: 'var(--muted)' }}>Select a chat</p>
          </div>
        )
      }
    </div>
  );
}

// ── Search tab (unchanged from EP-30) ────────────────────────────────────────

function SearchTab() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [since, setSince] = useState('');
  const [includeMeetings, setIncludeMeetings] = useState(true);
  const [maxResults, setMaxResults] = useState(50);
  const [showOptions, setShowOptions] = useState(false);
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [addingKeyword, setAddingKeyword] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const newKeywordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingKeyword) newKeywordRef.current?.focus();
  }, [addingKeyword]);

  const { data: favData } = useQuery({
    queryKey: ['teams-fav-keywords'],
    queryFn: () => api.listFavKeywords(),
  });
  const favKeywords = favData?.keywords ?? [];

  const addFavMutation = useMutation({
    mutationFn: (kw: string) => api.addFavKeyword(kw),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['teams-fav-keywords'] }); setNewKeyword(''); setAddingKeyword(false); },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeFavMutation = useMutation({
    mutationFn: (id: number) => api.deleteFavKeyword(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams-fav-keywords'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const searchMutation = useMutation({
    mutationFn: (q: string) => api.teamsUpdates({ query: q, since: since || undefined, includeMeetings, maxResults }),
    onSuccess: (data, q) => {
      setResults(prev => [{ id: crypto.randomUUID(), query: q, markdown: data.markdown, timestamp: new Date(), isOpen: true }, ...prev]);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleSearch() { const q = query.trim(); if (!q || searchMutation.isPending) return; searchMutation.mutate(q); }
  function handleSaveKeyword() { const kw = newKeyword.trim(); if (!kw) { setAddingKeyword(false); return; } addFavMutation.mutate(kw); }

  return (
    <div className="flex flex-col gap-4">
      {/* Search box */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)', borderLeft: '3px solid #8b5cf6' }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Search</h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--muted)' }}>Search synced Teams messages and meeting transcripts</p>
          </div>
          <button
            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded transition-colors hover:bg-[var(--bg-3)]"
            style={{ color: showOptions ? 'var(--accent)' : 'var(--muted)' }}
            onClick={() => setShowOptions(v => !v)}
          >
            <Settings2 size={12} /> Options
          </button>
        </div>
        <div className="px-4 py-3 flex items-center gap-2">
          <div className="flex-1 relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--muted)' }} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder='e.g. "deployment pipeline" or "auth decision"'
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border outline-none transition-colors"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            />
          </div>
          <Button size="sm" onClick={handleSearch} disabled={!query.trim() || searchMutation.isPending} loading={searchMutation.isPending}>
            {searchMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Search
          </Button>
        </div>
        {showOptions && (
          <div className="px-4 pb-3 pt-0 flex items-center gap-4 flex-wrap" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="flex items-center gap-1.5 pt-3">
              <label className="text-[11px]" style={{ color: 'var(--muted)' }}>Since</label>
              <input type="date" value={since} onChange={e => setSince(e.target.value)} className="text-[11px] px-2 py-1 rounded border outline-none" style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
            </div>
            <div className="flex items-center gap-1.5 pt-3">
              <label className="text-[11px]" style={{ color: 'var(--muted)' }}>Max results</label>
              <input type="number" min={5} max={200} value={maxResults} onChange={e => setMaxResults(parseInt(e.target.value) || 50)} className="w-16 text-[11px] px-2 py-1 rounded border outline-none" style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
            </div>
            <div className="flex items-center gap-1.5 pt-3">
              <input type="checkbox" id="includeMeetings" checked={includeMeetings} onChange={e => setIncludeMeetings(e.target.checked)} className="rounded" />
              <label htmlFor="includeMeetings" className="text-[11px] cursor-pointer" style={{ color: 'var(--fg)' }}>Include meeting transcripts</label>
            </div>
          </div>
        )}
      </div>

      {/* Favourites */}
      <div className="rounded-xl border px-4 py-3" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1 text-[11px] font-medium shrink-0" style={{ color: 'var(--muted)' }}>
            <Star size={11} style={{ color: '#f59e0b' }} /> Favourites
          </span>
          {favKeywords.map(kw => (
            <FavChip key={kw.id} kw={kw} isActive={query === kw.keyword}
              onClick={() => { setQuery(kw.keyword); inputRef.current?.focus(); }}
              onRemove={() => removeFavMutation.mutate(kw.id)}
            />
          ))}
          {addingKeyword ? (
            <span className="inline-flex items-center gap-1">
              <input
                ref={newKeywordRef}
                type="text"
                value={newKeyword}
                onChange={e => setNewKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveKeyword(); if (e.key === 'Escape') { setAddingKeyword(false); setNewKeyword(''); } }}
                onBlur={handleSaveKeyword}
                placeholder="keyword…"
                className="text-[11px] px-2 py-1 rounded-full border outline-none w-28"
                style={{ background: 'var(--bg)', borderColor: 'rgba(99,102,241,0.4)', color: 'var(--fg)' }}
              />
            </span>
          ) : (
            <button onClick={() => setAddingKeyword(true)} className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium transition-colors hover:bg-[var(--bg-3)]" style={{ color: 'var(--muted)', border: '1px dashed var(--border)' }}>
              <Plus size={10} /> Add
            </button>
          )}
          {favKeywords.length === 0 && !addingKeyword && (
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>— no favourites yet</span>
          )}
        </div>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{results.length} result{results.length !== 1 ? 's' : ''}</span>
            <button className="text-[10px] hover:underline" style={{ color: 'var(--muted)' }} onClick={() => setResults([])}>Clear all</button>
          </div>
          {results.map(r => (
            <ResultCard key={r.id} entry={r}
              onToggle={() => setResults(prev => prev.map(x => x.id === r.id ? { ...x, isOpen: !x.isOpen } : x))}
              onRemove={() => setResults(prev => prev.filter(x => x.id !== r.id))}
            />
          ))}
        </div>
      )}
      {results.length === 0 && !searchMutation.isPending && (
        <div className="rounded-xl border px-6 py-10 text-center" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
          <MessageSquare size={28} className="mx-auto mb-2" style={{ color: 'var(--muted)' }} />
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Enter a query and press Search, or click a favourite keyword.</p>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

type TabId = 'activity' | 'search';

export default function TeamsUpdatesPage() {
  const [tab, setTab] = useState<TabId>('activity');

  return (
    <div className="flex flex-col gap-3 animate-fade-in" style={{ maxWidth: '1100px' }}>
      {/* Tab bar */}
      <div className="flex items-center gap-1" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0px' }}>
        {([
          { id: 'activity' as TabId, label: 'Activity', icon: Activity },
          { id: 'search' as TabId, label: 'Search', icon: Search },
        ] as { id: TabId; label: string; icon: React.ComponentType<{ size?: number }> }[]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors"
            style={{
              color: tab === id ? 'var(--accent)' : 'var(--muted)',
              borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'activity' ? <ActivityTab /> : <SearchTab />}
    </div>
  );
}
