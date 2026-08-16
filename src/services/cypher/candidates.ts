/**
 * Cypher candidate-skill defaults — Slice 2 (2026-06-13).
 *
 * Maps task_class → ordered list of plausible wi-* skills. The /wi slash
 * command historically passes "all 8 commonly-dispatched" skills as
 * candidates regardless of task class. That's the worst case for
 * Beta-prior ranking: every candidate starts at the uniform prior and
 * the ranker falls back on alphabetical tiebreak. The first session
 * picks the wrong skill and the negative-shape feedback teaches Cypher
 * that wi-action-items is bad for "dispatch" — which is true but
 * mostly because wi-action-items was never a candidate to begin with.
 *
 * Solution: scope the default candidate list to skills genuinely
 * relevant to the task class. Callers passing an explicit list still
 * win; this is a default for callers that pass ['*'] or omit the
 * field entirely.
 *
 * Hard rule: this map is data, not logic. New skills get added here
 * by hand (or by CAP-13 self-extension when a proposal lands). No
 * heuristic matching against goal text — that's a different feature
 * (semantic-routing, ALT-J in the wi-router fold).
 */

export interface DefaultCandidates {
  /** task_class → ordered list of skill names that fit this class. */
  [taskClass: string]: string[];
}

/**
 * Default candidate skills per task class. Lists are ordered by rough
 * fit confidence (most-likely-fit first) — stable when the Beta priors
 * are uniform, since the ranker preserves input order on ties.
 *
 * Adding a new task class:
 *   1. Add the entry here.
 *   2. Bump the smoke § 20 sub-check that asserts the map shape.
 *   3. (Future) When CAP-13 self-extension proposes a new skill, the
 *      proposal includes the task_classes it should appear under, and
 *      the gate's [Promote] handler appends it here.
 */
export const DEFAULT_CANDIDATES: DefaultCandidates = {
  // Catch-all when caller passes no task class.
  '*': [
    'wi-investigate', 'wi-search', 'wi-pr-review', 'wi-jira-analyze',
  ],

  // /wi <free text> — the slash router itself. Full wi-* roster so Cypher
  // sees every operational skill when goal text doesn't map to a narrower
  // task class. Ordered by rough dispatch frequency (high-prior skills
  // first so stable tiebreak favours them before data accumulates).
  'dispatch': [
    'wi-investigate', 'wi-jira-analyze', 'wi-pr-review', 'wi-morning-brief',
    'wi-action-items', 'wi-pre-meeting', 'wi-daily-digest', 'wi-search-all',
    'wi-teams-search', 'wi-find-expert', 'wi-blast-radius', 'wi-correlate',
    'wi-jira-report', 'wi-code-research', 'wi-bug-report', 'wi-bug-resolve',
    'wi-bug-resolve-all', 'wi-who-owns', 'wi-ticket-links', 'wi-teammate',
    'wi-palace-query', 'wi-status', 'wi-health', 'wi-weekly-report',
    'wi-remind', 'wi-sync', 'wi-skill-install', 'wi-update-context',
    'wi-save-to-ticket', 'wi-ask-topic', 'wi-bis-regression',
    'wi-check-links', 'wi-frontmatter', 'wi-add-bucket', 'wi-record-outcome',
  ],

  // Investigations on a Jira/bug ticket — ReAct-style root-cause work.
  'investigate': [
    'wi-investigate', 'wi-bug-report', 'wi-jira-analyze', 'wi-search',
  ],

  // PR reviews — the wi-pr-review path that 77a-01 already wires Tier-0
  // persona rules into.
  'pr-review': [
    'wi-pr-review', 'wi-blast-radius', 'wi-investigate',
  ],

  // Daily / morning planning — non-investigation surfaces.
  'planning': [
    'wi-morning-brief', 'wi-daily-digest', 'wi-action-items',
    'wi-pre-meeting',
  ],

  // Cross-source search.
  'search': [
    'wi-search', 'wi-search-all', 'wi-teams-search',
  ],

  // Building / extending skills + framework code (where this slice's
  // Building / extending skills + framework code. Expanded seeded list
  // so Cypher has a full wi-* pool before the catalog merge appends
  // global/plugin skills (engineering-skills, code-reviewer, etc.).
  'build-feature': [
    'wi-skill-install', 'wi-investigate', 'wi-code-research',
    'wi-blast-radius', 'wi-pr-review', 'wi-search',
  ],

  // Meta-tasks: refactoring, schema migrations, smoke wiring. Today
  // there's no dedicated skill for these — Cypher will surface 'no
  // candidate fits' which is itself the signal CAP-13 needs.
  'refactor':         ['wi-investigate', 'wi-search'],
  'schema-migration': ['wi-investigate'],
  'wiring':           ['wi-investigate', 'wi-search'],
  'doc':              ['wi-search', 'wi-check-links'],
  'smoke':            ['wi-investigate', 'wi-search'],

  // Phase 82b — UI / frontend work. Seeded list is intentionally
  // small so the discovery merge in resolveCandidates surfaces global
  // and plugin skills (frontend-design, etc.) below them.
  'ui-review':        ['wi-investigate'],
  'frontend':         ['wi-investigate'],
  'design':           ['wi-investigate'],
};

/**
 * Resolve the candidate-skill list for a dispatch.
 *
 *   - When the caller passes a non-empty `candidate_skills`, use it
 *     verbatim (caller knows best).
 *   - When the caller passes nothing, look up DEFAULT_CANDIDATES by
 *     task class. Fall back to '*' when the class isn't mapped.
 *   - When `db` is provided, merge in skills from the discovered
 *     `skill_catalog` (phase 82b) whose task_classes JSON contains
 *     this taskClass. Seeded entries always rank first; discovered
 *     entries appear below, deduplicated.
 *   - Always returns a non-empty array — callers can treat the result
 *     as the source of truth without further null-checks.
 */
export function resolveCandidates(
  taskClass: string,
  callerCandidates: string[] | undefined,
  db?: import('better-sqlite3').Database,
): string[] {
  if (callerCandidates && callerCandidates.length > 0) return callerCandidates;
  const seeded = DEFAULT_CANDIDATES[taskClass] ?? DEFAULT_CANDIDATES['*'];

  if (!db) return seeded;

  // Phase 82b: append discovered skills whose task_classes JSON
  // includes the requested taskClass keyword. Defensive — any DB
  // error here falls back to the seeded list (the catalog is a
  // reachability boost, never a correctness dependency).
  let discovered: string[] = [];
  try {
    // For 'dispatch' (the /wi front door), surface the FULL catalog —
    // every wi-*, global, and plugin skill in skill_catalog. /wi is
    // the natural-language entry point so Cypher must see the whole
    // toolbox to make an informed pick. Other task classes still
    // honour the keyword-tag merge so narrower dispatches stay focused.
    if (taskClass === 'dispatch' || taskClass === '*') {
      const rows = db.prepare<[], { skill_name: string }>(`
        SELECT skill_name FROM skill_catalog
         ORDER BY source = 'wi' DESC, source = 'global' DESC, source = 'plugin' DESC, skill_name ASC
      `).all();
      discovered = rows.map(r => r.skill_name);
    } else {
      const tcLower = taskClass.toLowerCase();
      const needle = `%"${tcLower.replace(/"/g, '\\"')}"%`;
      const rows = db.prepare<[string], { skill_name: string }>(`
        SELECT skill_name FROM skill_catalog
         WHERE task_classes LIKE ?
         ORDER BY source = 'wi' DESC, source = 'global' DESC, source = 'plugin' DESC, registered_at ASC
      `).all(needle);
      discovered = rows.map(r => r.skill_name);
    }
  } catch {
    return seeded;
  }

  const seen = new Set(seeded);
  const merged = [...seeded];
  for (const s of discovered) {
    if (!seen.has(s)) {
      merged.push(s);
      seen.add(s);
    }
  }
  return merged;
}
