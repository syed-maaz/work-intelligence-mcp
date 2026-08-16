---
sidebar_position: 39
title: EP-39 Cross-Topic Relationship Detection
---

# EP-39: Cross-Topic Relationship Detection

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | Low |
| **Complexity** | Medium (3 days) |
| **Blocked By** | EP-37 (Semantic Search / Embeddings) — uses notebook embeddings |
| **Schema version** | 22 (adds `topic_relationships` table) |

## Summary

Topics are currently siloed — there is no mechanism to detect when "BDS auth" and "infra auth" are discussing the same Jira ticket, or when a blocker in one topic is blocking another. Cross-topic relationship detection surfaces these connections automatically:

- Two topics mentioning the same Jira key → linked
- Two topic notebooks semantically similar above a threshold → related
- A decision in one topic matches an open question in another → surfaced as a resolution candidate

Results stored in `topic_relationships` and shown in the notebook UI as a "Related Topics" sidebar.

## Decisions Made

- **Two detection methods**: (1) exact Jira key co-mention (cheap, high precision), (2) notebook embedding cosine similarity (semantic, catches non-Jira overlaps)
- **Asymmetric relationships** — topic A may reference B's domain without B referencing A; store both directions with independent scores
- **Threshold = 0.75 cosine similarity** for notebook-level semantic match — below this is noise
- **Run after notebook updates** — relationship detection fires at end of `runFullSync()` after notebooks are updated
- **No real-time computation** — relationships are pre-computed and cached; UI reads from `topic_relationships` table
- **Surface in notebook UI only initially** — no separate page; "Related Topics" panel in `TopicExpertPage.tsx`

## DB Schema (Migration 20 → 21)

```sql
CREATE TABLE IF NOT EXISTS topic_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_a TEXT NOT NULL,           -- references topics.name
  topic_b TEXT NOT NULL,           -- references topics.name
  relationship_type TEXT NOT NULL, -- 'jira_overlap' | 'semantic' | 'question_resolution'
  strength REAL NOT NULL,          -- 0–1; 1 = identical, lower = weaker relationship
  evidence TEXT,                   -- JSON: { sharedKeys: ['PROJ-123'], similarity: 0.82 }
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(topic_a, topic_b, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_topic_rel_a ON topic_relationships(topic_a);
CREATE INDEX IF NOT EXISTS idx_topic_rel_b ON topic_relationships(topic_b);
```

## Detection Logic — `src/tools/relationship-detector.ts`

### Method 1: Jira Key Co-mention

```typescript
export function detectJiraOverlaps(db: Database): TopicRelationship[] {
  // Extract Jira keys (e.g. PROJ-123) from messages per topic
  const jiraKeysByTopic = db.prepare(`
    SELECT t.name, GROUP_CONCAT(m.content) as all_content
    FROM messages m JOIN topics t ON m.topic_id = t.id
    WHERE m.timestamp >= date('now', '-30 days')
    GROUP BY t.id
  `).all().map(row => ({
    topic: row.name,
    keys: new Set((row.all_content.match(/[A-Z]+-\d+/g) ?? [])),
  }));

  const relationships: TopicRelationship[] = [];
  for (let i = 0; i < jiraKeysByTopic.length; i++) {
    for (let j = i + 1; j < jiraKeysByTopic.length; j++) {
      const shared = [...jiraKeysByTopic[i].keys].filter(k => jiraKeysByTopic[j].keys.has(k));
      if (shared.length >= 1) {
        const strength = Math.min(1, shared.length / 5);  // 5+ shared keys = max strength
        relationships.push({
          topic_a: jiraKeysByTopic[i].topic,
          topic_b: jiraKeysByTopic[j].topic,
          relationship_type: 'jira_overlap',
          strength,
          evidence: JSON.stringify({ sharedKeys: shared.slice(0, 10) }),
        });
      }
    }
  }
  return relationships;
}
```

### Method 2: Notebook Semantic Similarity (requires EP-36)

```typescript
export async function detectSemanticRelationships(
  db: Database,
  embedder: EmbeddingService,
  threshold = 0.75
): Promise<TopicRelationship[]> {
  const notebooks = listNotebooks(db);  // from src/db/queries.ts

  // Embed each notebook (or use cached embeddings if already stored)
  const embeddings = await Promise.all(
    notebooks.map(n => embedder.embed(n.content.slice(0, 3000)))
  );

  const relationships: TopicRelationship[] = [];
  for (let i = 0; i < notebooks.length; i++) {
    for (let j = i + 1; j < notebooks.length; j++) {
      const similarity = cosineSimilarity(embeddings[i], embeddings[j]);
      if (similarity >= threshold) {
        relationships.push({
          topic_a: notebooks[i].topic_name,
          topic_b: notebooks[j].topic_name,
          relationship_type: 'semantic',
          strength: similarity,
          evidence: JSON.stringify({ similarity: Math.round(similarity * 100) / 100 }),
        });
      }
    }
  }
  return relationships;
}
```

### Method 3: Question-Decision Resolution Matching

```typescript
export async function detectQuestionResolutions(
  db: Database,
  embedder: EmbeddingService
): Promise<TopicRelationship[]> {
  // Find open questions in topic A; find decisions in topic B
  // If cosine(question_embedding, decision_embedding) > 0.8, surface as resolution candidate
  // ...
}
```

### Orchestrator in `runFullSync()`

```javascript
// After notebook updates:
const { detectJiraOverlaps, detectSemanticRelationships } = await import('./src/tools/relationship-detector.js');

const jiraRelationships = detectJiraOverlaps(db);
const semanticRelationships = await detectSemanticRelationships(db, embedder);

for (const rel of [...jiraRelationships, ...semanticRelationships]) {
  db.prepare(`
    INSERT INTO topic_relationships (topic_a, topic_b, relationship_type, strength, evidence)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(topic_a, topic_b, relationship_type)
    DO UPDATE SET strength = excluded.strength, evidence = excluded.evidence, detected_at = datetime('now')
  `).run(rel.topic_a, rel.topic_b, rel.relationship_type, rel.strength, rel.evidence);
}
```

## New Endpoints — `web-server.js`

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/topics/:name/relationships` | `{ relationships: TopicRelationship[] }` for a specific topic |
| GET | `/api/topic-relationships` | All detected relationships |

## UI — Related Topics Panel in `TopicExpertPage.tsx`

Add a "Related Topics" section at the bottom of the notebook panel:

```
┌─────────────────────────────────────┐
│  Related Topics                      │
├─────────────────────────────────────┤
│  🔗 infra-auth  [jira_overlap]      │
│     Shared: PROJ-2341, PROJ-2398      │
│                                     │
│  ≈  platform-team  [semantic 84%]   │
│     High topic overlap detected     │
└─────────────────────────────────────┘
```

Clicking a related topic navigates to its notebook.

## Key Code Locations

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `topic_relationships` table, bump to v21 |
| `src/db/queries.ts` | Add `saveTopicRelationship`, `getTopicRelationships`, `listAllRelationships` |
| `src/tools/relationship-detector.ts` | NEW — three detection methods |
| `web-server.js` | Wire detection in `runFullSync`; add relationship endpoints |
| `web/src/pages/TopicExpertPage.tsx` | Add "Related Topics" panel to notebook view |
| `web/src/lib/api.ts` | Add `getTopicRelationships(topicName)` |

## Acceptance Criteria

- [ ] `topic_relationships` table created in migration
- [ ] Jira key co-mention detection finds topics sharing the same ticket keys
- [ ] Semantic similarity detection uses notebook embeddings (requires EP-36)
- [ ] Relationships upserted after each `runFullSync()` — no duplicates
- [ ] `GET /api/topics/:name/relationships` returns correct relationships
- [ ] "Related Topics" panel visible in TopicExpertPage when relationships exist
- [ ] Clicking a related topic navigates to its notebook
- [ ] TypeScript builds clean
