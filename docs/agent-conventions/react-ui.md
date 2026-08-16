---
paths:
  - "web/src/**"
---

## CSS variables — use only these
`var(--bg)`, `var(--bg-2)`, `var(--bg-3)`, `var(--fg)`, `var(--fg-2)`, `var(--muted)`, `var(--accent)`, `var(--border)`, `var(--danger)`.
`var(--fg-muted)` does NOT exist — using it silently renders nothing.

## Density tokens (EP-28 standard)
- Page/section headers: `px-3 py-2 text-xs font-semibold`, icon `size={12}`
- Table/list rows: `px-3 py-1.5 text-xs`
- Forms: inside a bordered card with a header strip — not bare `p-5` padding

## Mobile patterns
- Sidebar: `fixed inset-y-0 left-0 z-40` drawer + `translate-x-full`/`translate-x-0` via `mobileMenuOpen` Zustand state + `bg-black/40 md:hidden` backdrop
- Chat overlay: `fixed inset-0 z-50 md:hidden` + `hidden md:flex` for desktop sidebar

## Badge variants
`default | success | warning | danger | info` — defined in `web/src/components/ui/index.tsx`. No other variants exist.

## sendToChat pattern
`useUIStore.sendToChat(msg)` sets `chatOpen=true` + `pendingChatMessage=msg`. ChatPanel auto-submits via `useEffect` watching `pendingChatMessage`. Use this for action buttons that should open chat with pre-filled context.

## Jira polling pattern (202 + poll)
Fire `POST /api/jira/analyze` → 202 immediately. Poll `GET /api/jira/analyses` every 3s while `pendingKeys` exist. Drop to no polling when idle. State persists across page refresh via on-mount load of all analyses.

## api.ts request helpers
`request<T>()` for GET/POST. `requestDelete<T>()` for DELETE requests. Both in `web/src/lib/api.ts`.

## Component placement rule — no orphaned components
Every component in `web/src/components/shared/` MUST be imported and rendered somewhere in a page. When creating a new component:
1. Add it to a page before closing the PR/task.
2. If no existing page is the right home, create a new page and register it as a route in `App.tsx`.
3. After any new component is created, grep for its usage: `grep -r "ComponentName" web/src/pages/` — if nothing matches, wire it in.

**Current component → page mapping** (update when adding new components):
- `AlertFeed` → `DashboardPage`
- `ChatMessage` → `ChatPanel` (shell)
- `ConnectionGuard` → `DashboardPage`
- `DailySummarySection` → `DashboardPage`
- `EmptyState` → `ActionItemsPage`, `TopicsPage`
- `ErrorLogSection` → `DigestPage`
- `MarkdownPanel` → `TodaysCalendarSection`, `TopicExpertPage`, `SearchAllPage`, `DigestPage`
- `MyIssuesSection` → `DashboardPage`
- `SaturnBoardSection` → `DashboardPage`
- `SkeletonCard` / `SkeletonRow` → `SaturnBoardSection`, `MyIssuesSection`, `TopicsPage`, `ActionItemsPage`, `JiraReportPage`
- `SourceBadge` → `ActionItemsPage`
- `SyncAllButton` → `Topbar`, `JiraReportPage`
- `TodaysCalendarSection` → `DashboardPage` (contains `MeetingContextPanel` inline)
- `RecentMeetingsWidget` → `DashboardPage`
- `TokenStatsWidget` → `DigestPage`
- `DailyTokenUsageWidget` (inline in `DashboardPage`) → `DashboardPage`
- `WorkloadSection` → `DashboardPage`
- `VelocityStrip` → `JiraReportPage` (EP-42-4, between filter chips and stale warning)
