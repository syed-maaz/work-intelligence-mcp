---
title: "EP-22: Sync All Button"
sidebar_label: "EP-22: Sync All"
---

# EP-22: Sync All Button

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Web UI / Backend Engineer |
| **Depends On** | — |
| **Blocks** | [EP-25](./ep25-calendar-sync) |
| **File Scope** | `web-server.js` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shared/SyncAllButton.tsx` (new), `web/src/pages/DashboardPage.tsx` (edit) |

## Goal

Add a "Sync All" button to the Dashboard that triggers a full data sync for all topics, shows real-time per-topic progress, and auto-refreshes all dashboard data on completion. The user said: "on the front-page there should be a button to sync all the data."

## Decisions Made

- **Server-side `syncProgress` object (in-memory)**: Tracks running state per-topic. Persists across API calls within the same server process. Resets on server restart.
  - **Rejected**: Storing progress in `sync_state` table — `sync_state` tracks last-sync timestamps, not live progress. Mixing concerns would require parsing timestamps to infer "running" state.
- **Non-blocking endpoint — fire-and-forget**: `POST /api/sync/all` returns immediately with `{ status: 'started' }`. The frontend polls `GET /api/sync/status` every 2 seconds.
  - **Rejected**: Server-Sent Events / WebSocket — overkill for a 2-second polling interval on a local tool.
- **Frontend polls, not pushes**: Simpler, matches existing TanStack Query patterns in the codebase.
- **Double-click prevention**: If `syncProgress.running === true`, `POST /api/sync/all` returns `{ status: 'already_running' }` — no second sync starts.
- **Import from `dist/`**: `web-server.js` is plain Node.js. It already imports all tools from `dist/`. `runFullSync()` follows the same pattern — requires `npm run build` to be run first.

## What Will Be Built

### `web-server.js` (edit)

Add near top:
```js
const syncProgress = {
  running: false,
  currentTopic: null,       // string: topic name being synced
  completedTopics: [],      // string[]: finished topics
  startedAt: null,          // ISO string
  completedAt: null,        // ISO string
  error: null               // string | null
};

async function runFullSync() {
  syncProgress.running = true;
  syncProgress.completedTopics = [];
  syncProgress.startedAt = new Date().toISOString();
  syncProgress.completedAt = null;
  syncProgress.error = null;

  // Invalidate caches
  saturnCache.fetchedAt = 0;
  myIssuesCache.fetchedAt = 0;

  try {
    const topics = db.prepare('SELECT * FROM topics').all();
    for (const topic of topics) {
      syncProgress.currentTopic = topic.name;
      // For each topic, trigger relevant sync based on topic.config
      // Currently: teams-sync is a CLI; call syncTopicViaDb(db, topic, anthropicApiKey)
      // If SyncService is available from dist, use it; otherwise skip with log
      try {
        const { SyncService } = await import('./dist/services/sync.js');
        // minimal sync call per topic
      } catch (importErr) {
        process.stderr.write('[SyncAll] SyncService import failed — run npm run build first\n');
      }
      syncProgress.completedTopics.push(topic.name);
    }
    syncProgress.currentTopic = null;
    syncProgress.completedAt = new Date().toISOString();
  } catch (err) {
    syncProgress.error = err.message;
  } finally {
    syncProgress.running = false;
  }
}
```

New endpoints:
```
POST /api/sync/all     → { status: 'started' | 'already_running', ...syncProgress }
GET  /api/sync/status  → syncProgress
```

### `web/src/components/shared/SyncAllButton.tsx` (new)

```tsx
export function SyncAllButton() {
  const [polling, setPolling] = useState(false);
  const qc = useQueryClient();

  const startSync = async () => {
    await api.syncAll();
    setPolling(true);
  };

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      const progress = await api.syncStatus();
      if (!progress.running) {
        clearInterval(id);
        setPolling(false);
        qc.invalidateQueries();   // refresh all dashboard data
        if (progress.error) toast.error('Sync failed: ' + progress.error);
        else toast.success('Sync complete');
      }
    }, 2000);
    return () => clearInterval(id);
  }, [polling]);

  // Renders: Button with RefreshCw icon + "Sync All"
  // While polling: shows banner "Syncing [currentTopic]..." with animated dots
  // Button disabled while polling
}
```

### `web/src/lib/api.ts` (edit)

```ts
export interface SyncProgress {
  running: boolean;
  currentTopic: string | null;
  completedTopics: string[];
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

syncAll: () => request<{ status: string } & SyncProgress>('/sync/all', {})
syncStatus: () => request<SyncProgress>('/sync/status')
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-22-1 | Add `syncProgress` object + `runFullSync()` async function — **File:** `web-server.js` | 🔲 TODO |
| EP-22-2 | Add `POST /api/sync/all` (non-blocking) + `GET /api/sync/status` — **File:** `web-server.js` | 🔲 TODO |
| EP-22-3 | Add `SyncProgress` type + `syncAll()`, `syncStatus()` — **File:** `web/src/lib/api.ts` | 🔲 TODO |
| EP-22-4 | Build `SyncAllButton` with 2s polling + completion handling — **File:** `web/src/components/shared/SyncAllButton.tsx` | 🔲 TODO |
| EP-22-5 | Add `<SyncAllButton />` to Dashboard header — **File:** `web/src/pages/DashboardPage.tsx` | 🔲 TODO |

## Acceptance Criteria

- [ ] `POST /api/sync/all` returns immediately (does not block for the sync duration)
- [ ] `GET /api/sync/status` reflects live progress during sync
- [ ] Double-triggering returns `{ status: 'already_running' }`
- [ ] All dashboard queries are invalidated after sync completes
- [ ] Success toast shown on completion; error toast on failure
- [ ] Per-topic progress shown in banner while running
- [ ] `npm run typecheck` passes with zero errors

## Sample Usage

```bash
# Start sync
curl -X POST http://localhost:3132/api/sync/all
# → { status: "started", running: true, currentTopic: null, ... }

# Poll status during sync
curl http://localhost:3132/api/sync/status
# → { running: true, currentTopic: "BDS", completedTopics: ["teams"], ... }

# After completion
curl http://localhost:3132/api/sync/status
# → { running: false, completedTopics: ["BDS", "teams", ...], completedAt: "...", error: null }
```
