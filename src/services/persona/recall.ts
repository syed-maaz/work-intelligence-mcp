/**
 * Persona memory consumer helpers — Phase 80 wave 77a-01.
 *
 * Thin SQL helpers for callers that need active persona rules. Lives in
 * `src/services/persona/` so it sits inside the Hard rule 7 allowed
 * directories for direct table access (PERSONA-A-13).
 *
 * Routes / tools / agents call these helpers — they MUST NOT touch
 * `rule_cards`, `lessons_learned`, or `persona_rule_snapshots` directly.
 */

import type Database from 'better-sqlite3';

export interface ActivePersonaRule {
  rule_id: string;
  body: string;
  tier: 0 | 1;
  activation_glob: string | null;
}

export interface ActiveRulesQuery {
  /** Restrict to a tier. Default: any tier. */
  tier?: 0 | 1;
  /** Hard cap on rows returned. Default 10. */
  limit?: number;
  /** Glob substrings the changed-files list matches against
   *  `activation_glob`. When non-empty, rules whose `activation_glob` is
   *  null OR contains at least one changed-file extension are returned;
   *  others are dropped. Today every Tier-0 rule has activation_glob
   *  'src/**\/*.ts'; this filter is a no-op there but ready for 77a-04
   *  PR-comment-derived rules with narrower scopes. */
  changedFiles?: string[];
}

/**
 * Read the currently-active persona rules for prompt injection. Backed by
 * the SQL `rule_cards` + `persona_rule_snapshots` JOIN — palace is the
 * canonical body store, but the SQL snapshot covers the durability
 * contract (BLOCKER-3) and avoids the noisy reviews-wing semantic match
 * problem documented in `recall-wing-filter-leaking.md`.
 */
export function getActivePersonaRules(
  db: Database.Database,
  query: ActiveRulesQuery = {},
): ActivePersonaRule[] {
  const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
  const tier = query.tier;

  const whereParts: string[] = ["rc.status = 'active'", 'rs.retired_at IS NULL'];
  const params: Array<number | string> = [];
  if (tier === 0 || tier === 1) {
    whereParts.push('rc.tier = ?');
    params.push(tier);
  }
  const sql = `
    SELECT rs.rule_id, rs.body_yaml AS body, rc.tier, rc.activation_glob
      FROM rule_cards rc
      JOIN persona_rule_snapshots rs
        ON rs.rule_id = rc.rule_id
       AND rs.id = (
             SELECT MAX(id)
               FROM persona_rule_snapshots inner_rs
              WHERE inner_rs.rule_id = rc.rule_id
                AND inner_rs.retired_at IS NULL
           )
     WHERE ${whereParts.join(' AND ')}
     ORDER BY rc.applied_count DESC, rc.last_applied_at DESC, rc.rule_id ASC
     LIMIT ?
  `;
  let rows: Array<{ rule_id: string; body: string; tier: number; activation_glob: string | null }>;
  try {
    rows = db.prepare(sql).all(...params, limit) as Array<{
      rule_id: string;
      body: string;
      tier: number;
      activation_glob: string | null;
    }>;
  } catch {
    // Schema not migrated yet (e.g. fresh DB without v58) — best-effort empty.
    return [];
  }

  // Activation-glob narrowing — defensive for 77a-04+ rules with narrower
  // scopes. For 77a-01, every Tier-0 rule has activation_glob 'src/**/*.ts'
  // and any changed file containing '.ts' will match, so this is a no-op
  // in practice today.
  const changedFiles = query.changedFiles ?? [];
  const hasChangedFiles = changedFiles.length > 0;

  const filtered: ActivePersonaRule[] = [];
  for (const r of rows) {
    if (r.tier !== 0 && r.tier !== 1) continue;
    if (hasChangedFiles && r.activation_glob) {
      // Cheap substring match — 'src/**/*.ts' matches any changed file
      // that ends in '.ts'. Real glob support arrives with 77a-04.
      const ext = r.activation_glob.split('.').pop() ?? '';
      const matches = ext === '' || changedFiles.some(f => f.endsWith(`.${ext}`));
      if (!matches) continue;
    }
    filtered.push({
      rule_id: r.rule_id,
      body: r.body,
      tier: r.tier as 0 | 1,
      activation_glob: r.activation_glob,
    });
  }
  return filtered;
}
