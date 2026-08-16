/**
 * Skill-registry drift check — ADR-051 § Follow-up item 3.
 *
 * Purpose: on demand (or at bridge boot when WI_SKILL_DRIFT_CHECK=1), compare
 * the two skill inventories that ADR-051 decided to keep separate under
 * Option A:
 *
 *   Inventory A — SKILL_ROUTES in src/services/cypher/skill-dispatch.ts
 *   Inventory B — the set of wi-* rows in skill_catalog after discoverSkills()
 *
 * ADR-051 Option A is that these two inventories are legitimately non-identical:
 *
 *   - The 5 consolidated wrapper skills (wi-code, wi-people, wi-brief, wi-jira,
 *     wi-bug) are user-facing CLI conveniences with no HTTP route by design.
 *   - Some legacy routes remain in SKILL_ROUTES for backwards compat even after
 *     the user-facing skill was retired or consolidated.
 *
 * So a bare-set-diff between A and B fires false positives. This check reports
 * only DRIFT BEYOND THE KNOWN CARVE-OUTS — a whitelist of names that are
 * expected to appear in one inventory but not the other. Anything outside the
 * whitelist is drift the operator should investigate.
 *
 * Cost: pure SQL query + Set diff. No I/O beyond one DB read. Suitable for
 * boot-time observation and for a dedicated `/api/cypher/skill-drift`
 * read-only endpoint.
 *
 * Boot integration: called from web-server.js AFTER discoverSkills() completes,
 * gated by WI_SKILL_DRIFT_CHECK !== '0' (default ON, opt-out to 0). One-line
 * stderr summary; only expands per-name when drift beyond whitelist is found.
 *
 * References:
 *   - docs/adr/adr-051-skill-registry-unification.md (Accepted, Option A)
 *   - docs/adr/adr-051-tradeoff-analysis.md § "The 8-week undetected drift is
 *     a monitoring problem, not a design problem"
 */

import type Database from 'better-sqlite3';
import { _internal } from './skill-dispatch.js';

/**
 * Skills expected in Inventory B (user-facing skill_catalog) but INTENTIONALLY
 * absent from Inventory A (SKILL_ROUTES). ADR-051 Option A carve-out.
 *
 * If a skill in this list disappears from skill_catalog, that's real drift
 * (wrapper skill got removed on-disk but the whitelist wasn't updated). But
 * a skill in this list being absent from SKILL_ROUTES is expected.
 */
const EXPECTED_CATALOG_ONLY: ReadonlySet<string> = new Set([
  // Subcommand-dispatch wrapper skills (created 2026-07-24). CLI-only by design.
  'wi-code',
  'wi-people',
  'wi-brief',
  'wi-jira',
  'wi-bug',
  'wi-audit',
  'wi-git-audit',
  'wi-govern',
  'wi-vault',
  // Not-a-dispatchable-skill roles: PM/orchestration/support.
  'wi-pm',
  'wi-router',
  'wi-record-outcome',
  'wi-review-adr',
  'wi-pre-meeting',
  'wi-add-bucket',
]);

/**
 * Names expected in Inventory A (SKILL_ROUTES) but NOT necessarily in
 * skill_catalog. These are usually legacy routes kept for backwards compat
 * (the underlying user-facing skill was retired or consolidated into a wrapper)
 * OR are pure-endpoint routes with no SKILL.md at all.
 *
 * If a name in this list APPEARS in skill_catalog, that's fine — we just
 * don't warn.
 */
const EXPECTED_ROUTE_ONLY: ReadonlySet<string> = new Set([
  // Legacy primitive routes now surfaced via wrapper skills.
  'wi-blast-radius', // now via wi-code
  'wi-pr-review', // now via wi-code
  'wi-code-research', // now via wi-code
  'wi-find-expert', // now via wi-people
  'wi-teammate', // now via wi-people
  'wi-morning-brief', // now via wi-brief
  'wi-daily-digest', // now via wi-brief
  'wi-jira-analyze', // now via wi-jira
  'wi-jira-report', // now via wi-jira
  'wi-ticket-links', // now via wi-jira
  'wi-save-to-ticket', // now via wi-jira
  'wi-bug-report', // now via wi-bug
  // Pure operational routes — no SKILL.md counterpart, intentional.
  'wi-search-all',
  'wi-teams-search',
  'wi-palace-query',
  'wi-check-links',
  'wi-frontmatter',
  'wi-sync',
  'wi-health',
]);

export interface DriftReport {
  route_count: number;
  catalog_count: number;
  in_catalog_not_in_routes: string[];
  in_routes_not_in_catalog: string[];
  unknown_catalog_only: string[]; // NOT in EXPECTED_CATALOG_ONLY
  unknown_route_only: string[]; // NOT in EXPECTED_ROUTE_ONLY
  total_unknown_drift: number;
}

/** Compute the drift report against the current DB state. */
export function checkSkillRegistryDrift(db: Database.Database): DriftReport {
  const routes = Object.keys(_internal.SKILL_ROUTES);
  const routeSet = new Set(routes);

  const catalogRows = db
    .prepare<[], { skill_name: string }>(
      `SELECT skill_name FROM skill_catalog WHERE skill_name LIKE 'wi-%'`,
    )
    .all();
  const catalogSet = new Set(catalogRows.map((r) => r.skill_name));

  const in_catalog_not_in_routes: string[] = [];
  for (const name of catalogSet) {
    if (!routeSet.has(name)) in_catalog_not_in_routes.push(name);
  }
  in_catalog_not_in_routes.sort();

  const in_routes_not_in_catalog: string[] = [];
  for (const name of routes) {
    if (!catalogSet.has(name)) in_routes_not_in_catalog.push(name);
  }
  in_routes_not_in_catalog.sort();

  const unknown_catalog_only = in_catalog_not_in_routes.filter(
    (n) => !EXPECTED_CATALOG_ONLY.has(n),
  );
  const unknown_route_only = in_routes_not_in_catalog.filter(
    (n) => !EXPECTED_ROUTE_ONLY.has(n),
  );

  return {
    route_count: routes.length,
    catalog_count: catalogSet.size,
    in_catalog_not_in_routes,
    in_routes_not_in_catalog,
    unknown_catalog_only,
    unknown_route_only,
    total_unknown_drift:
      unknown_catalog_only.length + unknown_route_only.length,
  };
}

/**
 * Format a one-line-plus-detail summary for the boot logger.
 * - Green single line when total_unknown_drift === 0.
 * - Multi-line breakdown when drift found (bounded — max top-5 examples).
 */
export function formatDriftSummary(r: DriftReport): string {
  const lead = `[skill-drift] routes=${r.route_count} catalog=${r.catalog_count} known-carve-out=${r.in_catalog_not_in_routes.length + r.in_routes_not_in_catalog.length} unknown-drift=${r.total_unknown_drift}`;
  if (r.total_unknown_drift === 0) {
    return `${lead} — no drift beyond ADR-051 Option A carve-outs`;
  }
  const lines = [lead + ' — investigate:'];
  if (r.unknown_catalog_only.length > 0) {
    const examples = r.unknown_catalog_only.slice(0, 5).join(', ');
    const suffix =
      r.unknown_catalog_only.length > 5
        ? ` (+${r.unknown_catalog_only.length - 5} more)`
        : '';
    lines.push(
      `  in skill_catalog but not in SKILL_ROUTES: ${examples}${suffix}`,
    );
    lines.push(
      '    → user-facing skill exists but bridge cannot dispatch it. Either wire a route, mark cli-only, or add to EXPECTED_CATALOG_ONLY if intentional.',
    );
  }
  if (r.unknown_route_only.length > 0) {
    const examples = r.unknown_route_only.slice(0, 5).join(', ');
    const suffix =
      r.unknown_route_only.length > 5
        ? ` (+${r.unknown_route_only.length - 5} more)`
        : '';
    lines.push(
      `  in SKILL_ROUTES but not in skill_catalog: ${examples}${suffix}`,
    );
    lines.push(
      '    → route exists but no user-facing skill claims it. Either add a SKILL.md, retire the route, or add to EXPECTED_ROUTE_ONLY if intentional.',
    );
  }
  return lines.join('\n');
}
