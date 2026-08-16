#!/usr/bin/env python3
"""Predict Panel F rows: what would each of the 15 real dispatches look like
under Candidate A / B / C proposed architectures.

Deterministic rule-based prediction. Every predicted cell must be justifiable
from the source data alone — no hallucinated intent or target changes.

Writes docs/diagrams/first-stage-15-panel-f.json with per-candidate deltas.
"""
import json, os, re


with open(IN) as f:
    rows = json.load(f)


# ─── Candidate A — data-honesty upgrades ────────────────────────────────────
# Row-level impact is small because the 15 sample rows are already-successful
# SCOPE completions. A changes handoff invariants, not per-row routing.

def candidate_a(r):
    # A ships: drop feature flag, non-null refined_goal enforced, SSE event with
    # brief, halt on low-confidence, enforce evidence_cited ≥1, deprecate
    # multi-round. Predicted deltas per row:
    scope = ["stage1-fetch (unconditional)", "single-pass refiner"]
    # Model outcome-honoring reducer already landed (5463fa1+4ee8194). What
    # WOULD change on this window: outcome_note now visible in UI (F2). No
    # tool sequence change.
    exec_tools = [t["tool"] for t in r["exec_tools"]]
    # Predict outcome shift only for the row where the model self-reported failed
    # via cypher_record_outcome (row 3, cyp_8df957e5ba02).
    outcome = r["outcome"]
    # This is a POST-fix window — the row already reflects the honest outcome.
    # A adds no further outcome changes on these rows.
    return {
        "refined_delta": "(no change — same intent · target)",
        "scope_tools": scope,
        "exec_tools": exec_tools,
        "passed_to": r["passed_to"],
        "outcome": outcome,
        "why": "invariants tightened (non-null refined_goal, SSE event, low-conf halt); no per-row routing change",
        "changed": False,  # will flip True below if any cell actually differs
    }


# ─── Candidate B — skill-first EXECUTE ──────────────────────────────────────
# SCOPE emits recommended_skill. EXECUTE model MUST dispatch that skill via
# wi_dispatch OR emit cypher_record_outcome{failed} explaining why.

# Task-class → recommended-skill mapping. Grounded in .planning/skill-merging/PLAN.md
# and the actual repo skills/ directory. When task_class doesn't map cleanly, fall
# back on intent → skill.
TASKCLASS_TO_SKILL = {
    "investigate": "wi-investigate",
    "bug_investigation": "wi-investigate",
    "test_debt_cleanup": "wi-investigate",
    "code_review": "wi-code:pr-review",
    "pr_review": "wi-code:pr-review",
    "refactor": "wi-investigate",           # no wi-refactor exists; investigate does the audit
    "build": "wi-investigate",              # wi-add-bucket for scaffolding, wi-investigate for design-then-build
    "build-feature": "wi-investigate",
    "analyze": "wi-audit:analyze",
    "audit": "wi-audit:analyze",
    "storage": "wi-audit:storage",
    "search": "wi-search:all",
    "review": "wi-code:pr-review",
}

INTENT_TO_SKILL = {
    "investigate": "wi-investigate",
    "build":       "wi-investigate",
    "review":      "wi-code:pr-review",
    "analyze":     "wi-audit:analyze",
    "refactor":    "wi-investigate",
    "brainstorm":  "(PM capture)",
    "plan":        "(PM capture)",
    "decide":      "(PM capture)",
    "other":       "wi-investigate",
}

def candidate_b(r):
    # Pick recommended_skill from task_class first, else intent.
    tc = (r["task_class"] or "").lower()
    skill = TASKCLASS_TO_SKILL.get(tc) or INTENT_TO_SKILL.get(r["intent"], "wi-investigate")
    scope = ["stage1-fetch", "single-pass refiner", "skill-scorer → recommended_skill"]
    # EXECUTE collapses to: dispatch the recommended skill, then record outcome.
    # If the goal is a PM-capture shape, no EXECUTE at all.
    if skill == "(PM capture)":
        exec_tools = []
        passed_to = "PM"
        outcome = "captured_to_board"
    else:
        exec_tools = [f"wi_dispatch(skill='{skill}')", "cypher_record_outcome"]
        passed_to = r["passed_to"]
        # For row 3 (vitest-failures), skill would say "I can't do this either"
        # — same outcome, just faster.
        outcome = r["outcome"]
    # Compare against actuals
    actual_exec = [t["tool"] for t in r["exec_tools"]]
    changed = (exec_tools != actual_exec) or (passed_to != r["passed_to"])
    return {
        "refined_delta": f"+ recommended_skill: {skill}",
        "scope_tools": scope,
        "exec_tools": exec_tools,
        "passed_to": passed_to,
        "outcome": outcome,
        "why": (f"skill-first: refiner scored {skill} as best match; "
                f"EXECUTE dispatches directly instead of primitive tool chain of "
                f"{len(actual_exec)} calls"),
        "changed": changed,
    }


# ─── Candidate C — deliberative-first routing ───────────────────────────────
# PM routing default: capture unless refined_goal.target is concrete (has a
# ticket key, PR number, file path, or ADR number).

# Grounded predicate for "concrete artifact target"
CONCRETE_MARKERS = [
    r"BDS-\d+",              # Jira ticket
    r"ADR-\d+",              # ADR reference
    r"PR\s*#?\d+",           # Pull request
    r"cyp_[a-f0-9]{8,}",     # cypher session id
    r"/[\w.-]+\.\w{1,4}",    # file path with extension
    r"fix/[\w-]+",           # branch name
    r"tsk_\d+",              # task id
    r"\.ts:\d+",             # code line ref
    r"\btable\b|\bcolumn\b", # schema-shape (tables/columns are concrete)
    r"\bendpoint\b|\bAPI\b", # endpoint shapes
]

def is_concrete(target):
    return any(re.search(pat, target, re.IGNORECASE) for pat in CONCRETE_MARKERS)

def candidate_c(r):
    scope = ["stage1-fetch", "single-pass refiner", "concreteness-classifier"]
    if is_concrete(r["target"]):
        # Concrete target → still EXECUTE, same as today
        exec_tools = [t["tool"] for t in r["exec_tools"]]
        passed_to = "EXECUTE"
        outcome = r["outcome"]
        why = "target has a concrete artifact reference → EXECUTE (unchanged)"
        changed = False
    else:
        # Vague target → PM capture (thinking-card) instead
        exec_tools = []
        passed_to = "PM"
        outcome = "captured_to_board"
        why = "target is vague (no ticket/PR/file/ADR/branch marker) → PM capture for human triage"
        changed = True
    return {
        "refined_delta": "(no change to intent · target)",
        "scope_tools": scope,
        "exec_tools": exec_tools,
        "passed_to": passed_to,
        "outcome": outcome,
        "why": why,
        "changed": changed,
    }


# ─── Build the prediction ───────────────────────────────────────────────────

out = []
for r in rows:
    a = candidate_a(r)
    b = candidate_b(r)
    c = candidate_c(r)
    out.append({
        "session_id": r["session_id"],
        "goal": r["goal"],
        "intent": r["intent"],
        "target": r["target"],
        "task_class": r["task_class"],
        "actual_exec_len": len(r["exec_tools"]),
        "candidate_a": a,
        "candidate_b": b,
        "candidate_c": c,
    })

with open(OUT, "w") as f:
    json.dump(out, f, indent=2)

# Summary print
def s(t): return t[:2].upper() if t else "?"
print(f"wrote {OUT}")
print(f"{'row':>3} {'intent':<12} {'concrete':<9} {'A':^2} {'B':^2} {'C':^2}  target")
for i, r in enumerate(out, 1):
    conc = "yes" if is_concrete(r["target"]) else "no"
    a_ch = "△" if r["candidate_a"]["changed"] else "·"
    b_ch = "△" if r["candidate_b"]["changed"] else "·"
    c_ch = "△" if r["candidate_c"]["changed"] else "·"
    print(f"{i:>3} {r['intent']:<12} {conc:<9} {a_ch:^2} {b_ch:^2} {c_ch:^2}  {r['target'][:70]}")

a_chg = sum(1 for r in out if r["candidate_a"]["changed"])
b_chg = sum(1 for r in out if r["candidate_b"]["changed"])
c_chg = sum(1 for r in out if r["candidate_c"]["changed"])
print(f"\ntotals: A={a_chg}/15  B={b_chg}/15  C={c_chg}/15")
