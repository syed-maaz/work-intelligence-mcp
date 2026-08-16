---
title: "BUG-09: Two conflicting sync loops"
sidebar_label: "BUG-09: Dual sync loops"
---

# BUG-09: Two conflicting sync loops running simultaneously

| | |
|---|---|
| **Severity** | 🔴 Breaking |
| **Status** | ✅ Fixed |
| **File** | `src/services/sync.ts` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

`SyncService` contained two separate sync architectures running simultaneously.

### Loop 1 — The real sync (lines 154–175)

Introduced in EP-5. Uses the DB-backed path: loads topics from the database, reads sync state cursors, persists messages with `upsertMessage()`, detects action items, and updates `sync_state` timestamps.

```typescript
// Real sync — writes to DB
start(): void {
  this.globalIntervalId = setInterval(() => {
    this.syncAllTopics();  // DB-backed, proper cursor management
  }, intervalMs);
}
```

### Loop 2 — The dead sync (lines 382–418)

A holdover from before EP-5. `startTopicSync()` created per-topic per-source `setInterval` instances stored in `syncIntervals` Map. These called `syncSource()`, which fetched messages but **never called `upsertMessage()`**, **never detected action items**, and **never updated `sync_state`**.

```typescript
// Dead sync — fetches messages but writes nothing
startTopicSync(topic: Topic): void {
  const intervalId = setInterval(async () => {
    await this.syncSource(topic.id, source);  // ← returns SyncResult, discards it
  }, interval);
  this.syncIntervals.set(key, intervalId);
}
```

## Interaction Between the Two Loops

Both loops shared `lastSyncTimestamps` Map. If any caller invoked `startTopicSync()`, the per-topic interval would update `lastSyncTimestamps` with its own `since` timestamps. The global loop reads `lastSyncTimestamps` as its `since` source (before falling back to DB). The two loops stomped on each other's cursors.

The old public API (`syncTeams`, `syncEmail`, `syncJira`, `startTopicSync`, `stopTopicSync`, `syncTopic`) all routed through `syncSource()` — the dead path that writes nothing to DB. Callers using this API believed they were syncing but data went nowhere.

## Fix

The entire dead API was deleted:

- `startTopicSync()`
- `stopTopicSync()`
- `syncTopic()`
- `syncTeams()`
- `syncEmail()`
- `syncJira()`
- `isTopicSyncing()`
- `getLastSyncTimestamp()`
- Private `syncSource()`
- Private `syncSourceByType()`

The `SyncResult` interface and `syncIntervals` map were preserved because `SyncResult` is re-exported from `services/index.ts` and `syncIntervals` is used by `stop()` to clear any intervals that might have been registered externally.

The only sync entry points are now:
- `start()` — starts the global 15-minute loop
- `triggerSync(topicId)` — fires an immediate sync for one topic (used by `configure_topic`)

## Files Changed

- `src/services/sync.ts` — deleted ~235 lines of dead API methods
