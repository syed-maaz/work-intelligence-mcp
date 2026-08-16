/**
 * Per-skill dispatch timeout map (ADR-040 F4 / GAP-001 — G2 Dispatch).
 *
 * Replaces blanket 60s/300s timeouts with per-skill values tuned to each
 * skill's expected wall-clock. Shorter timeouts let retries fire sooner;
 * longer ones accommodate heavy endpoints (investigate, search-all).
 *
 * Skills not in the map get DEFAULT_TIMEOUT_MS.
 */

export const PER_SKILL_TIMEOUT_MS: Record<string, number> = {
  'wi-search': 90_000,
  'wi-search-all': 120_000,
  'wi-jira': 60_000,
  'wi-jira-analyze': 120_000,
  'wi-investigate': 120_000,
  'wi-blast-radius': 60_000,
  'wi-pr-review': 90_000,
  'wi-daily-digest': 60_000,
  'wi-brief': 60_000,
  'wi-audit': 90_000,
  'wi-people': 30_000,
  'wi-code': 60_000,
  'wi-status': 30_000,
  'wi-pm': 60_000,
};

export const DEFAULT_TIMEOUT_MS = 60_000;

export function getTimeoutForSkill(skillName: string): number {
  return PER_SKILL_TIMEOUT_MS[skillName] ?? DEFAULT_TIMEOUT_MS;
}
