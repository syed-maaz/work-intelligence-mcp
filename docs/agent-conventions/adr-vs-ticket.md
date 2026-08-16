# ADR vs. ticket — categorize before you write

> Before writing an ADR, ask ONE question: **am I recording a *decision* (why we chose X over Y), or a *thing to build/fix*?**
> - **Decision** (durable, rarely changes, explains a trade-off) → **ADR** in `docs/docs/adr/`.
> - **Build / fix / task** (has an open→done lifecycle, a fix commit, a test) → **board card** on `/board` (`POST /api/cypher/tasks` or `cypher_task_create`), NOT an ADR.

## Why this rule exists

ADRs became a catch-all because they were the only durable structured writing surface — so bugs and features got written as ADRs too. That's a category error with real cost:

- **ADRs stop meaning "decision."** An index full of bugs-dressed-as-ADRs can't answer "what did we decide and why."
- **Bugs/features don't get the lifecycle they need.** A bug wants status (open/fixed), a fix commit, a regression test. An ADR only has Proposed→Accepted (a *decision* lifecycle) — so a bug filed as an ADR sits "Proposed" forever and never closes.

The trigger case: **ADR-041** was a bug report (a 502 error rendered as content for an hour) written as an ADR. It sat "Proposed" indefinitely because it had no decision to accept. Converted to board card `tsk_676dfa687998` on 2026-07-15.

## The test

| It is… | Signal | Home |
|---|---|---|
| **Decision (ADR)** | "we chose X over Y because…"; a trade-off; alternatives-explored table; rarely changes once accepted | `docs/docs/adr/adr-NNN-*.md` |
| **Bug (ticket)** | opens with an incident/repro; "this is broken, here's the fix"; wants a fix commit + regression test | `/board` card |
| **Feature (ticket)** | "build capability Z"; has acceptance criteria + a ship state | `/board` card |
| **Both** | a feature that also requires a genuine architectural decision | ADR for the decision + ticket(s) for the build, cross-linked |

If it opens with a timestamp, a reproduction, or "here's the fix" — it's a ticket. If it opens with "we need to choose between A and B" — it's an ADR.

## When unsure

Default to a **board card**. A ticket can always spawn an ADR when a real decision surfaces mid-build; an ADR can't easily become a tracked, closeable ticket. Under-filing as a ticket is cheap; over-filing as an ADR pollutes the decision record.
