---
title: "EP-8: Testing"
sidebar_label: "EP-8: Testing"
---

# EP-8: Testing

| | |
|---|---|
| **Status** | 🔲 TODO |
| **Priority** | Medium |
| **Agent Role** | QA / Test Engineer |
| **Depends On** | [EP-0](./ep0-foundation) (unit tests); [EP-4](./ep4-jira-wiring), [EP-5](./ep5-sync-pipeline) (integration tests) |
| **Blocks** | — |
| **File Scope** | `src/tests/**` (create new directory) |

## Goal

Add meaningful test coverage for the components that have pure logic worth unit testing, plus integration test scaffolds for the browser connectors. The test suite should catch regressions when the schema, AI analyzer, or sync logic changes.

Unit tests mock external dependencies (Anthropic API, Jira API, browser). Integration tests for browser connectors are scaffolds — they document how to run manually and what to verify, but are not expected to run in CI (no browser in CI).

## Acceptance Criteria

- [ ] Test framework configured: `vitest` added to `devDependencies`, `npm test` runs all tests
- [ ] Unit tests for `AIAnalyzer` — mock `@anthropic-ai/sdk`, verify tool use calls and result mapping
- [ ] Unit tests for `JiraConnector.fetchMessages` — mock `fetch`, verify `UnifiedMessage` mapping
- [ ] Unit tests for `upsertMessage` deduplication — in-memory SQLite, verify idempotency
- [ ] Unit tests for MCP tool formatters — verify markdown output shape for `search_messages`, `get_action_items`
- [ ] Integration test scaffold for `TeamsBrowserConnector` — documents manual test steps
- [ ] Integration test scaffold for `OutlookBrowserConnector` — documents manual test steps
- [ ] `npm run typecheck` passes in `src/tests/**`

## Test Strategy

| Layer | Approach | Runs in CI |
|-------|----------|------------|
| AIAnalyzer | Mock Anthropic SDK, verify tool schemas + result parsing | Yes |
| JiraConnector | Mock fetch, verify URL construction + UnifiedMessage output | Yes |
| DB helpers | In-memory SQLite (`:memory:`), verify upsert dedup | Yes |
| MCP tools | Stub DB query, verify formatted response string | Yes |
| TeamsBrowser | Manual scaffold + checklist | No (browser required) |
| OutlookBrowser | Manual scaffold + checklist | No (browser required) |

## Recommended Test Framework

Use **Vitest** — it's ESM-native, compatible with the project's TypeScript setup, and requires minimal config.

```json
// package.json additions
{
  "devDependencies": {
    "vitest": "^2.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-8-1 | Configure Vitest, add `npm test` script | 🔲 TODO |
| EP-8-2 | Unit tests: `AIAnalyzer` — mock Anthropic SDK, verify tool use + result mapping | 🔲 TODO |
| EP-8-3 | Unit tests: `JiraConnector.fetchMessages` — mock fetch, verify `UnifiedMessage` mapping | 🔲 TODO |
| EP-8-4 | Unit tests: `upsertMessage` deduplication — in-memory SQLite | 🔲 TODO |
| EP-8-5 | Unit tests: MCP tool formatters (search_messages, get_action_items) | 🔲 TODO |
| EP-8-6 | Integration test scaffold: `TeamsBrowserConnector` manual test checklist | 🔲 TODO |
| EP-8-7 | Integration test scaffold: `OutlookBrowserConnector` manual test checklist | 🔲 TODO |

---

## Agent Prompt

:::tip Start This Epic
EP-0 must be done. For EP-8-3 through EP-8-5, the relevant epic (EP-4, EP-7) must also be done.
Start with EP-8-1 through EP-8-2 which only need EP-0.
:::

```
You are implementing EP-8: Testing for the Work Intelligence MCP project.


CONTEXT:
The project has no test suite yet. Your job is to add Vitest and write unit tests for
the components with pure logic. Do not write E2E tests for browser connectors — write
manual test scaffolds instead (documented test cases, not automated).

YOUR SCOPE: src/tests/** (new directory). Also modify package.json to add vitest.
Do NOT modify any source files in src/ (except package.json additions).

READ FIRST:
- src/services/analyzer.ts — understand all 4 methods to know what to test
- src/connectors/jira.ts — understand fetchMessages() to know what to mock
- src/db/queries.ts — understand upsertMessage() for dedup test
- src/tools/search-messages.ts — understand formatter for output test
- package.json — current dependencies and scripts

WHAT TO BUILD:

1. Configure Vitest:
   - Add "vitest": "^2.0.0" to devDependencies in package.json
   - Add "test": "vitest run", "test:watch": "vitest" to scripts
   - Create vitest.config.ts if needed for ESM/TypeScript

2. src/tests/analyzer.test.ts:
   - Mock @anthropic-ai/sdk — verify tool use is called with correct schema
   - Verify result is parsed from tool_use block (not regex)
   - Test each of the 4 methods

3. src/tests/jira.test.ts:
   - Mock global fetch — verify correct Jira API URL and auth header
   - Verify UnifiedMessage.source = MessageSource.Jira
   - Verify source_id = issue key

4. src/tests/queries.test.ts:
   - Use in-memory SQLite (new Database(':memory:'))
   - Apply migrations, then test upsertMessage()
   - Same (source, source_id) twice → only one row

5. src/tests/formatters.test.ts:
   - Stub DB query results
   - Verify search_messages output contains expected fields

ACCEPTANCE CRITERIA:
- npm test passes with zero failures
- npm run typecheck passes
- No test files modify src/ source files
```
