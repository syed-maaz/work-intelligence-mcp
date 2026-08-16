# Contributing to Work Intelligence MCP

Thanks for contributing. This is a **public repository** — everything you write
ships. No real person names, no employer domains, no internal ticket IDs
(see the leak-scan rule below).

## Setup + demo

```bash
npm run setup        # install deps, write .env, validate config
npm run demo         # offline demo: seeded data + one recall lane
npm run web:bridge   # HTTP bridge on :3132
npm run web:dev      # web UI on :5175
```

## Add a connector in 3 steps

Connectors are self-describing **`ConnectorAdapter`** objects
(`src/fetcher/sources/adapter.ts`). The registry dispatches purely off the
`ADAPTERS` array — no switch statements, ever.

1. **Write the spec builder** in `src/services/connector-registry.ts` (or wrap an
   existing source). Return `SourceSpec[]`; do not implement fetching here.
2. **Declare the adapter** in `src/fetcher/sources/adapter.ts`: implement the
   `ConnectorAdapter` interface (`name`, `displayName`, `modes`, `capabilities`,
   `requiredEnv`, `dataIngested`, `buildSourceSpecs`) — `buildSourceSpecs` must
   **delegate** to the builder from step 1.
3. **Append it to `ADAPTERS`** and mirror `capabilities`/`modes` in
   `capabilities.json`. `tests/connectors/registry.test.ts` fails if they drift.

## Config layers

Configuration resolves in three layers: defaults → `.env` → MCP client env.
Full reference: [`docs/docs/getting-started/configuration.md`](docs/docs/getting-started/configuration.md).
Add new settings only through `src/services/config.ts` so all three layers stay
consistent (validated by `npm run config:validate`).

## Smoke + tests

```bash
npm run typecheck      # required for every PR
npm run smoke:bridge   # end-to-end bridge smoke (fast)
npm run smoke:ui       # Playwright UI smoke (needs web:dev on :5175)
bash scripts/smoke-fetcher.sh   # connector registry smoke
```

Unit tests live next to the code (`*.test.ts`); the connector manifest-parity
test is `tests/connectors/registry.test.ts`.

## Leak-scan (mandatory)

```bash
bash scripts/leak-scan.sh    # must print LEAK SCAN CLEAN
```

The scanner runs over **all files** with a regex deny-list
(`scripts/leak-patterns.txt`) and a path allowlist (`scripts/leak-allow.txt`).
A PR that fails the leak-scan is rejected. If you genuinely need a term that
triggers it, argue the allowlist change in the PR description.

## PR rules

- Scope: one issue, one PR; say what changed and why in the description.
- Tests: list the commands you ran (see `.github/PULL_REQUEST_TEMPLATE.md`).
- UI changes: include before/after screenshots.
- Commits: `feat(oss):`, `fix:`, `docs:` prefixes; keep each commit self-contained.
- Never merge or push to `main` yourself; request review.