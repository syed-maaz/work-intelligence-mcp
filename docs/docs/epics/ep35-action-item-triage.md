---
sidebar_position: 35
title: EP-35 Action Item Confidence Triage
---

# EP-35: Action Item Confidence Triage

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | Medium |
| **Complexity** | Small (1 day) |
| **Blocked By** | None |
| **Schema version** | 20 (adds columns to `action_items`) |

## Summary

`detectActionItems()` already returns a `confidence` score (0–1) per extracted action item, but it's ignored at the DB layer — all items are stored as `open` regardless. This creates noise: low-confidence extractions ("Bob might look into this?") appear alongside high-confidence commitments ("Alice: send Q4 report by Friday").

This epic adds:
1. **Confidence-based status routing** — items below threshold → `pending_review`, above → `open`
2. **User confirmation UI** — dashboard widget to confirm/dismiss pending items
3. **Quality feedback loop** — confirmed/dismissed items feed back a `confirmed` flag, closing the loop for future model tuning

## Decisions Made

- **Threshold = 0.65** — below this, the extraction is speculative; reviewed empirically against existing data
- **`pending_review` is a new status** (not a new table) — fits existing `status` column pattern (`open` | `completed` | `pending_review` | `dismissed`)
- **`dismissed` status** — for items the user rejects as not real action items; kept for audit, never shown in active lists
- **Confirmation doesn't retrain the model** — just closes the quality loop in the DB; future fine-tuning can use this data
- **Auto-promote after 48h** — if a `pending_review` item is not actioned in 48h, auto-promote to `open` (cron in `runFullSync`) to avoid items disappearing silently

## DB Schema (Migration 18 → 19)

```sql
ALTER TABLE action_items ADD COLUMN confidence REAL;
ALTER TABLE action_items ADD COLUMN confirmed INTEGER DEFAULT 0;  -- 0=unconfirmed, 1=confirmed, -1=dismissed
ALTER TABLE action_items ADD COLUMN confirmed_at TEXT;
ALTER TABLE action_items ADD COLUMN auto_promoted_at TEXT;  -- set when 48h auto-promote fires
```

Update `detectActionItems` insert logic to store confidence from AI response.

Note: existing rows get `confidence = NULL`, `confirmed = 0`. Migration does not backfill confidence.

## New Status Values

| Status | Meaning | Shown in UI |
|--------|---------|-------------|
| `open` | Active, confirmed (or auto-promoted) | Yes — main list |
| `pending_review` | Low confidence, awaiting user confirmation | Yes — review widget |
| `completed` | Done | Yes — completed list |
| `dismissed` | User rejected as not a real action item | No |

## Changes to `src/db/queries.ts`

```typescript
// Update insertActionItem to accept confidence
export function insertActionItem(db: Database, item: {
  topic_id: number;
  title: string;
  description?: string;
  assignee?: string;
  due_date?: string;
  source_message_id?: number;
  content_hash: string;
  confidence?: number;  // NEW
}): void {
  const status = (item.confidence ?? 1) >= 0.65 ? 'open' : 'pending_review';
  // INSERT with status and confidence
}

// Confirm or dismiss a pending item
export function resolveActionItemReview(
  db: Database,
  id: number,
  decision: 'confirmed' | 'dismissed'
): void

// Auto-promote stale pending_review items
export function autoPromotePendingItems(db: Database, olderThanHours = 48): number
```

## Changes to `src/services/analyzer.ts`

`detectActionItems()` already returns confidence in the tool schema — ensure it's passed through to `insertActionItem()` call sites. No prompt change needed.

## New Endpoints — `web-server.js`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/action-items/pending-review` | Items with `status = 'pending_review'` |
| POST | `/api/action-items/:id/confirm` | Set `confirmed=1`, status→`open` |
| POST | `/api/action-items/:id/dismiss` | Set `confirmed=-1`, status→`dismissed` |

## New UI — `web/src/components/shared/PendingReviewWidget.tsx`

Small widget shown on Dashboard when `pending_review` items exist:

```
┌──────────────────────────────────────────────────────┐
│  ⚠ 3 action items need review                        │
├──────────────────────────────────────────────────────┤
│  "Bob to check on infra ticket"  (BDS chat, 2h ago)  │
│  confidence: 52%    [✓ Confirm]  [✗ Dismiss]         │
├──────────────────────────────────────────────────────┤
│  "Maybe Alice sends the report?" (email, 1d ago)     │
│  confidence: 41%    [✓ Confirm]  [✗ Dismiss]         │
└──────────────────────────────────────────────────────┘
```

Show badge count on Sidebar "Action Items" nav item when pending items exist.

## Auto-Promote Cron

In `runFullSync()`, call `autoPromotePendingItems(db, 48)` after sync. Log count to `ingestion_log` or console.

## Key Code Locations

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add columns to `action_items`, bump to v19 |
| `src/db/queries.ts` | Update `insertActionItem`, add `resolveActionItemReview`, `autoPromotePendingItems` |
| `src/services/analyzer.ts` | Pass confidence through to insert call |
| `web-server.js` | 3 new endpoints; call `autoPromotePendingItems` in `runFullSync` |
| `web/src/components/shared/PendingReviewWidget.tsx` | NEW |
| `web/src/lib/api.ts` | Add `getPendingReviewItems`, `confirmActionItem`, `dismissActionItem` |
| `web/src/pages/DashboardPage.tsx` | Add `PendingReviewWidget` |
| `web/src/components/shell/Sidebar.tsx` | Badge count on Action Items nav item |

## Acceptance Criteria

- [ ] Items with confidence < 0.65 inserted as `pending_review`, not `open`
- [ ] `confidence` column populated for all new items
- [ ] `GET /api/action-items/pending-review` returns pending items
- [ ] Confirm/dismiss endpoints update status and `confirmed` flag
- [ ] Auto-promote promotes `pending_review` items older than 48h to `open`
- [ ] Dashboard widget appears when pending items exist
- [ ] Sidebar badge shows pending count
- [ ] TypeScript builds clean
