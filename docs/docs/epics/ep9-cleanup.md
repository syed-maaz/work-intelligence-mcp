---
title: "EP-9: Dead Code Cleanup"
sidebar_label: "EP-9: Cleanup"
---

# EP-9: Dead Code Cleanup

| | |
|---|---|
| **Status** | 🔲 TODO |
| **Priority** | Low |
| **Agent Role** | Any |
| **Depends On** | [EP-2](./ep2-teams-scraper), [EP-3](./ep3-outlook-scraper) |
| **Blocks** | — |
| **File Scope** | `src/connectors/teams.ts`, `src/connectors/email.ts`, `src/connectors/graph-auth.ts` (delete all three) |

## Goal

Once the browser-based connectors (EP-2 Teams, EP-3 Outlook) are complete and the sync pipeline is running, the original Microsoft Graph API connectors become dead code. They reference Azure OAuth and Graph SDK which are blocked by corporate IT and never execute. This epic deletes them and removes the associated dead dependencies from `package.json`.

**Do not do this epic until EP-2 and EP-3 are both complete and verified working.**

## Why These Files Are Dead

| File | Reason |
|------|--------|
| `src/connectors/teams.ts` | Uses `@microsoft/microsoft-graph-client` — blocked by IT |
| `src/connectors/email.ts` | Uses `@microsoft/microsoft-graph-client` — blocked by IT |
| `src/connectors/graph-auth.ts` | Uses `@azure/identity` device code OAuth — blocked by IT |

These files were part of the original implementation before corporate IT policy blocked Graph API access. See [ADR-001](../adr/adr-001-browser-extraction) for the full context.

## Acceptance Criteria

- [ ] `src/connectors/teams.ts` deleted
- [ ] `src/connectors/email.ts` deleted
- [ ] `src/connectors/graph-auth.ts` deleted
- [ ] `@azure/identity` removed from `package.json` dependencies
- [ ] `@microsoft/microsoft-graph-client` removed from `package.json` dependencies
- [ ] `@microsoft/microsoft-graph-types` removed from `package.json` dependencies
- [ ] `npm run typecheck` still passes after deletion
- [ ] `npm install` completes without errors after package removals

## Verification Steps

Before deleting, confirm:
1. No files in `src/` import from `teams.ts`, `email.ts`, or `graph-auth.ts`
2. `SyncService` uses `TeamsBrowserConnector` and `OutlookBrowserConnector` (not the old connectors)

```bash
# Should return zero results
grep -r "from.*connectors/teams'" src/
grep -r "from.*connectors/email'" src/
grep -r "from.*connectors/graph-auth'" src/
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-9-1 | Verify no imports reference the dead files | 🔲 TODO |
| EP-9-2 | Delete `src/connectors/teams.ts` | 🔲 TODO |
| EP-9-3 | Delete `src/connectors/email.ts` | 🔲 TODO |
| EP-9-4 | Delete `src/connectors/graph-auth.ts` | 🔲 TODO |
| EP-9-5 | Remove `@azure/identity`, `@microsoft/microsoft-graph-client`, `@microsoft/microsoft-graph-types` from `package.json` | 🔲 TODO |
| EP-9-6 | Run `npm run typecheck` and verify zero errors | 🔲 TODO |

---

## Agent Prompt

:::tip Start This Epic
EP-2 (Teams Browser Connector) and EP-3 (Outlook Browser Connector) must both be complete
and verified working in the sync pipeline before starting this epic.
:::

```
You are implementing EP-9: Dead Code Cleanup for the Work Intelligence MCP project.


CONTEXT:
The original Microsoft Graph API connectors (teams.ts, email.ts, graph-auth.ts) are dead code.
Corporate IT blocks the Azure OAuth flow they rely on. They've been replaced by Playwright
browser connectors (teams-browser.ts, outlook-browser.ts). Now they can be safely deleted.

YOUR SCOPE:
- Delete: src/connectors/teams.ts, src/connectors/email.ts, src/connectors/graph-auth.ts
- Modify: package.json (remove 3 dead dependencies)

BEFORE DELETING, VERIFY:
Run these checks and confirm zero results:
  grep -r "from.*connectors/teams'" src/
  grep -r "from.*connectors/email'" src/
  grep -r "from.*connectors/graph-auth'" src/

If any imports are found, do NOT delete — report them instead.

WHAT TO REMOVE FROM package.json:
- @azure/identity
- @microsoft/microsoft-graph-client
- @microsoft/microsoft-graph-types

ACCEPTANCE CRITERIA:
- All 3 files deleted
- 3 dependencies removed from package.json
- npm run typecheck passes with zero errors after deletion
- No remaining imports reference the deleted files
```
