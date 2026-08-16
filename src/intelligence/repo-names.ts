// ---------------------------------------------------------------------------
// Repo-name resolution — OSS sanitization: never hardcode org repo names.
// Fallback chain (mirrors tool-catalog.ts REPO_ENUM / skill-dispatch.ts):
//   1. wi.config.json repos (config-driven names)
//   2. env vars (REPO_PATH / OPERATIONS_PATH) — generic 'workspace'/'operations'
//   3. generic names
// ---------------------------------------------------------------------------

import { getWiConfig } from '../services/wi-config.js';

/** Primary repo name: first configured repo, else 'workspace'.
 *  Never throws, even when wi.config.json repos is empty/missing. */
export function defaultRepoName(): string {
  try {
    const repos = getWiConfig().repos ?? [];
    if (repos.length > 0) return repos[0].name;
  } catch {
    // wi.config.json missing/unreadable — fall through to generic name
  }
  return 'workspace';
}

/** User-supplied repo name when non-empty, else defaultRepoName(). */
export function repoNameHint(repo?: string): string {
  return repo && repo.trim().length > 0 ? repo : defaultRepoName();
}

/** Repo names for enums/prompts: config repos, else env-gated fallback,
 *  else generic ['app', 'ops']. Never returns empty. */
export function repoDisplayNames(): string[] {
  let names: string[] = [];
  try {
    names = (getWiConfig().repos ?? []).map(r => r.name);
  } catch {
    // wi.config.json missing/unreadable — fall through to env
  }
  if (names.length === 0) {
    if (process.env.REPO_PATH) names.push('workspace');
    if (process.env.OPERATIONS_PATH) names.push('operations');
  }
  if (names.length === 0) return ['app', 'ops'];
  return names;
}