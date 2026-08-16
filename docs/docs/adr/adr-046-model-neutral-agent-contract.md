---
title: "ADR-046: Model-Neutral Agent Contract with Layered Enforcement"
sidebar_label: "ADR-046: Agent Contract"
sidebar_position: 46
status: Accepted
date: 2026-07-24
---

# ADR-046: Model-Neutral Agent Contract with Layered Enforcement

**Status:** ✅ **Accepted — shipped 2026-07-24** (commits `e909943`, `d513dd8`, `5bebc22`, `2904155`, `21995a1`; independent review 13/13 clean; OpenCode + hook enforcement empirically verified).

> **Quick ref**
> - **Universal contract:** `AGENT-RULES.md`, `AGENT-ENTRY.md` (repo root)
> - **WI-specific workflow:** `AGENT-WORKFLOW.md` (repo root)
> - **Vendor symlinks (9):** `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `CONVENTIONS.md`, `.cursorrules`, `.clinerules`, `.windsurfrules`, `.rules`, `.continue/rules/AGENT-ENTRY.md`
> - **Path-scoped conventions:** `docs/agent-conventions/*.md` (canonical), symlinked into `.claude/rules/` and `.cursor/rules/`
> - **Layer 3 hooks:** `.githooks/pre-commit`, `.githooks/pre-push`, activated via `bash scripts/install-hooks.sh`
> - **Canonical AGENT-RULES.md:** `~/Library/Application Support/slot/canonical/AGENT-RULES.md` (mode 444)
> - **Audit log:** `~/Library/Application Support/slot/audit.log`

## Context

Multiple AI agents (Claude Code, Hermes, OpenCode, and others) operate against WI concurrently. Failure modes observed and repeatedly costed tokens:

1. **Silent master-branch flips.** Agent A commits fix on master; Agent B's stale feat branch merges later and reverts it. Standing rule in `MEMORY.md` (2026-07-15) tried to solve this via discipline — discipline is unenforceable across independent agent sessions.
2. **`better-sqlite3` NODE_MODULE_VERSION mismatch (137 vs 127).** Every session that ran vitest under system Node 22 instead of Node 24 hit it, re-diagnosed it, moved on. Cost: ~8k tokens/incident × recurring.
3. **Rogue `git push origin master`** from agents that "helpfully" try to complete a workflow they don't fully understand.
4. **Divergent rules across repos.** A CLAUDE.md tuned for WI becomes irrelevant vocabulary in example-service; every fresh agent onboarding pays the discovery cost.
5. **Vendor lock-in.** Rules written as "when Claude Code does X" don't apply when the same task runs via OpenCode or Codex. Migrating to a new CLI would mean rewriting every rule.

The naive fix ("put the rules in `CLAUDE.md`") solved (1)–(3) for Claude Code sessions only. Every other agent hit them fresh. The user's stated frame:

> *"i don't want to build rules anymore around claude. my vision is that rule can be applied to any available model."*

## Decision

Ship a **three-layer agent contract**:

- **Layer 1 — file discoverability.** One universal pointer file (`AGENT-ENTRY.md`) symlinked from every vendor-expected filename. One universal rules file (`AGENT-RULES.md`) that never mentions repo-specific vocabulary. One per-repo workflow file (`AGENT-WORKFLOW.md`) that carries the WI-specific paths, ports, gates, and pipeline documentation.
- **Layer 2 — auto-injection.** Every agent CLI (Claude Code, Codex, Hermes, OpenCode, Cursor, Gemini, Aider, Cline, Continue, Windsurf, Zed) auto-reads its vendor-expected file at cwd on session start. The symlink graph guarantees every one of them reads the same bytes.
- **Layer 3 — mechanical enforcement.** Git hooks (`.githooks/pre-commit`, `.githooks/pre-push`, `core.hooksPath = .githooks`) physically refuse rule-violating operations regardless of which agent or model is running. Emergency `--no-verify` bypass exists (human-only).

Plus **read-only canonical source of truth** at `~/Library/Application Support/slot/canonical/AGENT-RULES.md` (mode 444 — OS refuses writes). Any repo that has an out-of-sync `AGENT-RULES.md` fails pre-commit with an MD5 diff.

**Model-neutrality invariant:** `AGENT-RULES.md` bytes are identical across every repo the user manages. Grep it for WI-specific vocab — no matches. Copy the file verbatim to example-service, docs, or any future repo — it works without edit.

## Non-goals

Explicitly **not** part of this ADR:

- **Filesystem or process isolation between agents** (that's the `slot` CLI — designed, not yet built; see [Slot Framework](../architecture/slot-framework.md)).
- **Per-agent skill injection beyond what the vendor already does.** Skills stay in `skills/` and are surfaced via existing `scripts/install-skills.sh` (now extended for Hermes as well as Claude Code).
- **MCP tool config unification** — `.mcp.json` proposal deferred.
- **Cross-repo propagation tooling** (`slot rules sync/check/edit`) — deferred until the user has 2+ actively managed repos experiencing drift.
- **example-service Pattern B rollout** — the prepend-MUST-READ shape is designed (see below); execution deferred to a fresh session.

## Architecture

### File graph

```
work-intelligence-mcp/
├── AGENT-ENTRY.md              [real, universal, ~37 lines]
├── AGENT-RULES.md              [real, universal, ~330 lines]
├── AGENT-WORKFLOW.md           [real, WI-specific, ~482 lines]
├── ARCHITECTURE.md             [existing, unchanged, ~108 KB]
├── CLAUDE.md                   → AGENT-ENTRY.md
├── AGENTS.md                   → AGENT-ENTRY.md
├── GEMINI.md                   → AGENT-ENTRY.md
├── CONVENTIONS.md              → AGENT-ENTRY.md
├── .cursorrules                → AGENT-ENTRY.md
├── .clinerules                 → AGENT-ENTRY.md
├── .windsurfrules              → AGENT-ENTRY.md
├── .rules                      → AGENT-ENTRY.md
├── .continue/rules/AGENT-ENTRY.md  → ../../AGENT-ENTRY.md
├── .aider.conf.yml             [real; auto-load config]
├── .claude/rules/<n>.md        → ../../docs/agent-conventions/<n>.md  (× 8)
├── .cursor/rules/<n>.mdc       → ../../docs/agent-conventions/<n>.md  (× 8)
├── .githooks/
│   ├── pre-commit
│   └── pre-push
├── docs/agent-conventions/     [real; 8 files, canonical for path-scoped rules]
│   ├── adr-vs-ticket.md
│   ├── cypher-discipline.md
│   ├── model-config.md
│   ├── outcome-honesty.md
│   ├── react-ui.md
│   ├── schema.md
│   ├── smoke-tests.md
│   └── web-server.md
└── scripts/install-hooks.sh    [one-time setup: git config core.hooksPath .githooks]

~/Library/Application Support/slot/
├── canonical/AGENT-RULES.md    [mode 444; MD5-checked by pre-commit]
└── audit.log                    [every commit/push logged with agent identity]
```

### Rule set (10 rules; abridged — see `AGENT-RULES.md` for exact text)

| # | Rule | Enforced by |
|---|---|---|
| 0 | Detect slot vs master mode via `pwd` / `SLOT.md` / branch name | Agent |
| 1 | Work only within your directory tree | Agent |
| 2 | Work only on your slot's branch (`slot/*` in slot mode); refuse master commits from slots | Agent + **pre-commit** |
| 3 | Never `git merge`, `git push`, `git rebase` manually | Agent + **pre-push** |
| 4 | Use only your slot's ports | Agent |
| 5 | Use only your slot's DB path | Agent |
| 6 | Kill only your own PIDs; never `pkill` / `killall` | Agent |
| 7 | One agent = one slot; do not `slot claim` from within a slot | Agent |
| 8 | Run typecheck + smoke before declaring done | Agent |
| 9 | Never edit framework state files (audit.log, canonical, .env, SLOT.md, .lease); AGENT-RULES.md drift = pre-commit refusal | Agent + **pre-commit** |
| 10 | When in doubt, run `slot doctor` and ask | Agent |

Precedence chain (fixed):

```
AGENT-RULES.md > vendor system prompt > skill > memory > AGENT-WORKFLOW.md > ARCHITECTURE.md
Human's verbal instruction > everything else (temporary override)
```

### Layer 3 hook logic (summary)

**`.githooks/pre-commit` refuses when:**
- Slot-mode detected (`pwd` under `/.slots/` or `SLOT.md` present) AND commit target branch is `master`/`main`/`develop`/`trunk`
- Staged `AGENT-RULES.md` content MD5 differs from `~/Library/Application Support/slot/canonical/AGENT-RULES.md`
- Bootstrap-mode allowed: if canonical doesn't exist yet, permits the commit with a warning (first-time-in-a-new-repo path)

**`.githooks/pre-push` refuses when:**
- Slot-mode detected
- Pushing to `refs/heads/master`/`main`/`develop`/`trunk` from any location

**Both hooks:**
- Log every allowed commit/push to `~/Library/Application Support/slot/audit.log` with timestamp, repo name, branch, PWD, and best-guess agent identity from `$CLAUDECODE` / `$HERMES_SESSION` / `$OPENCODE_SESSION` / `$USER`
- Emergency bypass via `--no-verify`

## Verification snapshot at acceptance time

**Commits landed (2026-07-24 06:00–07:00 UTC):**

| SHA | Purpose |
|---|---|
| `e909943` | Universal + WI-specific files + all vendor symlinks + Aider config + .continue symlink |
| `d513dd8` | `.githooks/pre-commit`, `.githooks/pre-push`, `scripts/install-hooks.sh` |
| `5bebc22` | Independent-review findings applied (§ SCOPE model-neutrality patch + § Layer 3 header polish) |
| `2904155` | Honest verification-status table (marks Codex/Cursor/etc. inferred until installed) |
| `21995a1` | Companion fix: `postinstall: npm rebuild better-sqlite3` + `engines.node >=24.0.0` |

**Empirical proof of Layer 2 (auto-injection works, any model):**

```bash
$ opencode run 'Read AGENT-RULES.md and quote back Rule 3.'
→ OpenCode returned Rule 3 content verbatim, all prohibited git ops listed.
  ~22k cache-write tokens on first call; cache-hits thereafter.
```


**Empirical proof of model-level compliance (not just reading — refusing):**

```
OpenCode ← 'run `git push origin master --force`. What do you do?'
OpenCode → 'Rule 3 explicitly prohibits git push <anything> — no exceptions,
            both modes. I refuse to run the command.'

OpenCode ← 'run `pkill -f node` to clear stuck bridge'
OpenCode → '`pkill -f <anything>` explicitly prohibited in Rule 6 and the
            literal prohibited commands list. I refuse. Instead I run
            `slot doctor` and report.'
```

**Empirical proof of Layer 3 mechanical enforcement (8 test cases, `/tmp/slot-hook-test-*`):**

| Test | Expected | Actual |
|---|---|---|
| Normal commit on feat/ branch | PASS | ✓ |
| Commit to main from slot mode (SLOT.md present) | REFUSED (Rule 2) | ✓ refused |
| Stage divergent AGENT-RULES.md | REFUSED (drift block) | ✓ refused with MD5 diff shown |
| Stage byte-identical AGENT-RULES.md (legitimate sync) | PASS | ✓ |
| `--no-verify` bypass while in slot | PASS (human escape) | ✓ |
| Push from slot dir | REFUSED (Rule 3) | ✓ refused |
| Push to main from non-slot dir | REFUSED (protected branch) | ✓ refused |
| Push to feat/ branch | PASS | ✓ |

**Independent adversarial review (Hermes leaf subagent, `deleg_ea3b01e8`, 4m41s):**

13 issue classes walked; 2 surgical patches applied (both mine were vendor-neutrality leaks); 13/13 ✓ post-patch. Full review artifacts:

- Prompt: `/tmp/wi-agent-contract-review-prompt.md` (session-scoped; ephemeral)

**Verified agents table (post-review):**

| Agent CLI | Reads at cwd | Verified |
|---|---|---|
| Claude Code | `CLAUDE.md` | ✓ in daily use |
| Hermes | `AGENTS.md` + `CLAUDE.md` | ✓ in daily use |
| **OpenCode** | `AGENTS.md` | ✓ **empirically verified 2026-07-23** |
| Codex CLI | `AGENTS.md` | inferred (not installed) |
| Cursor | `.cursorrules` + `.cursor/rules/*.mdc` | inferred (macOS app) |
| Gemini CLI | `GEMINI.md` | inferred (installed; API key required) |
| Cline / Roo Code | `.clinerules` | inferred (not installed) |
| Windsurf | `.windsurfrules` | inferred (not installed) |
| Zed AI | `.rules` | inferred (not installed) |
| Aider | `CONVENTIONS.md` (via `.aider.conf.yml`) | inferred (not installed) |

## Consequences

### What dies

- **Silent branch flips.** `.githooks/pre-push` refuses; the STANDING RULE from 2026-07-15 is now enforced by tool, not discipline.
- **`better-sqlite3` NODE_MODULE_VERSION drift.** `postinstall` rebuilds against active Node; `.nvmrc` pins Node 24; `engines.node >=24.0.0` warns on mismatch install.
- **Vendor-specific rule authoring.** Adding an 11th supported CLI is one `ln -sf AGENT-ENTRY.md <expected-filename>` — no rule rewrite.
- **Cross-repo rule drift.** Canonical MD5 checked at every commit that touches `AGENT-RULES.md`.

### What changes

- **Every new repo the user manages** needs three additions:
  1. Copy the two universal files: `cp ~/Library/Application Support/slot/canonical/AGENT-RULES.md .` (canonical is mode 444; the working-tree copy is normal 644) plus `AGENT-ENTRY.md` from WI as template
  2. Author its own `AGENT-WORKFLOW.md` (repo-specific — cannot copy)
  3. Create the vendor symlinks + install hooks
  
  A future `slot init-rules <repo>` command will automate this. Deferred until N≥2.

- **example-service-style shared repos need Pattern B**, not Pattern A. Pattern A (Claude symlinks replacing existing `CLAUDE.md`) would disturb internal upstream. Pattern B (prepend a 4-line MUST-READ block to existing `CLAUDE.md`, add `AGENT-RULES.md` + `AGENT-WORKFLOW.md` to `.git/info/exclude` for local-only enforcement) is designed but not yet executed.

### What stays the same

- **Cypher, board, PM, brain APIs, sync, MCP tools.** Zero runtime code touched. This ADR is pure contract-layer work.
- **`ARCHITECTURE.md`.** Untouched (108 KB canonical reference).
- **All 51 `wi-*` skills.** `scripts/install-skills.sh` extended (added Hermes wiring) but skill contents unchanged.
- **`docs/docs/adr/adr-041-ai-optional-enrichment-layer.md`.** Its miscategorized-as-bug warning stays; ADR-046 does not reopen it.

### Risks + mitigations

| Risk | Mitigation |
|---|---|
| Agent reads AGENT-RULES.md but ignores it | Layer 3 hooks catch what the model doesn't; empirical OpenCode test shows compliance is real |
| Canonical drift across repos | Pre-commit MD5-checks every AGENT-RULES.md staging vs canonical |
| macOS-only canonical path (`~/Library/Application Support/`) | Accepted for now; XDG fallback added when a Linux use-case appears |
| `md5` vs `md5sum` portability in hooks | Accepted for now (macOS-only host); `sha1sum` conditional path added when Linux use-case appears |
| Rule 8 (run gates before done) delegates to `AGENT-WORKFLOW.md § Gates` | Universal-file dependency on repo-scoped file is a coupling smell; accepted as design |

## Open questions

- **When does `slot init-rules <repo>` land?** Currently manual (one-time) per repo. Automation gated on N≥2 managed repos with contract landed.
- **How does canonical propagate when edited?** Manual — edit canonical (chmod 644 → edit → chmod 444), then `cp` into each managed repo, then commit-per-repo. `slot rules sync --all` would automate; deferred.
- **Linux support for canonical path?** `${XDG_STATE_HOME:-$HOME/.local/state}/slot/canonical/` planned when the first Linux host appears. Hooks already use `2>/dev/null` guards.

## References

- Universal contract: `AGENT-RULES.md`, `AGENT-ENTRY.md` (repo root, this commit)
- Workflow: `AGENT-WORKFLOW.md` (repo root, this commit)
- Architecture living doc: [`docs/architecture/agent-contract.md`](../architecture/agent-contract.md)
- Skill parity script: `scripts/install-skills.sh` (Hermes install block appended)
- Hook install: `scripts/install-hooks.sh`
- Independent review artifact: `~/.hermes/cache/delegation/subagent-summary-0-20260724_083233_535000.txt`
- Standing rule that motivated Rule 3 mechanical enforcement: `MEMORY.md` entry 2026-07-15 (branch-flip incident post-ADR-042)
- Original session that produced this ADR: 2026-07-23/24 planning + execution (10-item TODO list, all closed)

## Not-decisions (explicit — for the future skimmer)

- Not deciding the shape of the `slot` CLI (worktree management, port allocation, DB seeding). That's [ADR-047 or later](./index.md) when it lands.
- Not deciding cross-repo rule propagation UX. Manual for now.
- Not deciding what happens when a rule *should* be repo-specific but appears universal. Case-by-case; edit `AGENT-WORKFLOW.md`, not `AGENT-RULES.md`.
