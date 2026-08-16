---
sidebar_label: "Dual-Engine Investigation"
---

# Dual-Engine Investigation

When you click **Investigate** in the web UI (or call `POST /api/jira/investigate`), Work Intelligence runs **two investigation engines simultaneously** and merges their findings into one report.

---

## How It Works

```
You click "Investigate" on a Jira ticket
              ↓
┌─────────────────────────┬──────────────────────────────┐
│  Engine 1: ReAct Loop   │  Engine 2: wi-investigate     │
│                         │  Skill (Claude CLI)           │
│  TypeScript, Anthropic  │  claude --print --bare        │
│  SDK, 8 iterations max  │  wi-investigate SKILL.md      │
│                         │  loaded as system prompt      │
│  Tools:                 │                               │
│  • git_log_window       │  Full codebase access via     │
│  • get_flag_diff        │  --add-dir repos/example-service     │
│  • get_dep_diff         │  --add-dir repos/operations   │
│  • trace_call_graph     │                               │
│  • read_changed_files   │  No iteration limit —         │
│  • get_ownership        │  reasons freely               │
│  • get_bug_history      │                               │
│  • grep_code            │  Budget: $0.50 max            │
│  • get_pr               │  Timeout: 120s                │
│  • call_claude_code ←───┼── also uses wi-code-research  │
│                         │   skill for code sub-queries  │
└─────────────────────────┴──────────────────────────────┘
              ↓ both complete
        Synthesis step
        (higher confidence wins the root cause)
              ↓
      One merged report → DB → UI
```

---

## Synthesis Logic

The merger is simple and auditable:

| What | Rule |
|------|------|
| **Root cause** | Whichever engine has higher confidence score |
| **Conclusion text** | Both shown: `[ReAct] ... [Skill] ...` |
| **Evidence list** | All entries from both engines combined |
| **Proposed fix** | From the winning engine |
| **Confidence** | `Math.max(reactConfidence, skillConfidence)` |

If the skill engine fails (CLI not found, timeout, budget exceeded) — the ReAct result is returned unchanged. The skill is always additive, never blocking.

---

## What You See in the UI

The `InvestigatePanel` receives the merged `InvestigationReport`. The `conclusion` field will read:

```
[ReAct] Feature flag FF_RM_11372 promoted in operations PR #6107 on Apr 17.

[Skill] The recommendation engine's new code path was activated by FF_RM_11372
but the SMRDP compatibility layer was not updated. Roll back the flag in
operations/config/flags.yaml line 42.
```

If both engines agree, the report reinforces confidence. If they diverge, both perspectives are visible so you can judge which is more credible.

---

## The `call_claude_code` Sub-Tool

Inside the ReAct loop, one of the 10 tools is `call_claude_code` — used when the engine needs to do deep semantic code reading. This tool now also injects the `wi-code-research` skill prompt, so even the mid-loop code queries run with structured research guidance.

Two levels of skill integration:

1. **Top-level** — `wi-investigate` skill runs as a full parallel engine
2. **Mid-loop** — `wi-code-research` skill injected into `call_claude_code` sub-calls

---

## Using the Skill Directly from Claude Code

You can also run the skill manually from any Claude Code session without the web UI:

```
/wi-investigate PROJ-15257
```

This invokes only the skill engine (not the ReAct TypeScript loop). Use this when:
- You want faster, cheaper investigation (single engine, no synthesis overhead)
- You're already in a Claude Code session and don't want to open the web UI
- You want to iterate interactively on the investigation

See [wi-investigate skill reference](./wi-investigate.md) for full usage.

---

## Cost & Performance

| Item | Cost |
|------|------|
| ReAct engine | ~$0.10–0.30 (Sonnet, 8 iterations) |
| Skill engine | up to $0.50 (budget-capped) |
| `call_claude_code` sub-calls | up to $0.30 each (budget $0.30/call) |
| **Total worst case** | ~$1.10 per investigation |

Wall-clock time: ReAct runs first (~30–90s), then skill runs (~30–120s). Total: up to ~3.5 minutes.

---

## Related

- [ADR-022: Dual-Engine Investigation](../adr/adr-022-dual-engine-investigation.md)
- [ADR-013: Intelligent Bug Investigation](../adr/adr-013-intelligent-bug-investigation.md)
- [wi-investigate skill](./wi-investigate.md)
- [wi-code-research skill](./wi-code-blast-pr-expert.md)
