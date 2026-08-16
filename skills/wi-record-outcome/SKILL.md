---
name: wi-record-outcome
description: "Close a pending Cypher session with an outcome verdict. After running a skill that /wi suggested, run this with the session_id and the verdict (success | mixed | failed) so Cypher's Beta priors update. Without this, Cypher's session stays 'pending' and the prior never moves — the agent never learns from your real usage."
trigger_phrases:
  - "record cypher outcome"
  - "close a cypher session"
  - "verdict for this dispatch"
  - "the /wi suggestion worked"
  - "mark this as failed"
argument-hint: "<session_id> <success|mixed|failed> [--ac AC-1,AC-2,...] [optional note]"
allowed-tools:
  - Bash
---

<objective>
Close the Cypher session "$ARGUMENTS" by recording its outcome. Updates the
Beta(α, β) prior for the chosen skill so the agent learns from your real
usage.

Argument shape: `<session_id> <verdict> [--ac AC-1,AC-2,...] [note...]`
- session_id: e.g. `cyp_57c442a10012` — the value /wi printed at session open
- verdict: one of `success`, `mixed`, `failed`
- `--ac AC-1,AC-2`: PM-4 — comma-separated work_item ids to link as
  evidence (kind='cypher_session_id'). Each id must already exist in
  work_items (seed it first via the PM seeder if not). Posts to
  /api/cypher/pm/link.
- note (optional): free-text explanation that goes into the cypher_sessions
  outcome_note column. Useful when verdict is `mixed` or `failed`.
</objective>

<process>
1. **Parse the arguments.** Split "$ARGUMENTS" on whitespace. Pull out
   session_id (first token), verdict (second token), optional `--ac
   <csv>` pair, and the rest as note. If session_id or verdict is
   missing, print the usage line and stop. Validate verdict ∈
   {success, mixed, failed}; reject anything else.

   ```bash
   SESSION_ID="$(echo "$ARGUMENTS" | awk '{print $1}')"
   VERDICT="$(echo "$ARGUMENTS" | awk '{print $2}')"
   REST="$(echo "$ARGUMENTS" | cut -d' ' -f3-)"

   # Pull --ac AC-1,AC-2 out of REST (PM-4). Whatever remains is the note.
   AC_LIST=""
   if echo "$REST" | grep -qE '(^|[[:space:]])--ac[[:space:]]+'; then
     AC_LIST="$(echo "$REST" | sed -nE 's/.*(^|[[:space:]])--ac[[:space:]]+([^[:space:]]+).*/\2/p')"
     # Strip the --ac <csv> token pair from the note.
     REST="$(echo "$REST" | sed -E 's/(^|[[:space:]])--ac[[:space:]]+[^[:space:]]+//')"
   fi
   NOTE="$(echo "$REST" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

   if [ -z "$SESSION_ID" ] || [ -z "$VERDICT" ]; then
     echo "usage: /wi-record-outcome <session_id> <success|mixed|failed> [--ac AC-1,AC-2] [note]"
     exit 0
   fi
   case "$VERDICT" in
     success|mixed|failed) ;;
     *) echo "error: verdict must be one of: success, mixed, failed"; exit 0 ;;
   esac
   ```

2. **Look up the session's goal + task_class + candidates.**
   `wi_dispatch` is keyed on session_id, but it expects the same shape
   that opened the session (goal, task_class, candidate_skills) so the
   continuation re-runs the contract. Fetch them from the SQLite row:

   ```bash
   META=$(node --import tsx/esm -e "
   import { getDatabase } from '$REPO_ROOT/src/db/connection.js';
   const db = getDatabase();
   const r = db.prepare('SELECT goal, task_class, chosen_skill FROM cypher_sessions WHERE session_id=?').get('$SESSION_ID');
   if (!r) { console.error('NOT_FOUND'); process.exit(2); }
   console.log(JSON.stringify(r));
   " 2>&1)

   if [ "$META" = "NOT_FOUND" ]; then
     echo "error: session $SESSION_ID not found in cypher_sessions"
     exit 0
   fi
   ```

   `$REPO_ROOT` is the work-intelligence-mcp repo path — defaults to
   skill is part of WI so the path is stable.

3. **Close the session via /api/wi/dispatch.** Pass session_id + outcome
   + the looked-up goal and task_class. Pass the chosen skill back as
   the single candidate so the Beta update lands on the right row:

   ```bash
   GOAL=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['goal'])")
   TASK_CLASS=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['task_class'])")
   CHOSEN=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['chosen_skill'] or '')")

   PAYLOAD=$(python3 -c "
   import json, os
   d = {
     'session_id': '$SESSION_ID',
     'goal': os.environ.get('GOAL',''),
     'task_class': os.environ.get('TASK_CLASS','*'),
     'outcome': '$VERDICT',
   }
   if os.environ.get('CHOSEN'):
     d['candidate_skills'] = [os.environ['CHOSEN']]
   print(json.dumps(d))
   " GOAL="$GOAL" TASK_CLASS="$TASK_CLASS" CHOSEN="$CHOSEN")

   curl -fsS -X POST http://localhost:3132/api/wi/dispatch \
     -H 'content-type: application/json' \
     -d "$PAYLOAD"
   ```

4. **PM-4: link evidence to work_items if --ac was passed.** For each
   id in $AC_LIST, POST /api/cypher/pm/link with kind='cypher_session_id'
   and value=$SESSION_ID. Idempotent on (work_item, kind, value) so
   re-running is safe. Print a one-line confirmation per id; non-200
   responses surface the error but do NOT fail the whole skill — the
   primary outcome (Beta update) already landed in step 3.

   ```bash
   if [ -n "$AC_LIST" ]; then
     IFS=',' read -ra AC_IDS <<< "$AC_LIST"
     for AC_ID in "${AC_IDS[@]}"; do
       AC_ID="$(echo "$AC_ID" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
       [ -z "$AC_ID" ] && continue
       LINK_PAYLOAD=$(python3 -c "
   import json
   print(json.dumps({
     'work_item_id': '$AC_ID',
     'evidence_kind': 'cypher_session_id',
     'evidence_value': '$SESSION_ID',
     'note': 'closed via /wi-record-outcome ($VERDICT)',
   }))")
       LINK_RESP=$(curl -sS -o /tmp/wi-link-resp.json -w '%{http_code}' \
         -X POST http://localhost:3132/api/cypher/pm/link \
         -H 'content-type: application/json' \
         -d "$LINK_PAYLOAD")
       if [ "$LINK_RESP" = "200" ]; then
         echo "  ✓ linked $AC_ID ← $SESSION_ID"
       else
         ERR=$(cat /tmp/wi-link-resp.json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null || echo '?')
         echo "  ⚠ link $AC_ID failed (http $LINK_RESP): $ERR"
       fi
     done
   fi
   ```

5. **Render the closing card.** Format the response as:

   ```
   ✓ Cypher session cyp_57c442a10012 closed: success
     Skill: wi-investigate (was chosen by Cypher)
     Task class: dispatch
     Goal: <truncated to 80 chars>
     ✓ linked PERSONA-AC-7 ← cyp_57c442a10012
     ✓ linked PM-4 ← cyp_57c442a10012
   Beta prior updated. Next dispatch with similar shape will rank wi-investigate
   higher.
   ```

6. **Stop.** No follow-up skills, no auto-actions.
</process>

<hard-rules>
- This skill is best-effort: a curl failure surfaces the error but does NOT
  retry. The user can re-run with the same args.
- Verdict is recorded EXACTLY once per session. Re-running this skill on a
  session that's already 'done' is a no-op on Cypher's side (the wi_dispatch
  endpoint preserves the original outcome via UPSERT).
- The optional note is parsed but NOT yet wired into outcome_note in v1 —
  the wi_dispatch input schema doesn't expose outcome_note. Future slice
  extends the schema; the skill captures the note already so users can rely
  on the call shape.
- PM-4: --ac AC-1,AC-2 link calls are best-effort. A failed link does NOT
  fail the outcome record — Beta update is the load-bearing side effect,
  links are evidence rows that can be re-added later via the PM lens.
- PM-4: only ids that exist in work_items will land. Unknown ids return 404
  from /api/cypher/pm/link; the skill prints the warning and continues.
</hard-rules>

<example>
User: `/wi-record-outcome cyp_57c442a10012 success`

Skill output:
```
✓ Cypher session cyp_57c442a10012 closed: success
  Skill: wi-action-items
  Task class: dispatch
  Goal: Slice 1: ship wi-record-outcome companion skill...
Beta prior updated.
```

PM-4 example with --ac flag:
`/wi-record-outcome cyp_88d359eb0012 success --ac PM-4,PERSONA-AC-7 ship auto-link slice`

```
✓ Cypher session cyp_88d359eb0012 closed: success
  Skill: wi-investigate
  Task class: build-feature
  Goal: PM-4: Auto-link Cypher sessions...
  ✓ linked PM-4 ← cyp_88d359eb0012
  ✓ linked PERSONA-AC-7 ← cyp_88d359eb0012
Beta prior updated.
```

For a mixed/failed verdict, the user can add a note:
`/wi-record-outcome cyp_57c442a10012 mixed Cypher picked the wrong skill, work shipped anyway`
</example>
