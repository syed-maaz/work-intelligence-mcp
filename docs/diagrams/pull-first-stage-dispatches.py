#!/usr/bin/env python3
"""Pull 15 real dispatches from cypher_sessions with SCOPE + EXECUTE tool traces.

Outputs a JSON blob the diagram builder can consume. Deterministic so the
diagram is reproducible from the same DB snapshot.
"""
import sqlite3, json, os, re

DB = os.path.expanduser("~/.work-intelligence-mcp/data.db")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

# Pick 15 recent real user dispatches (exclude smoke tests + author-scaffold noise),
# with a mix of shapes: has-brief/no-brief, phase=1/2, dispatched/no-dispatch,
# and both capture-eligible + execute intents. Sort by newest.
sessions = conn.execute("""
    SELECT session_id, substr(goal, 1, 140) as goal, refined_goal, phase,
           chosen_skill, outcome, task_class, posture, scope_iters,
           duration_ms, started_at
      FROM cypher_sessions
     WHERE started_at > datetime('now','-30 days')
       AND goal NOT LIKE 'smoke%'
       AND goal NOT LIKE 'author new skill%'
       AND refined_goal IS NOT NULL
       AND length(refined_goal) > 20
     ORDER BY started_at DESC
     LIMIT 15
""").fetchall()

def tool_calls_for(session_id, phase):
    rows = conn.execute("""
        SELECT stage_index, payload FROM cypher_steps
         WHERE session_id = ? AND phase = ? AND stage = 'tool_use'
         ORDER BY stage_index ASC
    """, (session_id, phase)).fetchall()
    out = []
    for r in rows:
        try:
            p = json.loads(r["payload"] or "{}")
            tool = p.get("tool") or p.get("single_pass") and "(single_pass refiner)" or "?"
            inp = p.get("input") or {}
            # Truncate the input payload aggressively — we only want the shape,
            # not full user text
            inp_summary = ""
            if isinstance(inp, dict):
                keys = list(inp.keys())[:3]
                parts = []
                for k in keys:
                    v = inp[k]
                    vs = json.dumps(v) if not isinstance(v, str) else v
                    vs = vs.replace("\n", " ")
                    parts.append(f"{k}={vs[:35]}")
                inp_summary = ", ".join(parts)
            out.append({"idx": r["stage_index"], "tool": tool, "input_summary": inp_summary[:120]})
        except Exception:
            out.append({"idx": r["stage_index"], "tool": "?", "input_summary": "(parse err)"})
    return out


results = []
for s in sessions:
    scope_tools = tool_calls_for(s["session_id"], "scope")
    exec_tools  = tool_calls_for(s["session_id"], "execute")
    # Parse refined_goal for intent + target
    intent = target = ""
    try:
        rg = json.loads(s["refined_goal"]) if s["refined_goal"] else {}
        intent = str(rg.get("intent", ""))[:20]
        target = str(rg.get("target", ""))[:80]
    except Exception:
        pass
    results.append({
        "session_id": s["session_id"],
        "goal": s["goal"],
        "intent": intent,
        "target": target,
        "task_class": s["task_class"] or "",
        "phase": s["phase"],
        "chosen_skill": s["chosen_skill"] or "",
        "outcome": s["outcome"] or "",
        "scope_iters": s["scope_iters"] or 0,
        "duration_ms": s["duration_ms"] or 0,
        "scope_tools": scope_tools,
        "exec_tools": exec_tools,
        # Where did the goal end up going after SCOPE?
        "passed_to": "PM" if s["outcome"] == "captured_to_board"
                     else ("EXECUTE" if s["phase"] == 2 else "SCOPE-only"),
    })

with open(out_path, "w") as f:
    json.dump(results, f, indent=2)
print(f"wrote {out_path} ({len(results)} rows)")
for r in results:
    print(f"  {r['session_id'][:20]}  ph{r['phase']} · intent={r['intent']:12s} · scope_tools={len(r['scope_tools']):2d} · exec_tools={len(r['exec_tools']):2d} · outcome={r['outcome']} → {r['passed_to']}")
