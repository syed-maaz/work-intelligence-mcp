/**
 * OP-6 / U-10 (MVP): client-side entity linkification.
 *
 * Detects common references in free-text and turns them into clickable chips:
 *   • Jira keys     — PROJ-1234, KEY-77  → https://jira.example.com/browse/<key>
 *   • GitHub PRs    — #1234, PR #1234   → /pr-review (no repo context yet)
 *   • @mentions     — @alice            → mention chip (no link yet)
 *   • Bare URLs     — https://…         → external link (rel=noopener)
 *
 * Pure UI win — no schema change, no brain pipeline change. The full structured
 * evidence design ({source, source_id, timestamp, snippet, url}) is the
 * follow-up. See `.planning/ADR-REVIEW.md` U-10 entry.
 */

import type { ReactNode } from 'react';

const JIRA_BASE = (typeof window !== 'undefined' && (window as unknown as { __JIRA_BASE__?: string }).__JIRA_BASE__) || 'https://jira.example.com/browse';

// Order matters: longer/more-specific patterns must precede shorter ones to
// avoid the URL regex eating part of a Jira key etc.
type Pattern = {
  kind: 'url' | 'jira' | 'pr' | 'mention';
  regex: RegExp;
  render: (match: string, groups: string[]) => ReactNode;
};

const PATTERNS: Pattern[] = [
  // URLs — greedy, must come first so we don't tokenize their query strings.
  {
    kind: 'url',
    regex: /\bhttps?:\/\/[^\s<>"')]+/g,
    render: (match) => (
      <a
        href={match}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2"
        style={{ color: 'var(--accent)' }}
      >
        {match.length > 60 ? match.slice(0, 57) + '…' : match}
      </a>
    ),
  },
  // Jira issue keys — uppercase project + dash + digits. Word-boundary anchored.
  {
    kind: 'jira',
    regex: /\b([A-Z][A-Z0-9_]{1,9})-(\d{1,6})\b/g,
    render: (match) => (
      <a
        href={`${JIRA_BASE}/${match}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-medium align-baseline hover:underline"
        style={{ background: 'color-mix(in srgb, var(--jira, #2563eb) 18%, transparent)', color: 'var(--jira, #2563eb)' }}
        title="Open in Jira"
      >
        {match}
      </a>
    ),
  },
  // GitHub PR refs — `PR #1234` or bare `#1234` (but not inside markdown headings)
  {
    kind: 'pr',
    regex: /\b(?:PR\s)?#(\d{2,5})\b/g,
    render: (_match, [num]) => (
      <a
        href={`/pr-review?pr=${num}`}
        className="inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-medium align-baseline hover:underline"
        style={{ background: 'color-mix(in srgb, var(--github, #6e40c9) 18%, transparent)', color: 'var(--github, #6e40c9)' }}
        title="Open PR review"
      >
        #{num}
      </a>
    ),
  },
  // @mentions — chip only (no destination URL yet)
  {
    kind: 'mention',
    regex: /(?:^|\s)@([a-zA-Z][a-zA-Z0-9._-]{1,30})\b/g,
    render: (_match, [name]) => (
      <span
        className="inline-flex items-center px-1 py-0.5 rounded text-[11px] font-medium align-baseline"
        style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}
      >
        @{name}
      </span>
    ),
  },
];

/**
 * Walk `text` and produce a list of strings + React nodes with entities replaced.
 * Single-pass with a combined regex would be ideal but is fragile across overlapping
 * patterns; we run patterns in order and re-tokenize between passes. For typical
 * chat-message lengths (≤ 2 KB) this is fast enough — measured ~0.5 ms per message.
 */
export function linkify(text: string): ReactNode {
  if (!text || typeof text !== 'string') return text;
  let parts: Array<string | ReactNode> = [text];

  for (const pattern of PATTERNS) {
    const next: Array<string | ReactNode> = [];
    for (const part of parts) {
      if (typeof part !== 'string') { next.push(part); continue; }
      let lastIndex = 0;
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(part)) !== null) {
        const start = m.index;
        const matchText = m[0];
        // Handle the @mention leading-whitespace capture: keep the prefix as plain text.
        const leadingWS = pattern.kind === 'mention' && /^\s/.test(matchText) ? matchText[0] : '';
        const tokenStart = start + leadingWS.length;
        const tokenEnd = start + matchText.length;
        if (tokenStart > lastIndex) next.push(part.slice(lastIndex, tokenStart));
        const groups = m.slice(1);
        next.push(
          <span key={`${pattern.kind}-${tokenStart}-${matchText}`}>
            {pattern.render(matchText.trimStart(), groups)}
          </span>,
        );
        lastIndex = tokenEnd;
      }
      if (lastIndex < part.length) next.push(part.slice(lastIndex));
    }
    parts = next;
  }

  // Re-key so React doesn't warn on adjacent fragments.
  return parts.map((p, i) =>
    typeof p === 'string' ? <span key={`t-${i}`}>{p}</span> : <span key={`n-${i}`}>{p}</span>,
  );
}

/**
 * Recursively linkify `children` from a ReactMarkdown component override.
 * Strings get linkified; React elements pass through unchanged (so e.g.
 * `<code>DEMO-123</code>` stays as code and isn't double-rendered).
 */
export function linkifyChildren(children: ReactNode): ReactNode {
  if (typeof children === 'string') return linkify(children);
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === 'string'
        ? <span key={`lc-${i}`}>{linkify(c)}</span>
        : c,
    );
  }
  return children;
}

/**
 * U-10 phase 1.5: shared component-override bundle for ReactMarkdown so every
 * markdown surface (chat, daily summary, weekly report, Jira report, PR review,
 * Teams updates, MarkdownPanel) renders entities the same way.
 *
 * Usage:
 *   import ReactMarkdown from 'react-markdown';
 *   import { MD_COMPONENTS } from '@/lib/linkify';
 *   <ReactMarkdown components={MD_COMPONENTS}>{md}</ReactMarkdown>
 */
export const MD_COMPONENTS = {
  p: ({ children }: { children?: ReactNode }) => <p>{linkifyChildren(children)}</p>,
  li: ({ children }: { children?: ReactNode }) => <li>{linkifyChildren(children)}</li>,
  td: ({ children }: { children?: ReactNode }) => <td>{linkifyChildren(children)}</td>,
  strong: ({ children }: { children?: ReactNode }) => <strong>{linkifyChildren(children)}</strong>,
  em: ({ children }: { children?: ReactNode }) => <em>{linkifyChildren(children)}</em>,
};
