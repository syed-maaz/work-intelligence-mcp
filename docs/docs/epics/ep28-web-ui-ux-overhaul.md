---
sidebar_position: 28
title: "EP-28: Web UI/UX Overhaul"
sidebar_label: "EP-28: Web UI/UX Overhaul"
---

# EP-28: Web UI/UX Overhaul (Sprint 5)

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Depends On** | EP-20, EP-21, EP-22, EP-23, EP-24, EP-25, EP-26 |
| **Blocks** | — |
| **File Scope** | All 8 pages, `AppShell.tsx`, `Sidebar.tsx`, `Topbar.tsx`, `ChatPanel.tsx`, `web/src/components/shared/*`, `web/src/components/ui/index.tsx` |

## Goal

Full density + mobile responsiveness pass across every page. Move from a loose, card-heavy layout to a compact, information-dense design that works on smaller screens. Unify visual language across all pages so everything feels cohesive.

---

## Decisions Made

- **Uniform density tokens**: `px-3 py-2` headers, `text-xs` body text everywhere, `py-1.5` row height. No page deviates from these.
- **Mobile sidebar as fixed drawer**: `fixed inset-y-0 z-40` with backdrop + `translate-x` CSS transition. `mobileMenuOpen` Zustand state in `ui.ts`. Closes on nav click.
- **Mobile chat as full-screen overlay**: `fixed inset-0 z-50 md:hidden` — same ChatPanel, positioned differently on mobile vs desktop.
- **Sync status in Topbar**: Removed the standalone sync bar. Last sync time + AI/Browser status dots + SyncAllButton moved into Topbar center. Topbar is always visible.
- **Dashboard simplified**: Removed stats row, removed sync progress bar, removed ErrorLogSection from dashboard. Dashboard now = DailySummary hero → 3-col grid → 2-col Jira grid.
- **Forms inside bordered cards**: Every form (configure topic, digest, search) lives inside a `rounded-xl border overflow-hidden` card with a `px-3 py-2 border-b` header strip — consistent with list cards.
- **Rejected**: Keeping separate sync status page — redundant once Topbar has status.

---

## Dashboard Layout (After EP-28)

```
┌──────────────────────────────────────────────────────┐
│  DailySummarySection (hero accordion)                │
├──────────────────┬──────────────────┬────────────────┤
│  NeedsAttention  │  TodaysCalendar  │ RecentMeetings │
├──────────────────┴──────────────────┴────────────────┤
│  MyIssuesSection          │  SaturnBoardSection      │
└───────────────────────────┴──────────────────────────┘
```

---

## Pages Overhauled

| Page | Key changes |
|------|-------------|
| **Dashboard** | Removed stats/sync bar/errors; 3-col + 2-col grid layout |
| **JiraReport** | Epic grouping headers, 3-tab inline analysis cards (EP-29) |
| **TopicExpert** | Notebook + chat split layout (EP-26 UI), compact tab bar |
| **TeamsUpdates** | Favourite keyword chips, stacked result cards (EP-30) |
| **SearchAll** | Compact results list with source badges |
| **ActionItems** | Compact row layout, status filter chips |
| **Digest** | Date shortcuts bar, recent digests list, cached badge |
| **Topics** | Inline suggestions section, compact form in card, delete/edit buttons |

---

## Shell Changes

### Sidebar (`web/src/components/shell/Sidebar.tsx`)
- Mobile: `fixed inset-y-0 left-0 z-40 w-56` drawer + semi-transparent backdrop
- Desktop: standard `sticky` layout unchanged
- Close on nav item click (mobile)
- `mobileMenuOpen` + `toggleMobileMenu` in `useUIStore`

### Topbar (`web/src/components/shell/Topbar.tsx`)
- Hamburger menu button (mobile only) → `toggleMobileMenu`
- Center: last sync time + AI connected dot + Browser connected dot + `SyncAllButton`
- Right: CommandPalette trigger + Chat toggle

### ChatPanel (`web/src/components/shell/ChatPanel.tsx`)
- Desktop: `w-80` right sidebar (unchanged)
- Mobile: `fixed inset-0 z-50` full-screen overlay with close button

---

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-28-1 | Unified density tokens across all 8 pages | ✅ Done |
| EP-28-2 | Mobile sidebar drawer (fixed + translate + backdrop) | ✅ Done |
| EP-28-3 | Mobile chat full-screen overlay | ✅ Done |
| EP-28-4 | Sync status → Topbar center | ✅ Done |
| EP-28-5 | Dashboard layout simplification | ✅ Done |
| EP-28-6 | Forms → bordered card pattern | ✅ Done |
| EP-28-7 | Topics page: delete + edit buttons | ✅ Done |

---

## Acceptance Criteria

- [x] All 8 pages use `px-3 py-2 text-xs` density pattern
- [x] Sidebar opens/closes as drawer on mobile with backdrop
- [x] Chat opens as full-screen overlay on mobile
- [x] Topbar shows last sync time + status dots + SyncAll
- [x] Dashboard renders correctly at all viewport sizes
- [x] `npm run typecheck` passes with zero errors
- [x] `npm run build` compiles cleanly

---

## Key Files

- `web/src/components/shell/AppShell.tsx`
- `web/src/components/shell/Sidebar.tsx`
- `web/src/components/shell/Topbar.tsx`
- `web/src/components/shell/ChatPanel.tsx`
- `web/src/store/ui.ts` — `mobileMenuOpen`, `toggleMobileMenu`
- `web/src/pages/DashboardPage.tsx`
- All other pages in `web/src/pages/`
