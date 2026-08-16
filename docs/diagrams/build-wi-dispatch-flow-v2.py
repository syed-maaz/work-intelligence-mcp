#!/usr/bin/env python3
"""Rebuild wi-dispatch-flow-v2.drawio with the AFTER state.

Changes vs. previous v2:
  H5. Panel C: green "FIXED 2026-07-25" banner + before/after callout.
  H6. Panel A: bug annotation updated — old SCOPE 60s halt cured by ADR-042;
      new bug is EXECUTE returning without a tool_use (53/78 phase=2 successes).
  D-legend: updated to reflect that the ghost misroute pattern is now fixed
            (candidate list is clean); the 5 misrouted rows are HISTORICAL evidence.
"""
import html
import xml.etree.ElementTree as ET

PARENTS = [
    ("wi-audit",     ["analyze", "dead-writes", "kg-freshness", "storage"]),
    ("wi-brief",     ["daily", "morning", "weekly"]),
    ("wi-bug",       ["report", "resolve", "resolve-all"]),
    ("wi-code",      ["blast-radius", "correlate", "pr-review"]),
    ("wi-git-audit", ["merge-ready", "symlinks", "worktrees"]),
    ("wi-govern",    ["frontmatter", "links", "memory", "recall"]),
    ("wi-jira",      ["analyze", "report", "save", "ticket-links"]),
    ("wi-people",    ["expert", "owner", "teammate"]),
    ("wi-search",    ["all", "ask", "code", "palace", "teams"]),
    ("wi-status",    ["health", "impact", "next", "status", "sync"]),
    ("wi-vault",     ["annotate", "todo"]),
]

STANDALONE = [
    "wi-action-items", "wi-add-bucket", "wi-bis-regression", "wi-disk-audit",
    "wi-investigate", "wi-pm", "wi-pre-meeting", "wi-record-outcome",
    "wi-remind", "wi-review-adr", "wi-router", "wi-skill-install",
    "wi-example-service-pr-smoke", "wi-update-context",
]

# Historically-registered ghosts (now purged) — kept for evidence
GHOSTS = [
    "wi-annotate", "wi-ask-topic", "wi-blast-radius", "wi-bug-report",
    "wi-bug-resolve", "wi-bug-resolve-all", "wi-check-links", "wi-code-research",
    "wi-correlate", "wi-daily-digest", "wi-find-expert", "wi-frontmatter",
    "wi-health", "wi-jira-analyze", "wi-jira-report", "wi-memory-compact",
    "wi-morning-brief", "wi-palace-query", "wi-pr-review", "wi-recall-tune",
    "wi-save-to-ticket", "wi-search-all", "wi-sync", "wi-teammate",
    "wi-teams-search", "wi-ticket-links", "wi-vault-todo", "wi-weekly-report",
    "wi-who-owns",
]

DISPATCHES = [
    ("Fix 94 pre-existing vitest failures on master",
     "build · fix/test-debt-2026-07-24 — 94 vitest failures",
     "", "success", "end_turn with text answer, no wi_* tool dispatched"),
    ("author new skill wi-worktree-status from template",
     "build · skills/wi-worktree-status (new from template)",
     "example-skill", "failed", "plugin fallback route"),
    ("author new skill wi-kg-freshness from template",
     "build · skills/wi-kg-freshness",
     "example-skill", "failed", "plugin fallback route"),
    ("author new skill wi-analyze-audit stub from template",
     "build · skills/wi-analyze-audit (new stub)",
     "example-skill", "success", "plugin fallback route"),
    ("author new skill wi-dead-writes from template",
     "build · skill: wi-dead-writes (new, from template)",
     "example-skill", "failed", "plugin fallback route"),
    ("author new skill wi-storage-audit from template",
     "build · wi-storage-audit (scaffolded from template)",
     "example-skill", "failed", "plugin fallback route"),
    ("build GET /api/sync/stream SSE endpoint",
     "build · GET /api/sync/stream SSE endpoint",
     "wi-investigate", "success", "standalone parent"),
    ("PMAgent stall gate multi-column + pm-auto autoLink/autoClose",
     "investigate · PMAgent multi-column gate stall",
     "wi-investigate", "success", "standalone parent"),
    ("fix wi_search_all EXECUTE stall: local-first FTS return",
     "investigate · wi_search_all EXECUTE stall (tsk_44543...)",
     "wi-investigate", "success", "standalone parent"),
    ("PROJ-16602 PR #4714 review-response: remove dead env-var",
     "wi-investigate", "success", "standalone parent (not wi-code)"),
]

cells = []
def esc(s): return html.escape(s, quote=True)
def box(cid, x, y, w, h, value, style):
    cells.append(
        f'<mxCell id="{cid}" value="{esc(value)}" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
    )
def edge(cid, source, target, value, style):
    v = f' value="{esc(value)}"' if value else ""
    cells.append(
        f'<mxCell id="{cid}"{v} style="{style}" edge="1" parent="1" source="{source}" target="{target}">'
        f'<mxGeometry relative="1" as="geometry"/></mxCell>'
    )

# styles
S_TITLE   = "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=14;fontStyle=1;fontColor=#1a1a1a;"
S_PANELA  = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#fafafa;strokeColor=#455a64;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#263238;"
S_PANELB  = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#e3f2fd;strokeColor=#1565c0;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#0d3c78;"
S_PANEL_L = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#f5f5f5;strokeColor=#616161;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#212121;"
S_PANELC_L= "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#e8f5e9;strokeColor=#2e7d32;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#1b5e20;"
S_PANELC_R_FIXED = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#e8f5e9;strokeColor=#2e7d32;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#1b5e20;"

S_ENTRY   = "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#e8eaf6;strokeColor=#3949ab;fontColor=#1a237e;fontSize=11;verticalAlign=middle;align=center;"
S_SCOPE   = "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#fff8e1;strokeColor=#f9a825;fontColor=#6d4c00;fontSize=11;verticalAlign=middle;align=center;"
S_DIAMOND = "rhombus;whiteSpace=wrap;html=1;fillColor=#ede7f6;strokeColor=#5e35b1;fontColor=#311b92;fontSize=11;fontStyle=1;verticalAlign=middle;align=center;"
S_PMBOX   = "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#e8f5e9;strokeColor=#2e7d32;fontColor=#1b5e20;fontSize=11;verticalAlign=middle;align=center;"
S_EXBOX   = "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#bbdefb;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=10;verticalAlign=middle;align=center;"
S_CLOSE   = "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#eceff1;strokeColor=#455a64;fontColor=#263238;fontSize=11;verticalAlign=middle;align=center;"
# NEW bug annotation for H6 — orange (still-open) instead of red (fixed)
S_BUG_OPEN = "rounded=1;whiteSpace=wrap;html=1;arcSize=8;dashed=1;dashPattern=6 4;fillColor=#fff3e0;strokeColor=#e65100;fontColor=#bf360c;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=8;"

S_ARROW_HEAVY = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#3949ab;strokeWidth=2;endArrow=block;endFill=1;"
S_ARROW_SCOPE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#f9a825;strokeWidth=2;endArrow=block;endFill=1;fontSize=9;fontColor=#6d4c00;"
S_ARROW_PM    = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#2e7d32;strokeWidth=2;endArrow=block;endFill=1;fontSize=10;fontColor=#1b5e20;fontStyle=1;"
S_ARROW_EX    = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#1565c0;strokeWidth=2;endArrow=block;endFill=1;fontSize=10;fontColor=#0d3c78;fontStyle=1;"
S_ARROW_LOOP  = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#1565c0;strokeWidth=2;endArrow=block;endFill=1;dashed=1;dashPattern=4 3;fontSize=9;fontColor=#0d3c78;"
S_ARROW_BUG   = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;dashed=1;dashPattern=6 4;strokeColor=#e65100;strokeWidth=2;endArrow=block;endFill=1;fontSize=9;fontColor=#bf360c;fontStyle=1;"

# title
box("title", 40, 12, 2320, 44,
    "/wi <goal> — dispatch flow (v4, 2026-07-25)\n"
    "runLoop → SCOPE → EXECUTE → skills/<parent>/run.sh <sub>. Documents the current shape of dispatch. Failure modes + fix history live in .planning/, not here.",
    S_TITLE)

# ---- Panel A ----
PAX, PAY, PAW, PAH = 40, 70, 620, 720
box("panelA", PAX, PAY, PAW, PAH,
    "PANEL A — Main flow (loop.ts:938 runLoop)", S_PANELA)
box("entry", PAX+30, PAY+40, PAW-60, 96,
    "/wi <goal>\n\nPOST /api/wi/dispatch/stream → runLoop({ goal, phase:'scope' })\n"
    "opens cypher_sessions row · dispatch_source ∈ {user|smoke|test|agent|unknown} (v104, ADR-050 R0)\n"
    "model = Opus\n"
    "discoverSkills() upserted+PRUNED skill_catalog at boot (skill-discovery.ts:292)",
    S_ENTRY)
box("scope", PAX+30, PAY+134, PAW-60, 92,
    "SCOPE phase (loop.ts:1029, phase='scope')\n"
    "re-prompt #1 — read-only, mutators excluded from tool catalog\n"
    "ADR-042 single-pass when WI_STAGE1_ENABLED=1 (loop.ts:1309)\n"
    "raw goal → RefinedGoal { intent, target, constraints, success_criteria }",
    S_SCOPE)
# Bug/concern annotations REMOVED (v4).
# Rationale: diagram documents the current dispatch shape, not its bug history.
# Bug #814 (fixed) + model-no-dispatch (open, being investigated) live in
# .planning/execute-no-skill/. Keeping them here made the diagram a status
# board that goes stale on every commit.
box("decision", PAX+90, PAY+260, PAW-180, 100,
    "PM routing\nintent ?\n\nADR-043 · loop.ts:1670\nshouldCaptureToBoard()",
    S_DIAMOND)
box("pmboard", PAX+30, PAY+380, 240, 86,
    "PM board (DELIBERATIVE)\ncaptureToBoard() — pm-capture-hook.ts:89\n"
    "→ kanban card; outcome='captured_to_board'\n(0 rows in last 30d — branch quiet)",
    S_PMBOX)
box("execute", PAX+290, PAY+380, PAW-320, 220,
    "EXECUTE phase (loop.ts:938 · phase='execute')\n"
    "re-prompt #2 — agentic tool-use loop\n\n→ see Panel B for run.sh landing detail",
    "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#e3f2fd;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=11;fontStyle=1;verticalAlign=top;align=center;spacingTop=8;")
box("ex_model",  PAX+310, PAY+454, 120, 46, "model (Claude)\n→ tool_use", S_EXBOX)
box("ex_run",    PAX+450, PAY+454, 140, 46, "runSkillSubagent\nskill-dispatch.ts:269", S_EXBOX)
box("ex_result", PAX+380, PAY+520, 190, 54,
    "append tool_result → re-prompt\n(audit row → subagent_dispatches, v92)", S_EXBOX)
box("ex_exit",   PAX+310, PAY+580, PAW-340, 16,
    "until end_turn OR cap (iters / tokens / wallclock) — text = answer",
    "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=9;fontColor=#0d3c78;fontStyle=2;")
box("close", PAX+30, PAY+620, PAW-60, 86,
    "Close + learn (loop.ts closeSession · persistOutcome)\n"
    "cypher_sessions row updated: outcome ∈ {success|mixed|failed|halted|abandoned|rejected_non_interactive|captured_to_board}\n"
    "outcome + outcome_note rendered on CypherPage SessionDetail\n"
    "→ Beta priors updated (Cypher learns skill/tool routing)",
    S_CLOSE)

edge("e_a1", "entry",    "scope",    "", S_ARROW_HEAVY)
edge("e_a2", "scope",    "decision", "RefinedGoal", S_ARROW_SCOPE)
edge("e_a3", "decision", "pmboard",
     "DELIBERATIVE\nbrainstorm | plan | decide",
     S_ARROW_PM + "exitX=0;exitY=0.5;exitDx=0;exitDy=0;")
edge("e_a4", "decision", "execute",
     "DOING\ninvestigate|build|review|analyze|refactor",
     S_ARROW_EX + "exitX=1;exitY=0.5;exitDx=0;exitDy=0;")
edge("e_a5", "ex_model", "ex_run", "", S_ARROW_EX)
edge("e_a6", "ex_run",   "ex_result", "", S_ARROW_EX)
edge("e_a7", "ex_result","ex_model",  "loop",
     S_ARROW_LOOP + "exitX=0;exitY=0.5;entryX=0;entryY=1;")
edge("e_a8", "pmboard",  "close",     "", S_ARROW_PM)
edge("e_a9", "execute",  "close",     "end_turn → answer", S_ARROW_EX)

# ---- Panel B ----
PBX, PBY, PBW, PBH = 700, 70, 1660, 720
box("panelB", PBX, PBY, PBW, PBH,
    "PANEL B — Inside EXECUTE: how a tool_use lands on skills/<parent>/subs/<sub>.sh",
    S_PANELB)

mx, my = PBX + 30, PBY + 44
box("b_model",    mx, my,      330, 76,
    "1 · model emits tool_use\n{ name:\"wi_jira\", input:{ sub:\"analyze\", args:{…} } }\n"
    "(catalog exposed via TOOL_CATALOG — tool-catalog.ts:892, 19× wi.*)",
    "rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=#ffffff;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=10;verticalAlign=middle;align=left;spacingLeft=8;spacingTop=4;")
box("b_dispatch", mx, my+92,   330, 76,
    "2 · runSkillSubagent()  — skill-dispatch.ts:269\n"
    "resolves skill_name → source_path from skill_catalog,\nprepares env, picks confirm mode (auto/confirm/read-only)",
    "rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=#ffffff;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=10;verticalAlign=middle;align=left;spacingLeft=8;spacingTop=4;")
box("b_run",      mx, my+184,  330, 76,
    "3 · shell-exec\n$ bash skills/wi-jira/run.sh analyze <args>\n"
    "run.sh is a thin case-dispatcher (skill-scripting migration 2026-07-23)",
    "rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=#ffffff;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=10;verticalAlign=middle;align=left;spacingLeft=8;spacingTop=4;")
box("b_sub",      mx, my+276,  330, 76,
    "4 · subcommand script\ncase \"$sub\" in analyze) exec subs/analyze.sh \"$@\" ;; esac\n"
    "subs/analyze.sh does the real work; stdout is the tool_result",
    "rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=#ffffff;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=10;verticalAlign=middle;align=left;spacingLeft=8;spacingTop=4;")
box("b_result",   mx, my+368,  330, 76,
    "5 · tool_result → back to model\nstdout captured, wrapped as tool_result block, re-prompted.\n"
    "Audit row: subagent_dispatches (v92) — session, skill, sub, args, exit, ms, outcome.",
    "rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=#ffffff;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=10;verticalAlign=middle;align=left;spacingLeft=8;spacingTop=4;")

edge("b_e1", "b_model",    "b_dispatch", "", S_ARROW_EX)
edge("b_e2", "b_dispatch", "b_run",      "", S_ARROW_EX)
edge("b_e3", "b_run",      "b_sub",      "", S_ARROW_EX)
edge("b_e4", "b_sub",      "b_result",   "", S_ARROW_EX)

tx, ty = PBX + 400, PBY + 44

box("t1_title", tx, ty, 620, 24,
    "TRACE 1 — merged parent (wi-jira analyze)",
    "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=11;fontStyle=1;fontColor=#0d3c78;spacingLeft=6;")
box("t1_body", tx, ty+28, 620, 220,
    "user     : /wi analyze PROJ-16602\n"
    "SCOPE    : RefinedGoal { intent:'analyze', target:'PROJ-16602' }\n"
    "PM route : DOING → EXECUTE\n"
    "model    : tool_use { name:'wi_jira', input:{ sub:'analyze', ticket:'PROJ-16602' } }\n"
    "dispatch : runSkillSubagent('wi-jira', {…})   [skill-dispatch.ts:269]\n"
    "exec     : bash skills/wi-jira/run.sh analyze PROJ-16602\n"
    "           └── subs/analyze.sh → Jira REST + palace lookup → stdout JSON\n"
    "tool_res : {…} → model re-prompt\n"
    "close    : outcome=success · subagent_dispatches +1 row",
    "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#90a4ae;fontColor=#263238;fontSize=10;fontFamily=Courier New;verticalAlign=top;align=left;spacingLeft=8;spacingTop=6;")

box("t2_title", tx, ty+266, 620, 24,
    "TRACE 2 — standalone (wi-investigate, no subs)",
    "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=11;fontStyle=1;fontColor=#0d3c78;spacingLeft=6;")
box("t2_body", tx, ty+294, 620, 200,
    "user     : /wi fix wi_search_all EXECUTE stall (tsk_44543…)\n"
    "SCOPE    : RefinedGoal { intent:'investigate', target:'wi_search_all stall' }\n"
    "PM route : DOING → EXECUTE\n"
    "model    : (no subcommand — flat skill)\n"
    "           tool_use { name:'wi_investigate', input:{ goal:'…' } }\n"
    "dispatch : runSkillSubagent('wi-investigate', {…})\n"
    "exec     : loads skills/wi-investigate/SKILL.md as system prompt,\n"
    "           spawns Claude subagent w/ tool catalog (no run.sh path)\n"
    "close    : outcome=success",
    "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#90a4ae;fontColor=#263238;fontSize=10;fontFamily=Courier New;verticalAlign=top;align=left;spacingLeft=8;spacingTop=6;")

# Trace 3 — third real dispatch shape (was bug narrative in v3.x — now replaced with
# a real architectural trace: what happens when EXECUTE calls no wi_* tool at all).
box("t3_title", tx, ty+512, 620, 24,
    "TRACE 3 — model answers from priors (no wi_* tool dispatch)",
    "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=11;fontStyle=1;fontColor=#0d3c78;spacingLeft=6;")
box("t3_body", tx, ty+540, 620, 220,
    "user     : /wi what does wi_search return when the corpus is empty?\n"
    "SCOPE    : RefinedGoal { intent:'investigate', target:'wi_search empty-corpus semantics' }\n"
    "PM route : DOING → EXECUTE\n"
    "model    : reads goal + brief, decides no external state read is needed\n"
    "           emits final text: 'wi_search returns { hits: [], total: 0, took_ms: N }\n"
    "                              when the FTS5 corpus has zero rows.'\n"
    "         : (no tool_use blocks — end_turn on iter 1)\n"
    "dispatch : none (subagent_dispatches unchanged)\n"
    "close    : verdict resolver reads modelVerdict from record_outcome if present,\n"
    "           else falls through to stopReason==='end_turn' && surface.length>0 → 'success'.\n"
    "           chosen_skill='' · skill_actually_invoked='' · outcome_note null unless\n"
    "           the model called cypher_record_outcome.",
    "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#90a4ae;fontColor=#263238;fontSize=10;fontFamily=Courier New;verticalAlign=top;align=left;spacingLeft=8;spacingTop=6;")

# ---- Panel C ----
PCX, PCY, PCW, PCH = 40, 810, 2320, 400
# Panel C header — reframed v4: no fix-history banner. Documents current state.
box("panelC", PCX, PCY, PCW, PCH,
    "PANEL C — Routing surface (skill_catalog rows, source-of-truth = repo skills/)",
    S_PANEL_L)

box("panelCL", PCX+20, PCY+40, 1420, PCH-60,
    "11 merged parents (39 subs) + 14 standalone skills = 25 dispatchable wi-* skills on disk",
    S_PANELC_L)

py = PCY + 78
row_h = 24
for i, (parent, subs) in enumerate(PARENTS):
    y = py + i*row_h
    box(f"p_{i}_name", PCX+40, y, 140, row_h-2, parent,
        "rounded=0;whiteSpace=wrap;html=1;fillColor=#c8e6c9;strokeColor=#2e7d32;fontColor=#1b5e20;fontStyle=1;fontSize=10;align=left;spacingLeft=6;verticalAlign=middle;")
    box(f"p_{i}_subs", PCX+180, y, 1240, row_h-2, "  ".join(subs),
        "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#a5d6a7;fontColor=#1b5e20;fontSize=10;fontFamily=Courier New;align=left;spacingLeft=6;verticalAlign=middle;")

sy = py + len(PARENTS)*row_h + 8
box("stand_title", PCX+40, sy, 240, 22, "Standalone (SKILL.md only, no subs):",
    "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=10;fontStyle=1;fontColor=#1b5e20;")
box("stand_body", PCX+280, sy, 1140, 22, "  ".join(STANDALONE),
    "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#a5d6a7;fontColor=#1b5e20;fontSize=10;fontFamily=Courier New;align=left;spacingLeft=6;verticalAlign=middle;")

# ── Right panel: how the catalog stays consistent (invariants, not history) ──
box("panelCR", PCX+1460, PCY+40, 840, PCH-60,
    "Catalog invariants",
    "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#e8eaf6;strokeColor=#3949ab;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#1a237e;")

box("invariants", PCX+1480, PCY+78, 820, PCH-108,
    "1. Source of truth = repo skills/ (25 dispatchable dirs).\n"
    "\n"
    "2. install-skills.sh mirrors skills/ into\n"
    "     · ~/.claude/skills/work-intelligence/<name>/\n"
    "     · ~/.claude/skills/<name> (top-level symlink for slash-command)\n"
    "     · ~/.hermes/skills/wi/<name>/ (Hermes flat layout)\n"
    "   Pass --prune to reconcile deletions.\n"
    "\n"
    "3. skill_catalog table (SQLite) is populated by discoverSkills() at\n"
    "   bridge boot (src/services/cypher/skill-discovery.ts:292).\n"
    "     · UPSERTs every SKILL.md under the scanned roots\n"
    "     · PRUNES rows whose source_path is under a scanned root but\n"
    "       whose file is gone (kill switch: WI_SKILL_DISCOVERY_PRUNE=0)\n"
    "     · Skips dirs starting with `_` (e.g. _TEMPLATE)\n"
    "     · Skips SKILL.md with `dispatchable: false` frontmatter\n"
    "\n"
    "4. resolveCandidates() in candidates.ts:147 reads the catalog to\n"
    "   build the /wi candidate pool for each dispatch. When the model\n"
    "   picks a name, that name resolves via source_path to a real dir.\n"
    "\n"
    "Verification: .planning/skill-catalog-cleanup/verify-dispatch-\n"
    "candidates.mjs re-derives the candidate pool from the live DB.",
    "rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#3949ab;fontColor=#1a237e;fontSize=10;align=left;spacingLeft=8;spacingTop=4;verticalAlign=top;")

# ---- Panel D ----
PDX, PDY, PDW, PDH = 40, 1230, 2320, 400
box("panelD", PDX, PDY, PDW, PDH,
    "PANEL D — 10 real dispatches from cypher_sessions (last 14d) — dispatch shape snapshot",
    S_PANEL_L)

hdr_y = PDY + 40
cols = [
    ("#",              PDX+20,   30),
    ("raw /wi goal",   PDX+50,   430),
    ("RefinedGoal (intent · target)", PDX+480, 500),
    ("chosen_skill",   PDX+980,  180),
    ("outcome",        PDX+1160, 90),
    ("note",           PDX+1250, 1050),
]
for name, x, w in cols:
    safe = name.replace('#','hash').replace(' ','_').replace('(','').replace(')','').replace('·','')
    box(f"h_{safe}", x, hdr_y, w, 30, name,
        "rounded=0;whiteSpace=wrap;html=1;fillColor=#37474f;strokeColor=#263238;fontColor=#ffffff;fontStyle=1;fontSize=10;align=center;verticalAlign=middle;")

def outcome_fill(o):
    return {"success":"#c8e6c9","failed":"#ffcdd2","mixed":"#ffe0b2",
            "halted":"#ffe0b2","captured_to_board":"#c8e6c9"}.get(o, "#eceff1")

REAL = set(p for p,_ in PARENTS) | set(STANDALONE)
def chosen_fill(c):
    if not c: return "#eceff1"
    if c in REAL: return "#c8e6c9"
    return "#e0e0e0"  # historical — no longer red, now shown as neutral

for i, (raw, refined, chosen, outcome, note) in enumerate(DISPATCHES):
    ry = hdr_y + 30 + i*32
    base = "rounded=0;whiteSpace=wrap;html=1;strokeColor=#b0bec5;fontColor=#263238;fontSize=9;verticalAlign=middle;spacingLeft=6;spacingRight=6;"
    box(f"r{i}_0", cols[0][1], ry, cols[0][2], 32, str(i+1),
        base + "fillColor=#f5f5f5;align=center;fontStyle=1;")
    box(f"r{i}_1", cols[1][1], ry, cols[1][2], 32, raw,
        base + "fillColor=#ffffff;align=left;")
    box(f"r{i}_2", cols[2][1], ry, cols[2][2], 32, refined,
        base + "fillColor=#ffffff;align=left;fontFamily=Courier New;")
    box(f"r{i}_3", cols[3][1], ry, cols[3][2], 32, chosen or "(none)",
        base + f"fillColor={chosen_fill(chosen)};align=center;fontFamily=Courier New;")
    box(f"r{i}_4", cols[4][1], ry, cols[4][2], 32, outcome,
        base + f"fillColor={outcome_fill(outcome)};align=center;fontStyle=1;")
    box(f"r{i}_5", cols[5][1], ry, cols[5][2], 32, note,
        base + "fillColor=#ffffff;align=left;")

box("d_legend", PDX+20, PDY+PDH-40, PDW-40, 26,
    "GREEN chosen_skill = merged parent or standalone on disk · GREY = plugin/global fallback · BLANK = no dispatch (model answered from priors). "
    "This is a snapshot of dispatch shapes seen in cypher_sessions — not a health metric.",
    "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=10;fontStyle=2;fontColor=#455a64;spacingLeft=8;")

body = "\n".join(cells)
xml = (
    '<mxfile host="65bd71144e">\n'
    '  <diagram id="wi-dispatch-flow-v2" name="/wi Dispatch Flow v2">\n'
    '    <mxGraphModel dx="1255" dy="929" grid="1" gridSize="10" guides="1" tooltips="1" '
    'connect="1" arrows="1" fold="1" page="0" pageScale="1" '
    'pageWidth="2400" pageHeight="1680" math="0" shadow="0">\n'
    '      <root>\n'
    '        <mxCell id="0"/>\n'
    '        <mxCell id="1" parent="0"/>\n'
    f'{body}\n'
    '      </root>\n'
    '    </mxGraphModel>\n'
    '  </diagram>\n'
    '</mxfile>\n'
)

ET.fromstring(xml)  # validate
with open(out, "w") as f:
    f.write(xml)
print(f"OK wrote {out}")
print(f"cells={len(cells)} lines={xml.count(chr(10))} bytes={len(xml)}")
