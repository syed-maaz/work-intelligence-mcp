---
name: Pull request
about: Describe the change you are proposing
title: ""
labels: ""
assignees: ""
---

## Scope

- What does this PR change? (one or two sentences)
- Files touched (top 3 if large): e.g. `src/fetcher/sources/adapter.ts`, `web/src/pages/...`

## Tests run

- [ ] `npm run typecheck`
- [ ] `npm run smoke:bridge` (or targeted `scripts/smoke-*.sh`)
- [ ] `npm run smoke:ui` (if UI changed)
- [ ] New/updated unit tests (name them)

## Leak-scan expectation

- [ ] `bash scripts/leak-scan.sh` → `LEAK SCAN CLEAN`
- If it is not clean, list the hits and why each is a false positive / allowed.

## Screenshots (UI changes)

| Before | After |
|---|---|
| (paste or leave blank) | (paste) |

## Checklist

- [ ] No real person names, employer domains, or internal ticket IDs in new files (this is a public repo)
- [ ] README/docs updated if user-facing behavior changed
- [ ] Commit message follows the `feat(oss):` / `fix:` convention