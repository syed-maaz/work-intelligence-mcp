---
sidebar_position: 20
title: Good first issues
description: Concrete starter tasks sized for a first contribution
---

# Good first issues

Every task below is self-contained, names the exact file(s) to touch, and most
follow the **ConnectorAdapter pattern** (`src/fetcher/sources/adapter.ts`) — the
cleanest seam in the codebase. Pick one, open an issue, and send a PR.

## 1. Add a new connector adapter (e.g. Asana or Notion)

- **File:** `src/fetcher/sources/adapter.ts` (+ `src/services/connector-registry.ts`, `capabilities.json`)
- **Pattern:** implement `ConnectorAdapter` (`name`, `displayName`, `modes`, `capabilities`, `requiredEnv`, `dataIngested`, `buildSourceSpecs`) and append it to `ADAPTERS`. `buildSourceSpecs` must **delegate** to a spec builder — never re-implement fetching.
- **Verify:** `tests/connectors/registry.test.ts` enforces that adapter capabilities match `capabilities.json`. Run `npm run typecheck` + `npm run smoke:fetcher`.

## 2. Add a recall lane

- **File:** `src/services/embedder.ts` or `src/services/analyzer.ts`
- **Pattern:** each recall lane is a bounded, timeout-guarded pipeline (see the lane in `embedder.ts:281`). Add one for a new content type (e.g. bookmarks or PDFs) — wire it into the same orchestration as existing lanes.
- **Verify:** `npm run smoke:bridge` (exercises recall lanes end-to-end) + a unit test asserting the lane times out instead of hanging.

## 3. Add a UI panel

- **File:** `web/src/pages/` (new page, e.g. `ConnectorsPage.tsx`) + `web/src/components/`
- **Pattern:** follow an existing page (e.g. `SystemHealthPage.tsx`): page → `web/src/store/ui.ts` slice → typed API call to the HTTP bridge.
- **Verify:** `npm run smoke:ui` (Playwright) + screenshot in the PR.

## 4. Document a config layer

- **File:** `docs/docs/getting-started/configuration.md`
- **Pattern:** config resolves in three layers — defaults → `.env` → MCP client env. Add a worked example (e.g. pointing `DATABASE_PATH` at a team-shared dropbox folder) with a before/after config snippet.
- **Verify:** `npm run docs:start` renders it; paste a screenshot of the rendered page.

## 5. Extend smoke coverage for one connector

- **File:** `scripts/smoke-fetcher.sh`
- **Pattern:** the fetcher smoke boots the connector registry and runs each adapter against fixture data. Add a fixture + assertions for the connector you understand best (start with `linearAdapter` — no browser required).
- **Verify:** `bash scripts/smoke-fetcher.sh` passes; count of checks goes up.

## 6. Surface connector health in the UI

- **File:** `web/src/pages/SystemHealthPage.tsx` + bridge route in `src/routes/`
- **Pattern:** each `ConnectorAdapter` declares `requiredEnv` — add a route that reports which env vars are set per connector and render a green/amber row per connector.
- **Verify:** run `npm run demo`, open the health page, screenshot the connector rows.

## 7. Strengthen the leak-scan

- **File:** `scripts/leak-scan.sh` + `scripts/leak-patterns.txt`
- **Pattern:** the scanner is regex-file-driven with a path allowlist (`scripts/leak-allow.txt`). Add a pattern for a class of accidental leaks (e.g. `file://` paths) and a test file that must trigger it.
- **Verify:** `bash scripts/leak-scan.sh` stays `LEAK SCAN CLEAN`.

## 8. Turn an ADR into a cookbook recipe

- **File:** `docs/docs/development/` (new recipe page)
- **Pattern:** ADRs in `docs/docs/adr/` capture *why*; recipes capture *how*. Pick one operational ADR (e.g. the config-layers decision) and write a 10-step recipe with exact commands.
- **Verify:** link it from `docs/docs/development/index.md`; run the commands top-to-bottom on a fresh clone.

## Good first PR checklist

- [ ] Open an issue referencing the task number above before coding
- [ ] `bash scripts/leak-scan.sh` → `LEAK SCAN CLEAN` (mandatory — public repo)
- [ ] `npm run typecheck` passes
- [ ] Mention the file + pattern you followed in the PR description (see `.github/PULL_REQUEST_TEMPLATE.md`)