---
sidebar_position: 36
title: EP-36 Notebook Auto-Refresh & Pre-Brief Enhancement
---

# EP-36: Notebook Auto-Refresh & Pre-Brief Enhancement

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | Medium |
| **Complexity** | Small (1 day) |
| **Blocked By** | EP-26 (Topic Notebooks) ✅ |
| **Schema version** | No change |

## Summary

Two related improvements to how notebooks are used:

1. **Notebook auto-refresh** — notebooks currently only update if someone manually hits "Rebuild" or if `getOrBuildNotebook()` is called. New messages accumulate without triggering an update. Fix: aggressively trigger `updateNotebook()` in `runFullSync()` for any topic with new messages since last notebook build.

2. **Pre-brief enhancement** — `generatePreBrief()` currently receives attendees + recent context items (messages/emails). It does not receive the topic notebook for the meeting's topic. Since the notebook is Claude's accumulated memory of the project, passing it produces dramatically better briefs: grounded in actual project history, aware of current blockers, key people, and open questions.

## Decisions Made

- **Auto-refresh threshold** = any new messages since `topic_notebooks.last_message_id` → trigger update
- **Update is async** — `runFullSync()` does not await notebook updates; fires them in background via `Promise.allSettled()`
- **Pre-brief uses notebook as system context** — notebook content passed as a separate `system` block to `generatePreBrief()`, not mixed into user messages
- **Pre-brief falls back gracefully** — if no notebook exists for the meeting's topic, pre-brief works as before (attendees + recent messages only)
- **Topic matching for pre-brief** — calendar event title matched against `topics.name` using same keyword-matching logic as alert Rule 5

## Architecture

### EP-35-1: Notebook Auto-Refresh in `runFullSync()`

In `web-server.js` `runFullSync()`, after Teams + calendar sync step:

```javascript
// Step N: Update notebooks for topics with new messages
const topics = db.prepare('SELECT name FROM topics').all();
const notebookUpdates = topics.map(async ({ name }) => {
  try {
    await getOrBuildNotebook(db, name, analyzer, { forceRebuild: false });
  } catch (err) {
    console.error(`[notebook] update failed for ${name}:`, err.message);
  }
});
// Fire and forget — don't block sync completion
Promise.allSettled(notebookUpdates).then(results => {
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) console.warn(`[notebook] ${failed}/${topics.length} updates failed`);
});
```

`getOrBuildNotebook()` already handles the "no new messages → return cached" path, so this is cheap when notebooks are current.

### EP-35-2: Pre-Brief Enhancement

Current `generatePreBrief()` signature in `src/services/analyzer.ts`:

```typescript
async generatePreBrief(
  event: CalendarEvent,
  contextItems: ContextItem[]  // recent messages/emails
): Promise<string>
```

Updated signature:

```typescript
async generatePreBrief(
  event: CalendarEvent,
  contextItems: ContextItem[],
  notebookContent?: string  // NEW — topic notebook for this meeting's project
): Promise<string>
```

When `notebookContent` is provided, it is prepended to the system prompt as a `cache_control: ephemeral` block:

```typescript
const systemBlocks: PromptCachingBetaTextBlockParam[] = [
  {
    type: 'text',
    text: `You are preparing a pre-meeting brief.\n\n${
      notebookContent
        ? `## Project Knowledge Base\n\nThe following is a structured summary of the project this meeting is about:\n\n${notebookContent}\n\n---\n\n`
        : ''
    }Use the project knowledge and the recent context items below to write a focused pre-meeting brief.`,
    cache_control: { type: 'ephemeral' },
  }
];
```

### Topic matching for pre-brief in `web-server.js`

In `runFullSync()` where `generatePreBrief()` is called per calendar event:

```javascript
// Find matching topic for this calendar event
function findTopicForEvent(db, eventTitle) {
  const keywords = eventTitle
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 3);

  for (const kw of keywords) {
    const topic = db.prepare(
      `SELECT name FROM topics WHERE name LIKE ? LIMIT 1`
    ).get(`%${kw}%`);
    if (topic) return topic.name;
  }
  return null;
}

// In the pre-brief generation loop:
const topicName = findTopicForEvent(db, event.title);
const notebookContent = topicName
  ? getNotebook(db, topicName)?.content
  : undefined;

const brief = await analyzer.generatePreBrief(event, contextItems, notebookContent);
```

## Expected Impact

Before: "BDS Sprint Review tomorrow — attendees: Alice, Bob, Carol. Recent messages: [3 unrelated emails]"

After: "BDS Sprint Review tomorrow — attendees: Alice, Bob, Carol. Project context: Current sprint is blocked on the auth middleware rewrite (legal compliance requirement). Open questions include the Redis cache sizing decision. Key decision pending: whether to split the  Note resolution into two tickets."

The notebook's "Current Status", "Open Questions", and "Decisions Made" sections are directly useful for meeting preparation.

## Key Code Locations

| File | Change |
|------|--------|
| `src/services/analyzer.ts` | Add `notebookContent?` param to `generatePreBrief()` |
| `src/tools/notebook.ts` | No change — `getOrBuildNotebook()` already correct |
| `web-server.js` | Add `findTopicForEvent()`; wire notebook into pre-brief generation; call `getOrBuildNotebook` in `runFullSync` loop |

## Acceptance Criteria

- [ ] `runFullSync()` triggers `getOrBuildNotebook()` for each topic after sync
- [ ] Notebook update is fire-and-forget (sync does not block on notebook build)
- [ ] `generatePreBrief()` accepts optional `notebookContent` parameter
- [ ] When matching topic notebook exists, notebook content appears in system prompt
- [ ] Pre-brief quality visibly improved for topics with existing notebooks
- [ ] No regression when no notebook exists (falls back to attendees + context only)
- [ ] TypeScript builds clean
