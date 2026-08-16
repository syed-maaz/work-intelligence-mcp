import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { MD_COMPONENTS } from '@/lib/linkify';
import type { ChatMessage as ChatMessageType } from '@/store/chat';

// U-17: severity palette for proactive notifications. Colours match the rest of
// the system-health UI (danger / warning / accent).
type ProactiveSeverity = 'high' | 'medium' | 'low';

const SEVERITY_PALETTE: Record<ProactiveSeverity, { bg: string; fg: string; label: string }> = {
  high: {
    bg: 'color-mix(in srgb, var(--danger, #ef4444) 75%, transparent)',
    fg: '#fff',
    label: 'Urgent',
  },
  medium: {
    bg: 'color-mix(in srgb, #f59e0b 75%, transparent)',
    fg: '#fff',
    label: 'Attention',
  },
  low: {
    bg: 'color-mix(in srgb, var(--accent) 70%, transparent)',
    fg: '#fff',
    label: 'Proactive',
  },
};

/**
 * Best-effort severity inference from message content. Proactive messages
 * come from multiple agents (orchestrator, meeting-prep, correlation) with
 * different payload shapes — and right now the payload isn't typed for the
 * UI store. We scan the visible content for severity cues; explicit prefixes
 * win over heuristic keywords. This stays a UI-only signal until the
 * proactive_queue payload schema is locked down (tracked as a follow-up).
 */
function inferProactiveSeverity(content: string): ProactiveSeverity {
  const c = content.toLowerCase();
  // Explicit prefix from AlertScorerAgent (FEATURE-001 path): "[HIGH] ..." / "[MEDIUM] ..."
  if (/^\s*\[\s*high\s*\]/i.test(content)) return 'high';
  if (/^\s*\[\s*medium\s*\]/i.test(content)) return 'medium';
  if (/^\s*\[\s*low\s*\]/i.test(content)) return 'low';
  // Heuristic — keyword signals
  if (/\b(blocker|failed|failing|down|outage|error 5\d\d|401|403|critical)\b/.test(c)) return 'high';
  if (/\b(stale|overdue|warning|missing|reminder|attention)\b/.test(c)) return 'medium';
  return 'low';
}

const SOURCE_COLORS: Record<string, string> = {
  jira: 'var(--jira)',
  teams: 'var(--teams)',
  email: 'var(--email)',
  github: 'var(--github)',
  // EP-59: Palace provenance colors
  'palace-search': 'var(--accent)',
  'palace-kg': 'var(--accent)',
  'palace-graph': 'var(--accent)',
};

interface ChatMessageProps {
  message: ChatMessageType;
  onFollowUp?: (q: string) => void;
  isLatest?: boolean;
}

export function ChatMessage({ message, onFollowUp, isLatest }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex flex-col gap-1.5', isUser ? 'items-end' : 'items-start')}>
      {/* Bubble */}
      <div
        className={cn(
          'rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed',
          isUser ? 'rounded-br-sm max-w-[85%]' : 'rounded-bl-sm w-full'
        )}
        style={
          isUser
            ? { background: 'var(--accent)', color: '#fff' }
            : { background: 'var(--bg-3)', color: 'var(--fg)' }
        }
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <>
            {message.isProactive && (() => {
              // U-17: derive a severity from the proactive payload so the badge
              // tells the user at a glance whether to interrupt or skim later.
              //   high   → red    (interrupt now: prod issue, build failure)
              //   medium → amber  (today: stale PR, missing transcript)
              //   low    → blue   (info: meeting prep, nightly digest)
              const severity = inferProactiveSeverity(message.content);
              const palette = SEVERITY_PALETTE[severity];
              return (
                <span
                  className="inline-block mb-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
                  style={{ background: palette.bg, color: palette.fg }}
                  title={`${palette.label} — proactive notification`}
                >
                  {palette.label}
                </span>
              );
            })()}
            <div className="prose-wi text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {message.content}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>

      {/* Source pills — collapsible disclosure (EP-59) */}
      {!isUser && message.sources && message.sources.length > 0 && (
        <details className="px-1 mt-1">
          <summary
            className="inline-flex items-center gap-1 text-[10px] font-medium cursor-pointer select-none"
            style={{ color: 'var(--muted)' }}
          >
            {message.sources.length} source{message.sources.length !== 1 ? 's' : ''}
          </summary>
          <div className="flex flex-wrap gap-1 px-1 mt-1">
            {message.sources.slice(0, 8).map((s, i) => {
              const color = SOURCE_COLORS[s.type.toLowerCase()] ?? 'var(--muted)';
              const href = s.url || (s.drawerId ? `/api/palace/drawer/${encodeURIComponent(s.drawerId)}` : undefined);
              return href ? (
                <a
                  key={i}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium hover:underline transition-colors"
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', color }}
                >
                  <span className="w-1 h-1 rounded-full shrink-0" style={{ background: color }} />
                  {s.title || s.type}
                </a>
              ) : (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                  style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', color }}
                >
                  <span className="w-1 h-1 rounded-full shrink-0" style={{ background: color }} />
                  {s.title || s.type}
                </span>
              );
            })}
            {message.sources.length > 8 && (
              <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
                +{message.sources.length - 8} more
              </span>
            )}
          </div>
        </details>
      )}

      {/* Suggested follow-ups — only on latest assistant message */}
      {!isUser && isLatest && message.suggestedFollowUps && message.suggestedFollowUps.length > 0 && (
        <div className="flex flex-col gap-1.5 w-full px-1 mt-0.5">
          <p className="text-[10px] font-medium" style={{ color: 'var(--muted)' }}>Suggested</p>
          {message.suggestedFollowUps.map((q, i) => (
            <button
              key={i}
              onClick={() => onFollowUp?.(q)}
              className="text-left text-xs px-3 py-2 rounded-xl border transition-colors hover:bg-[var(--bg-3)] active:scale-[0.98]"
              style={{
                borderColor: 'var(--border)',
                color: 'var(--accent)',
                background: 'var(--bg-2)',
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
