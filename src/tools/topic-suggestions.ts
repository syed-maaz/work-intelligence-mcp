/**
 * EP-14-3: Auto-Topic Discovery tools
 *
 * get_topic_suggestions — returns undismissed topic candidates discovered from message clustering
 * dismiss_topic_suggestion — marks a suggestion as dismissed
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicSuggestion {
  id: number;
  keyword: string;
  message_count: number;
  author_count: number;
  sample_msgs: string[] | null;
  suggested_at: string;
  dismissed: number;
}

interface SuggestionRow {
  id: number;
  keyword: string;
  message_count: number;
  author_count: number;
  sample_msgs: string | null;
  suggested_at: string;
  dismissed: number;
}

// ---------------------------------------------------------------------------
// detectTopicCandidates — called after each sync run
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the','a','an','is','it','in','on','at','to','of','and','or','but','for',
  'with','this','that','be','are','was','were','have','has','had','will',
  'can','would','could','should','may','might','i','we','you','he','she',
  'they','us','me','him','her','them','my','our','your','his','its','their',
  'not','no','so','do','did','get','got','set','let','put','use','make',
  'just','also','if','else','then','than','from','by','as','up','out','off',
  'all','any','some','each','more','most','other','into','about','over',
  'after','before','between','through','during','again','further','once',
  'here','there','when','where','why','how','what','which','who','whom',
  'please','hello','thanks','thank','sure','yes','okay','good','great',
  'need','want','know','think','work','team','time','week','today','tomorrow',
  'meeting','update','call','chat','ping','message','check','sent','send',
  'follow','think','look','find','back','done','like','much','well','new',
  'see','tell','show','come','take','give','keep','still','even','only',
  'very','really','actually','basically','generally','specifically',
]);

/**
 * Extracts candidate topic keywords from a message row.
 * Priority: chat_name > subject > word frequency in content.
 *
 * Returns 0-3 candidate strings per message.
 */
function extractCandidates(content: string, subject: string | null, chatName: string | null): string[] {
  const candidates: string[] = [];

  // 1. Chat name is the strongest signal — "PROJ weekly", "HR sync", "INFRA planning"
  if (chatName) {
    const chatWords = chatName
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
      .map(w => w.toLowerCase());
    // Short uppercase tokens (project codes like PROJ, WEB, INFRA) are high-value signals
    const chatRaw = chatName.split(/\s+/).filter(w => /^[A-Z][A-Z0-9]{1,7}$/.test(w));
    for (const code of chatRaw) candidates.push(code.toLowerCase());
    // Also take the first meaningful word from the chat name
    const firstWord = chatWords.find(w => !STOPWORDS.has(w) && w.length >= 3);
    if (firstWord && !candidates.includes(firstWord)) candidates.push(firstWord);
  }

  // 2. Subject/title is next best (email subjects, Jira ticket titles)
  if (subject) {
    const subjectCodes = subject.split(/\s+/).filter(w => /^[A-Z][A-Z0-9]{1,7}(-\d+)?$/.test(w));
    for (const code of subjectCodes) {
      const base = code.replace(/-\d+$/, '').toLowerCase(); // strip ticket number (JIRA-123 → proj)
      if (!candidates.includes(base)) candidates.push(base);
    }
  }

  // 3. Fall back to corpus-wide word frequency in content
  // (only used if no chat name / subject signals found above)
  if (candidates.length === 0) {
    const words = content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w));
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    const topWord = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topWord) candidates.push(topWord[0]);
  }

  return candidates.slice(0, 3);
}

interface MessageRow {
  content: string;
  author: string;
  subject: string | null;
  chat_name: string | null;
}

/**
 * Scans recent messages, clusters them by keyword, and emits
 * `topic_suggestions` rows for clusters that:
 *   - have ≥ 5 messages (lowered from 10 since chat names are precise signals)
 *   - have ≥ 2 distinct authors
 *   - don't already have a configured topic with that keyword name
 */
export function detectTopicCandidates(
  db: Database.Database,
  newMessageIds: number[]
): void {
  if (newMessageIds.length === 0) return;

  const placeholders = newMessageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.content, m.author, m.subject, g.chat_name
       FROM messages m
       LEFT JOIN group_chats g ON m.source = 'teams' AND g.id = m.source_id
       WHERE m.id IN (${placeholders})`
    )
    .all(...newMessageIds) as MessageRow[];

  if (rows.length === 0) return;

  // keyword → { count, authors, sampleContents }
  const clusters = new Map<string, { count: number; authors: Set<string>; sampleContents: string[] }>();

  for (const row of rows) {
    const keywords = extractCandidates(row.content, row.subject, row.chat_name);
    for (const kw of keywords) {
      const entry = clusters.get(kw) ?? { count: 0, authors: new Set<string>(), sampleContents: [] };
      entry.count += 1;
      entry.authors.add(row.author);
      if (entry.sampleContents.length < 3) {
        const snippet = (row.chat_name ?? row.subject ?? row.content).slice(0, 80);
        entry.sampleContents.push(snippet);
      }
      clusters.set(kw, entry);
    }
  }

  // Load existing topic names to avoid suggesting duplicates
  const existingTopicNames = new Set<string>(
    (db.prepare('SELECT name FROM topics').all() as Array<{ name: string }>)
      .map(r => r.name.toLowerCase())
  );

  // Load existing undismissed suggestion keywords
  const existingKeywords = new Set<string>(
    (db.prepare('SELECT keyword FROM topic_suggestions WHERE dismissed = 0').all() as Array<{ keyword: string }>)
      .map(r => r.keyword.toLowerCase())
  );

  const upsert = db.prepare(`
    INSERT INTO topic_suggestions (keyword, message_count, author_count, sample_msgs)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(keyword) DO UPDATE SET
      message_count = excluded.message_count,
      author_count  = excluded.author_count,
      sample_msgs   = excluded.sample_msgs,
      suggested_at  = datetime('now'),
      dismissed     = 0
  `);

  for (const [keyword, entry] of clusters.entries()) {
    if (
      entry.count >= 5 &&
      entry.authors.size >= 2 &&
      !existingTopicNames.has(keyword) &&
      !existingKeywords.has(keyword)
    ) {
      upsert.run(
        keyword,
        entry.count,
        entry.authors.size,
        JSON.stringify(entry.sampleContents)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Tool: get_topic_suggestions
// ---------------------------------------------------------------------------

export function getTopicSuggestions(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT id, keyword, message_count, author_count, sample_msgs, suggested_at, dismissed
       FROM topic_suggestions
       WHERE dismissed = 0
       ORDER BY message_count DESC
       LIMIT 20`
    )
    .all() as SuggestionRow[];

  if (rows.length === 0) {
    return '## Topic Suggestions\n\nNo new topic candidates found yet. Suggestions appear after background sync when clusters of ≥ 5 messages with ≥ 2 authors are detected around a keyword.';
  }

  const suggestions: TopicSuggestion[] = rows.map(r => ({
    ...r,
    sample_msgs: r.sample_msgs ? (JSON.parse(r.sample_msgs) as string[]) : null,
  }));

  const lines: string[] = ['## Suggested Topics\n'];

  for (const s of suggestions) {
    lines.push(`### "${s.keyword}" (ID: ${s.id})`);
    lines.push(`- **Messages**: ${s.message_count} | **Authors**: ${s.author_count}`);
    lines.push(`- **Detected**: ${s.suggested_at.slice(0, 10)}`);
    if (s.sample_msgs && s.sample_msgs.length > 0) {
      lines.push('- **Sample messages**:');
      for (const msg of s.sample_msgs) {
        lines.push(`  > ${msg}…`);
      }
    }
    lines.push('');
    lines.push(`To configure: \`configure_topic({ name: "${s.keyword}", sources: { ... } })\``);
    lines.push(`To dismiss: \`dismiss_topic_suggestion({ id: ${s.id} })\``);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool: dismiss_topic_suggestion
// ---------------------------------------------------------------------------

export function dismissTopicSuggestion(
  db: Database.Database,
  id: number
): string {
  const result = db
    .prepare('UPDATE topic_suggestions SET dismissed = 1 WHERE id = ? AND dismissed = 0')
    .run(id);

  if (result.changes === 0) {
    return `No undismissed suggestion found with id ${id}.`;
  }

  return `Suggestion #${id} dismissed.`;
}
