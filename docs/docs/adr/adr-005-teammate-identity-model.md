---
title: "ADR-005: Teammate Identity Resolution — Alias Table over Exact Name Match"
sidebar_label: "ADR-005: Teammate Identity Model"
sidebar_position: 5
---

# ADR-005: Teammate Identity Resolution — Alias Table over Exact Name Match

| Field | Value |
|-------|-------|
| **Status** | Implemented (EP-45 ✅, Sprint 7) |
| **Date** | 2026-04-19 |
| **Epic** | EP-45 (Teammate Intelligence) |
| **Deciders** | Syed Maaz (product), Claude Code (architecture) |

---

## Context

EP-45 builds AI profiles for marked team members by aggregating their activity across four identity systems:

- **Teams messages** — `messages.sender` (display name, varies by client/device)
- **Jira tickets** — `jira_issues.assignee` (username format: `firstname.lastname`)
- **GitHub commits** — `git log --author` (GitHub handle: `@alice-gh`)
- **Calendar events** — `calendar_events.attendees` (email: `alice.chen@company.com`)

The fundamental problem: these four identity systems were never designed to reference each other. The same person appears as "Alice Chen", "Alice C.", "alice.chen@company.com", "alice-gh", and "alice.chen" depending on which system, which Teams client (desktop vs mobile), and whether she was ever added as a guest.

The question is: **how should Work Intelligence join these identities into a single view of a teammate?**

---

## Decision Drivers

1. **Profile accuracy** — a profile that silently undercounts activity by 30% is worse than no profile
2. **Privacy correctness** — identity resolution must not cross-correlate people who haven't been explicitly marked
3. **Maintenance cost** — the system should discover name variants automatically, not require manual alias entry
4. **Explainability** — when the system says "Alice sent 45 messages", the user should be able to verify which messages were attributed to her
5. **Graceful degradation** — if the alias resolver is uncertain, it should not guess; omission is better than misattribution

---

## Options Considered

### Option A: Exact string match on `teams_display_name` (rejected)

Store one canonical `teams_display_name` per member. Match `messages.sender = team_members.teams_display_name`.

**Pros:** Simple. No extra tables. Obvious join path.

**Cons:**
- Teams truncates display names on mobile ("Alice C." instead of "Alice Chen")
- External/guest users appear as "Alice Chen (Guest)" or "alice.chen@company.com"
- Encoding differences cause silent mismatches (non-ASCII characters in names)
- Profile silently undercounts activity by **20–40%** with no indication to the user

**Decision: Rejected.** Silent undercount is worse than a more complex join. The user has no way to know the profile is wrong.

---

### Option B: Manual alias management — user enters all variants (rejected)

Add a UI form where the user manually enters all known name variants for each member.

**Pros:** Explicit. User controls attribution. No false positives.

**Cons:**
- Requires the user to know all name variants in advance — they don't
- Must be re-maintained whenever a person's display name changes
- Defeats the purpose of automatic intelligence gathering

**Decision: Rejected.** Shifts maintenance burden to the user for a problem the system can solve algorithmically.

---

### Option C: Fuzzy match at query time — Levenshtein distance on every query (rejected)

At query time, run a fuzzy match between `messages.sender` and all `team_members.teams_display_name` values.

**Pros:** No extra tables. Always uses latest data.

**Cons:**
- O(N×M) at every `getMemberActivity()` call — N messages × M team members
- Levenshtein distance at query time is computationally expensive on large message tables
- Still produces false positives (two team members with similar names get cross-contaminated)
- No audit trail: can't explain "why was this message attributed to Alice?"

**Decision: Rejected.** Performance and false-positive risk unacceptable.

---

### Option D: `member_aliases` table with fuzzy pre-resolution (accepted)

Introduce a dedicated `member_aliases(member_id, alias, source)` table. Name variants are resolved **once** when a member is added or marked — not at query time. A fuzzy resolver (`identity-resolver.ts`) scans distinct message senders and identifies matches. Matches are stored as aliases. `getMemberActivity()` queries `WHERE messages.sender IN (SELECT alias FROM member_aliases WHERE member_id = ?)`.

**Resolution algorithm** (`resolveTeamsName()`):
1. Exact match
2. First name + last name initial ("Alice C." → "Alice Chen")
3. Email prefix match ("alice.chen" → "Alice Chen")
4. Levenshtein distance ≤ 2 (encoding diffs, typos, suffix like "(Guest)")
5. If none match: no alias created — no false attribution

**Pros:**
- Joins are fast — `member_aliases` is a small table; index on `member_id`
- Audit trail: `SELECT * FROM member_aliases WHERE member_id = ?` shows exactly which names were attributed
- Graceful degradation: unresolvable names produce no alias (omission, not misattribution)
- Auto-discovering: `buildAliasesForMember()` runs on add/mark and periodically to catch new variants
- Privacy-correct: alias resolution only runs for explicitly marked members — unmarked people are never correlated

**Cons:**
- Requires `buildAliasesForMember()` to run before first profile build
- Levenshtein threshold of 2 may occasionally miss aliases with larger edit distances (e.g., nickname vs legal name: "Liz" vs "Elizabeth")
- Manual `PATCH /api/teammates/:id/aliases` escape hatch needed for edge cases

**Decision: Accepted.** The alias table gives the right trade-off between accuracy, performance, privacy, and explainability.

---

## Consequences

### Positive
- `getMemberActivity()` attributions are accurate and auditable
- Profile activity counts reflect reality rather than silently undercounting
- Performance: small `member_aliases` table with indexed lookup is fast
- Privacy: alias resolution is gated on explicit marking — unmarked people never have their identities cross-correlated

### Negative
- Nickname ↔ legal name variants (e.g., "Bob" vs "Robert Singh") are not automatically resolved — require manual `PATCH /api/teammates/:id/aliases` entry
- `buildAliasesForMember()` must complete before first profile build — adds ~100ms per member on first sync (acceptable)
- Alias table grows over time as more message senders are seen — no impact on performance but needs monitoring

### Neutral
- Aliases are re-scanned periodically (every full sync) to catch new name variants added since the member was first marked
- The escape hatch `PATCH /api/teammates/:id/aliases` allows manual alias addition for edge cases

---

## Privacy Model Summary

```
marked member (marked = 1, deleted_at IS NULL):
  → Identity resolved via alias table + fuzzy matching
  → Full analytics: activity (via aliases), Jira, meetings, code
  → AI profile built with DIGEST_MODEL; structured tool output
  → notes field structurally excluded from MemberProfileInput (TypeScript Omit<>)

unmarked person (marked = 0):
  → NO alias resolution — never cross-correlated
  → Basic stats only: message_count + last_active (from canonical sender name only)
  → NO AI call, NO profile, NO cross-system join

soft-deleted member (deleted_at IS NOT NULL):
  → No longer shown in TeammatesPage
  → Profile + aliases preserved in DB (audit trail)
  → Can be restored by admin via direct DB update (no UI for restore — intentional)
```

---

## Implementation Notes

- `resolveTeamsName()` is pure JavaScript — no AI calls, no DB writes during resolution; writes only happen in `buildAliasesForMember()`
- Levenshtein implementation: use `fastest-levenshtein` npm package (pure JS, no native deps, 5-line import)
- `UNIQUE(alias)` on `member_aliases` prevents duplicate alias rows across runs
- Bot accounts (CI bots, service users) should be filtered before alias resolution using the same bot regex from EP-27: `T_[A-Z]+|.*\[bot\]|.*serviceuser|noreply.*`

---

## Related

- [EP-45: Teammate Intelligence](../epics/ep45-teammate-intelligence)
- [EP-43: Multi-Repo Code Intelligence](../epics/ep43-multi-repo-code-intelligence)
- [ADR-004: Obsidian Export Strategy](./adr-004-obsidian-smart-clusters) — same bot-filter pattern
