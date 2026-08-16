---
name: wi-investigate
description: "Investigate bugs and incidents: find root cause for errors (401/4xx/5xx), regressions, proxy/auth issues, and crashes. Use for goals like 'why is <service> returning 401', 'figure out this regression', 'debug production incident'. Runs a 3-layer ReAct investigation with evidence and confidence."
triggers:
- investigate
- figure out why
- why is this failing
- root cause
- trace the error
- what happened
- regression
- search-provider proxy
- 401

argument-hint: "<TICKET-KEY>"
allowed-tools:
  - Bash
  - mcp__work-intelligence__ask_topic_expert
  - mcp__jira__jira_get_issue
  - mcp__jira__jira_get_issue_development_info
  - mcp__github-tools__get_commit
  - mcp__github-tools__get_file_contents
  - mcp__github-tools__search_code
---

<objective>
Investigate a bug ticket using the Work Intelligence investigation engine.
Start the async investigation, poll until complete, then render the full
ReAct trace and root-cause conclusion.

Ticket key: "$ARGUMENTS"
</objective>

<process>
1. Validate the argument is a Jira key (e.g. JIRA-12345). If missing, ask for it.

2. Start investigation:
   ```bash
   curl -s -X POST http://localhost:3132/api/jira/investigate \
     -H "Content-Type: application/json" \
     -d '{"key": "$ARGUMENTS"}'
   ```

3. Poll for completion (max 90s, 5s intervals):
   ```bash
   curl -s http://localhost:3132/api/jira/investigation/$ARGUMENTS
   ```
   Continue polling while status is "running". Stop on "complete" or "error".

4. Render the investigation report:
   - Show confidence score (0.0–1.0) with interpretation:
     - ≥ 0.8 = High confidence — root cause confirmed
     - 0.5–0.79 = Medium — likely root cause, verify manually
     - < 0.5 = Low — hypothesis only, needs more signals
   - Show each ReAct iteration: thought → tool call → observation
   - Highlight the conclude step: root cause + proposed fix
   - List evidence trail (files, commits, feature flags cited)

5. If confidence ≥ 0.5, ask: "Save this investigation to the Jira ticket?"
   On yes:
   ```bash
   curl -s -X PUT http://localhost:3132/api/jira/analysis/$ARGUMENTS/notes \
     -H "Content-Type: application/json" \
     -d '{"notes": "<summary of conclusion>"}'
   ```

6. If confidence < 0.5, suggest: run `/wi-jira-analyze $ARGUMENTS` for broader analysis.
</process>

<output-contract>
When the investigation **orchestrator** invokes this skill via the Claude CLI subprocess
(dual-engine synthesis in `investigation-orchestrator.ts`), the model MUST emit JSON matching
`src/intelligence/skill-output-schema.ts`. The bridge validates with Zod; invalid output is
discarded and the ReAct-only report is returned (no regression).

Required top-level shape:

```json
{
  "findings": [
    {
      "rootCauseType": "dep-upgrade | code-regression | config-change | external-service | unknown",
      "rootCause": "Plain-language root cause (>= 10 characters)",
      "fixOwner": "Team responsible for the fix",
      "isExternalDep": true,
      "confidence": 0.85,
      "proposedFix": "file + change, or null if external",
      "example-serviceAction": "What the owning team should do",
      "evidence": [{ "type": "git-commit", "description": "..." }]
    }
  ],
  "filesExamined": ["repos/<your-repo>/src/example.ts"],
  "confidence": 0.85
}
```

**Interactive use** (`/wi-investigate JIRA-12345` in chat): follow `<process>` and render the
markdown trace from the bridge API. The JSON contract applies only to the orchestrator subprocess.
</output-contract>
