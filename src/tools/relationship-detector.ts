/**
 * EP-39: Cross-topic relationship detection.
 * Detects relationships between topics via Jira key overlap and shared people.
 * No AI calls — pure heuristic analysis of existing DB data.
 */

import Database from 'better-sqlite3';

export interface TopicRelationship {
  topicA: string;
  topicB: string;
  type: 'jira_overlap' | 'shared_people';
  strength: number; // 0–1 (Jaccard similarity)
  evidence: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractJiraKeys(text: string): Set<string> {
  const matches = text.match(/\b[A-Z]{2,10}-\d+\b/g) ?? [];
  return new Set(matches);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = [...a].filter(x => b.has(x));
  const union = new Set([...a, ...b]);
  return intersection.length / union.size;
}

function extractPeopleFromNotebook(content: string): Set<string> {
  const match = content.match(/##\s+Key People\s*\n([\s\S]*?)(?=\n##|\n---|\s*$)/i);
  if (!match) return new Set();
  const people = match[1]
    .split('\n')
    .map(line => {
      const m = line.match(/^[-*]\s+([A-Z][a-zA-Z'-]+,\s+[A-Z][a-zA-Z'-]+)/);
      return m ? m[1].trim() : null;
    })
    .filter((n): n is string => n !== null);
  return new Set(people);
}

// ── Detection methods ──────────────────────────────────────────────────────

/** Detect topic pairs that reference common Jira issue keys. */
export function detectJiraOverlaps(db: Database.Database): TopicRelationship[] {
  const topics = db
    .prepare('SELECT id, name FROM topics')
    .all() as Array<{ id: number; name: string }>;

  const topicKeys = new Map<string, Set<string>>();
  for (const topic of topics) {
    const msgs = db
      .prepare('SELECT content, subject FROM messages WHERE topic_id = ?')
      .all(topic.id) as Array<{ content: string | null; subject: string | null }>;
    const keys = new Set<string>();
    for (const msg of msgs) {
      for (const k of extractJiraKeys(msg.content ?? '')) keys.add(k);
      for (const k of extractJiraKeys(msg.subject ?? '')) keys.add(k);
    }
    topicKeys.set(topic.name, keys);
  }

  const relationships: TopicRelationship[] = [];
  const names = [...topicKeys.keys()];

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = topicKeys.get(names[i])!;
      const b = topicKeys.get(names[j])!;
      const strength = jaccard(a, b);
      if (strength > 0.03) {
        const shared = [...a].filter(k => b.has(k));
        relationships.push({
          topicA: names[i],
          topicB: names[j],
          type: 'jira_overlap',
          strength,
          evidence: `Shared Jira keys (${shared.length}): ${shared.slice(0, 5).join(', ')}`,
        });
      }
    }
  }

  return relationships;
}

/** Detect topic pairs that share key people from their notebooks. */
export function detectSharedPeople(db: Database.Database): TopicRelationship[] {
  const notebooks = db
    .prepare('SELECT topic_name, content FROM topic_notebooks WHERE content IS NOT NULL')
    .all() as Array<{ topic_name: string; content: string }>;

  const relationships: TopicRelationship[] = [];

  for (let i = 0; i < notebooks.length; i++) {
    for (let j = i + 1; j < notebooks.length; j++) {
      const a = extractPeopleFromNotebook(notebooks[i].content);
      const b = extractPeopleFromNotebook(notebooks[j].content);
      const strength = jaccard(a, b);
      if (strength > 0.08) {
        const shared = [...a].filter(p => b.has(p));
        relationships.push({
          topicA: notebooks[i].topic_name,
          topicB: notebooks[j].topic_name,
          type: 'shared_people',
          strength,
          evidence: `Shared people (${shared.length}): ${shared.slice(0, 3).join(', ')}`,
        });
      }
    }
  }

  return relationships;
}

/** Upsert detected relationships into the DB. */
export function saveRelationships(
  db: Database.Database,
  relationships: TopicRelationship[]
): void {
  const upsert = db.prepare(`
    INSERT INTO topic_relationships (topic_a, topic_b, relationship_type, strength, evidence, detected_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(topic_a, topic_b, relationship_type) DO UPDATE SET
      strength = excluded.strength,
      evidence = excluded.evidence,
      detected_at = excluded.detected_at
  `);
  for (const r of relationships) {
    upsert.run(r.topicA, r.topicB, r.type, r.strength, r.evidence);
  }
}

/** Get all relationships for a given topic, sorted by strength descending. */
export function getRelationshipsForTopic(
  db: Database.Database,
  topicName: string
): Array<{ other: string; type: string; strength: number; evidence: string }> {
  return db
    .prepare(`
      SELECT
        CASE WHEN topic_a = ? THEN topic_b ELSE topic_a END as other,
        relationship_type as type,
        strength,
        evidence
      FROM topic_relationships
      WHERE topic_a = ? OR topic_b = ?
      ORDER BY strength DESC
    `)
    .all(topicName, topicName, topicName) as Array<{
    other: string;
    type: string;
    strength: number;
    evidence: string;
  }>;
}
