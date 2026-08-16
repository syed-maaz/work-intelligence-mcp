---
name: wi-router
description: "Engage Cypher (WI's senior-engineer agent) with a free-text goal. Cypher runs as an ADR-037 tool-use loop: the model picks tools from the WI catalog (palace recall, code-graph, Jira/Teams/GitHub search, brain decide, etc.), executes them, and returns its answer. The /wi front door for the loop. Prints the model's final surface as the answer."
trigger_phrases:
  - "engage cypher"
  - "free-text goal"
  - "run this via /wi"
  - "cypher please"
  - "use the loop"
argument-hint: "<free text goal — e.g. 'figure out why JIRA-15702 is flaky on dev' or 'review PR #4167'>"
allowed-tools:
  - Bash
---

<objective>
Drive Cypher's ADR-037 tool-use loop for the user's goal: "$ARGUMENTS"

What changed (2026-06-23 evening): `/wi` used to be a "rank-and-suggest" router
that scored candidate `wi-*` skills via Beta priors and asked the user to type
the suggested command themselves (depth-≤-2 invariant). After the Phase 6
cutover landed the loop as the default engine AND `scripts/wi-dispatch-stream.sh`
made the streaming endpoint usable from a one-line shell call, `/wi` now drives
the loop directly. The loop picks tools per-iteration from the catalog,
executes them, and returns its final surface text. There's no "chosen skill"
to type — the loop already did the work.

The depth-≤-2 invariant still holds: this skill never invokes another *slash
command* from inside Claude Code. The loop's tool catalog lives on the bridge,
not in Claude Code's skill registry; tool execution happens inside `runLoop`,
not by Claude Code shelling out. The user sees the answer; if they want
follow-up work that requires a write-class action, that's still a fresh /wi
dispatch (or a direct slash command they type themselves).
</objective>

<process>
1. **Validate input.** If "$ARGUMENTS" is empty, ask the user for a goal in
   one sentence. Do not proceed without one.

2. **Dispatch through the loop.** Call `scripts/wi-dispatch-stream.sh` with
   `--confirm-mode "auto"` — `/wi` is invoked by Claude Code which is a
   non-interactive caller, so we skip Phase 1 confirm waits.

   **CRITICAL — set the Bash tool `timeout` parameter to 240000 (240s) on
   this call.** The Bash tool defaults to a 120s cap; the loop's `--max-time`
   is 180s, so with the default cap the tool SIGTERMs the wrapper at 120s
   (`Exit code 143`) before the loop can finish — every dispatch that takes
   >2 min then has to be re-run in the background. The Bash `timeout` MUST be
   strictly greater than `--max-time` so the loop's own deadline fires first
   and the wrapper returns a clean verdict. Rule: `bash_timeout > --max-time`.

   ```bash
   cd "$(git rev-parse --show-toplevel)" 2>/dev/null || cd ~/Desktop/projects/work-intelligence-mcp
   eval "$(bash scripts/wi-dispatch-stream.sh \
     --goal "$ARGUMENTS" \
     --task-class "dispatch" \
     --confirm-mode "auto" \
     --max-time 180)"
   ```

   (Invoke the Bash tool with `timeout: 240000`. If a goal is expected to be
   long-running, raise both together — e.g. `--max-time 500` + Bash
   `timeout: 560000` — keeping the strict `bash_timeout > --max-time` gap.)

   After eval, these shell variables are set from the wrapper's stdout:
   - `$session_id` — `cyp_…` for the dispatch (use this in the close call)
   - `$verdict` — one of `success | mixed | failed | halted | abandoned | rejected_non_interactive`
   - `$surface` — the model's final assistant text (THE answer)
   - `$iterations` — number of tool calls the loop made
   - `$duration_ms` — wallclock
   - `$engine` — always `loop` post-Phase-6 cutover

   Wrapper exits non-zero on bridge unreachable (2), timeout (3), or
   bad args (4). Exit 5 means the loop asked for interactive confirm —
   shouldn't happen with `--confirm-mode auto` but surface clearly if so.

3. **Render the answer.** Print the surface text + a small footer with
   provenance. Example shape:

   ```
   {{$surface — multi-line, possibly markdown}}

   ─── Cypher session: cyp_… · loop · 3 tool calls · 18.7s · verdict: success
   ```

   If `$verdict` is `failed` or `halted`, prepend a one-line note explaining
   what happened (you can usually infer from the surface text, but if the
   surface is empty say so explicitly).

4. **Stop.** The loop has already run. The answer is on screen. Do NOT
   chain into another slash command — depth-≤-2 invariant from ADR-033 § P0.

5. **Outcome capture is automatic** for the verdict the loop self-reported
   in step 2 — `runLoop` writes a `cypher_outcomes.signal_kind='verdict'`
   row before returning (see loop.ts § persistOutcome). The Beta priors
   for the underlying skill catalog update from those rows.

   To override the loop's self-reported verdict (e.g., the model thought
   it succeeded but the user disagrees), the user can still record a
   different outcome manually:

   ```bash
   curl -fsS -X POST http://localhost:3132/api/wi/dispatch \
     -H 'content-type: application/json' \
     -d "{\"session_id\":\"$session_id\",\"goal\":\"<same>\",\"outcome\":\"failed\",\"task_class\":\"dispatch\"}"
   ```

   This second call hits the non-streaming endpoint (recording the override
   doesn't need streaming; it's a single `recordSkillOutcomes` mutation).
</process>

<hard-rules>
- NEVER invoke another slash command from inside this SKILL.md. The depth-≤-2
  invariant from ADR-033 § Surfaces & dispatch is preserved by this skill
  driving the loop on the bridge side; the loop's tool calls do not chain
  into Claude Code's skill registry.
- NEVER pass `--confirm-mode "interactive"` to the wrapper here. Claude Code
  is non-interactive in the dispatch step; the loop would ask for confirmation
  via an SSE `event: confirm_required` that this skill cannot answer.
- If the wrapper exits non-zero, surface the error CLEARLY (bridge
  unreachable / timeout / etc.) and stop. Do not fall back to the legacy
  `/api/wi/dispatch` pipeline path — the routing change is deliberate; a
  silent fall-back would re-introduce the pre-cutover blindness.
- If `$verdict='halted'` and `$iterations=0`, the bridge may have regressed
  the halt-flag race (see the 2026-06-23 fix in `web-server.js:2687`). Surface
  the suspicion explicitly and stop.
</hard-rules>

<example>
User: `/wi figure out why JIRA-15702 is still flaky on dev`

After the eval block:
- `$session_id="cyp_…"`
- `$verdict="success"`
- `$surface="JIRA-15702 looks like FF_RM_ENABLE_SEARCH_PROXY being false on dev. Three FFs need to be true together: FF_RM_ENABLE_SEARCH_PROXY + FF_RM_SESSION_MANAGEMENT + FF_RM_SESSION_FORMAT_MIGRATION. Verified via palace.recall on the JIRA-15702 investigation thread and code-graph.blast-radius on getTokenMiddleware. Flip the three on the testpage /feature-flags endpoint and re-test."`
- `$iterations="3"`
- `$duration_ms="22340"`

Skill output:

```
JIRA-15702 looks like FF_RM_ENABLE_SEARCH_PROXY being false on dev. Three FFs
need to be true together: FF_RM_ENABLE_SEARCH_PROXY +
FF_RM_SESSION_MANAGEMENT + FF_RM_SESSION_FORMAT_MIGRATION.
Verified via palace.recall on the JIRA-15702 investigation thread and
code-graph.blast-radius on getTokenMiddleware. Flip the three on
the testpage /feature-flags endpoint and re-test.

─── Cypher session: cyp_… · loop · 3 tool calls · 22.3s · verdict: success
```

The user gets the answer directly. If they want to dig further or act on it,
they type the relevant slash command themselves (e.g. `/wi-bis-regression`
to set up a 3-leg matrix on dev) — depth-≤-2 preserved.
</example>
