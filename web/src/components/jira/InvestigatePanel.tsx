import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, type InvestigationSession, type InvestigationReport, type ReActEntry } from '@/lib/api';
import { formatConfidence } from '@/lib/confidence';
import { StaleBanner } from '@/components/shared/StaleBanner';

// ---------------------------------------------------------------------------
// InvestigatePanel — Phase 55 Wave 5
// Live ReAct trace viewer + conclusion card for a Jira ticket investigation.
// ---------------------------------------------------------------------------

interface InvestigatePanelProps {
  issueKey: string;
  title: string;
  status: string;
  assignee: string | null;
  description: string | null;
  createdAt: string;
}

export function InvestigatePanel({
  issueKey, title, status, assignee, description, createdAt,
}: InvestigatePanelProps) {
  const [session, setSession] = useState<InvestigationSession | null>(null);
  const [polling, setPolling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial load of existing session on mount / issueKey change — auto-start if none exists
  useEffect(() => {
    api.getInvestigation(issueKey).then(s => {
      if (s) {
        setSession(s);
        if (s.status === 'running') setPolling(true);
      } else {
        // No prior session — kick off automatically
        startInvestigation();
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueKey]);

  // Poll every 2s while running
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      try {
        const s = await api.getInvestigation(issueKey);
        setSession(s);
        if (!s || s.status !== 'running') setPolling(false);
      } catch {
        setPolling(false);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [polling, issueKey]);

  async function startInvestigation() {
    setStarting(true);
    setError(null);
    try {
      await api.startInvestigation({
        issueKey,
        title,
        status,
        assignee,
        description: description ?? '',
        createdAt,
      });
      setPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start investigation');
    } finally {
      setStarting(false);
    }
  }

  if (!session) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', padding: '32px 24px', gap: 12,
      }}>
        {starting ? (
          <>
            <div style={{ width: 20, height: 20, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>Starting investigation…</p>
          </>
        ) : (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0, textAlign: 'center' }}>
              No investigation yet for this ticket.
            </p>
            {error && (
              <p style={{ color: 'var(--danger)', fontSize: 12, margin: 0 }}>{error}</p>
            )}
            <button
              onClick={startInvestigation}
              disabled={starting}
              style={{
                padding: '8px 18px', background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 7, cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
              }}
            >
              Investigate Like a Senior Dev
            </button>
          </>
        )}
      </div>
    );
  }

  const traceStale =
    session.status === 'done' &&
    session.completedAt != null &&
    Date.now() - Date.parse(session.completedAt) > 3_600_000;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 20px', overflowY: 'auto' }}>
      {/* U-16: conclusion first */}
      {session.report && <ConclusionCard report={session.report} />}

      {traceStale && (
        <StaleBanner
          stale
          reason="Investigation completed earlier — re-run for a fresh trace"
          cachedAt={session.completedAt}
        />
      )}

      {/* U-16: full ReAct trace collapsed by default */}
      <InvestigationTraceSection session={session} />

      {/* Re-investigate button */}
      {session.status !== 'running' && (
        <button
          onClick={startInvestigation}
          disabled={starting}
          style={{
            alignSelf: 'flex-start', padding: '8px 16px',
            background: 'var(--bg-2)', color: 'var(--fg)',
            border: '1px solid var(--border)', borderRadius: 7,
            cursor: starting ? 'default' : 'pointer', fontSize: 13,
            opacity: starting ? 0.7 : 1, fontWeight: 500,
          }}
        >
          {starting ? 'Starting…' : 'Re-investigate'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InvestigationTraceSection — U-16: collapsed trace by default
// ---------------------------------------------------------------------------

function InvestigationTraceSection({ session }: { session: InvestigationSession }) {
  const [expanded, setExpanded] = useState(false);
  const stepCount = session.reactTrace.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-2)',
          cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--fg-2)',
          textAlign: 'left',
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
          Investigation trace
        </span>
        <span style={{ fontWeight: 500, color: 'var(--muted)' }}>
          {stepCount} step{stepCount === 1 ? '' : 's'}
          {session.status === 'running' ? ' · live' : ''}
        </span>
      </button>
      {expanded && (
        <>
          {session.reactTrace.map((entry, i) => (
            <ReActEntryRow key={i} entry={entry} />
          ))}
          {session.status === 'running' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px', borderRadius: 8,
              background: 'var(--bg-2)', border: '1px solid var(--border)',
              fontSize: 13, color: 'var(--muted)',
            }}>
              <Spinner />
              Investigating…
            </div>
          )}
          {session.reactTrace.length === 0 && session.status !== 'running' && (
            <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>
              No trace entries recorded.
            </div>
          )}
        </>
      )}
      {!expanded && session.status === 'running' && (
        <div style={{ fontSize: 12, color: 'var(--muted)', paddingLeft: 4 }}>
          <Spinner /> Running — expand to watch steps
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReActEntryRow — collapsible trace entry
// ---------------------------------------------------------------------------

function ReActEntryRow({ entry }: { entry: ReActEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = entry.thought || entry.toolInput || entry.observation;

  return (
    <div style={{
      borderRadius: 8, border: '1px solid var(--border)',
      background: 'var(--bg-2)', overflow: 'hidden',
    }}>
      <div
        onClick={() => { if (hasDetail) setExpanded(e => !e); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
          cursor: hasDetail ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        <span style={{
          fontSize: 11, fontFamily: 'monospace',
          color: 'var(--muted)', flexShrink: 0,
        }}>
          #{entry.iteration}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
          background: toolBadgeColor(entry.tool).bg,
          color: toolBadgeColor(entry.tool).text,
          flexShrink: 0,
        }}>
          {entry.tool}
        </span>
        <span style={{
          fontSize: 13, color: 'var(--fg-2)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {entry.thought ? entry.thought.slice(0, 90) + (entry.thought.length > 90 ? '…' : '') : ''}
        </span>
        {hasDetail && (
          <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </div>
      {expanded && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {entry.thought && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>THOUGHT</div>
              <div style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{entry.thought}</div>
            </div>
          )}
          {entry.toolInput && Object.keys(entry.toolInput).length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>TOOL INPUT</div>
              <pre style={{
                margin: 0, fontSize: 11, fontFamily: 'monospace', lineHeight: 1.5,
                background: 'var(--bg-3)', padding: '8px 10px', borderRadius: 6,
                overflowX: 'auto', color: 'var(--fg)',
              }}>
                {JSON.stringify(entry.toolInput, null, 2)}
              </pre>
            </div>
          )}
          {entry.observation && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>OBSERVATION</div>
              <div style={{
                fontSize: 13, color: 'var(--fg)', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                background: 'var(--bg-3)', padding: '8px 10px', borderRadius: 6,
                maxHeight: 240, overflowY: 'auto',
              }}>
                {entry.observation}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function toolBadgeColor(tool: string): { bg: string; text: string } {
  if (tool === 'conclude')        return { bg: 'rgba(16,185,129,0.15)',  text: '#10b981' };
  if (tool === 'git_log_window')  return { bg: 'rgba(99,102,241,0.15)', text: 'var(--accent)' };
  if (tool === 'get_dep_diff')    return { bg: 'rgba(245,158,11,0.15)', text: '#d97706' };
  if (tool === 'grep_code')       return { bg: 'rgba(239,68,68,0.12)',  text: '#ef4444' };
  if (tool === 'read_file')       return { bg: 'rgba(107,114,128,0.15)', text: '#6b7280' };
  if (tool === 'trace_call_graph') return { bg: 'rgba(168,85,247,0.15)', text: '#a855f7' };
  return { bg: 'var(--bg-3)', text: 'var(--muted)' };
}

// ---------------------------------------------------------------------------
// ConclusionCard — shown when investigation is done
// ---------------------------------------------------------------------------

function ConclusionCard({ report }: { report: InvestigationReport }) {
  const conf = formatConfidence(report.confidence);

  const ownerBadgeStyle = {
    fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 5,
    background: report.isExternalDep ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)',
    color: report.isExternalDep ? '#ef4444' : '#10b981',
    border: `1px solid ${report.isExternalDep ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)'}`,
  };

  return (
    <div style={{
      borderRadius: 10, border: '1px solid var(--border)',
      background: 'var(--bg)', overflow: 'hidden',
    }}>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg-2)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: conf.color }} title={conf.hint}>
          {conf.label}
        </span>
        <span style={ownerBadgeStyle}>
          Fix owner: {report.fixOwner}
        </span>
        {report.isExternalDep && (
          <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>EXTERNAL DEP</span>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Root cause */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Root Cause
          </div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--fg)', lineHeight: 1.6 }}>
            {report.rootCause}
          </p>
        </div>

        {/* example-service action */}
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Your action: </span>
          <span style={{ fontSize: 13, color: 'var(--fg)' }}>{report.nextAction}</span>
        </div>

        {/* Proposed fix steps */}
        {report.proposedFix && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Proposed Fix
            </div>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {report.proposedFix.steps.map((step, i) => (
                <li key={i} style={{ fontSize: 13, color: 'var(--fg)', marginBottom: 5, lineHeight: 1.6 }}>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Evidence */}
        {report.evidence.length > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Evidence
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {report.evidence.map((e, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--fg-2)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                    background: 'var(--bg-3)', color: 'var(--muted)', flexShrink: 0, marginTop: 3,
                  }}>
                    {e.type}
                  </span>
                  <span style={{ lineHeight: 1.5 }}>{e.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spinner helper
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10,
      border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  );
}
