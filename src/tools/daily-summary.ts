/**
 * daily_summary tool
 *
 * Generates a "morning standup replacement" summary covering:
 *   - Yesterday's activity across all sources (Claude Sonnet summary)
 *   - Today's open action items (due today or overdue)
 *   - Sprint board issues that are Todo/Ready (from board cache in digests table if warm)
 *   - Action items due today from the action_items table
 *
 * Results are cached in the `digests` table for 1 hour under topic_name = '__daily_summary__'.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type Database from 'better-sqlite3';
import { withRetry } from '../lib/retry.js';
import { bucketCallParams } from '../services/model-config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DailySummaryOptions {
  date?: string;   // ISO date string (default: today)
  refresh?: boolean; // Force regeneration even if cached
}

export interface DailySummaryResult {
  markdown: string;
  cached: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal DB row types
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number;
  source: string;
  subject: string | null;
  content: string;
  author: string;
  timestamp: string;
}

interface ActionItemRow {
  id: number;
  title: string;
  assignee: string | null;
  status: string;
  due_date: string | null;
}

interface DigestRow {
  markdown: string;
  generated_at: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function getCachedDigest(db: Database.Database, date: string): DigestRow | null {
  // TTL check in SQL to avoid brittle string comparisons. DB stores timestamps
  // as 'YYYY-MM-DD HH:MM:SS' (no 'T'), so compare against SQLite datetime('now').
  const row = db.prepare(
    `SELECT markdown, generated_at, expires_at FROM digests
     WHERE topic_name = '__daily_summary__' AND date = ? AND expires_at > datetime('now')`
  ).get(date) as DigestRow | undefined;
  return row ?? null;
}

function cacheDigest(db: Database.Database, date: string, markdown: string): void {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // +1 hour
  const gen = now.toISOString().replace('T', ' ').slice(0, 19);
  const exp = expiresAt.toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT OR REPLACE INTO digests (topic_name, date, markdown, generated_at, expires_at)
     VALUES ('__daily_summary__', ?, ?, ?, ?)`
  ).run(date, markdown, gen, exp);
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

function fetchYesterdaysMessages(db: Database.Database, yesterday: string): MessageRow[] {
  return db.prepare(
    `SELECT id, source, subject, content, author, timestamp
     FROM messages
     WHERE date(timestamp) = ?
     ORDER BY timestamp ASC
     LIMIT 200`
  ).all(yesterday) as MessageRow[];
}

/**
 * Finds the most recent date that has messages, starting from `startDate`
 * and looking back up to `maxDaysBack` days. Returns the date string.
 * This handles gaps in syncing (e.g. weekends, missed syncs) so the daily
 * summary never shows "no activity" when there is recent data just not from
 * exactly yesterday.
 */
function findLastActiveDate(db: Database.Database, startDate: string, maxDaysBack = 7): string {
  for (let i = 0; i < maxDaysBack; i++) {
    const d = new Date(new Date(startDate).getTime() - i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE date(timestamp) = ?`
    ).get(d) as { cnt: number };
    if (row.cnt > 0) return d;
  }
  return startDate; // nothing found — keep original (will show empty)
}

function fetchActionItemsDueToday(db: Database.Database, today: string): ActionItemRow[] {
  return db.prepare(
    `SELECT id, title, assignee, status, due_date
     FROM action_items
     WHERE (due_date <= ? OR status = 'open')
       AND status != 'completed'
     ORDER BY due_date ASC
     LIMIT 50`
  ).all(today) as ActionItemRow[];
}

// ---------------------------------------------------------------------------
// AI summary
// ---------------------------------------------------------------------------

async function generateSummaryWithClaude(
  date: string,
  yesterday: string,
  messages: MessageRow[],
  actionItems: ActionItemRow[],
  anthropicApiKey: string,
  db?: Database.Database,
): Promise<string> {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : anthropicApiKey,
    ...(baseURL ? {
      baseURL,
      defaultHeaders: { Authorization: `Bearer ${anthropicApiKey}` },
    } : {}),
  });

  const systemPrompt =
    'You are a work intelligence assistant generating a concise morning briefing. Be direct and practical. Use bullet points. Never hallucinate — if a section has no data, say "Nothing to report."';

  const cachedSystem: PromptCachingBetaTextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const bucketParams = db ? bucketCallParams(db, 'digest', 1500) : {
    model: 'claude-sonnet-4-6' as const,
    max_tokens: 1500,
  };

  // Build yesterday's activity text
  let yesterdayText = 'No activity recorded.';
  if (messages.length > 0) {
    const bySource = new Map<string, MessageRow[]>();
    for (const m of messages) {
      const list = bySource.get(m.source) ?? [];
      list.push(m);
      bySource.set(m.source, list);
    }
    const parts: string[] = [];
    for (const [source, msgs] of bySource) {
      parts.push(`${source.toUpperCase()} (${msgs.length} messages):`);
      for (const m of msgs.slice(0, 20)) {
        const subj = m.subject ? `[${m.subject}] ` : '';
        parts.push(`  - ${m.author}: ${subj}${m.content.slice(0, 150).replace(/\n/g, ' ')}`);
      }
      if (msgs.length > 20) parts.push(`  ...and ${msgs.length - 20} more`);
    }
    yesterdayText = parts.join('\n');
  }

  // Build action items text
  let actionText = 'No open action items.';
  if (actionItems.length > 0) {
    actionText = actionItems
      .map((a) => {
        const due = a.due_date ? ` (due: ${a.due_date.slice(0, 10)})` : '';
        const assignee = a.assignee ? ` — ${a.assignee}` : '';
        return `- [${a.status}] ${a.title}${assignee}${due}`;
      })
      .join('\n');
  }

  const userPrompt = `Generate a morning briefing for ${date} (data from ${yesterday}):

## Yesterday's Activity (${yesterday})
${yesterdayText}

## Open Action Items
${actionText}

Produce a concise daily briefing with these 3 sections:
1. **Yesterday's Summary** — 2-4 sentences summarizing what happened, key topics, any decisions made
2. **Today's Priorities** — top 5 most important action items to focus on today (pick from the list above, prioritize overdue and high-signal items)
3. **Open Action Items** — full checklist of all open items

Keep it practical and scannable. If any section truly has no data, say "Nothing to report."`;

  // Retry once on transient Anthropic errors (502 / 503 / 529 / ECONNRESET /
  // SDK "offline or connection may have changed" wrapping). Terminal errors
  // (4xx auth/validation) pass through unchanged. Let errors bubble up so
  // callers can render a deterministic fallback without embedding the error
  // string into the user-visible markdown.
  const response = await withRetry(
    () => client.beta.promptCaching.messages.create({
      ...bucketParams,
      system: cachedSystem,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    { maxAttempts: 2, baseDelayMs: 1_000 },
  );

  const block = response.content.find((b) => b.type === 'text');
  return block?.type === 'text' ? block.text : '';
}

// ---------------------------------------------------------------------------
// Format the final markdown response
// ---------------------------------------------------------------------------

function formatMarkdown(
  date: string,
  yesterday: string,
  messages: MessageRow[],
  actionItems: ActionItemRow[],
  aiSummary: string
): string {
  const lines: string[] = [
    `# Daily Summary — ${date}`,
    `_Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC | Activity from: ${yesterday} | ${messages.length} messages | ${actionItems.length} open action items_`,
    '',
  ];

  if (aiSummary) {
    lines.push(aiSummary);
  } else {
    // Fallback: plain rendering without AI
    lines.push('## Yesterday\'s Summary', '');
    if (messages.length === 0) {
      lines.push('Nothing to report.');
    } else {
      const bySource = new Map<string, MessageRow[]>();
      for (const m of messages) {
        const list = bySource.get(m.source) ?? [];
        list.push(m);
        bySource.set(m.source, list);
      }
      for (const [source, msgs] of bySource) {
        lines.push(`**${source.toUpperCase()}** — ${msgs.length} messages`);
      }
    }
    lines.push('', '## Open Action Items', '');
    if (actionItems.length === 0) {
      lines.push('Nothing to report.');
    } else {
      for (const a of actionItems) {
        const due = a.due_date ? ` _(due: ${a.due_date.slice(0, 10)})_` : '';
        lines.push(`- [ ] ${a.title}${due}`);
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function generateDailySummary(
  db: Database.Database,
  opts: DailySummaryOptions,
  anthropicApiKey?: string
): Promise<DailySummaryResult> {
  const today = opts.date ?? new Date().toISOString().slice(0, 10);
  // "Yesterday" = most recent day with messages, up to 7 days back.
  // Handles sync gaps (weekends, missed syncs) so the summary never shows
  // "no activity" when there's real recent data just not from exactly yesterday.
  const nominaldYesterday = new Date(new Date(today).getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const yesterday = findLastActiveDate(db, nominaldYesterday, 7);

  // Check cache
  if (!opts.refresh) {
    const cached = getCachedDigest(db, today);
    if (cached) {
      return {
        markdown: cached.markdown,
        cached: true,
        generatedAt: cached.generated_at,
      };
    }
  }

  // Fetch data
  const messages = fetchYesterdaysMessages(db, yesterday);
  const actionItems = fetchActionItemsDueToday(db, today);

  // Generate markdown (AI or fallback)
  let markdown: string;
  let aiFailed = false;
  if (anthropicApiKey) {
    try {
      const aiSummary = await generateSummaryWithClaude(
        today, yesterday, messages, actionItems, anthropicApiKey, db
      );
      markdown = formatMarkdown(today, yesterday, messages, actionItems, aiSummary);
    } catch {
      aiFailed = true;
      markdown = formatMarkdown(today, yesterday, messages, actionItems, '');
    }
  } else {
    markdown = formatMarkdown(today, yesterday, messages, actionItems, '');
  }

  // Cache it — but only when the AI summary succeeded. An error string like
  // "(AI summary unavailable: 502 …)" must not be stored for the full 1-hour
  // TTL; the next request should retry the generation instead.
  const hasAiError = anthropicApiKey && markdown.includes('(AI summary unavailable:');
  if (!hasAiError && !aiFailed) {
    try {
      cacheDigest(db, today, markdown);
    } catch {
      // digests table may not exist yet if migration hasn't run — ignore
    }
  }

  return {
    markdown,
    cached: false,
    generatedAt: new Date().toISOString(),
  };
}
