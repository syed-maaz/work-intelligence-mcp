import Database from 'better-sqlite3';

export interface TopicSuggestion {
  topic_id: number;
  topic_name: string;
  confidence: number;
  confirmed: number;
  keyword_hits: string[];
}

const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'will', 'your', 'they',
  'when', 'what', 'were', 'more', 'some', 'also', 'into', 'than', 'then',
  'them', 'their', 'here', 'there', 'where', 'team', 'chat', 'call', 'meet',
  'meeting', 'about', 'just', 'said', 'over', 'back', 'need', 'make', 'take',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

export function suggestTopicLinks(db: Database.Database, meetingId: number): TopicSuggestion[] {
  const meeting = db.prepare(
    'SELECT title, summary, decisions, topics, transcript FROM meetings WHERE id = ?'
  ).get(meetingId) as { title: string; summary: string | null; decisions: string | null; topics: string | null; transcript: string | null } | undefined;

  if (!meeting) return [];

  const allText = [meeting.title, meeting.summary, meeting.decisions, meeting.topics]
    .filter(Boolean).join(' ');
  const keywords = extractKeywords(allText);

  if (keywords.length === 0) return [];

  const topics = db.prepare('SELECT id, name FROM topics').all() as Array<{ id: number; name: string }>;

  const suggestions: TopicSuggestion[] = [];

  for (const topic of topics) {
    const topicWords = extractKeywords(topic.name);
    const hits = topicWords.filter(w => keywords.includes(w));

    const keywordHits = keywords.filter(kw =>
      topic.name.toLowerCase().includes(kw) || kw.includes(topic.name.toLowerCase().replace(/\s+/g, ''))
    );

    const allHits = Array.from(new Set([...hits, ...keywordHits]));
    if (allHits.length < 2) continue;

    const confidence = Math.min(1.0, allHits.length / Math.max(topicWords.length, 1));
    if (confidence < 0.5) continue;

    const existing = db.prepare(
      'SELECT confirmed FROM meeting_topic_links WHERE meeting_id = ? AND topic_id = ?'
    ).get(meetingId, topic.id) as { confirmed: number } | undefined;

    suggestions.push({
      topic_id: topic.id,
      topic_name: topic.name,
      confidence,
      confirmed: existing?.confirmed ?? 0,
      keyword_hits: allHits,
    });
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

export function confirmTopicLink(db: Database.Database, meetingId: number, topicId: number): void {
  db.prepare(`
    INSERT INTO meeting_topic_links (meeting_id, topic_id, confidence, confirmed)
    VALUES (?, ?, 1.0, 1)
    ON CONFLICT(meeting_id, topic_id) DO UPDATE SET confirmed = 1
  `).run(meetingId, topicId);
}

export function removeTopicLink(db: Database.Database, meetingId: number, topicId: number): void {
  db.prepare(
    'DELETE FROM meeting_topic_links WHERE meeting_id = ? AND topic_id = ?'
  ).run(meetingId, topicId);
}

export function getConfirmedTopicLinks(db: Database.Database, meetingId: number): Array<{ topic_id: number; topic_name: string }> {
  return db.prepare(`
    SELECT mtl.topic_id, t.name AS topic_name
    FROM meeting_topic_links mtl
    JOIN topics t ON t.id = mtl.topic_id
    WHERE mtl.meeting_id = ? AND mtl.confirmed = 1
  `).all(meetingId) as Array<{ topic_id: number; topic_name: string }>;
}
