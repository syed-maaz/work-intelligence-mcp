import { useState } from 'react';
import type { DecisionResult } from '@/lib/api';
import { api } from '@/lib/api';
import { CheckCircle2, Lightbulb, ListChecks, Zap, ThumbsUp, ThumbsDown, XCircle, Loader2 } from 'lucide-react';
import { linkify } from '@/lib/linkify';
import { formatConfidence } from '@/lib/confidence';
import { RecurringPatternBadge, type PastOutcome } from './RecurringPatternBadge';

interface Props {
  decision: DecisionResult;
}

interface PastOutcomeEvidence {
  source: 'past_outcome';
  id: string;
  outcomes: PastOutcome[];
}

function isPastOutcomeEvidence(ev: unknown): ev is PastOutcomeEvidence {
  if (!ev || typeof ev !== 'object') return false;
  const e = ev as Record<string, unknown>;
  return (
    e.source === 'past_outcome' &&
    typeof e.id === 'string' &&
    Array.isArray(e.outcomes)
  );
}

export function DecisionCard({ decision }: Props) {
  const conf = formatConfidence(decision.confidence);

  // Phase 71-04: pluck the synthetic past_outcome row out of evidence so the
  // badge renders above the decision text (visual feedback for the learning loop).
  // Remaining evidence rows still render inside the Evidence section below.
  const evidenceList = Array.isArray(decision.evidence) ? decision.evidence : [];
  const pastOutcome = evidenceList.find(isPastOutcomeEvidence);
  const otherEvidence = evidenceList.filter((ev) => !isPastOutcomeEvidence(ev));

  // U-18 — feedback state for the learning loop
  const [feedbackOutcome, setFeedbackOutcome] = useState<'success' | 'failed' | 'abandoned' | null>(
    decision.outcome && decision.outcome !== 'pending'
      ? (decision.outcome as 'success' | 'failed' | 'abandoned')
      : null,
  );
  const [feedbackPosting, setFeedbackPosting] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const sendFeedback = async (outcome: 'success' | 'failed' | 'abandoned') => {
    if (feedbackPosting || feedbackOutcome) return;
    setFeedbackPosting(true);
    setFeedbackError(null);
    try {
      await api.brainLearn({ decision_id: decision.decision_id, outcome });
      setFeedbackOutcome(outcome);
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : 'Failed to record outcome');
    } finally {
      setFeedbackPosting(false);
    }
  };

  return (
    <div
      className="rounded-xl border overflow-hidden text-xs"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
    >
      {/* Header strip */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ background: 'var(--bg-3)', borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-1.5">
          <Zap size={11} style={{ color: 'var(--accent)' }} />
          <span className="font-semibold text-[11px]" style={{ color: 'var(--fg)' }}>
            Brain Decision
          </span>
        </div>
        <span
          className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
          title={conf.hint}
          style={{ background: `${conf.color}22`, color: conf.color }}
        >
          {conf.label}
        </span>
      </div>

      <div className="px-3 py-2.5 space-y-3">
        {/* Phase 71-04: recurring pattern badge — above the decision text. */}
        {pastOutcome && (
          <RecurringPatternBadge
            outcomes={pastOutcome.outcomes}
            signature={pastOutcome.id}
          />
        )}

        {/* Section 1: Decision */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <CheckCircle2 size={10} style={{ color: 'var(--accent)' }} />
            <span className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--muted)' }}>
              Decision
            </span>
          </div>
          <p className="font-semibold leading-snug" style={{ color: 'var(--fg)' }}>
            {linkify(decision.decision)}
          </p>
        </div>

        {/* Section 2: Rationale */}
        {decision.rationale && (
          <div>
            <div className="flex items-center gap-1 mb-1">
              <Lightbulb size={10} style={{ color: 'var(--accent)' }} />
              <span className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--muted)' }}>
                Rationale
              </span>
            </div>
            <p className="leading-relaxed" style={{ color: 'var(--fg-2)' }}>
              {linkify(decision.rationale)}
            </p>
          </div>
        )}

        {/* Section 3: Evidence */}
        {otherEvidence.length > 0 && (
          <div>
            <div className="flex items-center gap-1 mb-1">
              <ListChecks size={10} style={{ color: 'var(--accent)' }} />
              <span className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--muted)' }}>
                Evidence
              </span>
            </div>
            <div className="space-y-1">
              {otherEvidence.map((ev, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 px-2 py-1.5 rounded-lg border"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
                >
                  <span
                    className="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium uppercase"
                    style={{ background: 'var(--bg-3)', color: 'var(--muted)' }}
                  >
                    {ev.source}
                  </span>
                  <div className="min-w-0 flex-1">
                    {ev.url ? (
                      <a href={ev.url} target="_blank" rel="noopener noreferrer" className="font-medium underline" style={{ color: 'var(--accent)' }}>
                        {ev.id}
                      </a>
                    ) : (
                      <span className="font-medium" style={{ color: 'var(--fg)' }}>{ev.id}</span>
                    )}
                    {ev.count !== undefined && (
                      <span className="ml-1.5" style={{ color: 'var(--muted)' }}>×{ev.count}</span>
                    )}
                    {ev.snippet && (
                      <p className="mt-0.5 text-[10px] line-clamp-2" style={{ color: 'var(--fg-2)' }}>{ev.snippet}</p>
                    )}
                    {ev.note && (
                      <p className="mt-0.5" style={{ color: 'var(--fg-2)' }}>{linkify(ev.note)}</p>
                    )}
                    {ev.timestamp && (
                      <p className="mt-0.5 text-[10px]" style={{ color: 'var(--muted)' }}>{ev.timestamp}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Section 4: Next Actions */}
        {decision.next_actions && decision.next_actions.length > 0 && (
          <div>
            <div className="flex items-center gap-1 mb-1">
              <Zap size={10} style={{ color: 'var(--accent)' }} />
              <span className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--muted)' }}>
                Next Actions
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {decision.next_actions.map((action, i) => (
                <button
                  key={i}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-medium transition-colors hover:bg-[var(--bg-3)]"
                  style={{ borderColor: 'var(--border)', color: 'var(--fg-2)', background: 'var(--bg)' }}
                  title={`${action.type}: ${action.tool} — ${action.args}`}
                  onClick={() => {/* no-op: next actions are displayed for visibility, wiring in Phase 71 */}}
                >
                  <span
                    className="px-1 py-0.5 rounded text-[9px] uppercase font-semibold"
                    style={{ background: 'var(--accent)22', color: 'var(--accent)' }}
                  >
                    {action.type}
                  </span>
                  {action.tool}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Alternatives (if present) */}
        {decision.alternatives && decision.alternatives.length > 0 && (
          <div>
            <p className="text-[10px] uppercase font-semibold tracking-wide mb-1" style={{ color: 'var(--muted)' }}>
              Alternatives considered
            </p>
            <div className="space-y-0.5">
              {decision.alternatives.map((alt, i) => (
                <div key={i} className="flex items-center justify-between gap-2">
                  <span style={{ color: 'var(--fg-2)' }}>{alt.decision}</span>
                  <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
                    {Math.round(alt.score * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* U-18: feedback row — closes the learning loop. Posts to POST /api/brain/learn. */}
        <div className="pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
          {feedbackOutcome ? (
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
              <CheckCircle2 size={11} style={{ color: 'var(--accent)' }} />
              <span>Recorded as <span className="font-medium" style={{ color: 'var(--fg-2)' }}>{feedbackOutcome}</span> — thanks, this updates the brain's confidence on similar future questions.</span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10px] uppercase font-semibold tracking-wide" style={{ color: 'var(--muted)' }}>
                Did this help?
              </span>
              <div className="flex items-center gap-1">
                <FeedbackButton
                  label="Worked"
                  icon={<ThumbsUp size={11} />}
                  color="var(--accent)"
                  disabled={feedbackPosting}
                  onClick={() => sendFeedback('success')}
                />
                <FeedbackButton
                  label="Didn't work"
                  icon={<ThumbsDown size={11} />}
                  color="var(--danger, #ef4444)"
                  disabled={feedbackPosting}
                  onClick={() => sendFeedback('failed')}
                />
                <FeedbackButton
                  label="Abandoned"
                  icon={<XCircle size={11} />}
                  color="var(--muted)"
                  disabled={feedbackPosting}
                  onClick={() => sendFeedback('abandoned')}
                />
                {feedbackPosting && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--muted)' }} />}
              </div>
            </div>
          )}
          {feedbackError && (
            <p className="mt-1 text-[10px]" style={{ color: 'var(--danger, #ef4444)' }}>
              {feedbackError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

interface FeedbackButtonProps {
  label: string;
  icon: React.ReactNode;
  color: string;
  disabled: boolean;
  onClick: () => void;
}

function FeedbackButton({ label, icon, color, disabled, onClick }: FeedbackButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] font-medium transition-opacity disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-3)]"
      style={{ color }}
      title={`Mark this decision as: ${label}`}
    >
      {icon}
      {label}
    </button>
  );
}
