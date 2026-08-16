import { minimatch } from 'minimatch';
import { getWiConfig } from '../services/wi-config.js';

export interface OwnershipEntry {
  repo:     string;
  glob:     string;    // minimatch pattern
  team:     string;
  owner?:   string;    // primary contact
  notes?:   string;
}

export function buildDefaultOwnerShipMap(): OwnershipEntry[] {
  const entries: OwnershipEntry[] = [];
  try {
    const repos = getWiConfig().repos ?? [];
    for (const r of repos) {
      entries.push(
        { repo: r.name, glob: 'apps/**',       team: 'core' },
        { repo: r.name, glob: 'packages/**',    team: 'core' },
        { repo: r.name, glob: 'services/**',    team: 'core' },
        { repo: r.name, glob: 'components/**',  team: 'core' },
        { repo: r.name, glob: '**',             team: 'core' },
      );
    }
  } catch {
    // wi.config.json missing — fall through to generic default
  }

  // External plugin modules — not in workspace repos
  entries.push(
    { repo: 'thirdparty-ui-plugins', glob: '**', team: 'external', notes: 'Not in workspace repos. Plugin integration layer.' },
    { repo: 'thirdparty-ui-plugins', glob: 'webapps/plugins/Component.js', team: 'external', notes: 'Entry point — framework API integration' },
  );

  if (entries.length === 0) {
    entries.push({ repo: 'app', glob: '**', team: 'core' });
  }

  return entries;
}

export const DEFAULT_OWNERSHIP_MAP: OwnershipEntry[] = buildDefaultOwnerShipMap();

export function getOwnership(
  filePath: string,
  repoHint: string,
  map: OwnershipEntry[] = DEFAULT_OWNERSHIP_MAP
): OwnershipEntry | null {
  // Most-specific glob wins (longest glob that matches)
  const matches = map
    .filter(e => e.repo === repoHint && minimatch(filePath, e.glob))
    .sort((a, b) => b.glob.length - a.glob.length);
  return matches[0] ?? null;
}
