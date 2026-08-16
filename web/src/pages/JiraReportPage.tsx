import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type EnhancedIssue, type JiraBoardResponse, type TicketDetail, type SprintMeta, type JiraAnalysis, type BrainStats } from '@/lib/api';
import { InvestigatePanel } from '@/components/jira/InvestigatePanel';
import { ResearchInsightCard } from '@/components/jira/ResearchInsightCard';
import { StaleBanner } from '@/components/shared/StaleBanner';

// ── Sprint tag config ──────────────────────────────────────────────────────────

const SPRINT_TAGS = {
  current_sprint: { icon: '★', label: 'Sprint',    color: 'var(--accent)',  bg: 'rgba(99,102,241,0.1)' },
  closed_sprint:  { icon: '↩', label: 'Past Sprint', color: '#6b7280',       bg: 'var(--bg-3)' },
  backlog:        { icon: '◇', label: 'Backlog',    color: '#f59e0b',        bg: 'rgba(245,158,11,0.08)' },
  no_sprint:      { icon: '─', label: 'No Sprint',  color: 'var(--muted)',   bg: 'var(--bg-3)' },
} as const;

const PRIORITY_COLORS: Record<string, string> = {
  Highest: '#dc2626', High: '#ea580c', Medium: '#d97706',
  Low: '#65a30d', Lowest: '#6b7280',
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function SprintBanner({ sprint }: { sprint: SprintMeta }) {
  return (
    <span style={{
      fontSize: 12, color: 'var(--muted)', background: 'var(--bg-2)',
      padding: '3px 8px', borderRadius: 4,
    }}>
      {sprint.name}
      {sprint.start && sprint.end && ` · ${sprint.start} – ${sprint.end}`}
      {sprint.total > 0 && ` · ${sprint.total} tickets`}
    </span>
  );
}

function MissingConfigBanner() {
  return (
    <div style={{
      padding: '10px 16px', background: 'rgba(245,158,11,0.08)',
      borderBottom: '1px solid var(--border)', fontSize: 13,
    }}>
      <strong>Mine tab requires configuration:</strong> Set{' '}
      <code style={{ background: 'var(--bg-3)', padding: '1px 4px', borderRadius: 3 }}>
        JIRA_MY_USERNAME=yourUsername
      </code>{' '}
      in your <code>.env</code> file, then restart the bridge.
    </div>
  );
}

function McpReconnectPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{
      margin: 16, padding: 16, background: 'var(--bg-2)',
      border: '1px solid var(--border)', borderRadius: 8, fontSize: 13,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--danger)' }}>
        ⚠ Jira MCP is not connected
      </div>
      <div style={{ marginBottom: 10, color: 'var(--fg)' }}>
        Your Jira data cannot be fetched. To reconnect:
      </div>
      <ol style={{ margin: '0 0 12px', paddingLeft: 20, color: 'var(--fg)', lineHeight: 1.8 }}>
        <li>Open a terminal in this project</li>
        <li>
          Run:{' '}
          <code style={{
            background: 'var(--bg-3)', padding: '2px 6px', borderRadius: 3,
            display: 'block', marginTop: 4,
          }}>
            npm run mcp-setup -- --name my-jira --url https://mcp.example.com/jira
          </code>
        </li>
        <li>Complete the browser authentication</li>
        <li>Click Retry below</li>
      </ol>
      <button
        onClick={onRetry}
        style={{
          padding: '6px 14px', background: 'var(--accent)', color: '#fff',
          border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13,
        }}
      >
        Retry connection
      </button>
    </div>
  );
}

// ── TicketList ─────────────────────────────────────────────────────────────────

interface TicketListProps {
  issues: EnhancedIssue[];
  loading: boolean;
  error: string | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  showAssignee: boolean;
  width: number;
}

function TicketList({ issues, loading, error, selectedKey, onSelect, showAssignee, width }: TicketListProps) {
  if (loading && issues.length === 0) {
    return (
      <div style={{
        width, borderRight: '1px solid var(--border)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13,
      }}>
        Loading…
      </div>
    );
  }
  if (error && issues.length === 0) {
    return (
      <div style={{
        width, borderRight: '1px solid var(--border)', padding: 16,
        color: 'var(--danger)', fontSize: 13,
      }}>
        {error}
      </div>
    );
  }
  if (issues.length === 0) {
    return (
      <div style={{
        width, borderRight: '1px solid var(--border)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13,
      }}>
        No tickets found
      </div>
    );
  }

  return (
    <div style={{
      width, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto',
    }}>
      {issues.map(issue => {
        const tag = SPRINT_TAGS[issue.sprintContext] ?? SPRINT_TAGS.no_sprint;
        const priorityColor = PRIORITY_COLORS[issue.priority ?? ''] ?? 'var(--muted)';
        const isSelected = issue.key === selectedKey;

        return (
          <div
            key={issue.key}
            onClick={() => onSelect(issue.key)}
            style={{
              padding: '10px 12px',
              cursor: 'pointer',
              borderBottom: '1px solid var(--border)',
              background: isSelected ? 'var(--bg-2)' : 'transparent',
              borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
              transition: 'background 0.1s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              {/* Priority color dot */}
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: priorityColor, flexShrink: 0,
              }} />
              <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
                {issue.key}
              </span>
              {issue.priority && (
                <span style={{ fontSize: 10, color: priorityColor, fontWeight: 600, marginLeft: 'auto' }}>
                  {issue.priority.toUpperCase().slice(0, 3)}
                </span>
              )}
            </div>
            <div style={{
              fontSize: 13, color: 'var(--fg)', lineHeight: '1.35', marginBottom: 5,
              fontWeight: isSelected ? 500 : 400,
            }}>
              {issue.title}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{issue.status}</span>
              {showAssignee && issue.assignee && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  · {issue.assignee.split(',')[0]}
                </span>
              )}
              <span style={{
                marginLeft: 'auto',
                fontSize: 10,
                fontWeight: 500,
                color: tag.color,
                background: tag.bg,
                padding: '1px 5px',
                borderRadius: 4,
              }}>
                {tag.icon}{' '}
                {issue.sprintContext === 'closed_sprint' && issue.sprintName
                  ? issue.sprintName
                  : tag.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── AnalysisCardWrapper ────────────────────────────────────────────────────────

// AnalysisCard lives in this file (retained from old JiraReportPage), referenced below.
// We keep only the AnalysisCard component and MdBlock helper; all old list/column components removed.

function timeAgo(ts: string): string {
  if (!ts || ts === 'Unknown' || ts === 'unknown') return '–';
  const d = new Date(ts.replace(' ', 'T'));
  if (isNaN(d.getTime())) return '–';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

import ReactMarkdown from 'react-markdown';
import { linkifyChildren } from '@/lib/linkify'; // U-10 phase 1.5
import { RefreshCw, Zap, AlertCircle, CheckCircle2, Clock, GitPullRequest, BookOpen, MessageSquare, ExternalLink, ChevronDown, Globe } from 'lucide-react';
import { useUIStore } from '@/store/ui';
import { useChatStore } from '@/store/chat';

function MdBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => (
          <h1 className="text-sm font-bold mt-4 mb-2 tracking-tight" style={{ color: 'var(--fg)' }}>{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-[13px] font-semibold mt-3.5 mb-1.5" style={{ color: 'var(--fg)' }}>{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-xs font-semibold mt-3 mb-1" style={{ color: 'var(--fg-2)' }}>{children}</h3>
        ),
        p: ({ children }) => (
          <p className="mb-2.5 last:mb-0 text-[13px] leading-[1.7]">{linkifyChildren(children)}</p>
        ),
        ul: ({ children }) => <ul className="list-none pl-0 mb-2.5 space-y-1.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2.5 space-y-1.5">{children}</ol>,
        li: ({ children }) => (
          <li className="text-[13px] flex items-start gap-2 leading-[1.6]">
            <span className="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--muted)' }} />
            <span>{linkifyChildren(children)}</span>
          </li>
        ),
        code: ({ children, className }) => {
          const isBlock = className?.startsWith('language-');
          return isBlock
            ? <code className="block px-3 py-2.5 rounded-lg text-[11px] font-mono overflow-x-auto mt-1.5 mb-2.5 leading-[1.6]" style={{ background: 'var(--bg-3)', color: 'var(--fg)' }}>{children}</code>
            : <code className="px-1.5 py-0.5 rounded text-[11px] font-mono" style={{ background: 'var(--bg-3)', color: 'var(--accent)' }}>{children}</code>;
        },
        pre: ({ children }) => (
          <pre className="mb-2.5 rounded-lg overflow-x-auto" style={{ background: 'var(--bg-3)' }}>{children}</pre>
        ),
        strong: ({ children }) => <strong className="font-semibold" style={{ color: 'var(--fg)' }}>{linkifyChildren(children)}</strong>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer"
            className="underline underline-offset-2 hover:opacity-80 transition-opacity"
            style={{ color: 'var(--accent)' }}>{children}</a>
        ),
        hr: () => <hr className="my-4" style={{ borderColor: 'var(--border)' }} />,
        blockquote: ({ children }) => (
          <blockquote className="pl-3.5 my-2.5 text-[13px] italic leading-[1.6]"
            style={{ borderLeft: '3px solid var(--accent)', color: 'var(--fg-2)' }}>{children}</blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

type AnalysisTab = 'analysis' | 'effort' | 'explanation' | 'solution' | 'codeimpact' | 'sources' | 'notes';

const TYPE_COLORS: Record<string, string> = {
  jira: '#2563eb',
  confluence: '#f97316',
  github: '#8b5cf6',
  docs: '#10b981',
  generic: 'var(--muted)',
};

function LinkedSourceItem({ source }: { source: { url: string; type: string; content: string; strategy: string; fetchedAt: string } }) {
  const [expanded, setExpanded] = useState(false);
  const color = TYPE_COLORS[source.type] || 'var(--muted)';
  const displayUrl = source.url.replace(/^https?:\/\//, '').slice(0, 60);

  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-2)] transition-colors"
      >
        <Globe size={11} style={{ color, flexShrink: 0 }} />
        <span className="flex-1 text-[12px] font-mono truncate" style={{ color: 'var(--fg)' }}>{displayUrl}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0"
          style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}>
          {source.type}
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
          style={{ background: 'var(--bg-2)', color: 'var(--muted)' }}>
          {source.strategy}
        </span>
        <ChevronDown size={10} style={{ color: 'var(--muted)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {expanded && (
        <div className="border-t px-3 py-2.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}>
          <pre className="text-[11px] leading-[1.5] whitespace-pre-wrap max-h-[200px] overflow-y-auto" style={{ color: 'var(--fg-2)' }}>
            {source.content.slice(0, 2000)}
          </pre>
          <a href={source.url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-2 text-[10px] hover:underline"
            style={{ color: 'var(--accent)' }}>
            <ExternalLink size={9} /> Open original
          </a>
        </div>
      )}
    </div>
  );
}

function AnalysisCard({
  analysis,
  isPending,
  onAnalyze,
  onDiscuss,
  issueKey,
  issueTitle,
}: {
  analysis: JiraAnalysis | null;
  isPending: boolean;
  onAnalyze: () => void;
  onDiscuss: () => void;
  issueKey: string;
  issueTitle: string;
}) {
  const [tab, setTab] = useState<AnalysisTab>('analysis');
  const [draftingPR, setDraftingPR] = useState(false);
  const [draftPRResult, setDraftPRResult] = useState<string | null>(null);
  const [notesText, setNotesText] = useState(analysis?.notes ?? '');
  const [notesSaving, setNotesSaving] = useState(false);

  if (isPending || analysis?.status === 'pending') {
    return (
      <div className="mx-3 mb-3 rounded-xl border overflow-hidden"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="relative flex items-center justify-center w-6 h-6 rounded-full shrink-0"
            style={{ background: 'rgba(37,99,235,0.1)' }}>
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
          </div>
          <div className="flex-1">
            <p className="text-[11px] font-medium" style={{ color: 'var(--fg)' }}>Analyzing…</p>
            <p className="text-[10px]" style={{ color: 'var(--muted)' }}>Running 5 parallel AI checks in background</p>
          </div>
          <div className="flex gap-0.5">
            {[0, 1, 2].map(i => (
              <span key={i} className="w-1 h-3 rounded-full animate-pulse"
                style={{ background: 'var(--accent)', opacity: 0.3 + i * 0.3, animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="mx-3 mb-3 rounded-xl border px-4 py-3 flex items-center justify-between"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2">
          <Zap size={12} style={{ color: 'var(--muted)' }} />
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>No AI analysis yet for this ticket</span>
        </div>
        <button
          onClick={onAnalyze}
          className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-90 active:scale-95"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          <Zap size={10} />
          Analyze
        </button>
      </div>
    );
  }

  let solutionData: { solution: string; steps: string[]; missingInfo: string | null } | null = null;
  let codeImpactData: { impactedFiles: string[]; riskLevel: 'low' | 'medium' | 'high'; rationale: string } | null = null;
  let linkedSources: { url: string; type: string; content: string; strategy: string; fetchedAt: string }[] = [];
  try { if (analysis.solution) solutionData = JSON.parse(analysis.solution); } catch { /* ignore */ }
  try { if (analysis.code_impact) codeImpactData = JSON.parse(analysis.code_impact); } catch { /* ignore */ }
  try { if (analysis.linked_content) linkedSources = JSON.parse(analysis.linked_content); } catch { /* ignore */ }

  const riskColor = codeImpactData
    ? codeImpactData.riskLevel === 'high' ? '#ef4444'
      : codeImpactData.riskLevel === 'medium' ? '#f97316'
      : '#10b981'
    : 'var(--muted)';

  const tabs: { id: AnalysisTab; label: string; hasContent: boolean }[] = [
    { id: 'analysis',    label: 'Analysis',    hasContent: !!analysis.analysis },
    { id: 'effort',      label: 'Effort',      hasContent: !!analysis.effort },
    { id: 'explanation', label: 'Explanation', hasContent: !!analysis.explanation },
    { id: 'solution',    label: 'Solution',    hasContent: !!solutionData },
    { id: 'codeimpact',  label: 'Code Impact', hasContent: !!codeImpactData },
    { id: 'sources',     label: 'Sources',     hasContent: linkedSources.length > 0 },
    { id: 'notes',       label: 'Notes',       hasContent: !!(analysis.notes) },
  ];

  async function handleDraftPR() {
    if (!solutionData) return;
    setDraftingPR(true);
    setDraftPRResult(null);
    try {
      const res = await api.draftPR(issueKey, {
        title: `[${issueKey}] ${issueTitle}`,
        prBody: `## Solution\n${solutionData.solution}\n\n## Steps\n${solutionData.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      });
      setDraftPRResult(res.url ?? 'PR created');
    } catch (err) {
      setDraftPRResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDraftingPR(false);
    }
  }

  return (
    <div className="mx-3 mb-3 rounded-xl border overflow-hidden flex flex-col flex-1"
      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
      {/* Tab bar */}
      <div className="flex items-center justify-between px-3 pt-2 pb-0 border-b"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="relative px-3 py-1.5 text-[11px] font-medium transition-colors rounded-t-md shrink-0"
              style={{
                color: tab === t.id ? 'var(--accent)' : t.hasContent ? 'var(--fg-2)' : 'var(--muted)',
                background: tab === t.id ? 'var(--bg)' : 'transparent',
                opacity: t.hasContent ? 1 : 0.5,
              }}
            >
              {t.label}
              {tab === t.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t-full"
                  style={{ background: 'var(--accent)' }} />
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pb-1 shrink-0">
          <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--muted)' }}>
            <Clock size={9} />
            {timeAgo(analysis.analyzed_at)}
          </span>
          <button
            onClick={onDiscuss}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md hover:bg-[var(--bg-3)] transition-colors"
            style={{ color: 'var(--accent)' }}
            title="Discuss with AI"
          >
            <MessageSquare size={9} />
            Discuss
          </button>
          <button
            onClick={onAnalyze}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md hover:bg-[var(--bg-3)] transition-colors"
            style={{ color: 'var(--muted)' }}
            title="Re-run analysis"
          >
            <RefreshCw size={9} />
            Re-run
          </button>
        </div>
      </div>
      {/* Content */}
      <div className="px-5 py-4 text-[13px] leading-[1.7] flex-1 overflow-y-auto"
        style={{ color: 'var(--fg)' }}>
        {tab === 'solution' ? (
          solutionData ? (
            <div className="space-y-4">
              <p className="text-[13px] leading-[1.7]" style={{ color: 'var(--fg)' }}>{solutionData.solution}</p>
              {solutionData.steps.length > 0 && (
                <ol className="space-y-2 pl-5">
                  {solutionData.steps.map((step, i) => (
                    <li key={i} className="text-[13px] leading-[1.6]" style={{ color: 'var(--fg)', listStyleType: 'decimal' }}>{step}</li>
                  ))}
                </ol>
              )}
              {solutionData.missingInfo && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg"
                  style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}>
                  <AlertCircle size={13} style={{ color: '#eab308', marginTop: 2, flexShrink: 0 }} />
                  <span className="text-[12px] leading-[1.5]" style={{ color: '#eab308' }}>{solutionData.missingInfo}</span>
                </div>
              )}
              <div className="pt-1">
                {draftPRResult ? (
                  <div className="flex items-center gap-2 text-[10px]"
                    style={{ color: draftPRResult.startsWith('Error') ? 'var(--danger)' : '#10b981' }}>
                    {!draftPRResult.startsWith('Error') && <CheckCircle2 size={10} />}
                    {draftPRResult.startsWith('http') ? (
                      <a href={draftPRResult} target="_blank" rel="noopener noreferrer"
                        className="hover:underline">{draftPRResult}</a>
                    ) : draftPRResult}
                  </div>
                ) : (
                  <button
                    onClick={handleDraftPR}
                    disabled={draftingPR}
                    className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg font-medium transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                  >
                    <GitPullRequest size={10} />
                    {draftingPR ? 'Creating…' : 'Create Draft PR'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-center py-4" style={{ color: 'var(--muted)' }}>Solution not yet generated — re-run analysis</p>
          )
        ) : tab === 'codeimpact' ? (
          codeImpactData ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold px-2.5 py-1 rounded-md"
                  style={{ background: `${riskColor}18`, color: riskColor, border: `1px solid ${riskColor}30` }}>
                  {codeImpactData.riskLevel.toUpperCase()} RISK
                </span>
                <span className="text-[13px]" style={{ color: 'var(--muted)' }}>{codeImpactData.rationale}</span>
              </div>
              {codeImpactData.impactedFiles.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>IMPACTED FILES</p>
                  {codeImpactData.impactedFiles.map(f => (
                    <div key={f} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md"
                      style={{ background: 'var(--bg-2)', border: '1px solid var(--border)' }}>
                      <span className="font-mono text-[12px]" style={{ color: 'var(--fg)' }}>{f}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-center py-4" style={{ color: 'var(--muted)' }}>Code impact not yet analysed — re-run analysis</p>
          )
        ) : tab === 'sources' ? (
          linkedSources.length > 0 ? (
            <div className="space-y-3">
              <p className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
                {linkedSources.length} linked document{linkedSources.length > 1 ? 's' : ''} fetched during analysis
              </p>
              {linkedSources.map((src, i) => (
                <LinkedSourceItem key={i} source={src} />
              ))}
            </div>
          ) : (
            <p className="text-center py-4" style={{ color: 'var(--muted)' }}>No linked documents found in ticket</p>
          )
        ) : tab === 'notes' ? (
          <div className="space-y-3">
            <p className="text-[12px]" style={{ color: 'var(--muted)' }}>Investigation notes — never overwritten by AI re-analysis</p>
            <textarea
              className="w-full rounded-md px-3 py-2.5 text-[13px] font-mono resize-y min-h-[140px] leading-[1.6]"
              style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)' }}
              value={notesText}
              onChange={e => setNotesText(e.target.value)}
              placeholder="Paste investigation findings, root cause, proposed fix…"
            />
            <button
              className="px-3 py-1.5 rounded-md text-xs font-medium"
              style={{ background: 'var(--accent)', color: '#fff', opacity: notesSaving ? 0.6 : 1 }}
              disabled={notesSaving}
              onClick={async () => {
                setNotesSaving(true);
                try { await api.saveJiraNotes(issueKey, notesText); } finally { setNotesSaving(false); }
              }}
            >
              {notesSaving ? 'Saving…' : 'Save Notes'}
            </button>
          </div>
        ) : (
          (() => {
            const content = tab === 'analysis' ? analysis.analysis
              : tab === 'effort' ? analysis.effort
              : analysis.explanation;
            return content
              ? <MdBlock content={content} />
              : <p className="text-center py-4" style={{ color: 'var(--muted)' }}>No content for this section</p>;
          })()
        )}
      </div>
    </div>
  );
}

// ── AnalysisCardWrapper ────────────────────────────────────────────────────────

function AnalysisCardWrapper({ issueKey, issueTitle, issueStatus, issueAssignee, issueEpic, onAnalysisLoaded, onDiscuss }: {
  issueKey: string;
  issueTitle: string;
  issueStatus: string;
  issueAssignee: string | null;
  issueEpic: string | null;
  onAnalysisLoaded: (a: JiraAnalysis | null) => void;
  onDiscuss: () => void;
}) {
  const [analysis, setAnalysis] = useState<JiraAnalysis | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [researchFindings, setResearchFindings] = useState<{ title: string; explanation: string; relevantFiles: string[]; confidence: number }[]>([]);
  const [researchId, setResearchId] = useState<number | null>(null);

  useEffect(() => {
    api.getJiraAnalysis(issueKey)
      .then(a => {
        const resolved = a?.status === 'not_analyzed' ? null : a;
        setAnalysis(resolved);
        onAnalysisLoaded(resolved);
        setLoaded(true);
      })
      .catch(() => { setAnalysis(null); onAnalysisLoaded(null); setLoaded(true); });
  }, [issueKey]);

  useEffect(() => {
    if (!issueTitle) return;
    const q = `What code paths are affected by this ticket? Key: ${issueKey}, Title: ${issueTitle}`;
    fetch(`/api/research/findings?question=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(data => { setResearchFindings(data.findings || []); setResearchId(data.researchId || null); })
      .catch(() => { setResearchFindings([]); setResearchId(null); });
  }, [issueKey, issueTitle]);

  // Poll while pending
  useEffect(() => {
    if (!isPending && analysis?.status !== 'pending') return;
    const t = setInterval(() => {
      api.getJiraAnalysis(issueKey)
        .then(a => {
          setAnalysis(a);
          onAnalysisLoaded(a);
          if (a.status === 'done') { setIsPending(false); clearInterval(t); }
        })
        .catch(() => { setIsPending(false); clearInterval(t); });
    }, 3000);
    return () => clearInterval(t);
  }, [isPending, analysis?.status, issueKey]);

  async function handleAnalyze() {
    setIsPending(true);
    try {
      await api.analyzeTicket({
        issueKey,
        title: issueTitle,
        status: issueStatus,
        assignee: issueAssignee,
        epic: issueEpic,
      });
    } catch (err) {
      console.error('analyzeTicket failed:', err);
      setIsPending(false);
    }
  }

  if (!loaded) return null;

  return (
    <>
      <AnalysisCard
        analysis={analysis}
        isPending={isPending}
        onAnalyze={handleAnalyze}
        onDiscuss={onDiscuss}
        issueKey={issueKey}
        issueTitle={issueTitle}
      />
      {researchFindings.length > 0 && (
        <ResearchInsightCard findings={researchFindings} researchId={researchId ?? undefined} />
      )}
    </>
  );
}

// ── TicketDetail ───────────────────────────────────────────────────────────────

interface TicketDetailProps {
  issueKey: string | null;
  detail: TicketDetail | null;
  loading: boolean;
  issues: EnhancedIssue[];
}

type DetailPanelTab = 'analysis' | 'investigate';

function TicketDetailPanel({ issueKey, detail, loading, issues }: TicketDetailProps) {
  const [loadedAnalysis, setLoadedAnalysis] = useState<JiraAnalysis | null>(null);
  const [detailTab, setDetailTab] = useState<DetailPanelTab>('analysis');
  const sendToChat = useUIStore(s => s.sendToChat);

  // Vertical resize: metadata area height
  const META_MIN = 100, META_DEFAULT = 260;
  const [metaHeight, setMetaHeight] = useState(() => {
    const v = localStorage.getItem('wi-jira-meta-height');
    const n = v ? parseInt(v, 10) : NaN;
    return isNaN(n) ? META_DEFAULT : Math.max(META_MIN, n);
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const metaDragY = useRef<number | null>(null);
  const metaDragStart = useRef(META_DEFAULT);
  const onMetaDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    metaDragY.current = e.clientY;
    metaDragStart.current = metaHeight;
    const maxH = containerRef.current ? containerRef.current.clientHeight * 0.7 : 600;
    function onMove(ev: MouseEvent) {
      if (metaDragY.current === null) return;
      const next = Math.min(maxH, Math.max(META_MIN, metaDragStart.current + (ev.clientY - metaDragY.current)));
      setMetaHeight(next);
      localStorage.setItem('wi-jira-meta-height', String(next));
    }
    function onUp() {
      metaDragY.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [metaHeight]);

  // Reset when ticket changes
  useEffect(() => { setLoadedAnalysis(null); setDetailTab('analysis'); }, [issueKey]);

  function buildDiscussMessage() {
    if (!detail) return '';
    const lines: string[] = [
      `Let's discuss ${detail.key}: ${detail.title}`,
      '',
      `**Ticket**`,
      `Status: ${detail.status}${detail.priority ? ` · ${detail.priority}` : ''}${detail.assignee ? ` · Assignee: ${detail.assignee}` : ''}`,
    ];
    if (detail.description) {
      lines.push('', '**Description**', detail.description.slice(0, 600) + (detail.description.length > 600 ? '…' : ''));
    }
    if (loadedAnalysis?.status === 'done') {
      if (loadedAnalysis.analysis) lines.push('', '**Analysis**', loadedAnalysis.analysis.slice(0, 500) + '…');
      if (loadedAnalysis.effort) lines.push('', '**Effort**', loadedAnalysis.effort.slice(0, 300) + '…');
      if (loadedAnalysis.solution) {
        try {
          const s = JSON.parse(loadedAnalysis.solution) as { solution: string; steps: string[] };
          lines.push('', '**Proposed Solution**', s.solution, ...s.steps.map((st, i) => `${i + 1}. ${st}`));
        } catch { /* ignore */ }
      }
      if (loadedAnalysis.notes) lines.push('', '**Investigation Notes**', loadedAnalysis.notes);
    }
    lines.push('', 'What would you like to explore or change about this ticket?');
    return lines.join('\n');
  }

  function handleDiscuss() {
    if (detail) {
      const title = `${detail.key}: ${detail.title}`.slice(0, 60);
      const store = useChatStore.getState();
      const existing = store.sessions.find(s => s.title.startsWith(detail.key));
      if (existing) {
        store.switchSession(existing.id);
        useUIStore.getState().setChatOpen(true);
        return;
      }
      store.newSession(title);
    }
    sendToChat(buildDiscussMessage());
  }

  if (!issueKey) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', fontSize: 13,
      }}>
        Select a ticket to view details
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', fontSize: 13,
      }}>
        Loading {issueKey}…
      </div>
    );
  }

  if (!detail) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', fontSize: 13,
      }}>
        Failed to load ticket
      </div>
    );
  }

  // Find the enhanced issue for epicName
  const enhancedIssue = issues.find(i => i.key === issueKey);

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Scrollable metadata section */}
      <div style={{ overflowY: 'auto', padding: '16px 20px', height: metaHeight, flexShrink: 0 }}>
      {/* Title + metadata */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace', marginBottom: 4,
        }}>
          {detail.key} · {detail.issueType ?? 'Issue'}
          {detail.priority && ` · ${detail.priority}`}
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>
          {detail.title}
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
          <span>Status: <strong style={{ color: 'var(--fg)' }}>{detail.status}</strong></span>
          {detail.assignee && (
            <span>Assignee: <strong style={{ color: 'var(--fg)' }}>{detail.assignee}</strong></span>
          )}
          {detail.reporter && <span>Reporter: {detail.reporter}</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <a
              href={detail.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)', fontSize: 12 }}
            >
              Open in Jira ↗
            </a>
          </div>
        </div>
        {detail.labels.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {detail.labels.map(l => (
              <span key={l} style={{
                fontSize: 10, background: 'var(--bg-3)',
                padding: '2px 6px', borderRadius: 4, color: 'var(--muted)',
              }}>
                {l}
              </span>
            ))}
          </div>
        )}
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />

      {/* Description */}
      {detail.description ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6,
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Description
          </div>
          <div style={{
            fontSize: 13, color: 'var(--fg)', lineHeight: 1.6,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {detail.description}
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>
          No description
        </div>
      )}

      {/* Comments */}
      {detail.comments.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8,
            textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Comments ({detail.comments.length})
          </div>
          {detail.comments.map((c, i) => (
            <div key={i} style={{
              marginBottom: 12, paddingLeft: 12, borderLeft: '2px solid var(--border)',
            }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 3 }}>
                {c.author} · {new Date(c.created).toLocaleDateString()}
              </div>
              <div style={{
                fontSize: 13, color: 'var(--fg)', lineHeight: 1.5,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {c.body}
              </div>
            </div>
          ))}
        </div>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />
      </div>{/* end scrollable metadata */}

      {/* Vertical resize handle */}
      <div
        onMouseDown={onMetaDragStart}
        style={{
          height: 5, flexShrink: 0, cursor: 'row-resize',
          background: 'var(--border)', transition: 'background 0.15s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'color-mix(in srgb, var(--accent) 40%, transparent)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--border)'; }}
      />

      {/* Detail panel tab bar */}
      <div style={{
        display: 'flex', gap: 2, padding: '4px 16px 0',
        borderBottom: '1px solid var(--border)', flexShrink: 0, background: 'var(--bg-2)',
      }}>
        {(['analysis', 'investigate'] as const).map(t => (
          <button
            key={t}
            onClick={() => setDetailTab(t)}
            style={{
              padding: '5px 12px', borderRadius: '6px 6px 0 0',
              border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: detailTab === t ? 600 : 400,
              background: detailTab === t ? 'var(--bg)' : 'transparent',
              color: detailTab === t ? 'var(--accent)' : 'var(--muted)',
              borderBottom: detailTab === t ? '2px solid var(--accent)' : '2px solid transparent',
              transition: 'color 0.1s',
            }}
          >
            {t === 'analysis' ? 'Analysis' : 'Investigate'}
          </button>
        ))}
      </div>

      {detailTab === 'analysis' && (
        <AnalysisCardWrapper
          issueKey={detail.key}
          issueTitle={detail.title}
          issueStatus={detail.status}
          issueAssignee={detail.assignee}
          issueEpic={enhancedIssue?.epicName ?? null}
          onAnalysisLoaded={setLoadedAnalysis}
          onDiscuss={handleDiscuss}
        />
      )}
      {detailTab === 'investigate' && (
        <InvestigatePanel
          issueKey={detail.key}
          title={detail.title}
          status={detail.status}
          assignee={detail.assignee}
          description={detail.description}
          createdAt={enhancedIssue?.updatedAt ?? new Date().toISOString()}
        />
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

// ── BrainStatsPanel — developer diagnostic panel (Phase 56) ───────────────────

function BrainStatsPanel() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<BrainStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (open && !stats) {
      api.brainStats().then(setStats).catch(console.error);
    }
  }, [open, stats]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.brainRefresh();
      setStats(null); // force reload on next open
      console.info(`[brain] refreshed ${r.refreshed} stale entries`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 16, fontSize: 12 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--muted)', textAlign: 'left',
        }}
      >
        <span style={{ fontWeight: 500 }}>Investigation Brain Stats</span>
        <span>{open ? '\u25B2' : '\u25BC'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
          {!stats ? (
            <p style={{ padding: '8px 0', color: 'var(--muted)' }}>Loading...</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 16, paddingTop: 8, alignItems: 'center' }}>
                <span>{stats.patternCount} patterns</span>
                <span style={{ color: stats.staleKnowledgeCount > 0 ? '#f59e0b' : undefined }}>
                  {stats.staleKnowledgeCount} stale entries
                </span>
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  style={{
                    marginLeft: 'auto', fontSize: 12, textDecoration: 'underline',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)',
                  }}
                >
                  {refreshing ? 'Refreshing...' : 'Refresh stale'}
                </button>
              </div>
              {stats.accuracyByRootCause.length > 0 && (
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 8 }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)' }}>
                      <th style={{ textAlign: 'left', paddingBottom: 4 }}>Root Cause Type</th>
                      <th style={{ textAlign: 'right', paddingBottom: 4 }}>Accuracy</th>
                      <th style={{ textAlign: 'right', paddingBottom: 4 }}>Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.accuracyByRootCause.map(r => (
                      <tr key={r.rootCauseType}>
                        <td>{r.rootCauseType}</td>
                        <td style={{ textAlign: 'right' }}>{(r.accuracy * 100).toFixed(0)}%</td>
                        <td style={{ textAlign: 'right' }}>{r.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function JiraReportPage() {
  const [tab, setTab] = useState<'mine' | 'sprint' | 'all'>('mine');
  const [boardData, setBoardData] = useState<JiraBoardResponse | null>(null);
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [ticketDetail, setTicketDetail] = useState<TicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mcpConnected, setMcpConnected] = useState<boolean | null>(null);
  // WR-50-2: showToast/newTeammatesCount are wired for a future feature — _autoImportSprintTeammates
  // runs server-side and does not currently push a count back to the frontend. When the backend
  // includes a `newTeammates` count in the jiraBoard response, call setNewTeammatesCount and
  // setShowToast(true) here after a successful sprint tab load.
  const [newTeammatesCount, setNewTeammatesCount] = useState(0);
  const [showToast, setShowToast] = useState(false);

  // Horizontal resize: ticket list width
  const LIST_MIN = 240, LIST_MAX = 600, LIST_DEFAULT = 340;
  const [listWidth, setListWidth] = useState(() => {
    const v = localStorage.getItem('wi-jira-list-width');
    const n = v ? parseInt(v, 10) : NaN;
    return isNaN(n) ? LIST_DEFAULT : Math.min(LIST_MAX, Math.max(LIST_MIN, n));
  });
  const listDragX = useRef<number | null>(null);
  const listDragStart = useRef(LIST_DEFAULT);
  const onListDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    listDragX.current = e.clientX;
    listDragStart.current = listWidth;
    function onMove(ev: MouseEvent) {
      if (listDragX.current === null) return;
      const next = Math.min(LIST_MAX, Math.max(LIST_MIN, listDragStart.current + (ev.clientX - listDragX.current)));
      setListWidth(next);
      localStorage.setItem('wi-jira-list-width', String(next));
    }
    function onUp() {
      listDragX.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [listWidth]);

  const loadBoard = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.jiraBoard(tab, forceRefresh);
      setBoardData(data);
      // Cache count for this tab so switching tabs doesn't lose the badge
      const count = tab === 'sprint' ? (data.sprint?.total ?? data.issues.length) : data.issues.length;
      setTabCounts(prev => ({ ...prev, [tab]: count }));
      // Wire toast when backend returns newTeammates count (sprint tab only)
      if (tab === 'sprint' && (data as { newTeammates?: number }).newTeammates) {
        const count = (data as { newTeammates?: number }).newTeammates ?? 0;
        if (count > 0) { setNewTeammatesCount(count); setShowToast(true); }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load board');
      // WR-50-4: clear stale ticket detail when board load fails
      setSelectedKey(null);
      setTicketDetail(null);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  const loadTicketDetail = useCallback(async (key: string) => {
    setDetailLoading(true);
    setTicketDetail(null);
    try {
      const detail = await api.getTicketDetail(key);
      setTicketDetail(detail);
    } catch (e) {
      console.error('Failed to load ticket detail:', e);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // Load board on tab change
  useEffect(() => { void loadBoard(); }, [loadBoard]);

  // Load ticket detail on selection
  useEffect(() => {
    if (selectedKey) void loadTicketDetail(selectedKey);
  }, [selectedKey, loadTicketDetail]);

  // MCP connection status is derived from boardData.dataSource — no separate probe needed.
  // dataSource='mcp' → connected, 'browser' → MCP failed, 'db_stale' → both failed.
  // mcpConnected state kept for McpReconnectPanel compatibility but driven by dataSource.
  useEffect(() => {
    if (!boardData) return;
    if (boardData.dataSource === 'mcp') setMcpConnected(true);
    else if (boardData.dataSource === 'browser' || boardData.dataSource === 'db_stale') setMcpConnected(false);
  }, [boardData?.dataSource]);

  // Poll while background refresh is in progress (stale-while-revalidate pattern)
  useEffect(() => {
    if (!boardData?.isRefreshing || loading) return;
    const t = setInterval(() => { void loadBoard(); }, 3000);
    return () => clearInterval(t);
  }, [boardData?.isRefreshing, loading, loadBoard]);

  const issues = boardData?.issues ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Jira</h1>
          {boardData?.sprint && <SprintBanner sprint={boardData.sprint} />}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {boardData && (
              <span style={{
                fontSize: 11, fontWeight: 500,
                padding: '2px 8px', borderRadius: 4,
                background: boardData.dataSource === 'mcp'
                  ? 'rgba(16,185,129,0.12)'
                  : boardData.dataSource === 'browser'
                    ? 'rgba(99,102,241,0.12)'
                    : 'rgba(239,68,68,0.1)',
                color: boardData.dataSource === 'mcp'
                  ? '#10b981'
                  : boardData.dataSource === 'browser'
                    ? 'var(--accent)'
                    : 'var(--danger)',
                border: `1px solid ${boardData.dataSource === 'mcp' ? 'rgba(16,185,129,0.3)' : boardData.dataSource === 'browser' ? 'rgba(99,102,241,0.3)' : 'rgba(239,68,68,0.3)'}`,
              }}>
              {boardData.dataSource === 'mcp'
                ? '● MCP'
                : boardData.dataSource === 'browser'
                  ? '● Browser'
                  : '● Stale'}
            </span>
            )}
            <button
              onClick={() => void loadBoard(true)}
              disabled={loading || (boardData?.isRefreshing ?? false)}
              style={{
                padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--bg-2)', color: 'var(--fg)',
              }}
            >
              {loading || boardData?.isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4 }}>
          {(['mine', 'sprint', 'all'] as const).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setSelectedKey(null); }}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                border: 'none',
                background: tab === t ? 'var(--accent)' : 'var(--bg-2)',
                color: tab === t ? '#fff' : 'var(--fg)',
                cursor: 'pointer',
                fontWeight: tab === t ? 600 : 400,
                fontSize: 13,
              }}
            >
              {t === 'mine'
                ? `Mine${tabCounts.mine != null ? ` (${tabCounts.mine})` : ''}`
                : t === 'sprint'
                  ? `Sprint${tabCounts.sprint != null ? ` (${tabCounts.sprint})` : ''}`
                  : `All${tabCounts.all != null ? ` (${tabCounts.all})` : ''}`}
            </button>
          ))}
        </div>
      </div>

      {/* Banners */}
      {boardData?.missingConfig && <MissingConfigBanner />}
      {mcpConnected === false && (!boardData || issues.length === 0) && (
        <McpReconnectPanel onRetry={() => void loadBoard(true)} />
      )}
      {boardData?.dataSource === 'browser' && (
        <div style={{ borderBottom: '1px solid var(--border)', padding: '0 8px' }}>
          <StaleBanner
            stale
            tone="warning"
            reason="MCP unavailable — board loaded via browser scraper"
            cachedAt={boardData.cachedAt}
            className="mb-0 rounded-none border-0"
            action={
              <button
                type="button"
                onClick={() => void loadBoard(true)}
                className="text-[11px] px-2 py-1 rounded border shrink-0"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-2)', background: 'var(--bg-3)' }}
              >
                Retry MCP
              </button>
            }
          />
        </div>
      )}
      {boardData?.dataSource === 'db_stale' && (
        <div style={{ borderBottom: '1px solid var(--border)', padding: '0 8px' }}>
          <StaleBanner
            stale
            tone="danger"
            reason="MCP and browser scraper failed — showing cached board"
            cachedAt={boardData.cachedAt}
            className="mb-0 rounded-none border-0"
            action={
              <button
                type="button"
                onClick={() => void loadBoard(true)}
                className="text-[11px] px-2 py-1 rounded border shrink-0"
                style={{ borderColor: 'var(--danger)', color: 'var(--danger)', background: 'transparent' }}
              >
                Retry
              </button>
            }
          />
        </div>
      )}

      {/* Main: list + detail */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <TicketList
          issues={issues}
          loading={loading}
          error={error}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          showAssignee={tab !== 'mine'}
          width={listWidth}
        />
        {/* Horizontal resize handle */}
        <div
          onMouseDown={onListDragStart}
          style={{
            width: 5, flexShrink: 0, cursor: 'col-resize',
            background: 'var(--border)', transition: 'background 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'color-mix(in srgb, var(--accent) 40%, transparent)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--border)'; }}
        />
        <TicketDetailPanel
          issueKey={selectedKey}
          detail={ticketDetail}
          loading={detailLoading}
          issues={issues}
        />
      </div>

      <BrainStatsPanel />

      {/* Toast */}
      {showToast && newTeammatesCount > 0 && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, background: 'var(--bg-2)',
          border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 100,
        }}>
          <span style={{ fontSize: 13 }}>
            ✓ {newTeammatesCount} new teammate{newTeammatesCount > 1 ? 's' : ''} from Saturn-93.{' '}
            <a href="/teammates" style={{ color: 'var(--accent)' }}>View in Teammates →</a>
          </span>
          <button
            onClick={() => setShowToast(false)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted)', fontSize: 16,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Keep BookOpen import used (referenced via AnalysisCard's similar-learning badge placeholder) */}
      <span style={{ display: 'none' }}><BookOpen size={0} /></span>
    </div>
  );
}
