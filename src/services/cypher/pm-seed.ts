/**
 * PM ingestion — seed work_items from planning markdown (PM-1, 2026-06-13).
 *
 * Strategy: parse the AC tables in the Phase 80 PRD, plus the PM-1
 * self-bootstrap entries (cypher-* slices shipped today + the PM
 * subsystem itself). Idempotent — re-running upserts.
 *
 * The shim is intentionally narrow: only the planning artifacts that
 * exist today get scanned. New phases / waves get handled by hand
 * (or by a future expansion of this shim) — the goal here is to seed
 * enough state that the PM lens has real data to query, not to build
 * a perfect markdown→SQL parser.
 *
 * Run via: `node --import tsx/esm scripts/seed-cypher-pm.ts`
 *   or via the bridge boot block (PM-2).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { upsertWorkItem, linkEvidence, type WorkItemStatus } from './pm.js';

interface ParsedAC {
  ac_id: string;
  wave: string;
  description: string;
  smoke_section: string | null;
}

/**
 * Parse the Phase 80 PRD's AC tables. The format (from the PRD as of
 * 2026-06-13):
 *
 *   ### Phase 77a (Tier-0 + canonical-prose pre-fill + Tier-1 logging)
 *
 *   | # | AC | Smoke | Status today |
 *   |---|---|---|---|
 *   | AC-1 | Schema v57 ... | § 17a | TBD |
 *   | AC-2 | ... | § 17a | TBD |
 *
 * Returns one row per AC line. The wave is the "### Phase 77x ..." header
 * the AC sits under. Cross-cutting ACs land under wave='cross-cutting'.
 */
export function parsePrdAcs(prdPath: string): ParsedAC[] {
  let text: string;
  try {
    text = readFileSync(prdPath, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  let currentWave = 'unknown';
  const out: ParsedAC[] = [];

  for (const line of lines) {
    // Wave header — match "### Phase 77a (...)" or "### Cross-cutting (...)"
    const phaseMatch = line.match(/^###\s+Phase\s+(77[a-z])\b/i);
    if (phaseMatch) {
      currentWave = phaseMatch[1].toLowerCase();
      continue;
    }
    if (/^###\s+Cross-cutting/i.test(line)) {
      currentWave = 'cross-cutting';
      continue;
    }

    // AC table row — pipe-delimited, starts with `| AC-N |`.
    const acMatch = line.match(/^\|\s*AC-(\d+)\s*\|\s*(.+?)\s*\|\s*(§ \S+|manual|bench|new § \S+|smoke|code grep|doc \+ dry-run|manual \+ replay)\s*\|/);
    if (acMatch) {
      const acNum = acMatch[1];
      const description = acMatch[2].replace(/\*\*/g, '').trim();
      const smoke = acMatch[3].trim();
      out.push({
        ac_id: `PERSONA-AC-${acNum}`,
        wave: currentWave,
        description,
        smoke_section: smoke === 'manual' || smoke === 'bench' || smoke === 'doc + dry-run' ? null : smoke,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedReport {
  persona_acs_seeded: number;
  cypher_items_seeded: number;
  evidence_links: number;
  errors: string[];
}

/**
 * Seed work_items with everything we know about today.
 *
 * Three batches:
 *   1. Phase 80 PRD ACs — 38 rows from the markdown.
 *   2. Cypher slices shipped today — schema v59, /wi, candidates.ts, etc.
 *   3. PM lens self-bootstrap — PM-1 through PM-5 as work items.
 *
 * Then link the commits + Cypher session ids that already exist as
 * evidence for the cypher-* items. Idempotent.
 */
export function seedWorkItems(db: Database.Database, repoRoot: string): SeedReport {
  const report: SeedReport = {
    persona_acs_seeded: 0,
    cypher_items_seeded: 0,
    evidence_links: 0,
    errors: [],
  };

  // ── Batch 1: Phase 80 ACs ─────────────────────────────────────────────────
  try {
    const prdPath = resolve(repoRoot, '.planning/phases/80-persona-memory-loop/PRD.md');
    const acs = parsePrdAcs(prdPath);
    for (const ac of acs) {
      // Map known-shipped ACs to status='shipped' from earlier work.
      const knownShipped = new Set([
        // Wave 77a-01 vertical slice ACs
        'PERSONA-AC-1',  // schema v57 — we shipped v58 + v59 + v60 instead, but the spirit is met
        'PERSONA-AC-3',  // tsconfig parser ≥ 6 strict-family rules
        'PERSONA-AC-5',  // retirement path
        'PERSONA-AC-6',  // Hard rule 4 — no drawer > 200 tokens
      ]);
      const status: WorkItemStatus = knownShipped.has(ac.ac_id) ? 'shipped' : 'pending';
      upsertWorkItem(db, {
        id: ac.ac_id,
        phase: '80-persona-memory-loop',
        wave: ac.wave,
        title: ac.description.slice(0, 120),
        description: ac.description,
        status,
        priority: ac.wave === '77a' ? 1 : (ac.wave === '77b' ? 3 : (ac.wave === '77c' ? 5 : 7)),
        smoke_section: ac.smoke_section,
      });
      report.persona_acs_seeded++;
    }
  } catch (err) {
    report.errors.push(`prd-acs: ${(err as Error).message}`);
  }

  // ── Batch 2: Cypher slices shipped today ──────────────────────────────────
  // These are coarser-grained than ACs — one per slice. Mapped to the
  // commits + sessions that produced them.
  const cypherSlices: Array<{
    id: string;
    wave: string;
    title: string;
    description: string;
    status: WorkItemStatus;
    priority: number;
    depends_on: string[];
    commit?: string;
    session?: string;
    files?: string[];
  }> = [
    {
      id: 'CYPHER-SLICE-A+B',
      wave: 'cypher-v1-spine',
      title: 'Cypher v1 spine — schema v59 + 9-step contract + Beta priors + path-classifier + memory governance + wi_dispatch MCP tool',
      description: 'Slice A+B from 2026-06-13: cypher_sessions / cypher_steps / skill_priors tables, run.ts 9-step runtime, learn.ts Beta(α,β) update + getRankedSkills, memory.ts what-goes-where, path-classifier.ts (ALLOWED/CONFIRM_REQUIRED/BLOCKED), wi_dispatch MCP tool, smoke § 20.',
      status: 'shipped',
      priority: 1,
      depends_on: [],
      commit: '41e07b4',
      session: 'cyp_becf711f000e',
      files: [
        'src/db/migrations/v59_cypher_tables.ts',
        'src/services/cypher/run.ts',
        'src/services/cypher/learn.ts',
        'src/services/cypher/memory.ts',
        'src/services/cypher/path-classifier.ts',
        'src/tools/manifest.ts',
        'web-server.js',
      ],
    },
    {
      id: 'CYPHER-FLOW-2',
      wave: 'cypher-v1-spine',
      title: '/wi slash command — Claude Code front door for wi_dispatch',
      description: 'Flow 2: thin Bash skill at skills/wi-router/SKILL.md curls /api/wi/dispatch and renders Cypher decision card. Never auto-executes (depth ≤ 2 invariant).',
      status: 'shipped',
      priority: 2,
      depends_on: ['CYPHER-SLICE-A+B'],
      commit: 'a1ef213',
      session: 'cyp_e01bde91000f',
      files: ['skills/wi-router/SKILL.md'],
    },
    {
      id: 'CYPHER-SLICE-1',
      wave: 'cypher-v1-spine',
      title: '/wi-record-outcome companion skill',
      description: 'Slice 1: skills/wi-record-outcome/SKILL.md — closes a Cypher session with success|mixed|failed verdict; updates Beta priors via /api/wi/dispatch.',
      status: 'shipped',
      priority: 3,
      depends_on: ['CYPHER-FLOW-2'],
      commit: '813d737',
      session: 'cyp_57c442a10012',
      files: ['skills/wi-record-outcome/SKILL.md'],
    },
    {
      id: 'CYPHER-SLICE-2',
      wave: 'cypher-v1-spine',
      title: 'Task-class-aware candidate filtering',
      description: 'Slice 2: src/services/cypher/candidates.ts — DEFAULT_CANDIDATES per task class; resolveCandidates(taskClass, callerCandidates). Caller wins when explicit; defaults substitute when caller passes empty.',
      status: 'shipped',
      priority: 3,
      depends_on: ['CYPHER-SLICE-A+B'],
      commit: '813d737',
      session: 'cyp_146301f40013',
      files: ['src/services/cypher/candidates.ts', 'src/services/cypher/run.ts'],
    },
    {
      id: 'CYPHER-SLICE-3',
      wave: 'cypher-v1-spine',
      title: 'Execute stage — read-class skills auto-invoke on auto_execute=true',
      description: 'Slice 3: src/services/cypher/skills.ts SKILL_CATALOG + invokeSkill(). Read-class skills auto-execute via bridge endpoints; write-class always return requires_confirmation; unknown-class skipped. Mirrors BUG_AUTO_MERGE=0.',
      status: 'shipped',
      priority: 3,
      depends_on: ['CYPHER-SLICE-2'],
      commit: '9aa10df',
      session: 'cyp_c0f2ad630009',
      files: ['src/services/cypher/skills.ts', 'src/services/cypher/run.ts', 'src/tools/manifest.ts'],
    },
    // ── Open Cypher work — the visible roadmap ────────────────────────────
    {
      id: 'CYPHER-NEXT-BUDGET',
      wave: 'cypher-v1-roadmap',
      title: 'Per-user budget gate on auto_execute',
      description: 'CAP-12 budget plumbing: rate-limit auto_execute calls per user per hour to prevent skill-spam. Reuses src/services/brain/budget.ts.',
      status: 'pending',
      priority: 2,
      depends_on: ['CYPHER-SLICE-3'],
    },
    {
      id: 'CYPHER-NEXT-CATALOG',
      wave: 'cypher-v1-roadmap',
      title: 'Wire more catalog entries (wi-pr-review, wi-jira-analyze, wi-blast-radius)',
      description: 'SKILL_CATALOG today only has wi-search and wi-investigate as read-class with buildRequest. Adding the rest expands the auto-execute surface.',
      status: 'pending',
      priority: 4,
      depends_on: ['CYPHER-SLICE-3'],
    },
    {
      id: 'CYPHER-CAP13-DRAFT',
      wave: 'cypher-v1-roadmap',
      title: 'CAP-13 self-extension — propose-then-approve skill drafting',
      description: 'When no candidate fits, Cypher drafts SKILL.md + tests + impl, runs typecheck + smoke locally, files a skill_proposals row. Human [Promote] click activates. The dramatic ADR-033 piece.',
      status: 'pending',
      priority: 6,
      depends_on: ['CYPHER-SLICE-3', 'CYPHER-NEXT-BUDGET'],
    },
  ];

  for (const slice of cypherSlices) {
    upsertWorkItem(db, {
      id: slice.id,
      phase: 'cypher',
      wave: slice.wave,
      title: slice.title,
      description: slice.description,
      status: slice.status,
      priority: slice.priority,
      depends_on: slice.depends_on,
    });
    report.cypher_items_seeded++;
    if (slice.commit) {
      linkEvidence(db, slice.id, 'commit_sha', slice.commit);
      report.evidence_links++;
    }
    if (slice.session) {
      linkEvidence(db, slice.id, 'cypher_session_id', slice.session);
      report.evidence_links++;
    }
    for (const f of slice.files ?? []) {
      linkEvidence(db, slice.id, 'file_path', f);
      report.evidence_links++;
    }
  }

  // ── Batch 3: PM lens self-bootstrap ───────────────────────────────────────
  const pmItems: Array<{
    id: string;
    title: string;
    description: string;
    status: WorkItemStatus;
    priority: number;
    depends_on: string[];
  }> = [
    {
      id: 'PM-1',
      title: 'Schema v60 work_items + work_item_links + ingestion shim',
      description: 'PM-1: SQL spine for the Cypher PM lens. Replaces GSD discipline. Markdown stays narrative; SQL is read model for status, write model for evidence.',
      status: 'in_progress',
      priority: 1,
      depends_on: ['CYPHER-SLICE-A+B'],
    },
    {
      id: 'PM-2',
      title: '/api/cypher/pm endpoints (next, status, link, impact)',
      description: 'HTTP face on the PM lens — GET /next, GET /status?ac=X, POST /link, GET /impact?file=Y. Plus smoke § 21.',
      status: 'pending',
      priority: 1,
      depends_on: ['PM-1'],
    },
    {
      id: 'PM-3',
      title: '/wi-status read-only skill (next | <ac> | impact <file>)',
      description: 'Bash skill that surfaces the PM data via /api/cypher/pm. Read-only in v1; writes happen via /wi-record-outcome.',
      status: 'pending',
      priority: 2,
      depends_on: ['PM-2'],
    },
    {
      id: 'PM-4',
      title: 'Auto-link Cypher sessions + commits to ACs',
      description: 'wi-record-outcome --ac flag + Cypher session goal-text scanner that extracts AC ids (regex) and offers them as suggested links. Closes the maintenance-rot risk.',
      status: 'pending',
      priority: 2,
      depends_on: ['PM-3'],
    },
    {
      id: 'PM-5',
      title: 'ADR-035 documenting the PM lens + docs/sidebars + PRD pointers',
      description: 'Write-up: ADR explaining the PM lens, docs page for /wi-status, update Phase 80 PRD and ROADMAP to point at SQL as source of truth for status.',
      status: 'pending',
      priority: 4,
      depends_on: ['PM-4'],
    },
  ];

  for (const item of pmItems) {
    upsertWorkItem(db, {
      id: item.id,
      phase: 'cypher-pm',
      wave: 'pm-lens',
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      depends_on: item.depends_on,
    });
    report.cypher_items_seeded++;
  }

  // PM-1's evidence — it's the slice we're shipping right now.
  linkEvidence(db, 'PM-1', 'cypher_session_id', 'cyp_a1484608000c');
  linkEvidence(db, 'PM-1', 'file_path', 'src/db/migrations/v60_cypher_pm.ts');
  linkEvidence(db, 'PM-1', 'file_path', 'src/services/cypher/pm.ts');
  linkEvidence(db, 'PM-1', 'file_path', 'src/services/cypher/pm-seed.ts');
  report.evidence_links += 4;

  return report;
}
