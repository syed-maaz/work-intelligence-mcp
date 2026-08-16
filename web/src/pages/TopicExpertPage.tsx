import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Brain, RefreshCw, Send, BookOpen, MessageSquare, AlertCircle, History, ChevronDown, ChevronUp, Network, StickyNote, Save } from 'lucide-react';
import { api, NotebookChatEntry, GraphNode, GraphEdge } from '@/lib/api';
import { MarkdownPanel } from '@/components/shared/MarkdownPanel';
import { StaleBanner } from '@/components/shared/StaleBanner';
import { Button } from '@/components/ui';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

type LeftTab = 'notebook' | 'graph' | 'notes';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

function formatRelative(iso: string) {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed ${
          isUser ? 'rounded-br-sm' : 'rounded-bl-sm'
        }`}
        style={{
          background: isUser ? 'var(--accent)' : 'var(--bg-3)',
          color: isUser ? '#fff' : 'var(--fg)',
          borderColor: 'var(--border)',
          border: isUser ? 'none' : '1px solid var(--border)',
        }}
      >
        {isUser ? (
          msg.content
        ) : (
          <div
            className="prose-wi text-xs"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        )}
      </div>
    </div>
  );
}

/** Minimal inline markdown render for chat — headers, bold, lists, code */
function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<strong>$1</strong>')
    .replace(/^## (.+)$/gm, '<strong>$1</strong>')
    .replace(/^# (.+)$/gm, '<strong>$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/\n/g, '<br/>');
}

function HistoryItem({ entry, onReuse }: { entry: NotebookChatEntry; onReuse: (q: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="rounded-lg border text-xs overflow-hidden"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
    >
      <button
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--bg-3)] transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="flex-1 font-medium truncate" style={{ color: 'var(--fg)' }}>
          {entry.question}
        </span>
        <span className="shrink-0 text-[10px] mt-0.5" style={{ color: 'var(--muted)' }}>
          {formatRelative(entry.asked_at)}
        </span>
        {expanded
          ? <ChevronUp size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
          : <ChevronDown size={12} className="shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
        }
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t" style={{ borderColor: 'var(--border)' }}>
          <div
            className="prose-wi text-xs mt-2"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.answer) }}
          />
          <button
            onClick={() => onReuse(entry.question)}
            className="mt-2 text-[10px] px-2 py-0.5 rounded-full border transition-colors hover:bg-[var(--bg-3)]"
            style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
          >
            Ask again
          </button>
        </div>
      )}
    </div>
  );
}

// ── Knowledge Graph (pure SVG, no D3) ─────────────────────────
interface GraphProps {
  nodes: GraphNode[] | undefined;
  edges: GraphEdge[] | undefined;
  activeTopic: string;
  onSelectTopic: (name: string) => void;
}

function KnowledgeGraph({ nodes, edges, activeTopic, onSelectTopic }: GraphProps) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const W = 480;
  const H = 380;
  const safeNodes = nodes ?? [];
  const safeEdges = edges ?? [];

  const cx = W / 2;
  const cy = H / 2;
  const n = safeNodes.length;

  if (n === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>No notebooks yet to graph</p>
      </div>
    );
  }

  const radius = Math.min(cx, cy) - 56;

  // Node size: range 14–28 based on messageCount
  const maxMsgCount = Math.max(1, ...safeNodes.map(n => n.messageCount));
  const nodeRadius = (msgCount: number) => 14 + (msgCount / maxMsgCount) * 14;

  // Position nodes on a circle
  const positions: Record<string, { x: number; y: number }> = {};
  safeNodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    positions[node.topicName] = {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });

  // Edge weight = sharedPeople + sharedTickets
  const edgeWeight = (e: GraphEdge) => e.sharedPeople.length + (e.sharedTickets?.length ?? 0);
  const maxWeight = Math.max(1, ...safeEdges.map(edgeWeight));

  // Strongest connection
  const strongestEdge = safeEdges.length > 0
    ? safeEdges.reduce((best, e) => edgeWeight(e) > edgeWeight(best) ? e : best, safeEdges[0])
    : null;

  return (
    <div className="relative w-full h-full flex flex-col items-center">
      {/* Strongest connection callout */}
      {strongestEdge && edgeWeight(strongestEdge) > 0 && (
        <div className="w-full px-3 pb-1 pt-2">
          <div className="text-[10px] px-2 py-1 rounded" style={{ background: 'var(--bg-3)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--fg-2)' }}>Strongest:</span>{' '}
            <span style={{ color: 'var(--accent)' }}>{strongestEdge.from}</span>
            {' ↔ '}
            <span style={{ color: 'var(--accent)' }}>{strongestEdge.to}</span>
            {strongestEdge.sharedPeople.length > 0 && <span> · {strongestEdge.sharedPeople.length} people</span>}
            {(strongestEdge.sharedTickets?.length ?? 0) > 0 && <span> · {strongestEdge.sharedTickets!.length} tickets</span>}
          </div>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full flex-1"
        style={{ maxHeight: '320px' }}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Edges */}
        {safeEdges.map((edge, i) => {
          const from = positions[edge.from];
          const to = positions[edge.to];
          if (!from || !to) return null;
          const w = edgeWeight(edge);
          const thickness = 1 + (w / maxWeight) * 4;
          const tooltipParts: string[] = [];
          if (edge.sharedPeople.length > 0) tooltipParts.push(`People: ${edge.sharedPeople.slice(0, 3).join(', ')}${edge.sharedPeople.length > 3 ? ` +${edge.sharedPeople.length - 3}` : ''}`);
          if ((edge.sharedTickets?.length ?? 0) > 0) tooltipParts.push(`Tickets: ${edge.sharedTickets!.slice(0, 3).join(', ')}${edge.sharedTickets!.length > 3 ? ` +${edge.sharedTickets!.length - 3}` : ''}`);
          return (
            <line
              key={i}
              x1={from.x} y1={from.y}
              x2={to.x} y2={to.y}
              strokeWidth={thickness}
              stroke="var(--accent)"
              opacity={0.3}
              className="cursor-pointer"
              onMouseEnter={(e) => {
                const rect = svgRef.current?.getBoundingClientRect();
                if (rect) {
                  setTooltip({
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top - 8,
                    text: tooltipParts.join(' | ') || 'Connected',
                  });
                }
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          );
        })}

        {/* Nodes */}
        {safeNodes.map((node) => {
          const pos = positions[node.topicName];
          if (!pos) return null;
          const isActive = node.topicName === activeTopic;
          const r = nodeRadius(node.messageCount);
          return (
            <g
              key={node.topicName}
              transform={`translate(${pos.x},${pos.y})`}
              className="cursor-pointer"
              onClick={() => onSelectTopic(node.topicName)}
            >
              <circle
                r={isActive ? r + 4 : r}
                fill={isActive ? 'var(--accent)' : 'var(--bg-3)'}
                stroke={isActive ? 'var(--accent)' : 'var(--border)'}
                strokeWidth={isActive ? 2 : 1}
                className="transition-all"
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9}
                fontWeight={isActive ? 600 : 400}
                fill={isActive ? '#fff' : 'var(--fg)'}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {node.topicName.length > 8 ? node.topicName.slice(0, 7) + '…' : node.topicName}
              </text>
              <text
                y={isActive ? r + 10 : r + 8}
                textAnchor="middle"
                fontSize={8}
                fill="var(--muted)"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {node.messageCount} msgs
              </text>
            </g>
          );
        })}

        {/* Mini legend — bottom-left */}
        <g transform={`translate(8,${H - 48})`}>
          <text fontSize={8} fill="var(--muted)" fontWeight={600} y={0}>Legend</text>
          <circle cx={6} cy={12} r={6} fill="var(--bg-3)" stroke="var(--border)" strokeWidth={1} />
          <circle cx={6} cy={12} r={10} fill="none" stroke="var(--border)" strokeWidth={0.5} strokeDasharray="2 2" />
          <text fontSize={7} fill="var(--muted)" x={20} y={16}>node size = msg count</text>
          <line x1={0} y1={26} x2={12} y2={26} stroke="var(--accent)" strokeWidth={2} opacity={0.5} />
          <text fontSize={7} fill="var(--muted)" x={20} y={30}>edge = shared people + tickets</text>
        </g>
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute pointer-events-none text-xs px-2 py-1 rounded shadow-lg"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            background: 'var(--bg-3)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            transform: 'translate(-50%, -100%)',
            whiteSpace: 'nowrap',
            maxWidth: 280,
          }}
        >
          {tooltip.text}
        </div>
      )}

      {n === 1 && (
        <p className="absolute bottom-2 left-0 right-0 text-center text-[10px]" style={{ color: 'var(--muted)' }}>
          Add more topics to see connections
        </p>
      )}
    </div>
  );
}

// ── My Notes (annotation editor) ──────────────────────────────
interface NotesTabProps {
  topicName: string;
}

function NotesTab({ topicName }: NotesTabProps) {
  const [annotation, setAnnotation] = useState('');
  const [saved, setSaved] = useState(true);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['annotation', topicName],
    queryFn: () => api.getAnnotation(topicName),
    enabled: !!topicName,
    staleTime: 60 * 1000,
  });

  // Sync to loaded data when topic changes
  useEffect(() => {
    if (data !== undefined) {
      setAnnotation(data.annotation ?? '');
      setSaved(true);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (text: string) => api.saveAnnotation(topicName, text),
    onSuccess: () => {
      setSaved(true);
      setLastSavedAt(new Date());
    },
    onError: (e: Error) => toast.error(`Failed to save notes: ${e.message}`),
  });

  const handleChange = useCallback((text: string) => {
    setAnnotation(text);
    setSaved(false);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveMutation.mutate(text);
    }, 2000);
  }, [saveMutation]);

  const handleSaveNow = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveMutation.mutate(annotation);
  };

  // Cleanup timer on unmount
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--muted)' }} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-3">
      <div>
        <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--fg)' }}>
          Your personal notes for {topicName}
        </p>
        <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
          These are injected into every chat answer as authoritative context
        </p>
      </div>

      <textarea
        value={annotation}
        onChange={e => handleChange(e.target.value)}
        placeholder={`Add context the AI doesn't know — key decisions, who to trust, what's disputed, current priorities for ${topicName}…`}
        className="flex-1 w-full resize-none rounded-lg border p-3 text-xs outline-none transition-colors"
        style={{
          background: 'var(--bg-2)',
          borderColor: 'var(--border)',
          color: 'var(--fg)',
          lineHeight: 1.6,
          minHeight: 120,
        }}
      />

      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSaveNow}
            disabled={saveMutation.isPending || saved}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            style={{
              background: 'var(--accent)',
              color: '#fff',
              opacity: saved ? 0.5 : 1,
            }}
          >
            <Save size={10} />
            {saveMutation.isPending ? 'Saving…' : 'Save Notes'}
          </button>
          {saved && lastSavedAt && (
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
              Saved {formatRelative(lastSavedAt.toISOString())}
            </span>
          )}
          {!saved && (
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>Unsaved changes…</span>
          )}
        </div>
      </div>

      <div
        className="rounded-lg px-3 py-2 text-[10px]"
        style={{ background: 'var(--bg-3)', color: 'var(--muted)', borderLeft: '2px solid var(--accent)' }}
      >
        Tip: Notes are prepended before every chat answer for this topic. Use them to correct AI assumptions or add private context.
      </div>
    </div>
  );
}

// ── Correct This button + modal (EP-49-4) ──────────────────────
function CorrectThisButton({ topicName }: { topicName: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      await api.submitNotebookFeedback(topicName, text.trim());
      toast.success('Correction saved — will apply on next rebuild');
      setText('');
      setOpen(false);
    } catch {
      toast.error('Failed to save correction');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mt-3 text-xs px-2 py-1 rounded border transition-colors hover:bg-[var(--bg-3)]"
        style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
      >
        Correct this
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-md rounded-lg p-5 space-y-3 shadow-xl"
            style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <p className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Correct this notebook</p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Corrections are stored as ground truth and applied the next time the notebook is rebuilt.
            </p>
            <textarea
              className="w-full rounded border p-2 text-xs resize-none focus:outline-none"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)', minHeight: 80 }}
              placeholder="e.g. Alice left the team in March 2025. The project was cancelled, not completed."
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setOpen(false); setText(''); }}
                className="text-xs px-3 py-1 rounded border"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!text.trim() || submitting}
                className="text-xs px-3 py-1 rounded transition-colors"
                style={{ background: 'var(--accent)', color: '#fff', opacity: (!text.trim() || submitting) ? 0.5 : 1 }}
              >
                {submitting ? 'Saving…' : 'Save correction'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────
export default function TopicExpertPage() {
  const queryClient = useQueryClient();
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [leftTab, setLeftTab] = useState<LeftTab>('notebook');
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { data: topics } = useQuery({ queryKey: ['topics'], queryFn: api.topics });

  // Auto-select first topic
  useEffect(() => {
    if (topics && topics.length > 0 && !selectedTopic) {
      setSelectedTopic(topics[0].name);
    }
  }, [topics, selectedTopic]);

  // Load notebook for selected topic
  const {
    data: notebook,
    isLoading: notebookLoading,
    error: notebookError,
  } = useQuery({
    queryKey: ['notebook', selectedTopic],
    queryFn: () => api.getNotebook(selectedTopic),
    enabled: !!selectedTopic,
    staleTime: 5 * 60 * 1000,
  });

  // Load graph data (all topics at once)
  const { data: graphData } = useQuery({
    queryKey: ['notebookGraph'],
    queryFn: () => api.notebookGraph(),
    staleTime: 5 * 60 * 1000,
    enabled: leftTab === 'graph',
  });

  // EP-39: Related topics
  const { data: relData } = useQuery({
    queryKey: ['relationships', selectedTopic],
    queryFn: () => api.getRelationships(selectedTopic),
    enabled: !!selectedTopic,
    staleTime: 10 * 60 * 1000,
  });

  // Load chat history for selected topic
  const { data: historyData, refetch: refetchHistory } = useQuery({
    queryKey: ['notebookHistory', selectedTopic],
    queryFn: () => api.notebookChatHistory(selectedTopic),
    enabled: !!selectedTopic,
    staleTime: 0,
    refetchOnMount: true,
  });
  const savedHistory = historyData?.history ?? [];

  // Rebuild mutation
  const rebuildMutation = useMutation({
    mutationFn: () => api.rebuildNotebook(selectedTopic),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notebook', selectedTopic] });
      queryClient.invalidateQueries({ queryKey: ['notebookGraph'] });
      toast.success('Notebook rebuilt');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Chat mutation
  const chatMutation = useMutation({
    mutationFn: (message: string) =>
      api.notebookChat(selectedTopic, { message, history: chatHistory }),
    onSuccess: (data, message) => {
      setChatHistory(h => [
        ...h,
        { role: 'user', content: message },
        { role: 'assistant', content: data.reply },
      ]);
      refetchHistory();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, chatMutation.isPending]);

  function handleTopicChange(name: string) {
    setSelectedTopic(name);
    setChatHistory([]);
    setInput('');
  }

  function handleSend() {
    const msg = input.trim();
    if (!msg || chatMutation.isPending) return;
    setInput('');
    chatMutation.mutate(msg);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const suggestedFollowUps = chatMutation.data?.suggestedFollowUps ?? [];
  const hasNotebook = !notebookLoading && !notebookError && !!notebook;

  const leftTabs: { id: LeftTab; label: string; icon: React.ReactNode }[] = [
    { id: 'notebook', label: 'Notebook', icon: <BookOpen size={11} /> },
    { id: 'graph', label: 'Graph', icon: <Network size={11} /> },
    { id: 'notes', label: 'My Notes', icon: <StickyNote size={11} /> },
  ];

  return (
    <div className="flex flex-col h-full animate-fade-in" style={{ height: 'calc(100vh - 120px)' }}>

      {/* Topic tabs */}
      <div
        className="flex items-center gap-1 px-1 pb-3 overflow-x-auto shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-1.5 mr-3 shrink-0">
          <Brain size={14} style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Topic Notebooks</span>
        </div>
        {topics?.map(t => (
          <button
            key={t.name}
            onClick={() => handleTopicChange(t.name)}
            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: selectedTopic === t.name ? 'var(--accent)' : 'var(--bg-3)',
              color: selectedTopic === t.name ? '#fff' : 'var(--muted)',
              border: `1px solid ${selectedTopic === t.name ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            {t.name}
          </button>
        ))}
        {(!topics || topics.length === 0) && (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>No topics configured</span>
        )}
      </div>

      {/* Main split layout */}
      {selectedTopic ? (
        <div className="flex flex-1 gap-4 pt-4 min-h-0">

          {/* Left: 3-tab panel */}
          <div className="flex flex-col w-1/2 min-h-0">
            {/* Tab switcher + rebuild button */}
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: 'var(--bg-3)' }}>
                {leftTabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setLeftTab(tab.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all"
                    style={{
                      background: leftTab === tab.id ? 'var(--bg)' : 'transparent',
                      color: leftTab === tab.id ? 'var(--fg)' : 'var(--muted)',
                      boxShadow: leftTab === tab.id ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                    }}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </div>

              {leftTab === 'notebook' && (
                <div className="flex items-center gap-2">
                  {notebook && (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      {notebook.message_count} msgs · {formatRelative(notebook.last_updated)}
                    </span>
                  )}
                  <button
                    onClick={() => rebuildMutation.mutate()}
                    disabled={rebuildMutation.isPending}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors hover:bg-[var(--bg-3)]"
                    style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
                    title="Rebuild notebook from all data"
                  >
                    <RefreshCw size={10} className={rebuildMutation.isPending ? 'animate-spin' : ''} />
                    Rebuild
                  </button>
                </div>
              )}
            </div>

            {/* Tab content */}
            <div
              className="flex-1 rounded-xl border overflow-y-auto min-h-0"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
            >
              {/* Notebook tab */}
              {leftTab === 'notebook' && (
                <>
                  {/* EP-49-1: Related chips inline, below tab switcher */}
                  {relData?.relationships && relData.relationships.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap px-4 pt-3 pb-0">
                      <span className="text-[10px] uppercase tracking-wide shrink-0" style={{ color: 'var(--muted)' }}>Related:</span>
                      {relData.relationships.slice(0, 5).map(r => (
                        <button
                          key={r.other}
                          onClick={() => { if (r.other) handleTopicChange(r.other); }}
                          title={r.evidence}
                          className="text-xs px-2 py-0.5 rounded-full border transition-colors hover:bg-[var(--bg-3)]"
                          style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                        >
                          {r.other}<span className="ml-1 opacity-60">{Math.round(r.strength * 100)}%</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {notebookLoading ? (
                    <div className="p-5 space-y-3">
                      <div className="flex items-center gap-2 mb-4">
                        <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--accent)' }} />
                        <span className="text-xs" style={{ color: 'var(--muted)' }}>
                          Building notebook from your data…
                        </span>
                      </div>
                      {[80, 60, 90, 70, 50].map((w, i) => (
                        <div key={i} className="animate-pulse h-3 rounded" style={{ width: `${w}%`, background: 'var(--border)' }} />
                      ))}
                    </div>
                  ) : notebookError ? (
                    <div className="p-5 flex items-start gap-2">
                      <AlertCircle size={14} style={{ color: 'var(--danger)' }} className="shrink-0 mt-0.5" />
                      <span className="text-xs" style={{ color: 'var(--danger)' }}>
                        {(notebookError as Error).message}
                      </span>
                    </div>
                  ) : notebook ? (
                    <div className="p-5">
                      <StaleBanner stale={notebook.stale} reason="AI unavailable — notebook from cache" />
                      {notebook.fresh && !notebook.stale && (
                        <span
                          className="inline-block mb-3 text-xs px-1.5 py-0.5 rounded-full"
                          style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}
                        >
                          freshly built
                        </span>
                      )}
                      <MarkdownPanel content={notebook.content} />
                      {/* EP-49-3: Sources footer */}
                      {notebook.sources && notebook.sources.length > 0 && (
                        <details className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
                          <summary className="cursor-pointer select-none py-1 font-medium" style={{ color: 'var(--fg-2)' }}>
                            Sources ({notebook.sources.length})
                          </summary>
                          <ul className="mt-2 space-y-1 pl-3 border-l" style={{ borderColor: 'var(--border)' }}>
                            {notebook.sources.map((s, i) => (
                              <li key={i}>{s}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {/* EP-49-4: Correct this button */}
                      <CorrectThisButton topicName={selectedTopic} />
                    </div>
                  ) : (
                    <div className="p-5 text-center">
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>No notebook yet — click Rebuild</span>
                    </div>
                  )}
                </>
              )}

              {/* Graph tab */}
              {leftTab === 'graph' && (
                <div className="p-3 h-full">
                  {!graphData ? (
                    <div className="flex items-center justify-center h-full">
                      <RefreshCw size={14} className="animate-spin" style={{ color: 'var(--muted)' }} />
                    </div>
                  ) : (
                    <KnowledgeGraph
                      nodes={graphData.nodes}
                      edges={graphData.edges}
                      activeTopic={selectedTopic}
                      onSelectTopic={handleTopicChange}
                    />
                  )}
                </div>
              )}

              {/* My Notes tab */}
              {leftTab === 'notes' && (
                <div className="p-4 h-full">
                  <NotesTab topicName={selectedTopic} />
                </div>
              )}
            </div>
          </div>

          {/* Right: Chat panel */}
          <div className="flex flex-col w-1/2 min-h-0">
            {/* Chat header */}
            <div className="flex items-center justify-between mb-3 shrink-0">
              <div className="flex items-center gap-2">
                <MessageSquare size={13} style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Ask the Notebook</span>
                {!hasNotebook && !notebookLoading && (
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>· build notebook first</span>
                )}
              </div>
              {chatHistory.length > 0 && (
                <button
                  onClick={() => setChatHistory([])}
                  className="text-xs px-2 py-1 rounded-md transition-colors hover:bg-[var(--bg-3)]"
                  style={{ color: 'var(--muted)' }}
                >
                  Clear
                </button>
              )}
            </div>

            {/* Chat messages */}
            <div
              className="flex-1 rounded-xl border overflow-y-auto p-4 min-h-0"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
            >
              {chatHistory.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center gap-3">
                  <Brain size={24} style={{ color: 'var(--border)' }} />
                  <div>
                    <p className="text-xs font-medium" style={{ color: 'var(--fg-2)' }}>
                      Chat with your notebook
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                      Ask questions about {selectedTopic}.<br />
                      Claude answers from its memory of your data.
                    </p>
                  </div>
                  {hasNotebook && (
                    <div className="flex flex-wrap gap-2 justify-center mt-2">
                      {[
                        'What are the current blockers?',
                        'Who are the key people involved?',
                        'What decisions have been made?',
                      ].map(q => (
                        <button
                          key={q}
                          onClick={() => { setInput(q); }}
                          className="text-xs px-2.5 py-1 rounded-full transition-colors hover:bg-[var(--bg-3)]"
                          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {chatHistory.map((msg, i) => (
                    <ChatBubble key={i} msg={msg} />
                  ))}
                  {chatMutation.isPending && (
                    <div className="flex justify-start mb-3">
                      <div
                        className="px-3 py-2 rounded-xl rounded-bl-sm"
                        style={{ background: 'var(--bg-3)', border: '1px solid var(--border)' }}
                      >
                        <div className="flex gap-1 items-center h-4">
                          {[0, 150, 300].map(delay => (
                            <span
                              key={delay}
                              className="w-1.5 h-1.5 rounded-full animate-pulse"
                              style={{ background: 'var(--muted)', animationDelay: `${delay}ms` }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Suggested follow-ups */}
                  {suggestedFollowUps.length > 0 && !chatMutation.isPending && (
                    <div className="flex flex-wrap gap-1.5 mt-2 mb-1">
                      {suggestedFollowUps.map(q => (
                        <button
                          key={q}
                          onClick={() => { setInput(q); }}
                          className="text-xs px-2.5 py-1 rounded-full transition-colors hover:bg-[var(--bg-3)]"
                          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </>
              )}
            </div>

            {/* Chat input */}
            <div
              className="flex items-end gap-2 mt-3 p-3 rounded-xl border shrink-0"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
            >
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={hasNotebook ? `Ask about ${selectedTopic}…` : 'Build the notebook first…'}
                disabled={!hasNotebook || chatMutation.isPending}
                rows={2}
                className="flex-1 bg-transparent text-xs resize-none outline-none"
                style={{ color: 'var(--fg)', lineHeight: 1.5 }}
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || !hasNotebook || chatMutation.isPending}
                loading={chatMutation.isPending}
                size="sm"
              >
                <Send size={12} />
              </Button>
            </div>

            {/* Saved Q&A history */}
            {savedHistory.length > 0 && (
              <div className="mt-3 shrink-0">
                <div className="flex items-center gap-1.5 mb-2">
                  <History size={12} style={{ color: 'var(--muted)' }} />
                  <span className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
                    Previous questions ({savedHistory.length})
                  </span>
                </div>
                <div className="space-y-1.5 max-h-52 overflow-y-auto pr-0.5">
                  {savedHistory.map(entry => (
                    <HistoryItem key={entry.id} entry={entry} onReuse={(q) => setInput(q)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Brain size={32} style={{ color: 'var(--border)' }} className="mx-auto mb-3" />
            <p className="text-sm" style={{ color: 'var(--muted)' }}>Select a topic to open its notebook</p>
          </div>
        </div>
      )}
    </div>
  );
}
