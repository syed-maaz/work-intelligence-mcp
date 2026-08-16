#!/usr/bin/env python3
"""Build wi-dispatch-flow-v2.drawio with THREE tabs:
  1. 'flow' — the v4 architecture snapshot (unchanged)
  2. 'first-stage' — SCOPE-phase internals: as-built + as-desired
  3. 'pm-routing' — PM board flow: current ADR-043 + proposed

Each tab is a separate <diagram> block in the same <mxfile>. Draw.io renders
them as bottom-of-window tabs; users click to switch.

Grounded in loop.ts:1029-1710, stage1.ts, refined-goal-schema.ts. Line
references included on every 'as-built' box.

Aspirational boxes on the right column are intentionally EDITABLE — this
is a design canvas. Update the Python, rerun, iterate.
"""
import html
import xml.etree.ElementTree as ET

# ─────────────────────────────────────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────────────────────────────────────

def esc(s):
    return html.escape(s, quote=True)


def build_diagram(diag_id, diag_name, page_w, page_h, body):
    return (
        f'  <diagram id="{diag_id}" name="{esc(diag_name)}">\n'
        '    <mxGraphModel dx="1255" dy="929" grid="1" gridSize="10" guides="1" tooltips="1" '
        'connect="1" arrows="1" fold="1" page="0" pageScale="1" '
        f'pageWidth="{page_w}" pageHeight="{page_h}" math="0" shadow="0">\n'
        '      <root>\n'
        '        <mxCell id="0"/>\n'
        '        <mxCell id="1" parent="0"/>\n'
        f'{body}\n'
        '      </root>\n'
        '    </mxGraphModel>\n'
        '  </diagram>\n'
    )


class Canvas:
    """Cell accumulator with helpers."""
    def __init__(self):
        self.cells = []

    def box(self, cid, x, y, w, h, value, style):
        self.cells.append(
            f'<mxCell id="{cid}" value="{esc(value)}" style="{style}" vertex="1" parent="1">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
        )

    def edge(self, cid, source, target, value, style):
        v = f' value="{esc(value)}"' if value else ""
        self.cells.append(
            f'<mxCell id="{cid}"{v} style="{style}" edge="1" parent="1" source="{source}" target="{target}">'
            f'<mxGeometry relative="1" as="geometry"/></mxCell>'
        )

    def body(self):
        return "\n".join(self.cells)


# Shared styles (identical to v4 palette so tabs feel like one document)
S_TITLE   = "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=14;fontStyle=1;fontColor=#1a1a1a;"
S_SUBTITLE = "text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=11;fontStyle=2;fontColor=#455a64;"
S_PANELA  = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#fafafa;strokeColor=#455a64;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#263238;"
S_PANELB  = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#e3f2fd;strokeColor=#1565c0;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#0d3c78;"
S_PANEL_L = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#f5f5f5;strokeColor=#616161;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#212121;"
S_PANELC_L= "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#e8f5e9;strokeColor=#2e7d32;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=11;fontStyle=1;fontColor=#1b5e20;"

# Design-canvas: LEFT = as-built (grounded), RIGHT = as-desired (aspirational)
S_ASBUILT_PANEL   = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#eceff1;strokeColor=#455a64;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=12;fontStyle=1;fontColor=#263238;"
S_ASDESIRED_PANEL = "rounded=1;whiteSpace=wrap;html=1;arcSize=3;fillColor=#fff8e1;strokeColor=#f57c00;strokeWidth=2;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontSize=12;fontStyle=1;fontColor=#e65100;"
S_ASBUILT_BOX     = "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#ffffff;strokeColor=#90a4ae;fontColor=#37474f;fontSize=10;verticalAlign=middle;align=left;spacingLeft=8;spacingRight=8;"
S_ASDESIRED_BOX   = "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#fff3e0;strokeColor=#f57c00;fontColor=#bf360c;fontSize=10;verticalAlign=middle;align=left;spacingLeft=8;spacingRight=8;"
S_CODE_REF        = "rounded=0;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#bdbdbd;fontColor=#37474f;fontSize=9;fontFamily=Courier New;verticalAlign=middle;align=left;spacingLeft=6;spacingRight=6;"

S_ENTRY   = "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#e8eaf6;strokeColor=#3949ab;fontColor=#1a237e;fontSize=11;verticalAlign=middle;align=center;"
S_SCOPE   = "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#fff8e1;strokeColor=#f9a825;fontColor=#6d4c00;fontSize=11;verticalAlign=middle;align=center;"
S_DIAMOND = "rhombus;whiteSpace=wrap;html=1;fillColor=#ede7f6;strokeColor=#5e35b1;fontColor=#311b92;fontSize=11;fontStyle=1;verticalAlign=middle;align=center;"
S_PMBOX   = "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#e8f5e9;strokeColor=#2e7d32;fontColor=#1b5e20;fontSize=11;verticalAlign=middle;align=center;"
S_EXBOX   = "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#bbdefb;strokeColor=#1565c0;fontColor=#0d3c78;fontSize=10;verticalAlign=middle;align=center;"
S_CLOSE   = "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#eceff1;strokeColor=#455a64;fontColor=#263238;fontSize=11;verticalAlign=middle;align=center;"

S_ARROW_HEAVY = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#3949ab;strokeWidth=2;endArrow=block;endFill=1;"
S_ARROW_SCOPE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#f9a825;strokeWidth=2;endArrow=block;endFill=1;fontSize=9;fontColor=#6d4c00;"
S_ARROW_PM    = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#2e7d32;strokeWidth=2;endArrow=block;endFill=1;fontSize=10;fontColor=#1b5e20;fontStyle=1;"
S_ARROW_EX    = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#1565c0;strokeWidth=2;endArrow=block;endFill=1;fontSize=10;fontColor=#0d3c78;fontStyle=1;"
S_ARROW_LOOP  = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#1565c0;strokeWidth=2;endArrow=block;endFill=1;dashed=1;dashPattern=4 3;fontSize=9;fontColor=#0d3c78;"
S_ARROW_ASDESIRED = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#f57c00;strokeWidth=2;endArrow=block;endFill=1;fontSize=9;fontColor=#e65100;fontStyle=1;"
S_ARROW_ASBUILT   = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#455a64;strokeWidth=2;endArrow=block;endFill=1;fontSize=9;fontColor=#263238;"


# ═══════════════════════════════════════════════════════════════════════════
# TAB 1 — 'flow' — existing v4 diagram (regenerated by v4 script, spliced in)
# See extract_v4_flow_diagram() below for the mechanism.
# ═══════════════════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════════════════
# TAB 2 — 'first-stage' — SCOPE-phase internals: as-built + as-desired
# ═══════════════════════════════════════════════════════════════════════════

def build_first_stage_tab():
    c = Canvas()

    # Load the 15 real dispatches (pulled by /tmp/pull_15_dispatches.py).
    # Baked into the diagram so it's a self-contained snapshot; regenerate the
    # JSON when the DB changes and rerun this script.
    import json, os
    with open(data_path) as f:
        dispatches = json.load(f)

    # Title + pointer to the flow tab
    c.box("title", 40, 12, 2320, 40,
          "SCOPE-phase internals — first stage of /wi dispatch",
          S_TITLE)
    c.box("subtitle", 40, 52, 2320, 22,
          "Two-column design canvas — LEFT: as-built (grounded in code) · RIGHT: as-desired (aspirational, editable). See 'flow' tab for the wider dispatch context.",
          S_SUBTITLE)
    c.box("pointer_flow", 40, 82, 2320, 26,
          "▶ Wider context — this whole diagram is the yellow SCOPE box on the 'flow' tab (Panel A). loop.ts:1037 `if (effectivePhase === 'scope')`.",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#e8eaf6;strokeColor=#3949ab;fontColor=#1a237e;fontSize=10;fontStyle=2;verticalAlign=middle;align=left;spacingLeft=10;")

    # ── AS-BUILT column (LEFT) ─────────────────────────────────────────────
    AX, AY, AW, AH = 40, 120, 1150, 1300
    c.box("panel_asbuilt", AX, AY, AW, AH,
          "AS-BUILT — SCOPE phase, current implementation (loop.ts:1037-1710)",
          S_ASBUILT_PANEL)

    # 1. Entry to SCOPE
    c.box("ab_entry", AX+30, AY+50, AW-60, 60,
          "Entry — runLoop({phase:'scope'}) called from web-server.js:3372\n"
          "updateSessionMetadata → cypher_sessions.phase=1, engine='loop'",
          S_ENTRY)
    c.box("ab_entry_ref", AX+30, AY+112, AW-60, 20,
          "loop.ts:1037 · updateSessionMetadata(db, session_id, { phase: 1, engine: 'loop' })",
          S_CODE_REF)

    # 2. Setup (wallclock + iter caps + catalog hint)
    c.box("ab_setup", AX+30, AY+142, AW-60, 76,
          "Setup — budgets + advisory catalog hint\n"
          "· scopeWallclockMs = CYPHER_SCOPE_MAX_WALLCLOCK_MS (default 60000ms, 0=off)\n"
          "· scopeMaxIters = CYPHER_SCOPE_MAX_ITERS (default 3, clamp 1..10)\n"
          "· catalogHint = getCatalogHint(goal) — advisory, non-binding (AC-9)",
          S_ASBUILT_BOX)
    c.box("ab_setup_ref", AX+30, AY+220, AW-60, 20,
          "loop.ts:1061-1078 · tool-catalog.ts::getCatalogHint",
          S_CODE_REF)

    # 3. Flag branch — Stage 1 vs legacy
    c.box("ab_flag", AX+30, AY+250, AW-60, 60,
          "Feature flag: WI_STAGE1_ENABLED\n"
          "· = '1' → Stage 1 (ADR-042 single-pass path, default off on master)\n"
          "· ≠ '1' → legacy multi-round refiner mini-loop",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#e1f5fe;strokeColor=#0277bd;fontColor=#01579b;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=8;")

    # 4a. Stage 1 evidence fetch
    c.box("ab_stage1_fetch", AX+30, AY+320, AW-60, 148,
          "Stage 1 (WI_STAGE1_ENABLED=1) — parallel evidence fetch\n"
          "\n"
          "1a. classifyMultiIntent(goal) — cheap Anthropic call, digest bucket\n"
          "    → {is_single: true} OR {sub_goals: [{intent, goal}, ...]}\n"
          "\n"
          "1b. stage1Fetch(goal) — single-intent branch, OR PER sub-goal in parallel\n"
          "    fan-out: prompt_memory + message_embeddings (cosine)\n"
          "    + getCatalogHint (semantic + word-overlap)\n"
          "    ⚠ trigger_phrases: shipped on 25 wi-* skills (ADR-050 R2-B.1, 2026-07-27)\n"
          "       but NOT read by getCatalogHint yet — consumer path OPEN\n"
          "    → Stage1Evidence { hits[], recognition_confidence, confidence_signal }\n"
          "    caps: SNIPPET_MAX_CHARS=120 · STAGE1_FETCH_TIMEOUT_MS=800 · MAX_HITS_PER_SOURCE=8",
          S_ASBUILT_BOX)
    c.box("ab_stage1_fetch_ref", AX+30, AY+452, AW-60, 20,
          "loop.ts:1099-1160 · stage1.ts::stage1Fetch · multi-intent-classifier.ts::classifyMultiIntent",
          S_CODE_REF)

    # 4b. Refiner prompt assembly
    c.box("ab_prompt", AX+30, AY+482, AW-60, 100,
          "Refiner prompt assembly (both paths)\n"
          "· PromptEvolver.buildPrompt('goal_refinement', {…}) → refinerSystemPrompt\n"
          "  (fallback: REFINER_FALLBACK_PROMPT hard-coded string)\n"
          "· Stage 1 evidence block PREPENDED (when non-empty) with '---' separator\n"
          "· Stage 1 also APPENDS strict 8-key JSON schema spec (no retry — must be right)",
          S_ASBUILT_BOX)
    c.box("ab_prompt_ref", AX+30, AY+584, AW-60, 20,
          "loop.ts:1165-1270 · prompt-evolver.ts::PromptEvolver.buildPrompt",
          S_CODE_REF)

    # 4c. Tool catalog for scope
    c.box("ab_tools", AX+30, AY+614, AW-60, 60,
          "Scope-eligible tool catalog\n"
          "· getCatalogForPhase('scope') ∩ toolsForPosture(posture)\n"
          "· READ-ONLY tools only (no mutators, no dispatch)",
          S_ASBUILT_BOX)
    c.box("ab_tools_ref", AX+30, AY+676, AW-60, 20,
          "loop.ts:1278-1286 · tool-catalog.ts::getCatalogForPhase",
          S_CODE_REF)

    # 5a. Single-pass path
    c.box("ab_singlepass", AX+30, AY+706, AW-60, 130,
          "SINGLE-PASS path (WI_STAGE1_ENABLED=1 AND stage1EvidenceBlock non-empty)\n"
          "\n"
          "scopeIters = 1 · scopeClient.beta.promptCaching.messages.create({\n"
          "  system: [{text: refinerSystemPrompt, cache_control: ephemeral}],\n"
          "  tools: [],   // NO tools — recognition-only\n"
          "  messages: [{role:'user', content: goal}],\n"
          "}, {timeout: llmCallTimeoutMs(remaining budget)})\n"
          "\n"
          "→ ONE Anthropic call, no retry, no tool_use.",
          S_ASBUILT_BOX)
    c.box("ab_singlepass_ref", AX+30, AY+838, AW-60, 20,
          "loop.ts:1317-1359 · ADR-042 (cures the 60s SCOPE halt)",
          S_CODE_REF)

    # 5b. Multi-round path
    c.box("ab_multiround", AX+30, AY+868, AW-60, 150,
          "MULTI-ROUND path (WI_STAGE1_ENABLED=0, legacy default on master)\n"
          "\n"
          "while (scopeIters < scopeMaxIters && !refinedGoalJson && !clarifyingQuestion) {\n"
          "  wallclock guard → halt if scopeWallclockMs exceeded\n"
          "  scopeClient.beta.promptCaching.messages.create({\n"
          "    system: [{text: refinerSystemPrompt, cache_control: ephemeral}],\n"
          "    tools: scopeSdkTools,   // scope-eligible read-only tools\n"
          "  })\n"
          "  process tool_use blocks → append tool_result → next iteration\n"
          "  OR extract JSON brief + validate → break\n"
          "}",
          S_ASBUILT_BOX)
    c.box("ab_multiround_ref", AX+30, AY+1020, AW-60, 20,
          "loop.ts:1506-1710 · CYPHER_SCOPE_MAX_ITERS (default 3)",
          S_CODE_REF)

    # 6. Result branch — brief vs clarifying
    c.box("ab_result", AX+30, AY+1050, AW-60, 120,
          "Result branch (both paths converge here)\n"
          "\n"
          "extractJsonBrief(assistantText):\n"
          "  match ✔ → validateRefinedGoal(brief) — refined-goal-schema.ts\n"
          "                ok  → refinedGoalJson = JSON.stringify(brief) → EXECUTE\n"
          "                fail → clarifyingQuestion = validator error surface → halt\n"
          "  match ✘ → clarifyingQuestion = assistantText → halt(asked_user)",
          S_ASBUILT_BOX)
    c.box("ab_result_ref", AX+30, AY+1172, AW-60, 20,
          "loop.ts:1398-1505, 1624-1710 · refined-goal-schema.ts::validateRefinedGoal",
          S_CODE_REF)

    # 7. Persist
    c.box("ab_persist", AX+30, AY+1202, AW-60, 60,
          "Persist SCOPE outcome\n"
          "· persistRefinedGoal(db, session_id, refinedGoalJson, scopeIters)\n"
          "  → cypher_sessions.refined_goal + scope_iters columns",
          S_ASBUILT_BOX)
    c.box("ab_persist_ref", AX+30, AY+1264, AW-60, 20,
          "loop.ts:1720 · loop.ts:830 persistRefinedGoal · migration v85",
          S_CODE_REF)

    # As-built vertical arrows
    c.edge("ab_e1", "ab_entry",       "ab_setup",       "", S_ARROW_ASBUILT)
    c.edge("ab_e2", "ab_setup",       "ab_flag",        "", S_ARROW_ASBUILT)
    c.edge("ab_e3", "ab_flag",        "ab_stage1_fetch","flag=1 (Stage 1)", S_ARROW_ASBUILT)
    c.edge("ab_e4", "ab_stage1_fetch","ab_prompt",      "", S_ARROW_ASBUILT)
    c.edge("ab_e5", "ab_prompt",      "ab_tools",       "", S_ARROW_ASBUILT)
    c.edge("ab_e6", "ab_tools",       "ab_singlepass",  "Stage 1", S_ARROW_ASBUILT)
    c.edge("ab_e7", "ab_tools",       "ab_multiround",  "legacy (flag=0)", S_ARROW_ASBUILT)
    c.edge("ab_e8", "ab_singlepass",  "ab_result",      "", S_ARROW_ASBUILT)
    c.edge("ab_e9", "ab_multiround",  "ab_result",      "", S_ARROW_ASBUILT)
    c.edge("ab_e10","ab_result",      "ab_persist",     "", S_ARROW_ASBUILT)

    # ── AS-DESIRED column (RIGHT) ──────────────────────────────────────────
    DX, DY, DW, DH = 1210, 120, 1150, 1300
    c.box("panel_asdesired", DX, DY, DW, DH,
          "AS-DESIRED — what SCOPE should look like (EDIT THIS COLUMN)",
          S_ASDESIRED_PANEL)

    # Starter placeholders for the user to iterate on
    c.box("des_intro", DX+30, DY+50, DW-60, 60,
          "Placeholder starter — the user drives what goes here.\n"
          "Suggested framing: what changes about SCOPE would make the model dispatch\n"
          "more reliably? (Group C investigation: 18 of 20 real goals had empty refined_goal.)",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;dashed=1;fillColor=#ffffff;strokeColor=#f57c00;fontColor=#e65100;fontSize=10;fontStyle=2;verticalAlign=middle;align=left;spacingLeft=8;")

    # Editable slots — these are the "what we want" boxes the user will fill
    c.box("des_slot1", DX+30, DY+130, DW-60, 90,
          "DESIRED STEP 1 (edit me)\n"
          "\n"
          "e.g. 'Always run Stage 1 fetch (drop the WI_STAGE1_ENABLED flag).\n"
          "Master-default OFF was a rollout safety; the 60s halt is cured and\n"
          "priors are populated — flip to on by default, remove the branch.'",
          S_ASDESIRED_BOX)

    c.box("des_slot2", DX+30, DY+230, DW-60, 90,
          "DESIRED STEP 2 (edit me)\n"
          "\n"
          "e.g. 'Never write refined_goal=NULL to cypher_sessions when SCOPE\n"
          "returned a parseable brief. Currently 18 of 20 real-user goals in\n"
          "Group C have empty refined_goal — investigate H1 (parse fail) vs H2\n"
          "(lossy write) per 03-GROUP-C-INVESTIGATION.md.'",
          S_ASDESIRED_BOX)

    c.box("des_slot3", DX+30, DY+330, DW-60, 90,
          "DESIRED STEP 3 (edit me)\n"
          "\n"
          "e.g. 'SCOPE should emit an SSE event with the brief BEFORE handing\n"
          "off to EXECUTE, so the user sees what Cypher understood the goal to\n"
          "be. Today the brief is invisible until session-detail view loads.'",
          S_ASDESIRED_BOX)

    c.box("des_slot4", DX+30, DY+430, DW-60, 90,
          "DESIRED STEP 4 (edit me)\n"
          "\n"
          "e.g. 'When Stage 1 confidence == low AND top_skill is null, halt\n"
          "with asked_user instead of proceeding to EXECUTE. Cheaper than\n"
          "letting the model no-op and mislabeling as success.'",
          S_ASDESIRED_BOX)

    c.box("des_slot5", DX+30, DY+530, DW-60, 90,
          "DESIRED STEP 5 (edit me)\n"
          "\n"
          "e.g. 'refined_goal.evidence_cited must include at least ONE entry\n"
          "with source in {file, ticket, adr}. Empty evidence = SCOPE didn't\n"
          "actually reason, just pattern-matched. Enforce at validator level.'",
          S_ASDESIRED_BOX)

    c.box("des_slot6", DX+30, DY+630, DW-60, 90,
          "DESIRED STEP 6 (edit me)\n"
          "\n"
          "e.g. 'Deprecate the multi-round path. It's dead code — Stage 1\n"
          "single-pass wins on latency (p95 ~6.9s vs ~60s) and never halts.\n"
          "The legacy path only exists for the WI_STAGE1_ENABLED=0 kill switch.'",
          S_ASDESIRED_BOX)

    c.box("des_slot7", DX+30, DY+730, DW-60, 90,
          "DESIRED STEP 7 (add more as needed)\n"
          "\n"
          "Add / remove / reorder these slots freely. Once we lock the shape,\n"
          "I'll re-diagram the target state, we'll audit code against it,\n"
          "then land the deltas as ADRs + commits.",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;dashed=1;fillColor=#ffffff;strokeColor=#f57c00;fontColor=#e65100;fontSize=10;fontStyle=2;verticalAlign=middle;align=left;spacingLeft=8;")

    # Design-canvas legend
    c.box("des_legend", DX+30, DY+DH-80, DW-60, 60,
          "How to use this column:\n"
          "1. Reply with the shape you want (edit any slot's text or say 'add slot for X').\n"
          "2. I'll redraw this column to match.\n"
          "3. Once locked, we'll walk left-to-right and file the deltas as work.",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#fff8e1;strokeColor=#f57c00;fontColor=#bf360c;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=8;")

    # Column divider — a subtle vertical line
    c.box("divider", 1195, 120, 5, 1300, "",
          "rounded=0;whiteSpace=wrap;html=1;fillColor=#bdbdbd;strokeColor=#bdbdbd;")

    # ── PANEL E — 15 real dispatches (bottom-wide) ─────────────────────────
    # Real trace of what SCOPE received, what it produced, tools called, and
    # where the goal was passed. Data source: first-stage-15-dispatches.json
    # (pulled from cypher_sessions + cypher_steps at diagram build time).
    EX, EY, EW, EH = 40, 1440, 2320, 900
    c.box("panelE", EX, EY, EW, EH,
          "PANEL E — 15 real dispatches from cypher_sessions — SCOPE input → refined_goal → tools invoked → where it went",
          S_PANEL_L)

    # Column layout (widths sum to EW-40 = 2280):
    #   #        (30)
    #   raw goal (350)
    #   → refined intent · target (350)
    #   task_class (100)
    #   scope tools (300)          — always [(single_pass refiner)] on current master
    #   exec tools (900)           — comma-list, truncated
    #   passed_to (100)
    #   chosen_skill (100)
    #   outcome (80)
    hdr_y = EY + 40
    cols = [
        ("#",              EX + 20,   30),
        ("raw /wi goal",   EX + 50,   350),
        ("→ refined (intent · target)", EX + 400,  350),
        ("task_class",     EX + 750,  100),
        ("SCOPE tools",    EX + 850,  300),
        ("EXECUTE tools (call sequence)", EX + 1150, 890),
        ("passed to",      EX + 2040, 90),
        ("outcome",        EX + 2130, 80),
        ("skill",          EX + 2210, 90),
    ]
    for name, x, w in cols:
        safe = re.sub(r"[^A-Za-z0-9_]", "_", name).lower() or "col"
        c.box(f"h_{safe}", x, hdr_y, w, 30, name,
              "rounded=0;whiteSpace=wrap;html=1;fillColor=#37474f;strokeColor=#263238;fontColor=#ffffff;fontStyle=1;fontSize=10;align=center;verticalAlign=middle;")

    def outcome_fill(o):
        return {
            "success": "#c8e6c9",
            "mixed": "#ffe0b2",
            "failed": "#ffcdd2",
            "halted": "#ffe0b2",
            "captured_to_board": "#d1c4e9",
        }.get(o, "#eceff1")

    def passed_to_fill(p):
        return {"PM": "#d1c4e9", "EXECUTE": "#bbdefb", "SCOPE-only": "#eceff1"}.get(p, "#eceff1")

    row_h = 52  # room for two lines of exec-tools
    for i, d in enumerate(dispatches):
        ry = hdr_y + 30 + i * row_h
        base = ("rounded=0;whiteSpace=wrap;html=1;strokeColor=#b0bec5;fontColor=#263238;"
                "fontSize=9;verticalAlign=middle;spacingLeft=6;spacingRight=6;")
        c.box(f"r{i}_0", cols[0][1], ry, cols[0][2], row_h, str(i + 1),
              base + "fillColor=#f5f5f5;align=center;fontStyle=1;")
        c.box(f"r{i}_1", cols[1][1], ry, cols[1][2], row_h, d["goal"],
              base + "fillColor=#ffffff;align=left;")
        refined = f"{d['intent']} · {d['target']}" if d["intent"] else "(no refined_goal)"
        c.box(f"r{i}_2", cols[2][1], ry, cols[2][2], row_h, refined,
              base + "fillColor=#fff8e1;align=left;fontFamily=Courier New;")
        c.box(f"r{i}_3", cols[3][1], ry, cols[3][2], row_h, d["task_class"] or "-",
              base + "fillColor=#ffffff;align=center;fontFamily=Courier New;")
        # SCOPE tools — usually single_pass refiner on current master
        scope_names = [t["tool"] for t in d["scope_tools"]]
        scope_str = ", ".join(scope_names) if scope_names else "(none)"
        c.box(f"r{i}_4", cols[4][1], ry, cols[4][2], row_h, scope_str,
              base + "fillColor=#fff3e0;align=left;fontFamily=Courier New;")
        # EXECUTE tools — comma list, may span two lines
        exec_names = [t["tool"] for t in d["exec_tools"]]
        exec_str = " → ".join(exec_names) if exec_names else "(no tool_use — end_turn on iter 1)"
        # Cap at ~180 chars visually; the diagram cell will wrap
        if len(exec_str) > 220:
            exec_str = exec_str[:217] + "…"
        c.box(f"r{i}_5", cols[5][1], ry, cols[5][2], row_h, exec_str,
              base + "fillColor=#e3f2fd;align=left;fontFamily=Courier New;spacingTop=2;")
        c.box(f"r{i}_6", cols[6][1], ry, cols[6][2], row_h, d["passed_to"],
              base + f"fillColor={passed_to_fill(d['passed_to'])};align=center;fontStyle=1;")
        c.box(f"r{i}_7", cols[7][1], ry, cols[7][2], row_h, d["outcome"] or "-",
              base + f"fillColor={outcome_fill(d['outcome'])};align=center;fontStyle=1;")
        c.box(f"r{i}_8", cols[8][1], ry, cols[8][2], row_h, d["chosen_skill"] or "(none)",
              base + "fillColor=#ffffff;align=center;fontFamily=Courier New;fontSize=8;")

    # Footer legend
    footer_y = hdr_y + 30 + len(dispatches) * row_h + 12
    c.box("panelE_legend", EX + 20, footer_y, EW - 40, 44,
          "How to read: 'SCOPE tools' shows what the refiner mini-loop invoked — always "
          "`(single_pass refiner)` on current master (WI_STAGE1_ENABLED=1 path — 1 Anthropic call, no tools inside).\n"
          "'EXECUTE tools' is the ordered tool_use sequence Cypher's model emitted after SCOPE handed off the brief. "
          "'passed to' = PM (captured_to_board) | EXECUTE (phase=2) | SCOPE-only (didn't advance).",
          "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=10;fontStyle=2;fontColor=#455a64;spacingLeft=8;")

    # ── PANEL F — Predicted behavior under 3 candidate architectures ──────
    # Same 15 rows as Panel E. For each row, show what would happen under
    # Candidate A (data-honesty), B (skill-first), C (deliberative-first).
    # Data source: first-stage-15-panel-f.json (built by predict-panel-f.py).
    with open(predictions_path) as f:
        predictions = json.load(f)

    # Panel F sits below Panel E. Recalculate placement based on E's footer.
    FY = footer_y + 60
    FX, FW = EX, EW
    # 15 rows × 3 sub-rows × 26px each + header (56) + candidate header (30) + footer
    F_row_stack_h = 3 * 32  # 32 per candidate sub-row
    FH = 100 + len(predictions) * (F_row_stack_h + 6) + 50
    c.box("panelF", FX, FY, FW, FH,
          "PANEL F — Predicted behavior under 3 candidate architectures (same 15 rows as Panel E)",
          S_PANEL_L)

    # Candidate summary header
    c.box("panelF_summary", FX + 20, FY + 40, FW - 40, 44,
          "A · data-honesty upgrades (drop flag, non-null refined_goal, SSE brief, halt on low-conf) — predicted delta: 0/15 rows change (post-fix window; row-level impact is 0 because 5463fa1+4ee8194 already landed)   "
          "|   B · skill-first EXECUTE (refiner emits recommended_skill; model MUST dispatch it or record outcome) — 15/15 rows change (every primitive chain collapses to wi_dispatch + record_outcome)   "
          "|   C · deliberative-first routing (PM capture unless target has concrete artifact — ticket/PR/file/ADR/branch) — 5/15 rows flip EXECUTE → PM",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#e8eaf6;strokeColor=#3949ab;fontColor=#1a237e;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=10;spacingRight=10;")

    # Decision banner (2026-07-25) — user chose to ship all three in order A → C → B
    c.box("panelF_decision", FX + 20, FY + 88, FW - 40, 26,
          "▶ DECISION 2026-07-25 — Adopt ALL THREE, ship in order A → C → B. Rationale + rollout gates in .planning/first-stage-redesign/00-DECISION.md",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#e8f5e9;strokeColor=#2e7d32;fontColor=#1b5e20;fontSize=11;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=10;")

    # Table headers — narrower, per-row 3-line format (shifted +30 to accommodate decision banner)
    fhdr_y = FY + 126
    fcols = [
        ("#",                FX + 20,   30),
        ("goal + target",    FX + 50,   380),
        ("cand.",             FX + 430,  50),
        ("PROPOSED SCOPE tools",   FX + 480,  330),
        ("PROPOSED EXECUTE tools", FX + 810,  740),
        ("passed to",        FX + 1550, 90),
        ("outcome",          FX + 1640, 90),
        ("Δ / rationale",    FX + 1730, 590),
    ]
    for name, x, w in fcols:
        safe = re.sub(r"[^A-Za-z0-9_]", "_", name).lower() or "col"
        c.box(f"fh_{safe}", x, fhdr_y, w, 30, name,
              "rounded=0;whiteSpace=wrap;html=1;fillColor=#37474f;strokeColor=#263238;fontColor=#ffffff;fontStyle=1;fontSize=10;align=center;verticalAlign=middle;")

    # Per-row: 3 stacked sub-rows (A, B, C), with the goal+target spanning all 3
    def truncate(s, n):
        return s if len(s) <= n else s[:n-1] + "…"

    # Cell base style
    def cell(fill, align="left", family=""):
        base = "rounded=0;whiteSpace=wrap;html=1;strokeColor=#b0bec5;fontColor=#263238;fontSize=9;verticalAlign=middle;spacingLeft=6;spacingRight=6;"
        base += f"fillColor={fill};align={align};"
        if family:
            base += f"fontFamily={family};"
        return base

    def cand_color(letter, changed):
        # Muted when unchanged, saturated when changed
        if letter == "A":
            return ("#eceff1", "#37474f", "#455a64") if not changed else ("#cfd8dc", "#37474f", "#263238")
        if letter == "B":
            return ("#e3f2fd", "#0d3c78", "#1565c0") if not changed else ("#bbdefb", "#0d3c78", "#0d47a1")
        if letter == "C":
            return ("#fff3e0", "#bf360c", "#e65100") if not changed else ("#ffe0b2", "#bf360c", "#bf360c")
        return ("#ffffff", "#263238", "#90a4ae")

    sub_row_h = 32
    stack_h = 3 * sub_row_h + 4  # tiny gap after each row set

    row_y = fhdr_y + 30
    for i, p in enumerate(predictions):
        row_top = row_y + i * stack_h
        # Column 0: row number, spans all 3 sub-rows
        c.box(f"fr{i}_num", fcols[0][1], row_top, fcols[0][2], sub_row_h * 3, str(i + 1),
              cell("#f5f5f5", "center") + "fontStyle=1;")
        # Column 1: goal + target, spans all 3 sub-rows
        goal_target = truncate(p["goal"], 130) + "\n\n→ " + p["intent"] + " · " + truncate(p["target"], 100)
        c.box(f"fr{i}_gt", fcols[1][1], row_top, fcols[1][2], sub_row_h * 3, goal_target,
              cell("#ffffff", "left") + "spacingTop=4;")

        # Now three sub-rows, one per candidate
        for j, (letter, key) in enumerate([("A", "candidate_a"), ("B", "candidate_b"), ("C", "candidate_c")]):
            cand = p[key]
            sy = row_top + j * sub_row_h
            fill_bg, fill_fg, fill_border = cand_color(letter, cand["changed"])

            # Candidate letter cell
            marker = f"{letter} △" if cand["changed"] else f"{letter} ·"
            c.box(f"fr{i}_c{letter}_marker", fcols[2][1], sy, fcols[2][2], sub_row_h, marker,
                  f"rounded=0;whiteSpace=wrap;html=1;strokeColor={fill_border};fillColor={fill_bg};fontColor={fill_fg};fontSize=11;fontStyle=1;verticalAlign=middle;align=center;")

            # SCOPE tools
            scope_str = " → ".join(cand["scope_tools"])
            c.box(f"fr{i}_c{letter}_scope", fcols[3][1], sy, fcols[3][2], sub_row_h, truncate(scope_str, 100),
                  cell(fill_bg, "left", "Courier New"))

            # EXECUTE tools
            exec_str = " → ".join(cand["exec_tools"]) if cand["exec_tools"] else "(no EXECUTE — captured to PM)"
            c.box(f"fr{i}_c{letter}_exec", fcols[4][1], sy, fcols[4][2], sub_row_h, truncate(exec_str, 220),
                  cell(fill_bg, "left", "Courier New"))

            # passed_to
            c.box(f"fr{i}_c{letter}_pass", fcols[5][1], sy, fcols[5][2], sub_row_h, cand["passed_to"],
                  cell(fill_bg, "center") + "fontStyle=1;")

            # outcome
            c.box(f"fr{i}_c{letter}_out", fcols[6][1], sy, fcols[6][2], sub_row_h, cand["outcome"],
                  cell(fill_bg, "center") + "fontStyle=1;")

            # rationale
            c.box(f"fr{i}_c{letter}_why", fcols[7][1], sy, fcols[7][2], sub_row_h, truncate(cand["why"], 180),
                  cell(fill_bg, "left") + "fontStyle=2;")

    # Panel F footer
    f_footer_y = row_y + len(predictions) * stack_h + 12
    c.box("panelF_footer", FX + 20, f_footer_y, FW - 40, 44,
          "△ = row changes under this candidate  ·  · = row unchanged  ·  Muted color = unchanged prediction (identical to Panel E)  ·  Saturated color = predicted delta.  "
          "Cell contents on B and C are RULE-BASED predictions from predict-panel-f.py — the concrete-artifact classifier (C) uses regex markers "
          "for ticket/PR/file/ADR/branch shapes; the skill-mapper (B) uses task_class→skill fallback to intent→skill (grounded in .planning/skill-merging/PLAN.md).",
          "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=10;fontStyle=2;fontColor=#455a64;spacingLeft=8;")

    return c.body()


# ═══════════════════════════════════════════════════════════════════════════
# TAB 3 — 'pm-routing' — Current ADR-043 vs Proposed
# ═══════════════════════════════════════════════════════════════════════════

def build_pm_routing_tab():
    c = Canvas()

    c.box("title", 40, 12, 2320, 40,
          "PM routing — how deliberative goals become kanban cards",
          S_TITLE)
    c.box("subtitle", 40, 52, 2320, 22,
          "Two-column design canvas — LEFT: current ADR-043 as-designed · RIGHT: proposed (editable). See 'flow' tab for how SCOPE routes here.",
          S_SUBTITLE)
    c.box("pointer_flow", 40, 82, 2320, 26,
          "▶ Wider context — this diagram expands the purple 'PM routing' diamond + 'PM board (DELIBERATIVE)' box in Panel A of the 'flow' tab. loop.ts:1670 shouldCaptureToBoard()",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#ede7f6;strokeColor=#5e35b1;fontColor=#311b92;fontSize=10;fontStyle=2;verticalAlign=middle;align=left;spacingLeft=10;")

    # ── CURRENT column (LEFT) — ADR-043 as-designed ────────────────────────
    CX, CY, CW, CH = 40, 120, 1150, 1300
    c.box("panel_current", CX, CY, CW, CH,
          "CURRENT — ADR-043 as-designed (5 stages, 0 rows in last 30d)",
          S_ASBUILT_PANEL)

    # 1. Routing diamond
    c.box("cur_route", CX+90, CY+60, CW-180, 100,
          "shouldCaptureToBoard(refinedGoal)\n"
          "\n"
          "intent ∈ {brainstorm, plan, decide}?",
          S_DIAMOND)
    c.box("cur_route_ref", CX+30, CY+165, CW-60, 20,
          "loop.ts:1670 · task-memory.ts REFINED_INTENT_TO_PM_INTENT",
          S_CODE_REF)

    # 2. CAPTURE
    c.box("cur_capture", CX+30, CY+205, CW-60, 100,
          "1 · CAPTURE — captureToBoard()\n"
          "\n"
          "· Insert tasks row: {id: task_…, goal_text, pm_intent, source_session_id}\n"
          "· intent enum: brainstorm | plan | decide (from mapping above)\n"
          "· Session closes with outcome='captured_to_board'\n"
          "· NO execution — this is a thinking-card, not a doing-card",
          S_PMBOX)
    c.box("cur_capture_ref", CX+30, CY+307, CW-60, 20,
          "src/services/cypher/pm-capture-hook.ts:89",
          S_CODE_REF)

    # 3. PRIORITIZE
    c.box("cur_prio", CX+30, CY+347, CW-60, 90,
          "2 · PRIORITIZE — manual /pm commands\n"
          "\n"
          "· /pm prioritize task_… <n>  — set priority 1..N\n"
          "· /pm effort task_… <sml|med|lrg>  — set effort estimate",
          S_PMBOX)
    c.box("cur_prio_ref", CX+30, CY+439, CW-60, 20,
          "src/services/board/priority.ts · /pm slash-command handlers",
          S_CODE_REF)

    # 4. RANK
    c.box("cur_rank", CX+30, CY+479, CW-60, 90,
          "3 · RANK — scored backlog list\n"
          "\n"
          "· ranker.ts computes score = f(priority, effort, staleness, deps)\n"
          "· Explicit contribution breakdown per card (auditable)",
          S_PMBOX)
    c.box("cur_rank_ref", CX+30, CY+571, CW-60, 20,
          "src/services/board/ranker.ts",
          S_CODE_REF)

    # 5. QUERY
    c.box("cur_query", CX+30, CY+611, CW-60, 90,
          "4 · QUERY — /pm next\n"
          "\n"
          "· GET /api/board/backlog → { top_task_id, backlog[] }\n"
          "· Answers 'what should I work on next?'",
          S_PMBOX)
    c.box("cur_query_ref", CX+30, CY+703, CW-60, 20,
          "web-server.js /api/board/backlog · /pm next handler",
          S_CODE_REF)

    # 6. BOARD (kanban home)
    c.box("cur_board", CX+30, CY+743, CW-60, 80,
          "WI KANBAN BOARD — /board (ADR-040)\n"
          "\n"
          "· Card lives here until a human promotes it OR archives it\n"
          "· Columns: pending · in_progress · shipped · blocked · deferred",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#d1c4e9;strokeColor=#5e35b1;fontColor=#311b92;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=8;")

    # 7. BoardWorker
    c.box("cur_worker", CX+30, CY+843, CW-60, 100,
          "5 · WORKER — BoardWorkerAgent\n"
          "\n"
          "· Picks up cards with intent='execute' (promoted / re-curated)\n"
          "· Dispatches BACK through /wi EXECUTE (recursive)\n"
          "· Deliberative cards wait for a human decision first",
          S_PMBOX)
    c.box("cur_worker_ref", CX+30, CY+945, CW-60, 20,
          "src/intelligence/board-worker-agent.ts",
          S_CODE_REF)

    # 8. Reality note
    c.box("cur_reality", CX+30, CY+985, CW-60, 80,
          "⚠ REALITY (2026-07-25)\n"
          "\n"
          "0 cypher_sessions rows with outcome='captured_to_board' in last 30d.\n"
          "The branch exists but is empirically quiet. Either users are typing\n"
          "'doing' verbs, or the classifier maps them all to execute-intents.",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;dashed=1;fillColor=#eceff1;strokeColor=#78909c;fontColor=#37474f;fontSize=10;fontStyle=2;verticalAlign=middle;align=left;spacingLeft=8;")

    # Edges
    c.edge("cur_e1","cur_route",  "cur_capture","intent ∈ {brainstorm,plan,decide}",
           S_ARROW_PM)
    c.edge("cur_e2","cur_capture","cur_prio",   "",   S_ARROW_ASBUILT)
    c.edge("cur_e3","cur_prio",   "cur_rank",   "",   S_ARROW_ASBUILT)
    c.edge("cur_e4","cur_rank",   "cur_query",  "",   S_ARROW_ASBUILT)
    c.edge("cur_e5","cur_query",  "cur_board",  "",   S_ARROW_ASBUILT)
    c.edge("cur_e6","cur_board",  "cur_worker", "promote (intent→execute)",
           S_ARROW_EX)

    # ── PROPOSED column (RIGHT) — ADR-053 Multi-Stage Orchestration ─────────
    PX, PY, PW, PH = 1210, 120, 1150, 1300
    c.box("panel_proposed", PX, PY, PW, PH,
          "PROPOSED — ADR-053 Multi-Stage Orchestration (Proposed 2026-07-27, 4-6wk build)",
          S_ASDESIRED_PANEL)

    c.box("prop_intro", PX+30, PY+50, PW-60, 84,
          "ADR-053 — full coordination layer on top of existing runLoop. Gated ADR_053_ENABLED=1.\n"
          "MVP scope: HORIZONTAL SLICE for one goal shape (feature.cross-repo — the flagship\n"
          "lotse example). Other shapes fall through to today's flat runLoop unchanged.\n"
          "Hard blocker: ADR-040 § 49.2 e2e-column advancement bug must be fixed first.",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#e8f5e9;strokeColor=#2e7d32;fontColor=#1b5e20;fontSize=10;fontStyle=2;verticalAlign=middle;align=left;spacingLeft=8;")

    # Stage 1 — SCOPE (unchanged in MVP)
    c.box("prop_stage1", PX+30, PY+150, PW-60, 90,
          "STAGE 1 — SCOPE (unchanged in MVP, ADR-042)\n"
          "\n"
          "Emits RefinedGoal { intent, target, constraints, success_criteria }.\n"
          "Q3 hydration manifest DEFERRED to follow-up ADR. MVP hard-codes hydration\n"
          "inside the feature.cross-repo template.",
          S_ASDESIRED_BOX)

    # Stage 2 — PM (new posture)
    c.box("prop_stage2_pm", PX+30, PY+254, PW-60, 118,
          "STAGE 2a — PM ORCHESTRATOR (new posture='pm', Sonnet bucket)\n"
          "\n"
          "1. Hydrate context (blast-radius + prompt_memory + wi-people + palace)\n"
          "2. LLM drafts DAG: {sub_tasks: [{posture, model_bucket, depends_on}]}\n"
          "3. Template validator layer (Q5) — Kahn cycle-check, missing-ops-check, etc.\n"
          "4. Emit board cards (Q6 — kanban IS the graph)",
          S_ASDESIRED_BOX)

    # Stage 2 — Architect (new posture)
    c.box("prop_stage2_arch", PX+30, PY+386, PW-60, 96,
          "STAGE 2b — ARCHITECT (new posture='architect', Opus bucket)\n"
          "\n"
          "MVP: always called once per goal after PM decomposition (Q4 Option A).\n"
          "Reviews {plan, hydration_evidence} → {verdict: approved|revise, notes[]}.\n"
          "🎯 RADAR: switch to Option B (hard-boundary heuristic) after ~50 goals.",
          S_ASDESIRED_BOX)

    # Board as graph (Q6)
    c.box("prop_board", PX+30, PY+496, PW-60, 100,
          "BOARD IS THE GRAPH (Q6 Option D — closest to user's goal)\n"
          "\n"
          "PM emits N board cards populating the EXISTING tasks.depends_on_json\n"
          "(JSON array of parent task_ids, shipped ADR-040 v90). BoardWorkerAgent.depsDone()\n"
          "dispatches cards whose depends_on_json parents all reached kanban_column='done'. User watches\n"
          "orchestration LIVE on /board UI as cards move through columns.",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#d1c4e9;strokeColor=#5e35b1;fontColor=#311b92;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=8;")

    # Stage 3 — Executor
    c.box("prop_stage3", PX+30, PY+610, PW-60, 108,
          "STAGE 3 — EXECUTOR (current runLoop, UNCHANGED)\n"
          "\n"
          "posture per PM's decomposition (fe|be|ops|generic). NOT a self-learning\n"
          "specialist per role — Q1 pinned learning at Beta-prior level. Executor is\n"
          "'dumb' in the vision's framing but reuses today's full runLoop primitive.\n"
          "NEW tool in execute-phase catalog: emit_sub_task_event(kind, payload).",
          S_ASDESIRED_BOX)

    # Feedback loop
    c.box("prop_feedback", PX+30, PY+732, PW-60, 118,
          "FEEDBACK LOOP (Q7 Option B — sub_task_events + PM re-entry)\n"
          "\n"
          "v107 migration adds sub_task_events table. Executors emit events during\n"
          "runs (kind ∈ question|partial|blocker|scope_discovery). PM does NOT stay\n"
          "alive — events accumulate. User (MVP) or BoardWorkerAgent (follow-up)\n"
          "triggers /wi resume <parent_goal_id> → PM re-enters via new phase='pm-resume'\n"
          "and resolves events (ack | revise | amend plan | escalate).",
          S_ASDESIRED_BOX)

    # Scope + blockers
    c.box("prop_scope", PX+30, PY+864, PW-60, 118,
          "MVP SCOPE — 4-6 weeks, ~1000-1100 LOC delta, fully behind ADR_053_ENABLED\n"
          "\n"
          "2 migrations: v107 (sub_task_events), v108 (posture enum). No depends_on migration — uses existing depends_on_json.\n"
          "2 model_config buckets added: pm (Sonnet), architect (Opus).\n"
          "1 template: feature.cross-repo (~100 LOC + ~200 LOC harness).\n"
          "1 new endpoint: /wi resume; 1 SQL clause update on BoardWorkerAgent.\n"
          "🎯 Hard blocker: ADR-040 § 49.2 must be fixed FIRST.",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#fff3e0;strokeColor=#e65100;fontColor=#bf360c;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=8;")

    # Deferred to follow-up
    c.box("prop_deferred", PX+30, PY+996, PW-60, 118,
          "DEFERRED TO FOLLOW-UP ADRs (locked on RADAR)\n"
          "\n"
          "· Q3 hydration manifest (Stage 1 authors, PM executes) — MVP hard-codes it\n"
          "· 6+ additional templates (single-repo-bug, refactor, migration, etc.)\n"
          "· Auto-triggered PM re-entry (BoardWorkerAgent watches for stale events)\n"
          "· Board UI hierarchical grouping (flat depends_on in MVP)\n"
          "· Per-task model selection at PM's discretion\n"
          "· Architect quality eval harness (Beta priors only in MVP)",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;dashed=1;fillColor=#ffffff;strokeColor=#78909c;fontColor=#37474f;fontSize=10;fontStyle=2;verticalAlign=middle;align=left;spacingLeft=8;")

    # Legend / pointers
    c.box("prop_legend", PX+30, PY+PH-158, PW-60, 148,
          "See:\n"
          "· docs/docs/adr/adr-053-multi-stage-orchestration.md — full ADR (Proposed)\n"
          "· .planning/adr-053-multi-stage-orchestration/DISCUSSION.md — Q1-Q8 design log\n"
          "· .hermes/plans/2026-07-27_adr-053-mvp-implementation-plan.md — task-by-task TDD plan\n"
          "\n"
          "Design decisions locked (Q1-Q8):\n"
          "Q1: coordination layer (not new arch)  ·  Q2: PM + Architect separate agents\n"
          "Q3: hydration manifest (DEFERRED)     ·  Q4: always-Architect for MVP, radar Option B\n"
          "Q5: LLM proposes + templates validate  ·  Q6: kanban IS the graph\n"
          "Q7: sub_task_events + PM re-entry     ·  Q8: horizontal slice for feature.cross-repo",
          "rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=#fff8e1;strokeColor=#f57c00;fontColor=#bf360c;fontSize=10;fontStyle=1;verticalAlign=middle;align=left;spacingLeft=8;")

    # Edges — the flow through the new tier
    c.edge("prop_e1", "prop_stage1",     "prop_stage2_pm",   "feature.cross-repo shape detected", S_ARROW_PM)
    c.edge("prop_e2", "prop_stage2_pm",  "prop_stage2_arch", "draft plan", S_ARROW_PM)
    c.edge("prop_e3", "prop_stage2_arch","prop_board",       "approved OR revised", S_ARROW_PM)
    c.edge("prop_e4", "prop_board",      "prop_stage3",      "dispatchable (parents complete)", S_ARROW_EX)
    c.edge("prop_e5", "prop_stage3",     "prop_feedback",    "emit_sub_task_event", S_ARROW_ASBUILT)
    c.edge("prop_e6", "prop_feedback",   "prop_stage2_pm",   "/wi resume → pm-resume phase", S_ARROW_PM)

    c.box("pm_divider", 1195, 120, 5, 1300, "",
          "rounded=0;whiteSpace=wrap;html=1;fillColor=#bdbdbd;strokeColor=#bdbdbd;")

    return c.body()


# ═══════════════════════════════════════════════════════════════════════════
# Assemble the multi-tab file. Reuse the existing v4 script as-is for tab 1.
# ═══════════════════════════════════════════════════════════════════════════

# For tab 1, we need to re-emit the v4 diagram. The cleanest way is to import
# the v4 script's build logic, but the v4 script writes a full <mxfile>.
# Simpler: re-run the v4 script's output-generation and lift its <diagram>
# block. We do that via a small extractor.

import subprocess, os, re

def extract_v4_flow_diagram():
    """Regenerate the v4 diagram file, parse it, and return just the <diagram> block."""
    subprocess.check_call(["python3", v4_script])
    with open(v4_out) as f:
        content = f.read()
    # Grab the <diagram>...</diagram> block, whatever id/name it currently has,
    # and rename it to 'flow' so the tab labels are consistent.
    m = re.search(r'<diagram\s[^>]*>(.*?)</diagram>', content, re.DOTALL)
    if not m:
        raise SystemExit("failed to find <diagram> in v4 output")
    inner = m.group(1)
    return f'  <diagram id="flow" name="flow (architecture)">\n{inner}\n  </diagram>\n'


def main():
    # Tab 1: v4 flow (regenerated fresh)
    flow_tab = extract_v4_flow_diagram()

    # Tab 2: first-stage (as-built + as-desired)
    fs_body = build_first_stage_tab()
    firststage_tab = build_diagram("first-stage", "first-stage (SCOPE canvas)", 2400, 4300, fs_body)

    # Tab 3: pm-routing (current + proposed)
    pm_body = build_pm_routing_tab()
    pm_tab = build_diagram("pm-routing", "pm-routing (design canvas)", 2400, 1440, pm_body)

    # Combine
    xml = (
        '<mxfile host="65bd71144e">\n'
        + flow_tab
        + firststage_tab
        + pm_tab
        + '</mxfile>\n'
    )

    # Validate
    ET.fromstring(xml)

    with open(out, "w") as f:
        f.write(xml)
    print(f"OK wrote {out}")
    print(f"tabs: flow · first-stage · pm-routing")
    print(f"bytes={len(xml)} lines={xml.count(chr(10))}")


if __name__ == "__main__":
    main()
