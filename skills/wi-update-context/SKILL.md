---
name: wi-update-context
description: "Flush a Claude Code session into Work Intelligence — code edits, ticket investigations, AND pure-discussion / decision-capture sessions. Auto-detects scope (WI-own-source vs customer-repo vs topic-only). APPENDS to Jira ticket investigation notes (never overwrites). Writes to all 4 memory surfaces: WI bridge (bug capture / Jira notes / code-graph reindex / brain learn / profile observe), claude-mem session observations, MemPalace drawers, AND the user's auto-memory dir at ~/.claude/projects/<project>/memory/ (bugs_resolved.md / decision_*.md / feedback_*.md / project_*.md + MEMORY.md index pointer). Use when the user says 'update wi context', 'sync wi', 'save this to wi', 'save this discussion', 'remember this', 'update memory', or after any non-trivial Claude Code session."
trigger_phrases:
  - "flush this session to WI"
  - "update WI context"
  - "save this discussion"
  - "record decisions to WI"
argument-hint: "[--ticket <KEY>] [--dry-run] [--force-reindex] [--scope wi|customer|topic|auto] [--decision <id>] [--topic <slug>] [--memory-only] [--auto-memory <type>]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
  - Edit
---

<objective>
Take everything that happened in this Claude Code session — investigation findings, code edits, decisions, recall hits, OR a pure design / planning discussion — and persist it across **four memory surfaces** so the work is recoverable from any future session via any of the surfaces:

1. **WI bridge** (`~/.work-intelligence-mcp/data.db`) — bug capture, Jira ticket notes, code-graph reindex, brain decision outcomes, profile observations.
2. **claude-mem** (~/.claude/projects/<project>/sessions/*.jsonl) — per-session observations searchable via `mcp-search.search()`.
3. **MemPalace** — semantic vector + KG drawer in the appropriate wing (`decisions`, `topics`, `meetings`, or new explicit drawer for the session summary).
4. **Auto-memory** (`~/.claude/projects/<project>/memory/`) — durable cross-session facts: `MEMORY.md` index + `bugs_resolved.md` / `decision_*.md` / `feedback_*.md` / `project_*.md` topic files, in the format the user already uses by hand.

Claude Code uses `claude-mem` for cross-session memory, but **WI's own database is a separate store**, AND **MemPalace is a third store**, AND **auto-memory is a fourth store the user reads at session start**. Without this skill, work done via Claude Code is invisible to one or more of:
- `wi_brain_context` (brain decision history)
- `wi_palace_query` (MemPalace KG)
- `GET /api/persona` (rolling profile)
- `GET /api/jira/analysis/<KEY>` (per-ticket findings — the canonical reference point on a customer ticket)
- The `/bugs` page investigation tab
- The morning brief / digest summaries
- **Future Claude Code sessions** — without the auto-memory write, the next session has no recall of decisions / corrections made this turn (the system-reminder context is bounded; only `MEMORY.md` lines survive long-term)

**The four surfaces serve four distinct read paths** and each one matters:

| Surface | Read by | Latency to first read | Without this write |
|---|---|---|---|
| WI bridge SQL | wi_* MCP tools, web UI, morning brief | seconds | `wi_brain_context` returns stale answers |
| claude-mem | `mcp-search.search()`, semantic recall in this session and next | seconds | "did we already solve this?" returns nothing |
| MemPalace | `wi_palace_query` natural-language KG | seconds | KG misses the relationship; `tripleCount` stays at 0 |
| Auto-memory | Loaded at next session start as system-reminder | next session | Recurring corrections / decisions repeat indefinitely |

**The Jira ticket is the authoritative reference point** for customer-repo work — by **appending** structured, dated investigation entries to `jira_analysis.notes`, never overwriting prior work.

**The auto-memory dir is the authoritative reference point for cross-session feedback** — corrections like "always include MEMORY.md index entry when a new memory file lands" only survive if they're written there.

Arguments: "$ARGUMENTS"
- `--ticket <KEY>`: pin findings to a Jira ticket (e.g. JIRA-15257). Required when scope=customer and not auto-detected.
- `--dry-run`: print what would be sent to each surface without POSTing or writing.
- `--force-reindex`: also POST `/api/code-graph/index` (skip the heuristic).
- `--scope wi|customer|topic|auto`: override scope detection. Default `auto`.
- `--decision <id>`: brain decision_id to record an outcome for (`/api/brain/learn`).
- `--topic <slug>`: explicit topic slug for topic-only mode (e.g. `adr-032-design`). Forces scope=topic.
- `--memory-only`: skip ticket/bug/code-graph surfaces; write ONLY to claude-mem + palace + auto-memory.
- `--auto-memory <type>`: explicit auto-memory write — `bug` / `decision` / `feedback` / `project` / `reference`. Skips the heuristic that decides whether the session warrants an auto-memory write.
</objective>

<the-key-distinction>

**Read this before doing anything.** WI tracks **three different kinds of work**, and the data goes to different places. Misrouting will pollute the wrong table and confuse future investigators.

| Origin of work | Files live under | Bug capture | Jira ticket notes | Code-graph reindex | claude-mem | MemPalace | Auto-memory |
|---|---|---|---|---|---|---|---|
| **WI itself** | `src/**`, `web/src/**`, `web-server.js`, `scripts/**`, `docs/**`, `.planning/**`, root config files | ✅ `POST /api/bugs/report` (Phase A capture) | ⚠️ ONLY when the WI change is **anchored to a customer ticket**. Tag as `[WI-side change]`. Otherwise WI's own work lives in `.planning/`. | ❌ N/A | ✅ session observation | ✅ `decisions` wing if a brain decision_id exists | ✅ on non-trivial scope (decision / bug-fix / feedback / project update) |
| **Customer repos** | `repos/<your-repo>/**` or `repos/<your-second-repo>/**` | ❌ NEVER (Phase 77 territory; not yet shipped) | ✅ **PUT /api/jira/analysis/<KEY>/notes (APPEND)** | ✅ `POST /api/code-graph/index` for the touched repo | ✅ session observation | ✅ `decisions` wing if applicable | ✅ on non-trivial scope |
| **Topic-only** (no code edited, no ticket — just discussion / design / decision-making) | n/a — conversation only | ❌ N/A | ❌ N/A unless `--ticket` passed | ❌ N/A | ✅ session observation | ✅ `topics` drawer (new entry per session) | ✅ on non-trivial discussion (default: write `feedback` or `project` based on classifier) |

**Profile observations and brain learning are scope-agnostic** — they describe what _the user_ did, not what _was changed_.

**Rules baked in (each enforced before the POST/Write fires):**
1. NEVER post a customer-repo file path to `/api/bugs/report`. Reject and tell the user.
2. NEVER **overwrite** existing `jira_analysis.notes` — always read-first, then append a new section.
3. NEVER reindex `repos/*` if no files under that path were actually touched.
4. NEVER invent a customer Jira ticket. If `--scope=customer` but `--ticket` is missing AND no ticket key was found in the recent commits or conversation → ask, don't guess.
5. NEVER write a "WI-side change" entry to a customer ticket unless the user passes `--ticket` explicitly or the ticket key is unambiguous in the commits.
6. **NEVER overwrite an existing auto-memory file.** Read first; if present, decide append vs new-file (see auto-memory rules below). Use `Edit` for surgical line-level updates, never `Write` on existing files.
7. **ALWAYS update `MEMORY.md` index when a new auto-memory file is created.** Per the user's hard rule (`feedback_no_orphaned_components.md` style): a new memory file with no index pointer is invisible.
8. **DEDUP claude-mem and palace writes by content hash.** A session re-run shouldn't double-log. Hash the session summary; skip if hash already exists.

</the-key-distinction>

<scope-detection>

The `auto` scope inspector runs before any other step. It classifies the session as `wi`, `customer`, `topic`, or `mixed`. **The classifier inspects FIVE channels, not just `git status`** — because a session can have customer-ticket relevance even when no `repos/*` files were edited *this turn* (e.g. uncommitted screenshots, recent customer commits without Jira-notes attached, conversation references to ticket keys).

#### Channel 1: Edited paths (`git status`)

- Any path under `repos/<your-repo>/**` or `repos/<your-second-repo>/**` → record as customer.
- Any path under `src/**`, `web/src/**`, `web-server.js`, `scripts/**`, `docs/**`, `.planning/**`, `skills/**`, root config (`package.json`, `tsconfig*`, `pnpm-workspace.yaml`) → record as wi-own.

#### Channel 2: Filename pattern matching for ticket keys (untracked + tracked)

Regex `(JIRA|PROJ|TICKET|OPS)-[0-9]{2,6}` against ALL filenames returned by `git status --short` (modified AND untracked). Each unique match is a candidate ticket — typical sources are PR verification screenshots like `JIRA-15702-AFTER-pr4055-dev-factsheet.png`. Each detected ticket triggers customer-scope behaviour for that ticket, even if no `repos/*` file is in `git status`.

#### Channel 3: Recent customer-repo commits without Jira-notes coverage

For each customer repo (`repos/<your-repo>`, `repos/<your-second-repo>`):

```bash
# Find commits in the last 3 days
git -C repos/<your-repo> log --since='3 days ago' --pretty='%H %s' \
  | grep -oE '(BDS|RM|TURBO|OPS)-[0-9]{2,6}' \
  | sort -u
```

For each recovered ticket key, check whether `/api/jira/analysis/<KEY>/notes` already contains a `## Session ` block dated after the latest matching commit. If NOT, queue an append-Jira-notes for that ticket — this catches the "shipped code 2 days ago, never wrote it back to WI" case.

#### Channel 4: Conversation references

Scan the conversation transcript (the last ~50 messages, accessible via the agent's own context) for:
- Explicit ticket key mentions: regex `(BDS|RM|TURBO|OPS)-[0-9]{2,6}`.
- Auto-memory recalls of ticket-specific files: `[[project_bds15702_*]]`, `[[project_bds16155_*]]` style.
- Direct references to customer-repo paths in user messages: `"in <repo-name>"`, `"the <second-repo> repo"`, `repos/<your-repo>/...`.

Each matched ticket joins the customer-scope candidate list. **Conversation-only matches need confirmation** — a single mention isn't the same as actual work; the skill prompts the user to confirm before queueing a Jira-notes append for a ticket sourced ONLY from chat.

#### Channel 5: Explicit user override

`--ticket <KEY>` adds a ticket regardless of detection. `--scope customer|wi|topic` forces the classification.

#### Final classification (after all 5 channels)

```
ticket_candidates = union(channel-1 keys, channel-2 keys, channel-3 keys, channel-4 keys, channel-5 keys)
wi_paths_touched  = (channel-1 found wi-own paths)
customer_paths    = (channel-1 found repos/*)

Final scope:
  - len(ticket_candidates) > 0 AND len(wi_paths_touched) > 0  → mixed
  - len(ticket_candidates) > 0 AND len(customer_paths) > 0    → customer (one-or-more)
  - len(ticket_candidates) > 0 AND no path edits              → customer (recovered from artifacts/commits/chat)
  - wi_paths_touched only                                      → wi
  - no edits, no tickets, substantial conversation             → topic
```

**Mixed scope is the common case** for sessions that fix WI bugs while debugging a customer-repo investigation. The skill writes to BOTH the WI bug queue AND the customer Jira ticket notes, with the Jira-notes block tagged `[WI-side change in support of JIRA-XXXXX]` so the customer ticket reflects the support work.

#### Topic-mode triggers (independent of scope)

These can fire alongside any scope:

- The user said "save this discussion" / "remember this" / "save to memory" / "update memory" in the last 3 messages.
- `--topic <slug>` or `--memory-only` was passed.
- File edits are trivial (only docs / config bumps) AND conversation has substantive design content.

When the trigger fires:
- The scope value is unchanged (mixed/customer/wi).
- An ADDITIONAL palace `topics`-wing drawer is written for the discussion summary, in addition to whatever else fires.
- Auto-memory `decision`/`feedback`/`project` types fire more aggressively (lower thresholds).

</scope-detection>

<intelligent-classifier-detail>

This block addresses three specific reasons earlier dry-runs felt under-intelligent.

#### Why `/api/brain/learn` should NOT just "skip when no --decision id"

The original v2 design only fired `learn` when the user passed `--decision <id>`. That's wrong because most sessions don't carry a decision_id explicitly — but they DO often produce outcomes for decisions the brain made earlier (today, or recently).

**Auto-discover behaviour:**

```sql
SELECT id, decision, rationale, confidence, created_at
FROM brain_decisions
WHERE user = ?               -- Maaz
  AND day_iso = ?             -- today UTC
  AND outcome = 'pending'     -- still open
ORDER BY created_at DESC
LIMIT 10;
```

For each pending decision, compute cosine similarity between the decision's `decision + rationale` and the session's summary. If exactly one decision has similarity > 0.78, attach the outcome (`success` / `failed` / `partial` / `abandoned`) inferred from the session and call `/api/brain/learn`.

If multiple match above threshold, surface the candidates to the user and ask which one (no auto-fire on ambiguity).

If none match, log "no pending decision matched this session's topic" and skip — same as today.

This converts the "skipped" outcome into a useful default that closes the brain learning loop without explicit user opt-in.

#### Why `/api/bugs/report` should distinguish three bug types

The current classifier treats all bug-shaped events as candidates for `/api/bugs/report`. That's wrong. There are three distinct categories:

| Category | Examples | Where it should land |
|---|---|---|
| **WI runtime bug** — caught by `window.onerror` / agent try-catch / bridge stderr in actual user-facing surface | A `/bugs` page crash, a sync agent throwing, a brain decide call returning 500 | `POST /api/bugs/report` (ADR-030 Phase A capture). Auto-fires. |
| **WI code-level mistake found and fixed mid-session** | The ZodDefault converter bug (June 2): valid Zod input crashed `tools/list`. We diagnosed + fixed in the same session. | `POST /api/bugs/report` AND `auto-memory bug_*.md`. Both — the bug existed, it's worth a runtime-bug log AND a future-Maaz cross-session lesson. |
| **Dev-environment / build / config issue** | better-sqlite3 ABI mismatch on Node v26 upgrade. gyp build fails. pnpm config moved homes between minor versions. | **Auto-memory only** (`bug_*.md` with `metadata.type: reference`). NOT `/api/bugs/report` — it's not a runtime bug a WI user would hit, it's an env note for future-Maaz. |

**Classifier heuristic (called from step 4e):**

```bash
# Was the error caught at WI runtime by an existing capture surface?
HAS_RUNTIME_TRACE=$( ... |  grep -qE "window\.onerror|onError|bridge stderr|agent .* threw|HTTP 5\d\d" && echo 1 )
# Is the fix in src/** / web/src/** / web-server.js?
FIX_IN_WI_SOURCE=$( ... | grep -qE "^[AM] (src/|web/src/|web-server\.js)" && echo 1 )
# Is the symptom in dev tooling — node, pnpm, gyp, npm rebuild, NODE_MODULE_VERSION?
IS_ENV_ISSUE=$( ... | grep -qE "NODE_MODULE_VERSION|node-gyp|pnpm.*rebuild|engines.*node|prebuild-install" && echo 1 )

if [ "$IS_ENV_ISSUE" = "1" ]; then
  # Env issue → auto-memory only (type=reference or bug, but not /api/bugs/report)
  WRITE_AUTO_MEMORY_BUG=1
  WRITE_BRIDGE_BUG=0
elif [ "$HAS_RUNTIME_TRACE" = "1" ] && [ "$FIX_IN_WI_SOURCE" = "1" ]; then
  # Both runtime + fix in source → both surfaces
  WRITE_BRIDGE_BUG=1
  WRITE_AUTO_MEMORY_BUG=1
elif [ "$HAS_RUNTIME_TRACE" = "1" ]; then
  # Runtime caught but no fix yet (open bug) → bridge only
  WRITE_BRIDGE_BUG=1
  WRITE_AUTO_MEMORY_BUG=0
else
  # No runtime evidence and no env issue → probably a feature/refactor → neither
  WRITE_BRIDGE_BUG=0
  WRITE_AUTO_MEMORY_BUG=0
fi
```

This is the discrimination the original classifier was missing.

#### Why scope detection needs all 5 channels

The original detector only used Channel 1 (`git status`). That misses:

- A session that **completes** customer work — diagnoses the bug, ships the fix, records the screenshot — but has all `repos/*` edits already committed (so `git status` is clean for those paths).
- A session whose customer relevance is **conveyed only through artifacts** (PR verification screenshots, commit references, chat mentions).
- A session where the user's authoring intent is to **write up a Jira-notes block for a ticket they just finished**, even though the code is upstream-merged — the WI Jira analysis panel still needs the session-history entry.

In all three cases, Channel 1 alone returns "wi" scope and Jira notes are wrongly skipped. Channels 2–5 are what make the classifier *intelligent* about session intent vs raw file location.

</intelligent-classifier-detail>


<auto-memory-rules>


**The format the user uses by hand** — match it exactly. Each file has frontmatter + body:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference | bug | decision
---

<the fact body. Link related memories with [[their-name]] liberally. For
feedback/project, follow with **Why:** and **How to apply:** lines.>
```

`MEMORY.md` is the index. Each line: `- [Title](file.md) — hook` (one line per memory, no frontmatter, never put memory content there).

**When to write each type:**

| Type | Trigger | Filename pattern | Body shape |
|---|---|---|---|
| `bug` | Session resolved a tricky / non-obvious bug. Root cause was non-obvious; future-Maaz might hit it again. | `bug_<topic>_<facet>.md` (e.g. `bug_mcp_zoddefault_fix.md`) | Symptom + root cause + fix + verification. Cross-link to related project files via `[[name]]`. |
| `decision` | A non-obvious architectural / implementation choice was made; the *why* matters more than the *what*. | `decision_<topic>.md` | Decision + rationale + alternatives rejected. |
| `feedback` | User gave guidance on how Claude Code should work — corrections OR confirmed approaches. **Always** include `**Why:**` and `**How to apply:**` lines. | `feedback_<topic>.md` | What the rule is + why + how to apply it next time. |
| `project` | Ongoing work / goals / constraints not derivable from the code or git history. Convert relative dates to absolute. | `project_<topic>.md` | State + context + open threads. |
| `reference` | Pointers to external resources (URLs, dashboards, tickets). | `reference_<topic>.md` | Links + context. |
| `user` | Who the user is (role, expertise, preferences). Rare — probably only update existing `user_preferences.md`. | `user_<facet>.md` | Profile fact. |

**When NOT to write to auto-memory:**
- The fact is already in `MEMORY.md` (search the index first via grep before writing).
- The fact is already in CLAUDE.md, the project README, an ADR, or git history (reference instead of duplicating).
- The fact is task-scoped and only matters in this conversation.
- The session was purely UI tweaks / doc edits / mechanical refactors with no learnings.

**The MEMORY.md index update rule:** if a new file landed in the auto-memory dir, append a one-line pointer to MEMORY.md *in the same flush*. The pattern is:

```
- [Title](file.md) — short hook describing what's in the file (one sentence)
```

Insert near related entries, not blindly at the end. Use `Edit` (insert one line); never rewrite the whole file.

**Wikilink discipline:** link liberally with `[[name]]`. A `[[name]]` that doesn't yet match an existing memory is fine — it marks something worth writing later.

</auto-memory-rules>



<the-jira-notes-format>

**This is the canonical format the skill writes to `jira_analysis.notes`.** Every Claude Code session that touches a ticket appends ONE block in this exact shape. The format is:

- **Self-contained per session** — no continuation marks; each block is independently readable.
- **Machine re-parseable** — fixed section headers in a fixed order. Future Claude Code sessions can scan the existing notes and grep for `## Session ` to find prior work.
- **Plain-text-readable** — renders fine in the Notes tab textarea even though Markdown isn't auto-formatted there. The structure is visible from the headers.
- **Dated and signed** — every block carries a UTC ISO-8601 timestamp + the host that did the work, so the user can tell sessions apart.

```markdown
## Session 2026-06-01T13:21Z — Claude Code (host: maaz-mac)

**Scope:** customer / <repo-name>
**Files touched:**
  - repos/your-repo-name/src/auth/login.ts (+12 -3)
  - repos/your-repo-name/src/auth/session.ts (+5 -1)
  - repos/your-repo-name/tests/auth.spec.ts (+18 -0)
**Commits:** abc123de (your-repo-name), def4567 (your-repo-name)

**Root cause:**
The session-migration helper was reading from a stale cookie domain
after the  IDS upgrade. <one paragraph max>

**Evidence:**
- Commit history on src/auth/session.ts shows the cookie-domain change
  landed in <repo-name> 4 days ago (`a1b2c3d`)
- Repro: hitting /login with an old IDS cookie → 401 loop
- Existing test in tests/auth.spec.ts didn't cover the new domain branch

**Decision:**
Patch the session-migration helper to detect both legacy and new
cookie domains for one release; remove the legacy branch in v2.4.0.

**Proposed fix / change shipped:**
1. session.ts: parse both cookie domains
2. login.ts: prefer new domain, fall back to legacy
3. auth.spec.ts: add coverage for both branches
4. Tests passing locally; PR draft pending.

**Status:** investigation-complete / fix-staged / fix-shipped / pending-review
**Confidence:** 0.85
**Next steps (if any):** Open PR, request review from <person>, monitor
   feat-test for 24h after merge.

**Cross-references:**
- WI bug fingerprint: <if any>
- Brain decision_id: <if any>
- Related tickets: <if any>
- Prior session notes in this ticket: yes (see Session 2026-05-20T09:14Z)
```

**The skill must:**
1. Read `loadJiraAnalysis(db, issueKey)` first to fetch existing `notes`
2. **Reject and warn** if existing notes look corrupted (e.g. start with "Tool result observed:" — known prior pollution from misuse)
3. Compose the new block in the exact format above
4. PUT the **concatenation** of existing notes + `\n\n---\n\n` separator + new block
5. Verify by GET-ing the analysis row again and confirming the new block landed at the end

**The skill must NEVER:**
- Overwrite a ticket's notes with just the new block (would erase prior investigation)
- Truncate the notes if they get long (the column is `TEXT`, no length limit; let it grow)
- Re-format prior blocks (leave them exactly as they were written, even if poorly)

</the-jira-notes-format>

<preconditions>
1. Bridge probe (bail if not reachable):
   ```bash
   curl -fsS -m 2 http://localhost:3132/api/status >/dev/null 2>&1 \
     && echo "bridge: ready" || echo "bridge: NOT reachable"
   ```
   Not reachable → tell user to run `npm run web:bridge` and stop. Do NOT run the POSTs.

2. CWD must be the WI repo. Check via `[ -f web-server.js ] && [ -d .planning ]`.

3. `jq` must be available (used to safely build JSON bodies). Most macOS dev setups have it; if missing, fail early with `brew install jq`.
</preconditions>

<process>

### 1. Detect scope (no user prompt yet)

```bash
# What changed across the last 5 commits + working tree?
ALL=$(
  (git -C . diff --name-only HEAD~5..HEAD 2>/dev/null;
   git -C . status --short 2>/dev/null | awk '{print $2}') \
  | sort -u
)

# Bucket the changes
WI_FILES=$(echo "$ALL" | grep -vE '^repos/(your-repo-name|your-second-repo-name)/' | grep -vE '^$')
example-service_FILES=$(echo "$ALL" | grep -E '^repos/your-repo-name/' | grep -vE '^$')
OPERATIONS_FILES=$(echo "$ALL" | grep -E '^repos/your-second-repo-name/' | grep -vE '^$')

# Tickets in recent commits + conversation (most-recent-first)
TICKETS=$(git -C . log --oneline -10 | grep -oE '(BDS|RM|TURBO|OPS|ADR|EP)-[0-9]+' | head -5)
```

Decide scope:
- Both WI and customer files changed → `scope=mixed`
- Only customer files → `scope=customer`, repo = whichever bucket is non-empty
- Only WI files → `scope=wi`
- Neither → `scope=meta` (only profile observations fire)

If `--scope` was passed, override the detection.

Also scan the **current conversation** for:
- Investigation conclusions ("root cause is X", "the bug is in file Y", "evidence: …")
- Decisions ("we'll go with approach A because B")
- Recall hits — moments where prior knowledge from MEMORY.md / claude-mem affected the answer
- Bug-capture signals ("error: TypeError ...", "the bridge crashed at ...")

### 2. For each customer ticket: read existing notes FIRST

This is the most important step. Before composing the new block, fetch what's already there:

```bash
for K in $TICKETS; do
  EXISTING=$(curl -fsS "http://localhost:3132/api/jira/analysis/${K}" | jq -r '.notes // ""')
  EXISTING_LEN=${#EXISTING}

  # Detect known pollution patterns from prior misuse
  if echo "$EXISTING" | head -1 | grep -q '^Tool result observed:'; then
    echo "⚠️ ${K}: existing notes start with 'Tool result observed:' — known pollution from prior misuse."
    echo "   Will append a new clean section but NOT touch the polluted content (user can clean up manually)."
  fi

  # Detect prior Claude Code sessions
  PRIOR_SESSIONS=$(echo "$EXISTING" | grep -c '^## Session ' || echo 0)
  echo "   Prior Claude Code sessions on this ticket: $PRIOR_SESSIONS"
done
```

### 3. Plan what to write — show user before any POST

Render a plan summary surfacing the scope distinction AND the per-ticket history:

```markdown
## WI Context Update Plan

**Detected scope:** customer (<repo-name>)
**Customer Jira ticket:** JIRA-15257
**Files touched:**
  - WI source: 0 files
  - your-repo-name:  3 files (src/auth/login.ts, src/auth/session.ts, tests/auth.spec.ts)
  - your-second-repo-name: 0 files

**Existing investigation history on JIRA-15257:**
  - 2 prior Claude Code sessions in `jira_analysis.notes`
    (most recent: 2026-05-20T09:14Z — "stale cookie domain hypothesis")
  - AI analysis: status=done, has solution + code_impact

I'll fire these surfaces:

### ✅ Customer ticket notes — APPEND (PUT /api/jira/analysis/JIRA-15257/notes)
   New block: "Session 2026-06-01T13:21Z — Claude Code (host: maaz-mac)"
   Sections: Scope, Files touched, Commits, Root cause, Evidence, Decision,
             Proposed fix, Status, Confidence, Next steps, Cross-references
   **Will be appended after the 2 existing sessions, with --- separator.**

### ✅ Profile observations (POST /api/profile/observe)
   - kind=jira_open  payload={key: 'JIRA-15257', action: 'investigated'}
   - kind=code_edit  payload={bucket: '<repo-name>', files: [3], ticket: 'JIRA-15257'}
   - kind=session_end payload={summary, tickets, files_changed}

### ✅ Code-graph reindex (POST /api/code-graph/index repo=<repo-name>)

### ⊘ /api/bugs/report — SKIPPED (customer-repo work, not WI-own-source)

### ⊘ Brain learning — SKIPPED (no decision_id passed; use --decision <id> to fire)

Proceed? [y / n / pick subset]
```

For a WI-source case (no customer ticket):

```markdown
## WI Context Update Plan

**Detected scope:** wi (work-intelligence-mcp itself)
**Files touched:**
  - WI source: 4 files (src/db/migrations/v56_bug_resolver.ts, ...)
  - customer:  0 files
**Customer ticket anchor:** none

I'll fire these surfaces:

### ✅ Bug capture (POST /api/bugs/report) — only if a real bug was confirmed and fixed
   source='agent', errorName='<class>', message='<one-line>'

### ✅ Profile observations (POST /api/profile/observe)
   - kind=code_edit, kind=session_end

### ⊘ /api/jira/analysis/<KEY>/notes — SKIPPED (no customer ticket; WI roadmap is .planning/)

### ⊘ Code-graph reindex — SKIPPED (WI itself is not in the code-graph index)

Proceed? [y / n / pick subset]
```

If `--dry-run`, stop here and dump the bodies that WOULD be POSTed.

### 4. Execute the flush

#### 4a. Customer ticket notes — APPEND, never overwrite

This is the heaviest, most important surface. Flow per ticket:

```bash
TICKET="JIRA-15257"
NOW=$(date -u +%Y-%m-%dT%H:%MZ)
HOST=$(hostname -s)

# 4a.1 — fetch existing notes
EXISTING=$(curl -fsS "http://localhost:3132/api/jira/analysis/${TICKET}" \
  | jq -r '.notes // ""')

# 4a.2 — compose the new block (synthesize from conversation)
NEW_BLOCK=$(cat <<EOF
## Session ${NOW} — Claude Code (host: ${HOST})

**Scope:** customer / <repo-name>
**Files touched:**
$(echo "$example-service_FILES $OPERATIONS_FILES" | tr ' ' '\n' | grep -v '^$' | sed 's/^/  - /')
**Commits:**
$(git -C . log --oneline -5 | sed 's/^/  - /')

**Root cause:**
<synthesized from the conversation; one paragraph max>

**Evidence:**
- <key signal 1>
- <key signal 2>

**Decision:**
<what was decided this session, if anything>

**Proposed fix / change shipped:**
<numbered steps or summary; mark whether shipped or pending>

**Status:** <investigation-complete | fix-staged | fix-shipped | pending-review>
**Confidence:** <0..1>
**Next steps:** <only if non-trivial; else 'none'>

**Cross-references:**
- WI bug fingerprint: <if any, else 'none'>
- Brain decision_id: <if any, else 'none'>
- Related tickets: <comma-list, else 'none'>
- Prior session notes in this ticket: <yes/no — set based on grep '^## Session '>
EOF
)

# 4a.3 — concatenate: existing + separator + new block
if [ -z "$EXISTING" ]; then
  COMBINED="$NEW_BLOCK"
else
  COMBINED="${EXISTING}

---

${NEW_BLOCK}"
fi

# 4a.4 — PUT the combined notes (jq -n so newlines and quotes can't break the JSON)
curl -fsS -X PUT "http://localhost:3132/api/jira/analysis/${TICKET}/notes" \
  -H "Content-Type: application/json" \
  --data "$(jq -n --arg n "$COMBINED" '{notes: $n}')" \
  >/dev/null \
  || { echo "FAILED: jira-notes for ${TICKET}"; continue; }

# 4a.5 — verify by re-reading and grep-checking the new timestamp landed
VERIFIED=$(curl -fsS "http://localhost:3132/api/jira/analysis/${TICKET}" \
  | jq -r '.notes // ""' \
  | grep -c "^## Session ${NOW}")
[ "$VERIFIED" -ge 1 ] && echo "✅ ${TICKET} notes appended (now ${#COMBINED} chars total)" \
                     || echo "⚠️ ${TICKET} verify failed — block not visible in re-fetched notes"
```

**For WI-side changes anchored to a customer ticket** (rare — passed via `--ticket` even though scope=wi), the block uses scope `WI-side change` and the Files-touched list cites WI paths. The format is identical except the header line:

```markdown
## Session 2026-06-01T13:21Z — Claude Code (host: maaz-mac) [WI-side change]
```

This makes it scannable in the ticket history that the change was on the WI side, not the customer's.

#### 4b. Profile observations — every scope

```bash
# code_edit: one observation per repo bucket
for bucket in wi your-repo-name your-second-repo-name; do
  case $bucket in
    wi)         FILES_FOR_BUCKET="$WI_FILES" ;;
    your-repo-name)   FILES_FOR_BUCKET="$example-service_FILES" ;;
    your-second-repo-name) FILES_FOR_BUCKET="$OPERATIONS_FILES" ;;
  esac
  [ -z "$FILES_FOR_BUCKET" ] && continue

  curl -fsS -X POST http://localhost:3132/api/profile/observe \
    -H "Content-Type: application/json" \
    --data "$(jq -n \
      --arg b "$bucket" \
      --arg t "${TICKET:-}" \
      --argjson fs "$(echo "$FILES_FOR_BUCKET" | jq -R . | jq -s .)" \
      '{kind:"code_edit", source:"claude-code",
        payload:{bucket:$b, files:$fs, ticket:$t, reason:"investigation"}}')" \
    >/dev/null || echo "FAILED: code_edit observe ($bucket)"
done

# jira_open: one per ticket discussed
for K in $TICKETS; do
  curl -fsS -X POST http://localhost:3132/api/profile/observe \
    -H "Content-Type: application/json" \
    --data "$(jq -n --arg k "$K" \
      '{kind:"jira_open", source:"claude-code",
        payload:{key:$k, action:"investigated", via:"claude-code-cli"}}')" \
    >/dev/null || echo "FAILED: jira_open observe ($K)"
done

# session_end: one summary
curl -fsS -X POST http://localhost:3132/api/profile/observe \
  -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg sum "$SESSION_SUMMARY" \
    --arg sc "$SCOPE" \
    --argjson tks "$(echo "$TICKETS" | jq -R . | jq -s .)" \
    '{kind:"session_end", source:"claude-code",
      payload:{summary:$sum, tickets:$tks, scope:$sc, outcome:"flushed-to-wi"}}')" \
  >/dev/null || echo "FAILED: session_end observe"
```

Valid `kind` values (anything else 400s): `tool_call`, `jira_open`, `message_sent`, `code_edit`, `session_start`, `session_end`, `feedback_positive`, `feedback_negative`, `recall_hit`, `recall_miss`, `other`.

#### 4c. Brain learning — only when --decision <id> passed

Do NOT invent a `brain_decisions.id`. Fire only when explicit:

```bash
[ -n "$DECISION_ID" ] && curl -fsS -X POST http://localhost:3132/api/brain/learn \
  -H "Content-Type: application/json" \
  --data "$(jq -n --arg id "$DECISION_ID" --arg o "$DECISION_OUTCOME" \
    '{decision_id:$id, outcome:$o}')" \
  >/dev/null || echo "(brain/learn skipped — no --decision id)"
```

Valid outcomes (from `VALID_OUTCOMES`): `applied`, `reverted`, `partial`, `ignored`, `superseded`.

#### 4d. Code-graph reindex — only customer files changed

```bash
[ -n "$example-service_FILES" ] && curl -fsS -X POST http://localhost:3132/api/code-graph/index \
  -H "Content-Type: application/json" -d '{"repo":"your-repo-name"}' \
  >/dev/null || echo "FAILED: reindex your-repo-name"

[ -n "$OPERATIONS_FILES" ] && curl -fsS -X POST http://localhost:3132/api/code-graph/index \
  -H "Content-Type: application/json" -d '{"repo":"your-second-repo-name"}' \
  >/dev/null || echo "FAILED: reindex your-second-repo-name"
```

#### 4e. WI bug capture — only when scope ∈ {wi, mixed} AND a real bug was fixed

Skip when investigation-only or feature work. Only fire on confirmed WI-source bug fix:

```bash
curl -fsS -X POST http://localhost:3132/api/bugs/report \
  -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg src "$BUG_SOURCE"   `# 'agent'/'bridge'/'web-ui'/'sync' — derive from where the bug lived` \
    --arg en  "$ERROR_NAME"   \
    --arg msg "$ERROR_MSG"    \
    --arg trc "$STACK_OR_EMPTY" \
    --arg tk  "${TICKET:-}"   \
    '{source:$src, errorName:$en, message:$msg, stack:$trc,
      context:{resolved_by:"claude-code", ticket:$tk, files_touched:'$WI_FILE_COUNT'}}')" \
  >/dev/null || echo "FAILED: bugs/report"
```

If `scope=customer`, this entire block is skipped — customer bugs are NOT WI bugs.

#### 4f. claude-mem session observation — every scope, dedup by content hash

This is what makes the session retrievable from `mcp-search.search()` and the next session's system-reminder timeline. Every flush writes ONE observation describing the session in human-readable form — not a transcript dump, a summary.

```bash
# Compose the session summary (single paragraph + structured tail)
SESSION_SUMMARY=$(cat <<EOF
${SCOPE^^} session: ${SESSION_HEADLINE}

Files touched: ${WI_FILE_COUNT} WI / ${example-service_FILE_COUNT} <repo-name> / ${OPS_FILE_COUNT} <second-repo-name>
Commits: $(git -C . log --oneline -5 | head -3 | tr '\n' '; ')
${TICKET:+Ticket: $TICKET}
${DECISION_ID:+Decision: $DECISION_ID}

Outcome: ${OUTCOME_ONE_LINER}
EOF
)

# Hash for dedup — skip if this exact observation already exists in this session's claude-mem
HASH=$(echo -n "$SESSION_SUMMARY" | shasum -a 256 | cut -c1-16)

# claude-mem doesn't have a direct REST API; the canonical write path is via the
# claude-mem MCP tool surface. The skill writes a marker file the claude-mem
# observer picks up, OR uses the mcp__plugin_claude-mem_mcp-search__build_corpus
# pattern. Here we use the marker-file approach (durable, no MCP roundtrip):
mkdir -p "$MARK_DIR"
MARK_FILE="$MARK_DIR/wi-update-context-${HASH}.md"

if [ ! -f "$MARK_FILE" ]; then
  cat > "$MARK_FILE" <<EOF
---
type: session_summary
scope: ${SCOPE}
ticket: ${TICKET:-}
decision_id: ${DECISION_ID:-}
created_at: ${NOW}
content_hash: ${HASH}
---

${SESSION_SUMMARY}
EOF
else
  echo "claude-mem: skipping (already logged this session — hash $HASH)"
fi
```

**Why a marker-file approach:** the claude-mem observer agent runs in the background and ingests `~/.claude/projects/.../observations/*.md` files into its session JSONL. The skill never needs to hit a live API — drop the file, walk away, claude-mem picks it up on its next sweep. Idempotent (hash-keyed filenames), survives bridge/observer restarts.

#### 4g. MemPalace direct drawer write — semantic memory anchor

claude-mem and the brain's `record_outcome` already write to palace transitively, but only for specific shapes (decisions wing, conversations wing). For a session that produced a substantive *topic* — an architectural conclusion, a persona insight, a research finding — write an explicit drawer to the `topics` wing so `wi_palace_query` finds it semantically.

Skip when scope=customer (the Jira note IS the canonical record) AND no decision_id was passed AND no `--topic` slug was given. Topic-mode and decision-recorded sessions always write.

```bash
# Only fire if there's substance worth a palace anchor
if [ "$SCOPE" = "topic" ] || [ -n "$DECISION_ID" ] || [ -n "$TOPIC_SLUG" ] || [ "$NON_TRIVIAL" = "1" ]; then
  TOPIC_NAME="${TOPIC_SLUG:-$(echo "$SESSION_HEADLINE" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | head -c 60)}"

  # Use the brain's /api/brain/learn endpoint with a 'palace_drawer' verb.
  # If the bridge doesn't support that verb yet, fall back to writing through
  # the existing record_outcome path (which writes the 'decisions' wing) by
  # passing decision_id; otherwise hit /api/palace/drawer directly.

  # Probe for endpoint support (cheap; cached)
  if curl -fsS -X OPTIONS "http://localhost:3132/api/palace/drawer" 2>/dev/null | grep -q "POST"; then
    curl -fsS -X POST http://localhost:3132/api/palace/drawer \
      -H "Content-Type: application/json" \
      --data "$(jq -n \
        --arg wing "topics" \
        --arg name "$TOPIC_NAME" \
        --arg body "$SESSION_SUMMARY" \
        --arg label "wi-update-context-${NOW}" \
        '{wing:$wing, room:$name, content:$body, label:$label}')" \
      >/dev/null || echo "FAILED: palace/drawer (continuing)"
  else
    # Fallback path — palace drawer write embedded in a no-op decision
    echo "palace: /api/palace/drawer not available; relying on claude-mem observer for palace propagation"
  fi
fi
```

**Why opt-in not always-on:** every code-edit session would otherwise create a palace `topics` drawer, and most code edits are not topics — they're work-in-progress. The classifier is conservative: write when the session resembles an explicit decision, finished investigation, or design discussion.

#### 4h. Auto-memory writes — the durable cross-session surface

This is the surface most often forgotten and most often valuable. Future sessions read `~/.claude/projects/<project>/memory/MEMORY.md` at startup; if a fact didn't land here, the next session has no recall.

**The classifier (decides what to write):**

```bash
# Classify this session's auto-memory output. Multiple types may fire.
# Each type has its own gating heuristic.

WRITE_BUG=0
WRITE_DECISION=0
WRITE_FEEDBACK=0
WRITE_PROJECT=0

# Bug — only when a non-obvious WI bug was fixed AND the root cause is worth remembering
if [ "$SCOPE" != "customer" ] && [ -n "$BUG_FIXED" ] && [ "$BUG_NON_OBVIOUS" = "1" ]; then
  WRITE_BUG=1
fi

# Decision — fired when:
#   - --decision <id> was passed (always write the rationale)
#   - OR the session synthesized a non-obvious architectural choice
#     (heuristic: conversation contains "decision:" / "we'll go with" / "decided to" / etc.
#      AND the choice has an alternative that was rejected)
if [ -n "$DECISION_ID" ] || grep -qE "(decided to|we'll go with|decision:|chose .+ over)" "$CONV_LOG"; then
  WRITE_DECISION=1
fi

# Feedback — fired when the user gave a correction or a confirmed approach.
# Heuristics: imperative-mood "always" / "never" / "don't" / "make sure" / "remember to"
# from the user, OR explicit "save this as feedback".
if grep -qE "^User: (always|never|don't|do not|make sure|remember to|from now on|in the future)" "$CONV_LOG" \
   || grep -qE "save (this )?(as )?feedback|remember (this|that)" "$CONV_LOG"; then
  WRITE_FEEDBACK=1
fi

# Project — fired when substantive ongoing-work context was built (ADR, roadmap,
# multi-day investigation, phase plan). Heuristic: ADR/PLAN/SPEC files
# touched OR session > 30 minutes with sustained discussion of a named project.
if echo "$EDITED_FILES" | grep -qE "\.planning/.*PLAN\.md|\.planning/.*SPEC\.md|adr-[0-9]+.*\.md" \
   || [ "$LONG_FOCUSED_SESSION" = "1" ]; then
  WRITE_PROJECT=1
fi

# --auto-memory <type> overrides the classifier
case "$AUTO_MEMORY_OVERRIDE" in
  bug)      WRITE_BUG=1; WRITE_DECISION=0; WRITE_FEEDBACK=0; WRITE_PROJECT=0 ;;
  decision) WRITE_BUG=0; WRITE_DECISION=1; WRITE_FEEDBACK=0; WRITE_PROJECT=0 ;;
  feedback) WRITE_BUG=0; WRITE_DECISION=0; WRITE_FEEDBACK=1; WRITE_PROJECT=0 ;;
  project)  WRITE_BUG=0; WRITE_DECISION=0; WRITE_FEEDBACK=0; WRITE_PROJECT=1 ;;
esac
```

**The write paths (each one is read-first, append/edit, never overwrite):**

```bash
INDEX="$MEM_DIR/MEMORY.md"
NEW_INDEX_LINES=()

# 4h.1 — Bug resolution
if [ "$WRITE_BUG" = "1" ]; then
  SLUG="bug_${TOPIC_SLUG:-$(slugify "$BUG_TITLE")}"
  FILE="$MEM_DIR/${SLUG}.md"
  if [ -f "$FILE" ]; then
    echo "auto-memory: $SLUG already exists; appending an addendum"
    # Use Edit tool from Claude Code, not bash sed, to preserve atomicity.
    # Append a new "## Update YYYY-MM-DD" section to the existing file.
    APPEND_BUG_FILE  # placeholder — see <implementation-notes>
  else
    cat > "$FILE" <<EOF
---
name: ${SLUG}
description: ${BUG_DESC_ONE_LINE}
metadata:
  type: bug
---

**Symptom:** ${BUG_SYMPTOM}

**Root cause:** ${BUG_ROOT_CAUSE}

**Fix:** ${BUG_FIX}. Files: ${BUG_FIX_FILES}.

**Verification:** ${BUG_VERIFICATION}.

**Why it's worth saving:** ${BUG_WHY_REMEMBER}.

**Related:** ${BUG_RELATED_LINKS}.
EOF
    NEW_INDEX_LINES+=("- [${BUG_TITLE}](${SLUG}.md) — ${BUG_INDEX_HOOK}")
  fi
fi

# 4h.2 — Decision (similar shape, type=decision in frontmatter)
# 4h.3 — Feedback (similar shape, type=feedback, body INCLUDES **Why:** and **How to apply:**)
# 4h.4 — Project (similar shape, type=project, body covers state + open threads)

# 4h.5 — MEMORY.md index update — ALWAYS when a new file landed
if [ ${#NEW_INDEX_LINES[@]} -gt 0 ]; then
  for line in "${NEW_INDEX_LINES[@]}"; do
    # Use Edit tool: insert near a related entry, not blindly at the end.
    # The find-related-entry heuristic uses the description text from the new
    # frontmatter to match against existing index lines, then inserts after
    # the closest match. Falls back to end-of-file if no match.
    APPEND_INDEX_LINE  # placeholder — see <implementation-notes>
  done
fi
```

**Anti-rules (always check before writing):**

1. Search `MEMORY.md` first via `grep -F "${SLUG}"` — if the slug exists, do NOT create a new file. Either append to the existing file or skip.
2. Search the body content via `grep -ri "$KEY_PHRASE" "$MEM_DIR"` — if the same lesson is already documented under a different filename, skip with a log line ("auto-memory: similar entry already at ...; skipped").
3. NEVER write a file with `metadata.type: user` unless the user explicitly opted in (e.g. `--auto-memory user`). The user-preferences file is hand-curated; auto-edits would be intrusive.
4. NEVER write a `bug` entry for a customer-repo bug — those go to the Jira ticket notes (4a), not the WI memory dir.
5. **Wikilink every related memory.** If the new entry mentions a project / decision / bug already in MEMORY.md, link it as `[[name]]`. Use the `name:` field from the related file's frontmatter (NOT the filename — the slug minus extension is usually the same but not guaranteed).

### 5. Verify + report

After all surfaces fire, fetch a tight verification:

```bash
# Re-pull the ticket analysis so we can show the user that the new block actually landed
for K in $TICKETS; do
  echo "─── ${K} ─────────────────────────────────────"
  curl -fsS "http://localhost:3132/api/jira/analysis/${K}" \
    | jq -r '.notes // ""' \
    | grep '^## Session ' \
    | tail -3   # last 3 sessions, including the one we just appended
done

# Persona should now reflect today's observations
curl -fsS http://localhost:3132/api/persona | head -c 1000 \
  | jq -r '.systemPrompt // ""' | grep -E 'kind=|recent' | head -5

# claude-mem observation marker landed?
  && echo "  ✅ observation marker on disk (claude-mem will ingest on next sweep)"

# Auto-memory file landed AND index updated?
[ "$WROTE_AUTO_MEMORY" = "1" ] && {
  echo "─── auto-memory ─────────────────────────────"
  ls -la "$MEM_DIR" | tail -3
  grep -F "${NEW_FILE_BASENAME}" "$INDEX" \
    && echo "  ✅ MEMORY.md index points at ${NEW_FILE_BASENAME}" \
    || echo "  ❌ MEMORY.md index update missing — re-run with --auto-memory"
}
```

Render a final summary covering ALL surfaces:

```markdown
## ✅ WI Context Updated  (scope=customer, ticket=JIRA-15257)

| Surface              | Result |
|----------------------|--------|
| Customer Jira notes  | ✅ APPENDED to JIRA-15257 (3 sessions total now, 4,820 chars) |
| Profile observations | ✅ 5 inserted (code_edit×1 <repo-name>, jira_open×1, session_end×1) |
| Brain learning       | ⊘ skipped (no --decision id) |
| Code-graph reindex   | ✅ kicked off for <repo-name> (background) |
| WI bug capture       | ⊘ skipped (customer-repo work, not WI-own-source) |
| claude-mem observation | ✅ marker dropped (hash 4f8a2b1c…); observer will ingest |
| MemPalace drawer     | ✅ topics/jira-15257-search-fix written |
| Auto-memory          | ✅ NEW project_jira15257_search_fix.md + MEMORY.md index updated |

**Reference points now visible in the WI Jira UI:**
- Open the WI Jira analysis panel for JIRA-15257 → Notes tab
- The new "Session 2026-06-01T13:21Z" block sits at the bottom
- All prior sessions remain unchanged

**Reference points now visible to FUTURE Claude Code sessions:**
- `MEMORY.md` index loads automatically at next session start
- `mcp-search.search("JIRA-15257")` will return the marker once ingested
- `wi_palace_query("search proxy fix")` will return the topics drawer

Quick checks:
  curl http://localhost:3132/api/jira/analysis/JIRA-15257 | jq -r .notes
  curl http://localhost:3132/api/persona | head -c 1000

Browser: http://localhost:5175/jira-report → click JIRA-15257 → Notes tab
```

If any surface failed, list it with the suspected cause:

```markdown
⚠️ /api/profile/observe returned 503 schema_not_ready — migration v51 may
   not have applied. Bounce the bridge to re-trigger startup migrations.

⚠️ Notes verify on JIRA-15257 reported 0 matches for new timestamp —
   PUT may have succeeded but read-after-write is lagging. Re-check in
   2s with: curl http://localhost:3132/api/jira/analysis/JIRA-15257

⚠️ Auto-memory file written but MEMORY.md index not updated — the new
   memory will be invisible to next session. Re-run the skill with
   --auto-memory <type> to retry the index append, or manually add:
     - [Title](file.md) — hook
   to MEMORY.md.

⚠️ /api/palace/drawer returned 404 — endpoint not yet implemented in
   the bridge. Falling back to claude-mem only; palace propagation will
   happen via the observer's drawer-write side effect (slower).
```

</process>

<failure-modes>

| Symptom | Likely cause | First action |
|---|---|---|
| `bridge: NOT reachable` on probe | Bridge not running or crashed at boot | `npm run web:bridge` in another terminal; check `tail -30 /tmp/bridge*.log` |
| `503 schema_not_ready` from /api/profile/observe | `user_profile_observations` table missing (v51) | Bounce the bridge — startup migrations re-run on connection open |
| `400 invalid_kind` from /api/profile/observe | Skill emitted a `kind` outside the enum | Re-check against the valid list above; only the 11 enum values are accepted |
| Existing notes start with "Tool result observed:" | Known pollution from prior misuse | Append the new clean block but DO NOT clean up the polluted prior content (could be valuable history despite format) — surface it to the user |
| PUT /api/jira/analysis/<K>/notes 200 OK but verify grep returns 0 | Read-after-write lag (rare) | Wait 2s, re-fetch; if still missing, the PUT silently no-op'd (very unusual) |
| `400 invalid_outcome` from /api/brain/learn | Outcome string outside the allowed set | Use one of: applied, reverted, partial, ignored, superseded |
| `409` from /api/code-graph/index | Reindex already in flight | Don't retry — the running job will pick up the latest commit anyway |
| Customer ticket key looks fake (e.g. `XYZ-1`) | Skill heuristic over-matched | Reject before POSTing; ticket keys must match `^(BDS|RM|TURBO|OPS|ADR|EP)-\d{2,6}$` |
| Notes column getting very long (> 100KB) | Many sessions accumulated | Don't truncate. SQLite TEXT has no practical limit. If render performance matters, that's a UI concern; surface it but don't act |
| Auto-memory file written but no MEMORY.md update | Skill's index-append step skipped or failed | Re-run with `--auto-memory <type>` matching the file's `metadata.type`; or manually edit MEMORY.md to add a one-line pointer |
| Auto-memory: existing slug found, new content differs | Skill is about to clobber a manually-edited memory file | NEVER overwrite. Append a `## Update YYYY-MM-DD` section to the existing file, OR create a sibling `<slug>_v2.md` and update the index pointer |
| claude-mem marker file accumulates without ingestion | Observer agent not running | Check `~/.claude/projects/.../observations/` count; if growing beyond ~50 stale files, the claude-mem observer process needs a restart |
| `/api/palace/drawer` returns 404 | Endpoint not yet implemented (Phase 78+ territory) | Skip the explicit drawer write; rely on claude-mem observer to drive palace propagation indirectly. Log the skip but don't fail the flush |
| Auto-memory dir doesn't exist | Fresh machine; user hasn't started persisting memory yet | `mkdir -p $MEM_DIR` and create a starter `MEMORY.md` with `# Memory Index` header. Then proceed with the writes |
| Multiple auto-memory types fire for one session (bug + decision + project) | Classifier matched all three; that's fine | Write all three; each gets its own file + index pointer. Cross-link them via `[[name]]` so the wiki-graph stays connected |

</failure-modes>

<implementation-notes>

- **The Jira notes APPEND is the most important guarantee.** All other surfaces are append-only by construction (profile observe is INSERT, bugs.report is UPSERT-by-fingerprint, code-graph is idempotent). Only `jira_analysis.notes` is a full-replace PUT — and overwriting it would erase prior investigation history. The skill MUST: read existing → concatenate with separator → PUT combined → verify with re-fetch.

- **The `## Session <ISO-Z>` header is a contract.** Future Claude Code sessions can grep for that exact prefix to enumerate prior work on a ticket. Don't change the format without bumping a version marker.

- **Read-mostly until step 4.** Steps 1–3 only run git, fetch existing notes, and inspect the conversation. The user-confirmation prompt at the end of step 3 is the gate.

- **No string-concatenation into JSON.** Every body uses `jq -n --arg` / `--argjson`.

- **Auto-memory writes use Claude Code's `Write` and `Edit` tools, not bash heredoc.** Bash `cat > file` is fine for *new* files. For appending to existing memory files or updating `MEMORY.md`, use `Edit` so the harness tracks the file as read+written and concurrent edits don't lose data. The placeholder `APPEND_BUG_FILE` / `APPEND_INDEX_LINE` in step 4h means: invoke the `Edit` tool with the right anchor string, don't shell out.

- **MEMORY.md insertion is not "append at end" — it's "insert near related entries".** The heuristic: read MEMORY.md, find the line whose description text has highest cosine similarity to the new entry's hook (or simplest: highest token overlap), insert after that line. Falls back to end-of-file if no related entry has > 30% overlap.

- **Don't call /api/sync/all.** That's `wi-sync`'s job — pulling external sources. This skill flushes in-conversation work.

- **Customer ticket key formats commonly seen here:** `JIRA-`, `PROJ-`, sometimes `TICKET-`/`OPS-`, occasionally `ADR-`/`EP-` for internal references. Reject anything that doesn't look like a real ticket.

- **Idempotent on all surfaces:**
  - `/api/bugs/report` UPSERTs by fingerprint → re-firing is safe
  - `/api/profile/observe` is append-only → re-firing creates dups (rolling-window aggregator handles it)
  - `/api/jira/analysis/<K>/notes` — **the SKILL makes it idempotent** by using the unique ISO-8601 timestamp in the section header (running the skill twice in the same minute would write the same header twice, which is a benign but visible duplicate; running it twice in different minutes is fine)
  - `/api/code-graph/index` returns 409 if already running → don't retry
  - `/api/brain/learn` last-write-wins on (decision_id, outcome) → safe to re-fire
  - **claude-mem marker files** — keyed by content hash; re-running a same-content session produces the same filename and is a no-op
  - **MemPalace drawers** — `addDrawer(wing, room, content)` is idempotent on `(wing, room)`; the skill picks a stable room name from `--topic <slug>` or derived headline so re-runs overwrite cleanly
  - **Auto-memory writes** — keyed by slug; the skill SEARCHES MEMORY.md for the slug before writing. If found, it appends an `## Update YYYY-MM-DD` section instead of creating a duplicate file

- **Topic-mode is for the discussion-only case, not a parallel pipeline.** When `--topic` fires, steps 4a–4e all skip (their preconditions aren't met) and only 4f/4g/4h fire. The skill is one pipeline with conditional surfaces, not two separate code paths.

</implementation-notes>

