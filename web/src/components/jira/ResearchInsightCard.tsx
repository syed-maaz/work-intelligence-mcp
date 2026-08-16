import { useState } from 'react';

interface ResearchFinding {
  title: string;
  explanation: string;
  relevantFiles: string[];
  confidence: number;
}

interface ResearchInsightCardProps {
  findings: ResearchFinding[];
  researchId?: number;
}

export function ResearchInsightCard({ findings, researchId }: ResearchInsightCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState<number | null>(null);

  if (!findings || findings.length === 0) return null;

  const sendFeedback = async (feedback: 1 | -1) => {
    if (!researchId || feedbackSent !== null) return;
    try {
      await fetch('/api/research/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ researchId, feedback }),
      });
      setFeedbackSent(feedback);
    } catch { /* silent */ }
  };

  return (
    <div className="research-insight-card" style={{ border: '1px solid var(--border-muted)', borderRadius: 8, padding: '12px 16px', marginTop: 12, background: 'var(--bg-subtle, #f8f9fa)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: '#7c3aed', color: '#fff', fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4 }}>claude-code</span>
          <span style={{ fontWeight: 500, fontSize: 14 }}>Deep Research ({findings.length} findings)</span>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{expanded ? '▼' : '▶'}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {findings.map((f, i) => (
            <div key={i} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: i < findings.length - 1 ? '1px solid var(--border-muted)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{f.title}</span>
                <span style={{ fontSize: 11, color: f.confidence >= 0.7 ? '#16a34a' : '#ca8a04', background: f.confidence >= 0.7 ? '#dcfce7' : '#fef9c3', padding: '1px 5px', borderRadius: 3 }}>
                  {Math.round(f.confidence * 100)}%
                </span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0', lineHeight: 1.4 }}>
                {f.explanation.slice(0, 300)}{f.explanation.length > 300 ? '...' : ''}
              </p>
              {f.relevantFiles.length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Files: {f.relevantFiles.slice(0, 5).join(', ')}
                </div>
              )}
            </div>
          ))}

          {researchId && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-muted)' }}>
              <button
                onClick={() => sendFeedback(1)}
                disabled={feedbackSent !== null}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border-muted)', cursor: feedbackSent !== null ? 'default' : 'pointer', background: feedbackSent === 1 ? '#dcfce7' : 'transparent' }}
              >
                👍 {feedbackSent === 1 ? 'Thanks!' : 'Helpful'}
              </button>
              <button
                onClick={() => sendFeedback(-1)}
                disabled={feedbackSent !== null}
                style={{ fontSize: 12, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border-muted)', cursor: feedbackSent !== null ? 'default' : 'pointer', background: feedbackSent === -1 ? '#fee2e2' : 'transparent' }}
              >
                👎 {feedbackSent === -1 ? 'Noted' : 'Not useful'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
