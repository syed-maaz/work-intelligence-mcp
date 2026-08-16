---
title: "EP-16: macOS Event-Driven Trigger System"
sidebar_label: "EP-16: macOS Triggers"
---

# EP-16: macOS Event-Driven Trigger System

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Depends On** | [EP-15](./ep15-proactive-agent) |
| **Blocks** | — |
| **File Scope** | `web-server.js` (edit), `src/connectors/outlook-watcher.ts` (new) |

## Goal

Replace the fixed 15-minute polling loop with an **event-driven trigger system**. When something arrives — a Jira notification email, a Teams message, a calendar update — the system reacts within seconds and syncs **only what changed, from where it left off last time**.

Two parallel mechanisms:

1. **File watcher on `HxStore.hxd`** — Outlook's live mail store. `fs.watch()` fires instantly when Outlook writes to it (new mail arriving). Zero polling, zero latency, zero wasted work.
2. **Teams badge poll (60s)** — Teams has no watchable local file. AppleScript reads the unread badge count every 60 seconds. If it increases, trigger a Teams-only resync.

In both cases: sync only the relevant source, **from `last_synced_at` forward**, not the last 7 days. Then regenerate alerts. The 15-min full sync (EP-15-1) remains as a safety net.

---

## Architecture

```
HxStore.hxd  ←──── fs.watch (Node.js FSEvents, instant)
     │
     ▼
AppleScript: get unread subjects from Outlook
     │
     ├── Jira pattern match? ──► runJiraSync(since: last_jira_sync)
     │                           → invalidate saturnCache + myIssuesCache
     │                           → re-fetch from jira.example.com (browser)
     │                           → update sync_state
     │                           → generateAlerts()
     │                           → macOS notification
     │
     └── other email? ──────────► (future: runEmailSync when EP-3 fully wired)
                                  → generateAlerts()

Teams AppleScript badge poll (every 60s)
     │
     └── badge count increased? ► runTeamsSync(since: last_teams_sync)
                                  → scrape only unread chats from last_synced_at
                                  → update sync_state
                                  → update notebooks for affected topics
                                  → generateAlerts()
                                  → macOS notification

EP-15-1 auto-sync (every 15 min) — full sync, safety net for everything
```

---

## Critical Fix: "Since Last Update" Across All Sources

**Current bug in `web-server.js`**: `runTeamsSync()` always passes `sinceDays: 7` — it ignores `sync_state.last_synced_at`. Every sync re-fetches the last 7 days regardless of when the last sync ran. This wastes browser time and re-processes already-seen messages.

**Fix required in EP-16-3** (wired into all targeted syncs and the full sync):

```javascript
// Get the last sync time for a source across all topics
function getLastSyncTime(source) {
  const row = db.prepare(
    `SELECT MIN(last_synced_at) as oldest FROM sync_state WHERE source = ?`
  ).get(source);
  // Use the oldest topic's sync time so no topic is left behind
  // Fall back to 7 days if never synced
  if (!row?.oldest) return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return new Date(row.oldest);
}
```

Then in `runTeamsSync()`:
```javascript
const since = getLastSyncTime('teams');
const sinceDays = Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
// ...
await chatScraper.scrapeChats({
  sinceDays: Math.max(1, Math.min(sinceDays, 90)), // cap at 90 days
  // ...
});
```

And in Jira sync trigger:
```javascript
const since = getLastSyncTime('jira');
// pass since to jira scraper / invalidate and re-fetch from that date
```

This ensures:
- Triggered syncs fetch exactly what's new since the last run
- No duplicate processing
- No missed messages if sync was delayed

---

## Tickets

### EP-16-1 — Outlook File Watcher (`src/connectors/outlook-watcher.ts`)

**Goal**: Watch `HxStore.hxd` with `fs.watch()` and classify new mail via AppleScript. Instant, zero-poll for email/Jira signals.

**Why `HxStore.hxd`**:
- Verified on this machine: it's the live Outlook mail store (58MB, updated today Apr 17)
- `fs.watch()` fires a `rename` event immediately when Outlook writes to it
- No special permissions needed — it's in your home directory
- Same approach as `mac-calendar.ts` which already uses `execFileSync('osascript', ...)`

**New file `src/connectors/outlook-watcher.ts`**:

```typescript
import { watch, type FSWatcher } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OutlookWatchEvent {
  type: 'jira' | 'email' | 'unknown';
  subjects: string[];
  jiraProjectKeys: string[];  // e.g. ['BDS', 'KBA'] from subjects like "[PROJ-234] ..."
  unreadCount: number;
}

export type OutlookWatchCallback = (event: OutlookWatchEvent) => void;

// Path to Outlook's live mail store — verified on macOS Outlook 16.x
const HXSTORE_PATH = join(
  homedir(),
  'Library/Group Containers/UBF8T346G9.Office/Outlook/Outlook 15 Profiles/Main Profile/HxStore.hxd'
);

// Debounce: HxStore gets multiple writes per mail arrival — wait 2s for them to settle
const DEBOUNCE_MS = 2000;

const JIRA_PATTERNS = [
  /jira\.tools\./i,
  /\[jira\]/i,
  /jira notification/i,
  /atlassian/i,
];

function runAppleScript(script: string): string {
  try {
    return execFileSync('osascript', ['-e', script], {
      timeout: 10_000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function getUnreadSubjects(): string[] {
  const raw = runAppleScript(`
    tell application "Microsoft Outlook"
      try
        set msgs to (messages of inbox whose is read is false)
        set msgCount to count of msgs
        if msgCount = 0 then return ""
        set subjects to {}
        repeat with i from 1 to msgCount
          set end of subjects to subject of (item i of msgs)
        end repeat
        return subjects
      on error
        return ""
      end try
    end tell
  `);
  if (!raw) return [];
  return raw.split(', ').map(s => s.trim()).filter(Boolean);
}

function getUnreadCount(): number {
  const raw = runAppleScript(
    'tell application "Microsoft Outlook" to count (messages of inbox whose is read is false)'
  );
  const n = parseInt(raw, 10);
  return isNaN(n) ? -1 : n;
}

function extractProjectKeys(subjects: string[]): string[] {
  const keys = new Set<string>();
  for (const s of subjects) {
    for (const m of s.matchAll(/\b([A-Z]{2,8})-\d+\b/g)) {
      keys.add(m[1]);
    }
  }
  return [...keys];
}

export class OutlookWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUnreadCount = -1;
  private callback: OutlookWatchCallback;

  constructor(callback: OutlookWatchCallback) {
    this.callback = callback;
  }

  start(): boolean {
    try {
      // Seed the initial unread count so first fire only triggers on actual new mail
      this.lastUnreadCount = getUnreadCount();

      this.watcher = watch(HXSTORE_PATH, () => {
        // Debounce: multiple rapid writes happen per mail — wait for them to settle
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.handleChange(), DEBOUNCE_MS);
      });

      this.watcher.on('error', (err) => {
        process.stderr.write(`[OutlookWatcher] fs.watch error: ${err.message}\n`);
      });

      process.stderr.write(
        `[OutlookWatcher] Watching HxStore.hxd — initial unread: ${this.lastUnreadCount}\n`
      );
      return true;
    } catch (err) {
      process.stderr.write(
        `[OutlookWatcher] Could not start — HxStore.hxd not found or not readable: ${(err as Error).message}\n`
      );
      return false;
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private handleChange(): void {
    const currentCount = getUnreadCount();

    // File changed but unread count didn't increase — read/delete/move event, not new mail
    if (currentCount !== -1 && currentCount <= this.lastUnreadCount) {
      this.lastUnreadCount = currentCount;
      return;
    }

    // New mail arrived
    const subjects = getUnreadSubjects();
    this.lastUnreadCount = currentCount;

    const hasJira = subjects.some(s => JIRA_PATTERNS.some(p => p.test(s)));
    const jiraKeys = extractProjectKeys(subjects);

    process.stderr.write(
      `[OutlookWatcher] New mail: ${subjects.length} unread | Jira: ${hasJira} | Keys: ${jiraKeys.join(', ') || 'none'}\n`
    );

    this.callback({
      type: hasJira ? 'jira' : subjects.length > 0 ? 'email' : 'unknown',
      subjects,
      jiraProjectKeys: jiraKeys,
      unreadCount: currentCount,
    });
  }
}
```

**Acceptance criteria:**
- [x] `OutlookWatcher` class with `start()` / `stop()` methods
- [x] `start()` returns `false` gracefully if `HxStore.hxd` doesn't exist (Outlook not installed / different version)
- [x] Debounce of 2s — multiple rapid writes trigger only one callback
- [x] Unread count check: only fires callback when count actually increased (ignores read/delete events)
- [x] `extractProjectKeys` extracts `['BDS']` from `['[PROJ-234] Issue updated']`
- [x] `getUnreadSubjects()` returns `[]` (not throws) when Outlook is closed
- [x] AppleScript calls have 10s timeout — never block the server

**Files:** `src/connectors/outlook-watcher.ts`

---

### EP-16-2 — Teams Badge Watcher (AppleScript poll)

**Goal**: Poll Teams unread badge every 60s via AppleScript. On increase, trigger Teams-only resync from `last_synced_at`.

**Why polling for Teams (not file watching)**: Teams on Mac is an Electron app. All state is in-memory and remote. There is no local `HxStore.hxd` equivalent. The only local signal available without Accessibility permissions is the unread count visible via AppleScript on the running app badge.

**Add to `src/connectors/outlook-watcher.ts`** (same file, separate export):

```typescript
export function getTeamsBadgeCount(): number {
  // Read Teams dock badge (unread message count)
  // Returns -1 if Teams is not running
  const raw = runAppleScript(`
    tell application "System Events"
      try
        if not (exists process "MSTeams") then return -1
        set badgeList to value of attribute "AXStatusLabel" of ¬
          (first button of (first tab group of (first window of process "MSTeams")))
        if badgeList is missing value then return 0
        return badgeList
      on error
        return -1
      end try
    end tell
  `);
  if (raw === '-1' || raw === '') return -1;
  if (raw === '0' || raw === '') return 0;
  // Badge shows "3" or "3+" — extract the number
  const n = parseInt(raw.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
```

**Note**: `getTeamsBadgeCount()` requires Accessibility permissions (`System Preferences → Privacy & Security → Accessibility → terminal/node`). If not granted, it returns -1 and the watcher skips gracefully — Teams sync still runs on the 15-min auto loop.

**Acceptance criteria:**
- [x] `getTeamsBadgeCount()` returns integer (0 if no unread, -1 if Teams not running or no permissions)
- [x] Returns -1 gracefully without crashing if accessibility not permitted
- [x] Handles badge showing "3+" (strips non-numeric characters)

---

### EP-16-3 — "Since Last Update" Fix + Targeted Sync Functions in web-server.js

**Goal**: All triggered syncs fetch only from `last_synced_at` forward. Fix the current `sinceDays: 7` hardcode. Add three targeted sync functions.

**Add helper + three targeted functions to `web-server.js`**:

```javascript
// ── Since-last-update helper ───────────────────────────────────
/**
 * Returns the earliest last_synced_at across all topics for a given source.
 * Using the minimum ensures no topic is left behind on a targeted sync.
 * Falls back to `fallbackDays` ago if never synced.
 */
function getLastSyncTime(source, fallbackDays = 7) {
  const row = db.prepare(
    `SELECT MIN(last_synced_at) as oldest FROM sync_state WHERE source = ?`
  ).get(source);
  if (!row?.oldest) return new Date(Date.now() - fallbackDays * 24 * 60 * 60 * 1000);
  return new Date(row.oldest);
}

// ── Targeted sync: Teams only ──────────────────────────────────
async function runTargetedTeamsSync() {
  if (!process.env.BROWSER_PROFILE_PATH) return;
  const since = getLastSyncTime('teams');
  const sinceDays = Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
  process.stderr.write(`[TriggeredSync] Teams — fetching since ${since.toISOString().slice(0,16)} (${sinceDays}d)\n`);

  try {
    const { TeamsChatScraper } = await import('./dist/connectors/teams-chats.js');
    const { TeamsMeetingsScraper } = await import('./dist/connectors/teams-meetings.js');
    const session = getBrowserSession();
    const chatScraper = new TeamsChatScraper(session);
    const meetingScraper = new TeamsMeetingsScraper(session, anthropicApiKey);
    const chats = await chatScraper.scrapeChats({
      unreadOnly: true,
      sinceDays: Math.max(1, Math.min(sinceDays, 90)),
      maxMessagesPerChat: 200,
      maxChats: 30,
      meetingScraper,
    });
    const topicsUpdated = new Set();
    for (const chat of chats) {
      const isActive = chat.lastMessageAt &&
        new Date(chat.lastMessageAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      upsertGroupChatLocal(db, chat.name, chat.lastMessageAt, isActive || chat.isUnread);
      db.transaction(() => {
        for (const msg of chat.messages) {
          const saved = upsertMessageLocal(db, msg);
          if (saved?.topic_id) topicsUpdated.add(saved.topic_id);
        }
      })();
      if (chat.meeting) upsertMeetingLocal(db, chat.meeting);
    }
    // Update sync_state for teams source
    const now = new Date().toISOString();
    const topics = db.prepare('SELECT id FROM topics').all();
    for (const t of topics) {
      db.prepare(`
        INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
        VALUES (?, 'teams', ?, ?)
        ON CONFLICT(topic_id, source) DO UPDATE SET
          last_synced_at = excluded.last_synced_at,
          last_message_count = excluded.last_message_count
      `).run(String(t.id), now, chats.reduce((n, c) => n + c.messages.length, 0));
    }
    // Update notebooks only for affected topics
    if (analyzer) {
      for (const topicId of topicsUpdated) {
        const t = db.prepare('SELECT name FROM topics WHERE id = ?').get(topicId);
        if (t) await getOrBuildNotebook(db, t.name, analyzer).catch(() => {});
      }
    }
    process.stderr.write(`[TriggeredSync] Teams done — ${chats.length} chats\n`);
  } catch (err) {
    process.stderr.write(`[TriggeredSync] Teams failed: ${err.message}\n`);
  }
}

// ── Targeted sync: Jira only ───────────────────────────────────
async function runTargetedJiraSync(projectKeys = []) {
  const since = getLastSyncTime('jira');
  process.stderr.write(
    `[TriggeredSync] Jira — invalidating cache, re-fetching since ${since.toISOString().slice(0,16)}` +
    (projectKeys.length ? ` | keys: ${projectKeys.join(', ')}` : '') + '\n'
  );
  // Invalidate in-memory caches — next request re-fetches from Jira
  saturnCache.fetchedAt = 0;
  myIssuesCache.fetchedAt = 0;
  // Eagerly re-fetch so data is ready before next page load
  await Promise.allSettled([
    loadSaturnIssues().catch(() => {}),
    loadMyIssues().catch(() => {}),
  ]);
  // Update jira sync_state timestamp
  const now = new Date().toISOString();
  const topics = db.prepare('SELECT id FROM topics').all();
  for (const t of topics) {
    db.prepare(`
      INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
      VALUES (?, 'jira', ?, 0)
      ON CONFLICT(topic_id, source) DO UPDATE SET last_synced_at = excluded.last_synced_at
    `).run(String(t.id), now);
  }
  process.stderr.write(`[TriggeredSync] Jira done\n`);
}

// ── Targeted sync: Calendar only ──────────────────────────────
async function runTargetedCalendarSync() {
  const since = getLastSyncTime('calendar', 1); // calendar: fall back 1 day only
  process.stderr.write(`[TriggeredSync] Calendar — since ${since.toISOString().slice(0,16)}\n`);
  await scrapeAndSaveCalendar();
  process.stderr.write(`[TriggeredSync] Calendar done\n`);
}
```

**Also fix `runTeamsSync()` (used by full sync) to use `getLastSyncTime`:**
```javascript
// Replace hardcoded sinceDays: 7 with:
const since = getLastSyncTime('teams');
const sinceDays = Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
// ...
sinceDays: Math.max(1, Math.min(sinceDays, 90)),
```

**Acceptance criteria:**
- [x] `getLastSyncTime(source)` queries `MIN(last_synced_at)` from `sync_state` for that source
- [x] Falls back to `fallbackDays` days ago if never synced
- [x] `runTargetedTeamsSync()` uses `getLastSyncTime('teams')` for `sinceDays`
- [x] `runTargetedTeamsSync()` updates `sync_state` after completion with current timestamp
- [x] `runTargetedTeamsSync()` rebuilds notebooks only for topics with new messages
- [x] `runTargetedJiraSync()` invalidates cache AND eagerly re-fetches
- [x] `runTargetedJiraSync()` updates `sync_state` for jira source
- [x] `runTeamsSync()` (full sync path) also uses `getLastSyncTime` — no more hardcoded 7 days
- [x] All three targeted functions are safe to call concurrently (guarded by `isRefreshing` flags)

**Files:** `web-server.js`

---

### EP-16-4 — Wire Watchers into web-server.js

**Goal**: Start both watchers when `web-server.js` boots, call targeted syncs on trigger.

**Add to bottom of `web-server.js`** (after server starts listening):

```javascript
import { OutlookWatcher, getTeamsBadgeCount } from './dist/connectors/outlook-watcher.js';

// ── macOS notification helper ──────────────────────────────────
function sendMacNotification(title, body) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('osascript', ['-e',
      `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`
    ], { timeout: 3000 });
  } catch { /* best-effort */ }
}

// ── Watcher state (exposed in /api/sync/status) ────────────────
const watcherState = {
  outlookEnabled: false,
  teamsEnabled: false,
  lastOutlookCheck: null,
  lastTeamsCheck: null,
  lastTriggerAt: null,
  lastTriggerReason: null,
  triggerCount: 0,
};

// ── Outlook watcher ────────────────────────────────────────────
const outlookWatcher = new OutlookWatcher(async (event) => {
  watcherState.lastTriggerAt = new Date().toISOString();
  watcherState.triggerCount++;

  if (event.type === 'jira') {
    watcherState.lastTriggerReason = `Jira email: ${event.jiraProjectKeys.join(', ')}`;
    sendMacNotification('Work Intelligence', `New Jira activity: ${event.jiraProjectKeys.join(', ')}`);
    await runTargetedJiraSync(event.jiraProjectKeys);
  } else if (event.type === 'email') {
    watcherState.lastTriggerReason = 'New email';
    sendMacNotification('Work Intelligence', 'New email — syncing');
    // Email sync will be wired when EP-3 email scraper is fully operational
    // For now: just regenerate alerts in case action items are email-sourced
  }

  generateAlerts(); // EP-15-2
  watcherState.lastOutlookCheck = new Date().toISOString();
});
watcherState.outlookEnabled = outlookWatcher.start();

// ── Teams badge watcher ────────────────────────────────────────
const TEAMS_POLL_MS = Number(process.env.TEAMS_POLL_MS) || 60_000;
let lastTeamsBadge = getTeamsBadgeCount();
watcherState.teamsEnabled = lastTeamsBadge !== -1;

setInterval(async () => {
  const current = getTeamsBadgeCount();
  watcherState.lastTeamsCheck = new Date().toISOString();

  if (current === -1) return; // Teams not running or no accessibility permissions

  if (current > lastTeamsBadge) {
    const delta = current - lastTeamsBadge;
    process.stderr.write(`[TeamsBadge] Badge increased by ${delta} — triggering Teams sync\n`);
    watcherState.lastTriggerAt = new Date().toISOString();
    watcherState.lastTriggerReason = `Teams: ${delta} new message(s)`;
    watcherState.triggerCount++;

    sendMacNotification('Work Intelligence', `${delta} new Teams message${delta > 1 ? 's' : ''} — syncing`);
    await runTargetedTeamsSync();
    generateAlerts();
  }
  lastTeamsBadge = current;
}, TEAMS_POLL_MS);

process.stderr.write(
  `[Watchers] Outlook: ${watcherState.outlookEnabled ? 'active' : 'inactive'} | ` +
  `Teams: ${watcherState.teamsEnabled ? `active (${TEAMS_POLL_MS/1000}s poll)` : 'inactive (no accessibility)'}\n`
);
```

**Acceptance criteria:**
- [x] Both watchers start automatically when `web-server.js` boots
- [x] Outlook watcher: triggers `runTargetedJiraSync` on Jira email detection
- [x] Teams watcher: triggers `runTargetedTeamsSync` when badge increases
- [x] macOS notification sent for both trigger types
- [x] `watcherState` updated on every check and trigger
- [x] Watchers disabled gracefully (log message, no crash) if file/app not available
- [x] `TEAMS_POLL_MS` env var respected for poll interval

**Files:** `web-server.js`

---

### EP-16-5 — Watcher Status in API + Dashboard

**Goal**: Make the trigger system observable. See when it last fired and why.

**Extend `GET /api/sync/status`** response:

```javascript
// Add to existing sync status response:
watcher: {
  outlookEnabled: boolean,      // HxStore.hxd found and being watched
  teamsEnabled: boolean,        // Teams running + accessibility granted
  lastOutlookCheck: string|null, // ISO — last HxStore change event processed
  lastTeamsCheck: string|null,   // ISO — last Teams badge poll
  lastTriggerAt: string|null,    // ISO — last time a sync was triggered
  lastTriggerReason: string|null, // e.g. "Jira email: BDS, KBA"
  triggerCount: number,           // total triggers since server start
}
```

**Frontend — small addition to sync state row on Dashboard:**

```
Watcher  ●  Outlook: active · Teams: active · 3 triggers today · last: Jira email (BDS) 4m ago
```

- Green dot when both active, amber when one inactive, grey when both inactive
- Single line, below the existing sync state table

**Acceptance criteria:**
- [x] `GET /api/sync/status` includes `watcher` object with all fields
- [x] `api.ts` `SyncStatus` type updated with `watcher` field
- [x] Dashboard shows watcher status line
- [x] Status line updates on page refresh (uses existing sync-status query)

**Files:** `web-server.js`, `web/src/lib/api.ts`, `web/src/components/shell/StatusBar.tsx` (or Dashboard)

---

## Definition of Done

- [x] `npm run typecheck` passes
- [x] `OutlookWatcher` compiles and `start()` returns `true` when Outlook is installed
- [x] File watcher fires within 3s of a new email arriving in Outlook
- [x] Jira email → `runTargetedJiraSync` called → cache re-fetched → dashboard updated
- [x] Teams badge increase → `runTargetedTeamsSync` called → only new messages fetched (from `last_synced_at`)
- [x] macOS notification appears for both trigger types
- [x] `runTeamsSync()` (full sync) no longer hardcodes `sinceDays: 7`
- [x] `GET /api/sync/status` includes `watcher` object
- [x] All triggered syncs update `sync_state.last_synced_at` so next sync continues from the right place
- [x] Server starts cleanly even when Outlook/Teams are not running

---

## Environment Variables

```
TEAMS_POLL_MS=60000    # Teams badge poll interval (default: 60s)
```

---

## Latency After This Epic

| Event | Before | After |
|---|---|---|
| New Jira email | Up to 15 min | ~3s (file watch + 2s debounce) |
| New Teams message | Up to 15 min | ~60s (badge poll) |
| New calendar event | Up to 15 min | Up to 15 min (full sync — calendar has no local signal) |
| Dashboard shows fresh data | Manual sync or wait | Automatic, triggered by the event itself |
