import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { listNotebooks } from '../db/queries.js';

// ── Constants ──────────────────────────────────────────────────────────────

export const SEPARATOR = '<!-- USER ANNOTATIONS BELOW — DO NOT EDIT ABOVE -->';

/** Author patterns that identify bots / system accounts — filtered from people/ */
const BOT_PATTERN = /T_[A-Z_]+|[[\]bot]|\[bot\]|serviceuser|noreply|DEVOPS|AppOps|github-actions/i;

/** Subject patterns that identify security scanner noise */
const SECURITY_NOISE_PATTERN = /\[(Critical|High|Medium)\]\s*Security violation|Vulnerabilities detected/i;

/** Jira tag prefixes that are severity/process labels, not component names */
const NOISE_TAGS = new Set([
  'Critical', 'High', 'Medium', 'Low',
  'Follow-up', 'FOLLOWUP', 'POC', 'SPIKE',
  'RESEARCH', 'TESTING', 'CLEANUP', 'Logging',
]);

/** Minimum messages to create a person note */
const PERSON_MIN_MESSAGES = 2;

/** Minimum messages sharing a signal to create a cluster note */
const CLUSTER_MIN_MESSAGES = 3;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExportResult {
  exported: number;
  skipped: number;
  errors: string[];
  lastExportedAt: string;
}

interface MessageRow {
  id: number;
  topic_id: number;
  topic_name: string;
  source: string;
  subject: string | null;
  author: string;
  content: string;
  timestamp: string;
}

interface ActionItemRow {
  title: string;
  assignee: string | null;
  status: string;
  topic_name: string;
}

interface PersonRecord {
  displayName: string;
  normalizedKey: string;
  jiraTickets: Array<{ key: string; title: string; topicName: string; timestamp: string }>;
  emailThreads: Array<{ subject: string; slug: string; topicName: string }>;
  teamsConversations: Array<{ chatName: string; slug: string }>;
  actionItems: ActionItemRow[];
  messageCount: number;
}

interface ClusterRecord {
  slug: string;
  title: string;
  source: 'jira' | 'email' | 'teams' | 'mixed';
  topicName: string;
  messages: MessageRow[];
  participants: string[];
  isSecurity: boolean;
}

// ── Main export ────────────────────────────────────────────────────────────

// ── Palace enrichment types ────────────────────────────────────────────────

/** Structural type for optional palace enrichment — avoids importing PalaceClient directly */
interface PalaceInterface {
  search(query: string, wing?: string, limit?: number): Promise<string>;
  kgQuery(entity: string, predicate?: string): Promise<string>;
  isConnected: boolean;
}

/**
 * Export all notebooks + people + smart clusters to an Obsidian vault.
 * Produces ~50-80 files. All SQL-driven, no AI calls, completes in <200ms.
 * See ADR-004 for the decision to use people+clusters over per-ticket export.
 *
 * @param palace - Optional PalaceClient for Deep Memory enrichment (EP-58).
 *                 When provided and connected, topic notes gain a "## Deep Memory"
 *                 section with semantically related palace drawers and KG triples.
 */
export async function exportNotebooksToVault(
  db: Database.Database,
  vaultPath: string,
  palace?: PalaceInterface,
): Promise<ExportResult> {
  const result: ExportResult = { exported: 0, skipped: 0, errors: [], lastExportedAt: new Date().toISOString() };

  ensureSubdirectories(vaultPath);

  // ── 1. Topic summary notes (existing behaviour, preserved) ──
  const notebooks = listNotebooks(db);
  const allTopicNames = notebooks.map(n => n.topic_name);

  for (const notebook of notebooks) {
    try {
      const filePath = path.join(vaultPath, `${sanitizeFilename(notebook.topic_name)}.md`);
      const existingAnnotation = readExistingAnnotations(filePath);
      const annotation = notebook.user_annotation ?? existingAnnotation ?? '';
      const rendered = renderTopicNote(notebook.topic_name, notebook.content, annotation, allTopicNames, notebook.message_count, notebook.last_updated);

      // EP-58: inject Deep Memory section when palace is available
      let deepMemory = '';
      if (palace && palace.isConnected) {
        try {
          const [searchResults, kgResults] = await Promise.all([
            palace.search(notebook.topic_name, undefined, 3),
            palace.kgQuery(notebook.topic_name),
          ]);
          if (searchResults || kgResults) {
            deepMemory = buildDeepMemorySection(searchResults, kgResults);
          }
        } catch {
          // Palace unavailable — omit Deep Memory silently
        }
      }

      const finalContent = deepMemory ? rendered + '\n\n' + deepMemory : rendered;
      fs.writeFileSync(filePath, finalContent, 'utf-8');
      result.exported++;
    } catch (err) {
      result.errors.push(`${notebook.topic_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 2. Load all messages across all topics ──
  const allMessages = loadAllMessages(db);
  const allActionItems = loadAllActionItems(db);

  // ── 3. Build people index ──
  const personIndex = buildPersonIndex(allMessages, allActionItems);

  // Write people notes
  for (const [key, person] of personIndex) {
    if (person.messageCount < PERSON_MIN_MESSAGES) { result.skipped++; continue; }
    try {
      const content = renderPersonNote(person);
      fs.writeFileSync(path.join(vaultPath, 'people', `${key}.md`), content, 'utf-8');
      result.exported++;
    } catch (err) {
      result.errors.push(`people/${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 4. Build cluster index ──
  const clusterIndex = buildClusterIndex(allMessages);

  // Write cluster notes
  for (const [slug, cluster] of clusterIndex) {
    if (cluster.messages.length < CLUSTER_MIN_MESSAGES && !cluster.isSecurity) { result.skipped++; continue; }
    try {
      const content = renderClusterNote(cluster);
      fs.writeFileSync(path.join(vaultPath, 'clusters', `${slug}.md`), content, 'utf-8');
      result.exported++;
    } catch (err) {
      result.errors.push(`clusters/${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 5. Extended index ──
  try {
    writeExtendedIndexFile(vaultPath, notebooks, personIndex, clusterIndex);
  } catch (err) {
    result.errors.push(`_index.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Export a single topic note (called after annotation save — fast path).
 */
export function exportSingleNotebook(
  db: Database.Database,
  vaultPath: string,
  topicName: string
): void {
  const notebooks = listNotebooks(db);
  const notebook = notebooks.find(n => n.topic_name === topicName);
  if (!notebook) return;

  const allTopicNames = notebooks.map(n => n.topic_name);
  const filePath = path.join(vaultPath, `${sanitizeFilename(topicName)}.md`);
  const annotation = notebook.user_annotation ?? '';
  const rendered = renderTopicNote(topicName, notebook.content, annotation, allTopicNames, notebook.message_count, notebook.last_updated);

  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(filePath, rendered, 'utf-8');
}

// ── Data loading ───────────────────────────────────────────────────────────

function loadAllMessages(db: Database.Database): MessageRow[] {
  return db.prepare(`
    SELECT m.id, m.topic_id, t.name AS topic_name, m.source,
           m.subject, m.author, m.content, m.timestamp
    FROM messages m
    JOIN topics t ON t.id = m.topic_id
    ORDER BY m.timestamp ASC
  `).all() as MessageRow[];
}

function loadAllActionItems(db: Database.Database): ActionItemRow[] {
  return db.prepare(`
    SELECT a.title, a.assignee, a.status, t.name AS topic_name
    FROM action_items a
    JOIN topics t ON t.id = a.topic_id
  `).all() as ActionItemRow[];
}

// ── People index ───────────────────────────────────────────────────────────

function buildPersonIndex(messages: MessageRow[], actionItems: ActionItemRow[]): Map<string, PersonRecord> {
  const index = new Map<string, PersonRecord>();

  function getOrCreate(displayName: string): PersonRecord {
    const key = normalizePerson(displayName);
    if (!index.has(key)) {
      index.set(key, {
        displayName,
        normalizedKey: key,
        jiraTickets: [],
        emailThreads: [],
        teamsConversations: [],
        actionItems: [],
        messageCount: 0,
      });
    }
    return index.get(key)!;
  }

  for (const msg of messages) {
    const authors = parseAuthors(msg.author);
    for (const author of authors) {
      if (isBot(author)) continue;

      const person = getOrCreate(author);
      person.messageCount++;

      if (msg.source === 'jira' && msg.subject) {
        const key = extractJiraKey(msg.subject);
        const title = extractJiraTitle(msg.subject);
        if (key && !person.jiraTickets.find(t => t.key === key)) {
          person.jiraTickets.push({ key, title, topicName: msg.topic_name, timestamp: msg.timestamp });
        }
      } else if (msg.source === 'email' && msg.subject) {
        const slug = slugifyThread(msg.subject, 'email');
        if (!person.emailThreads.find(t => t.slug === slug)) {
          person.emailThreads.push({ subject: msg.subject, slug, topicName: msg.topic_name });
        }
      } else if (msg.source === 'teams') {
        const chatName = msg.subject ?? 'Teams Chat';
        const slug = slugifyThread(chatName, 'teams');
        if (!person.teamsConversations.find(c => c.slug === slug)) {
          person.teamsConversations.push({ chatName, slug });
        }
      }
    }
  }

  // Attach action items
  for (const ai of actionItems) {
    if (!ai.assignee) continue;
    const authors = parseAuthors(ai.assignee);
    for (const author of authors) {
      if (isBot(author)) continue;
      const key = normalizePerson(author);
      if (index.has(key)) {
        index.get(key)!.actionItems.push(ai);
      }
    }
  }

  return index;
}

// ── Cluster index ──────────────────────────────────────────────────────────

function buildClusterIndex(messages: MessageRow[]): Map<string, ClusterRecord> {
  const index = new Map<string, ClusterRecord>();

  // Security noise: group all security-scanner tickets into one cluster
  const securityMessages = messages.filter(m =>
    m.source === 'jira' && SECURITY_NOISE_PATTERN.test(m.subject ?? '') && isBot(m.author)
  );
  if (securityMessages.length > 0) {
    const slug = 'Security_Violations';
    index.set(slug, {
      slug,
      title: 'Security Violations (Scanner)',
      source: 'jira',
      topicName: securityMessages[0].topic_name,
      messages: securityMessages,
      participants: [],
      isSecurity: true,
    });
  }

  // Jira clusters: group by component tag extracted from subject
  const jiraMessages = messages.filter(m => m.source === 'jira' && !SECURITY_NOISE_PATTERN.test(m.subject ?? ''));
  const jiraByTag = new Map<string, MessageRow[]>();
  for (const msg of jiraMessages) {
    const tags = extractComponentTags(msg.subject ?? '');
    for (const tag of tags) {
      if (!jiraByTag.has(tag)) jiraByTag.set(tag, []);
      jiraByTag.get(tag)!.push(msg);
    }
  }
  for (const [tag, msgs] of jiraByTag) {
    const slug = `${msgs[0].topic_name}_${tag}`;
    const participants = uniqueAuthors(msgs).filter(a => !isBot(a));
    index.set(slug, {
      slug,
      title: `${tag} — ${msgs[0].topic_name} Component`,
      source: 'jira',
      topicName: msgs[0].topic_name,
      messages: msgs,
      participants,
      isSecurity: false,
    });
  }

  // Email clusters: group by normalized subject
  const emailMessages = messages.filter(m => m.source === 'email' && m.subject);
  const emailBySubject = new Map<string, MessageRow[]>();
  for (const msg of emailMessages) {
    const normalized = normalizeEmailSubject(msg.subject!);
    if (!emailBySubject.has(normalized)) emailBySubject.set(normalized, []);
    emailBySubject.get(normalized)!.push(msg);
  }
  for (const [subject, msgs] of emailBySubject) {
    const slug = slugifyThread(subject, 'email');
    const participants = uniqueAuthors(msgs).filter(a => !isBot(a));
    if (index.has(slug)) continue; // avoid collision
    index.set(slug, {
      slug,
      title: subject,
      source: 'email',
      topicName: msgs[0].topic_name,
      messages: msgs.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      participants,
      isSecurity: false,
    });
  }

  // Teams clusters: group by chat name (subject field or fallback)
  const teamsMessages = messages.filter(m => m.source === 'teams');
  const teamsByChat = new Map<string, MessageRow[]>();
  for (const msg of teamsMessages) {
    const chatName = msg.subject ?? 'Teams Chat';
    if (!teamsByChat.has(chatName)) teamsByChat.set(chatName, []);
    teamsByChat.get(chatName)!.push(msg);
  }
  for (const [chatName, msgs] of teamsByChat) {
    const slug = slugifyThread(chatName, 'teams');
    const participants = uniqueAuthors(msgs).filter(a => !isBot(a));
    if (index.has(slug)) continue;
    index.set(slug, {
      slug,
      title: chatName.replace(/^\[Teams\]\s*/i, ''),
      source: 'teams',
      topicName: msgs[0].topic_name,
      messages: msgs.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      participants,
      isSecurity: false,
    });
  }

  return index;
}

// ── Renderers ──────────────────────────────────────────────────────────────

export function renderTopicNote(
  topicName: string,
  notebookMarkdown: string,
  userAnnotation: string,
  allTopicNames: string[],
  messageCount: number,
  lastUpdated: string
): string {
  const peopleNames = extractPeopleNames(notebookMarkdown);
  const body = injectWikilinks(notebookMarkdown, allTopicNames.filter(t => t !== topicName), peopleNames);

  return `---
topic: ${topicName}
last_updated: ${lastUpdated}
message_count: ${messageCount}
tags: [work-intelligence, auto-generated]
---

# ${topicName}
<!-- AUTO-GENERATED — edit only below the separator -->

${body}

---
${SEPARATOR}

${userAnnotation}`;
}

/**
 * Build the "## Deep Memory" section from palace search and KG query results.
 * Returns an empty string if both results are empty or unparseable.
 * Content is truncated: max 300 chars per drawer entry, max 10 KG triples.
 */
function buildDeepMemorySection(searchResults: string, kgResults: string): string {
  const sections: string[] = [];

  // Parse search results (JSON array of drawer matches)
  if (searchResults && searchResults !== '[]' && searchResults !== '') {
    try {
      const results = JSON.parse(searchResults) as unknown[];
      if (Array.isArray(results) && results.length > 0) {
        sections.push('### Related Palace Memories');
        for (const r of results.slice(0, 3)) {
          const entry = r as Record<string, unknown>;
          const raw = (entry['content'] ?? entry['text'] ?? entry['document'] ?? String(r)) as string;
          const content = String(raw);
          const source = String(entry['source_file'] ?? entry['wing'] ?? 'palace');
          sections.push(`- **${source}**: ${content.slice(0, 300)}${content.length > 300 ? '...' : ''}`);
        }
      }
    } catch {
      // Not valid JSON — use raw text
      if (searchResults.length > 10) {
        sections.push('### Related Palace Memories');
        sections.push(searchResults.slice(0, 500));
      }
    }
  }

  // Parse KG results (triples)
  if (kgResults && kgResults !== '[]' && kgResults !== '') {
    try {
      const triples = JSON.parse(kgResults) as unknown[];
      if (Array.isArray(triples) && triples.length > 0) {
        sections.push('### Entity Relationships');
        for (const t of triples.slice(0, 10)) {
          if (Array.isArray(t)) {
            const [subj, pred, obj] = t as [string, string, string];
            sections.push(`- ${subj} **${pred}** ${obj}`);
          } else {
            const triple = t as Record<string, unknown>;
            const subj = String(triple['subject'] ?? '');
            const pred = String(triple['predicate'] ?? '');
            const obj = String(triple['object'] ?? '');
            sections.push(`- ${subj} **${pred}** ${obj}`);
          }
        }
      }
    } catch {
      if (kgResults.length > 10) {
        sections.push('### Entity Relationships');
        sections.push(kgResults.slice(0, 500));
      }
    }
  }

  if (sections.length === 0) return '';
  return '## Deep Memory\n\n' + sections.join('\n');
}

function renderPersonNote(person: PersonRecord): string {
  const ticketRows = person.jiraTickets
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map(t => `| [[${t.key}]] *(${t.topicName})* | ${escapeMarkdown(t.title)} |`)
    .join('\n');

  const threadRows = person.emailThreads
    .map(t => `- [[${t.slug}]] — ${escapeMarkdown(t.subject)} *(${t.topicName})*`)
    .join('\n');

  const teamsRows = person.teamsConversations
    .map(c => `- [[${c.slug}]] — ${escapeMarkdown(c.chatName)}`)
    .join('\n');

  const aiRows = person.actionItems
    .map(a => `- [${a.status === 'open' ? ' ' : 'x'}] ${escapeMarkdown(a.title)} *(${a.topic_name})*`)
    .join('\n');

  return `---
type: person
name: "${person.displayName}"
jira_ticket_count: ${person.jiraTickets.length}
email_thread_count: ${person.emailThreads.length}
teams_conversation_count: ${person.teamsConversations.length}
action_item_count: ${person.actionItems.length}
tags: [work-intelligence, person]
---

# ${person.displayName}

${person.jiraTickets.length > 0 ? `## Jira Tickets (${person.jiraTickets.length})

| Ticket | Title |
|--------|-------|
${ticketRows}
` : ''}
${person.emailThreads.length > 0 ? `## Email Threads

${threadRows}
` : ''}
${person.teamsConversations.length > 0 ? `## Teams Conversations

${teamsRows}
` : ''}
${person.actionItems.length > 0 ? `## Action Items

${aiRows}
` : ''}
---
*Auto-generated by Work Intelligence MCP*`;
}

function renderClusterNote(cluster: ClusterRecord): string {
  const participantLinks = cluster.participants
    .map(p => `[[${normalizePerson(p)}]]`)
    .join(', ');

  const messageBlocks = cluster.isSecurity
    ? `${cluster.messages.length} security violation tickets filed by automated scanner.\n\n` +
      cluster.messages.slice(0, 20).map(m => `- ${extractJiraKey(m.subject ?? '') ?? ''} — ${extractJiraTitle(m.subject ?? '')}`).join('\n') +
      (cluster.messages.length > 20 ? `\n\n*...and ${cluster.messages.length - 20} more*` : '')
    : cluster.messages.map(m => {
        const header = m.source === 'jira'
          ? `### [[${extractJiraKey(m.subject ?? '') ?? m.subject}]] — ${extractJiraTitle(m.subject ?? '')}`
          : m.source === 'email'
          ? `### ${m.timestamp.slice(0, 10)} — ${escapeMarkdown(m.author)}`
          : `### ${m.timestamp.slice(0, 10)} — [[${normalizePerson(m.author)}]]`;
        const body = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
        return `${header}\n\n${body}`;
      }).join('\n\n---\n\n');

  return `---
type: cluster
title: "${cluster.title}"
source: ${cluster.source}
topic: ${cluster.topicName}
message_count: ${cluster.messages.length}
participants: [${cluster.participants.map(p => `"${p}"`).join(', ')}]
is_security_noise: ${cluster.isSecurity}
tags: [work-intelligence, cluster, ${cluster.source}, ${cluster.topicName}]
---

# ${cluster.title}

**Topic:** [[${cluster.topicName}]] | **Source:** ${cluster.source} | **Messages:** ${cluster.messages.length}${cluster.participants.length > 0 ? ` | **People:** ${participantLinks}` : ''}

${messageBlocks}

---
*Auto-generated by Work Intelligence MCP*`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function extractPeopleNames(notebookMarkdown: string): string[] {
  const match = notebookMarkdown.match(/##\s+Key People\s*\n([\s\S]*?)(?=\n##|\n---|\s*$)/i);
  if (!match) return [];
  return match[1].split('\n')
    .map(line => {
      // Match "- Lastname, Firstname" format (most common in these notebooks)
      const m1 = line.match(/^[-*]\s+([A-Z][a-zA-Z'-]+,\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/);
      if (m1) return m1[1].trim();
      // Match "- Firstname Lastname" format (no comma)
      const m2 = line.match(/^[-*]\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)/);
      return m2 ? m2[1].trim() : null;
    })
    .filter((n): n is string => n !== null);
}

export function injectWikilinks(text: string, topicNames: string[], peopleNames: string[]): string {
  let result = text;
  const terms = [...topicNames, ...peopleNames].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if (!term || term.length < 2) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<!\\[\\[)\\b(${escaped})\\b(?!\\]\\])`, 'g'), '[[$1]]');
  }
  return result;
}

export function readExistingAnnotations(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const idx = content.indexOf(SEPARATOR);
    if (idx === -1) return null;
    const below = content.slice(idx + SEPARATOR.length).trimStart();
    return below || null;
  } catch {
    return null;
  }
}

// ── EP-60: Vault Annotation Extraction ────────────────────────────────────

/** In-memory content hash map for dedup (file path -> SHA-256 of annotation content). */
const annotationHashes = new Map<string, string>();

export interface AnnotationResult {
  filePath: string;
  topicName: string;
  content: string;
  isNew: boolean;
}

/**
 * EP-60: Extract annotations from all vault files that have the SEPARATOR marker.
 * Returns only files with NEW or CHANGED annotations (content-hash dedup).
 * Does NOT write to palace — caller handles that.
 */
export function extractVaultAnnotations(vaultPath: string): AnnotationResult[] {
  if (!fs.existsSync(vaultPath)) return [];
  const results: AnnotationResult[] = [];

  // Scan root + subdirectories for .md files
  const scanDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const idx = content.indexOf(SEPARATOR);
        if (idx === -1) continue;

        const annotation = content.slice(idx + SEPARATOR.length).trimStart();
        if (!annotation) continue;

        // Content hash dedup
        const hash = crypto.createHash('sha256').update(annotation).digest('hex');
        const prevHash = annotationHashes.get(fullPath);
        if (prevHash === hash) continue; // unchanged

        annotationHashes.set(fullPath, hash);

        // Derive topic name from filename (strip .md extension)
        const topicName = path.basename(fullPath, '.md');

        results.push({
          filePath: fullPath,
          topicName,
          content: annotation,
          isNew: prevHash === undefined,
        });
      } catch {
        // ENOENT or permission error — skip silently
      }
    }
  };

  scanDir(vaultPath);
  return results;
}

function extractComponentTags(subject: string): string[] {
  // Strip ticket key "[JIRA-15043]" first
  const withoutKey = subject.replace(/\[[A-Z]+-\d+\]/g, '');
  const tags: string[] = [];
  const matches = withoutKey.matchAll(/\[([A-Z][A-Z0-9_-]{1,20})\]/g);
  for (const m of matches) {
    const tag = m[1];
    if (!NOISE_TAGS.has(tag) && !/^\d+$/.test(tag)) tags.push(tag);
  }
  return [...new Set(tags)];
}

function extractJiraKey(subject: string): string | null {
  const m = subject.match(/\[([A-Z]+-\d+)\]/);
  return m ? m[1] : null;
}

function extractJiraTitle(subject: string): string {
  return subject.replace(/\[[^\]]+\]\s*/g, '').trim().slice(0, 80);
}

function parseAuthors(authorField: string): string[] {
  return authorField.split(/;\s*/).map(a => a.trim()).filter(a => a.length > 0);
}

function isBot(name: string): boolean {
  return BOT_PATTERN.test(name);
}

function normalizePerson(displayName: string): string {
  return displayName.replace(/[,\s]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').replace(/_+/g, '_').replace(/^_|_$/, '');
}

function slugifyThread(subject: string, _source: 'email' | 'teams'): string {
  return subject.replace(/^\[Teams\]\s*/i, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/, '').slice(0, 80);
}

function normalizeEmailSubject(subject: string): string {
  return subject.replace(/^(Re:|Fwd?:|AW:|WG:)\s*/gi, '').trim();
}

function uniqueAuthors(messages: MessageRow[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of messages) {
    for (const a of parseAuthors(m.author)) {
      if (!seen.has(a)) { seen.add(a); result.push(a); }
    }
  }
  return result;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

function escapeMarkdown(text: string): string {
  return text.replace(/[|]/g, '\\|');
}

function ensureSubdirectories(vaultPath: string): void {
  for (const sub of ['', 'people', 'clusters']) {
    fs.mkdirSync(path.join(vaultPath, sub), { recursive: true });
  }
}

function writeExtendedIndexFile(
  vaultPath: string,
  notebooks: Array<{ topic_name: string; message_count: number; last_updated: string }>,
  personIndex: Map<string, PersonRecord>,
  clusterIndex: Map<string, ClusterRecord>
): void {
  const topicRows = notebooks
    .map(n => `| [[${n.topic_name}]] | ${n.message_count} | ${n.last_updated.slice(0, 10)} |`)
    .join('\n');

  const peopleCount = [...personIndex.values()].filter(p => p.messageCount >= PERSON_MIN_MESSAGES).length;
  const clusterCount = [...clusterIndex.values()].filter(c => c.messages.length >= CLUSTER_MIN_MESSAGES || c.isSecurity).length;

  const content = `---
title: Work Intelligence — Vault Index
tags: [work-intelligence, index]
---

# Work Intelligence Vault

| Stat | Count |
|------|-------|
| Topics | ${notebooks.length} |
| People | ${peopleCount} |
| Clusters | ${clusterCount} |

## Topics

| Topic | Messages | Last Updated |
|-------|----------|-------------|
${topicRows}

## People
${[...personIndex.values()]
  .filter(p => p.messageCount >= PERSON_MIN_MESSAGES)
  .sort((a, b) => b.messageCount - a.messageCount)
  .map(p => `- [[${p.normalizedKey}]] — ${p.displayName} (${p.messageCount} messages)`)
  .join('\n')}

## Clusters
${[...clusterIndex.values()]
  .filter(c => c.messages.length >= CLUSTER_MIN_MESSAGES || c.isSecurity)
  .sort((a, b) => b.messages.length - a.messages.length)
  .map(c => `- [[${c.slug}]] — ${c.title} (${c.messages.length} messages)`)
  .join('\n')}

---
*Auto-generated by Work Intelligence MCP*
`;

  fs.writeFileSync(path.join(vaultPath, '_index.md'), content, 'utf-8');
}

/**
 * Count all .md files across the vault (recursively across subdirectories).
 */
export function countVaultNotes(vaultPath: string): number {
  if (!fs.existsSync(vaultPath)) return 0;
  try {
    let count = 0;
    for (const sub of ['', 'people', 'clusters']) {
      const dir = sub ? path.join(vaultPath, sub) : vaultPath;
      if (fs.existsSync(dir)) {
        count += fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '_index.md').length;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * §6 vault→persona bridge (2026-07-18). Mirror the current human annotations
 * (content below the SEPARATOR in each vault note) into
 * `<memoryDir>/vault_annotations.md` so persona.ts injects them into the NEXT
 * chat turn — closing the gap where annotations only reached MemPalace (Cypher's
 * later investigate stage) but never the persona-injected memory.
 *
 * Unlike extractVaultAnnotations (which dedups against a hash cache and returns
 * only CHANGED annotations for the palace sync), this reads ALL current
 * annotations fresh and rewrites the mirror file in full — persona wants the
 * complete current picture, not a delta.
 *
 * Capped at `maxChars` (default 6 KB, under persona's 8 KB per-file read cap)
 * newest-file-first, so the persona budget isn't blown by a large vault.
 * Idempotent: same annotations → byte-identical file.
 *
 * @returns number of annotated notes mirrored (0 if vault/memoryDir missing).
 */
export function mirrorVaultAnnotationsToMemory(
  vaultPath: string,
  memoryDir: string,
  maxChars = 6144,
): number {
  if (!fs.existsSync(vaultPath) || !fs.existsSync(memoryDir)) return 0;

  // Collect all notes with non-empty content below the separator, newest first.
  const collected: Array<{ topic: string; content: string; mtimeMs: number }> = [];
  const scan = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.md') || entry.name.startsWith('_')) continue;
      try {
        const content = fs.readFileSync(full, 'utf-8');
        const idx = content.indexOf(SEPARATOR);
        if (idx === -1) continue;
        const annotation = content.slice(idx + SEPARATOR.length).trim();
        if (!annotation) continue;
        collected.push({
          topic: path.basename(full, '.md'),
          content: annotation,
          mtimeMs: fs.statSync(full).mtimeMs,
        });
      } catch { /* skip unreadable */ }
    }
  };
  scan(vaultPath);
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Render, respecting the char cap (drop oldest overflow, note the drop).
  const header = '# Vault annotations (human corrections mirrored from Obsidian)\n' +
    '<!-- AUTO-GENERATED by obsidian-export.mirrorVaultAnnotationsToMemory — do not edit; annotate in the vault -->\n\n';
  const blocks: string[] = [];
  let used = header.length;
  let dropped = 0;
  for (const c of collected) {
    const block = `## ${c.topic}\n${c.content}\n\n`;
    if (used + block.length > maxChars) { dropped++; continue; }
    blocks.push(block);
    used += block.length;
  }
  let body = header + blocks.join('');
  if (dropped > 0) body += `<!-- ${dropped} older annotation(s) omitted to fit the persona budget -->\n`;

  fs.writeFileSync(path.join(memoryDir, 'vault_annotations.md'), body, 'utf-8');
  return blocks.length;
}
