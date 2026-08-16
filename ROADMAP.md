# ROADMAP

Future goals for Work Intelligence MCP. Everything here is **planned, not done** — for what
already ships and how it was measured, see [`ACHIEVEMENTS.md`](ACHIEVEMENTS.md).

## v1.0 public release

- [ ] **Owner polish:** fill in the `<owner>` placeholders (README badges, CI workflow, repo URL).
- [ ] **Live demo assets:** run `npm run demo:trace` once with a real API key so
      `docs/static/demo-loop.gif` and the annotated trace page stop being placeholders;
      publish the held-out gold-label evaluation results alongside it.
- [ ] **CI on GitHub Actions:** leak-scan gate (`bash scripts/leak-scan.sh`), typecheck,
      vitest run, and the fast bridge smoke on every PR.
- [ ] **Release packaging:** tag + changelog cadence; document MCP install for Claude
      Desktop / Cursor from the packaged artifact.

## Product depth

- [ ] **Connector hardening:** browser-profile connectors (Outlook / Teams / Jira-UI) are the
      most fragile surface — add health checks and self-diagnosing failure messages.
- [ ] **Embeddings fallback ladder:** Ollama → local ONNX → stub, so recall degrades
      gracefully on machines with no model runtime.
- [ ] **Multi-repo code graph:** widen the non-TypeScript code-graph coverage so recall can
      answer "where does this live" across every repo in `wi.config.json`.
- [ ] **Privacy report:** one command that shows exactly what the bridge has written
      (`data.db`, MemPalace) — "show me everything you know about me".

## Engineering hygiene

- [ ] **Migration ledger dashboard:** a page listing v45→v108 with applied-at timestamps per
      install, so schema state is never a mystery.
- [ ] **Flaky-surface quarantine:** a tagged test tier for browser-dependent paths so CI
      green always means the *structural* suite, not the flaky one.
- [ ] **Docs site parity:** every page in `docs/docs/` cross-linked from `README.md`,
      `GETTING-STARTED.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`.

## Non-goals (deliberate)

- No cloud sync, no multi-operator mode, no hosted service — the design contract is one
  operator, one laptop, data that never leaves it.
- No LLM-as-judge anywhere: any self-grading must stay mechanical (see `outcomes.ts`).