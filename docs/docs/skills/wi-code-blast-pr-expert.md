---
sidebar_label: "Code, PR & Team Skills"
---

# Skills Reference — Code, PR & Team Intelligence

---

## /wi-who-owns

Look up code ownership for a file or path.

```
/wi-who-owns <file-path-or-glob>
```

**Examples:**
```
/wi-who-owns src/auth/login.ts
/wi-who-owns src/recommendations/
```

**Output:**
- Primary owner + team
- Last N contributors with commit dates
- Subsystem name
- Blast radius: direct dependents → transitive dependents → affected tests → risk score

---

## /wi-blast-radius

Calculate the blast radius of a file change or PR.

```
/wi-blast-radius <file-path>
/wi-blast-radius <PR-URL>
```

**Examples:**
```
/wi-blast-radius src/auth/middleware.ts
/wi-blast-radius https://github.com/acme/example-service/pull/6107
```

**Risk scoring:**

| Score | Dependent count | Test coverage |
|-------|----------------|---------------|
| LOW | < 10 files | Tests exist |
| MEDIUM | 10–50 files | Partial tests |
| HIGH | 50–200 files | Few/no tests |
| CRITICAL | > 200 files | No tests |

---

## /wi-pr-review

Work-context PR review: related tickets, ownership, risk, patterns.

```
/wi-pr-review <PR-URL>
/wi-pr-review <owner/repo#number>
```

**What gets injected beyond the diff:**
- Related Jira tickets (from PR title/description)
- Code ownership for changed files
- Blast radius score
- Patterns from similar past changes in the same area
- AI-generated line-level review comments

**Verdict:** APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION

---

## /wi-find-expert

Find the best teammate for a skill, code area, or domain.

```
/wi-find-expert <skill or path or topic>
```

**Examples:**
```
/wi-find-expert authentication middleware
/wi-find-expert src/recommendations/
/wi-find-expert SMRDP integration
```

**Matching algorithm:**
1. Code ownership (primary author of relevant files)
2. Recent Jira activity (tickets in this area)
3. Teams messages (active discussion in related channels)
4. Fallback: Levenshtein alias resolution

**Returns:** Top match with confidence score + 2 alternatives + evidence trail.

---

## /wi-teammate

Full teammate profile: activity across all sources, expertise, owned code.

```
/wi-teammate <name or email>
```

**Examples:**
```
/wi-teammate alice chen
/wi-teammate alice.chen@.com
```

**Profile sections:** Expertise Areas • Code Ownership • Recent Jira Activity • Teams Activity • Recent Decisions

---

## /wi-code-research

Self-evolving codebase research engine.

```
/wi-code-research <research question>
```

**Examples:**
```
/wi-code-research "how does the recommendation engine decide which links to show?"
/wi-code-research "what calls the feature flag evaluation in example-service?"
```

**How it works:**
1. Cost Gate (Haiku) classifies whether the question is worth running Claude Code
2. Checks 24h cache (SHA-256 keyed)
3. Runs Claude Code with the current OPRO-evolved prompt template
4. Quality scorer rates result (0.0–1.0)
5. Poor results (< 0.4) trigger TextGrad repair

**Quality Score:** Shown with the result — below 0.4 = treat as hypothesis only.

See [ADR-021: Claude Code Research Engine](../adr/adr-021-claude-code-research-engine.md) for architecture details.
