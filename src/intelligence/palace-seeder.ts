import { readFileSync } from 'fs';
import { join } from 'path';
import type { PalaceClient } from './palace-client.js';

// ---------------------------------------------------------------------------
// Palace Seeder — Phase 57 Wave 1
// Parses cluster-setup/feature-flags.yaml from the config repo and writes
// KG triples to the palace. No YAML parser dependency — uses a state-machine.
// ---------------------------------------------------------------------------

export interface FlagEntry {
  name:        string;
  description: string;
  status:      string;
  startDate?:  string;
  clusters:    Record<string, boolean>;
}

export interface SeederResult {
  flagsProcessed:  number;
  triplesWritten:  number;
}

/**
 * Parse feature-flags.yaml into FlagEntry objects using a line-by-line state machine.
 * Supports the structure:
 *   FF_RM_XXXX_NAME:
 *     Description: "..."
 *     Status: In Progress
 *     Date:
 *       - Creation: "..."
 *       - Start: "..."
 *     Clusters:
 *       clusterName: true|false
 */
export function parseFeatureFlags(yamlContent: string): FlagEntry[] {
  const lines = yamlContent.split('\n');
  const flags: FlagEntry[] = [];

  let current: FlagEntry | null = null;
  let inDate = false;
  let inClusters = false;
  let inDependencies = false;

  for (const line of lines) {
    // Skip comment lines
    if (/^\s*#/.test(line)) continue;

    // Top-level flag: ^FF_RM_\w+:
    const flagMatch = line.match(/^(FF_RM_\w+):\s*$/);
    if (flagMatch) {
      if (current) flags.push(current);
      current = { name: flagMatch[1], description: '', status: '', clusters: {} };
      inDate = false;
      inClusters = false;
      inDependencies = false;
      continue;
    }

    if (!current) continue;

    // Dependencies block starts — skip everything inside it (deeply nested)
    if (/^  Dependencies:\s*$/.test(line)) {
      inDependencies = true;
      inDate = false;
      inClusters = false;
      continue;
    }

    // While in Dependencies, skip until we see a top-level key (not indented) or another FF
    if (inDependencies) {
      // Dependencies end when we see a 2-space top-level key that is NOT further indented
      if (/^  \w/.test(line) && !/^    /.test(line)) {
        // This is a sibling key — exit dependencies mode and fall through
        inDependencies = false;
      } else {
        continue;
      }
    }

    // Description:
    const descMatch = line.match(/^  Description:\s+"(.*)"$/) ||
                      line.match(/^  Description:\s+'(.*)'$/) ||
                      line.match(/^  Description:\s+(.+)$/);
    if (descMatch) {
      current.description = descMatch[1].trim();
      continue;
    }

    // Status:
    const statusMatch = line.match(/^  Status:\s+(.+)$/);
    if (statusMatch) {
      current.status = statusMatch[1].trim();
      continue;
    }

    // Date: block
    if (/^  Date:\s*$/.test(line)) {
      inDate = true;
      inClusters = false;
      continue;
    }

    // Start date inside Date block
    if (inDate) {
      const startMatch = line.match(/^\s+-\s+Start:\s+"(.+)"$/) ||
                         line.match(/^\s+-\s+Start:\s+'(.+)'$/) ||
                         line.match(/^\s+-\s+Start:\s+(.+)$/);
      if (startMatch) {
        current.startDate = startMatch[1].trim().replace(/["']/g, '');
      }
      // Date block ends when we see a non-indented-list line
      if (/^  [A-Z]/.test(line)) {
        inDate = false;
        // fall through to handle this line as another field
      }
    }

    // Clusters: block
    if (/^  Clusters:\s*$/.test(line)) {
      inClusters = true;
      inDate = false;
      continue;
    }

    // Cluster entries (4-space indent)
    if (inClusters && /^    [\w-]+:\s+(true|false)$/.test(line)) {
      const clusterMatch = line.match(/^    ([\w-]+):\s+(true|false)$/);
      if (clusterMatch) {
        current.clusters[clusterMatch[1]] = clusterMatch[2] === 'true';
      }
      continue;
    }

    // Clusters block ends when indentation resets
    if (inClusters && /^  [A-Z]/.test(line)) {
      inClusters = false;
    }
  }

  if (current) flags.push(current);
  return flags;
}

/**
 * Bootstrap the KG from feature-flags.yaml in the config repo.
 * Writes KG triples for each flag found.
 * Idempotent — safe to run multiple times.
 */
export async function runPalaceSeeder(
  _palacePath: string,
  configRepoPath: string,
  palace: PalaceClient,
): Promise<SeederResult> {
  const flagsYamlPath = join(configRepoPath, 'cluster-setup', 'feature-flags.yaml');

  let yamlContent: string;
  try {
    yamlContent = readFileSync(flagsYamlPath, 'utf8');
  } catch (err) {
    process.stderr.write(`[palace-seeder] Cannot read ${flagsYamlPath}: ${(err as Error).message}\n`);
    return { flagsProcessed: 0, triplesWritten: 0 };
  }

  const flags = parseFeatureFlags(yamlContent);
  let triplesWritten = 0;

  // Idempotency guard: check if KG already has triples for the first flag
  // If yes, skip seeding (triples from previous run are still valid)
  if (flags.length > 0) {
    const existingTriples = await palace.kgQuery(flags[0].name, 'has-status');
    if (existingTriples && existingTriples !== '' && existingTriples !== '[]') {
      process.stdout.write(`[palace-seeder] Skipped — KG already seeded (${flags.length} flags known)\n`);
      return { flagsProcessed: flags.length, triplesWritten: 0 };
    }
  }

  for (const flag of flags) {
    // Use deterministic valid_from from source data (flag.startDate), not wall-clock time
    const validFrom = flag.startDate ? flag.startDate.slice(0, 10) : '2024-01-01';

    // Triple 1: has-status
    if (flag.status) {
      await palace.kgAdd(flag.name, 'has-status', flag.status, validFrom);
      triplesWritten++;
    }

    // Triple 2: description (store description as a triple for recall — timeless, no valid_from)
    if (flag.description) {
      await palace.kgAdd(flag.name, 'description', flag.description.slice(0, 200));
      triplesWritten++;
    }

    // Triple 3: activated-on (only if startDate exists)
    if (flag.startDate) {
      // Normalize to YYYY-MM-DD
      const dateOnly = flag.startDate.slice(0, 10);
      await palace.kgAdd(flag.name, 'activated-on', dateOnly, dateOnly);
      triplesWritten++;
    }

    // Triple 4+: active-in-cluster (one per true cluster)
    for (const [clusterName, active] of Object.entries(flag.clusters)) {
      if (active) {
        await palace.kgAdd(flag.name, 'active-in-cluster', clusterName, validFrom);
        triplesWritten++;
      }
    }
  }

  process.stdout.write(
    `[palace-seeder] Processed ${flags.length} flags, wrote ${triplesWritten} KG triples\n`,
  );

  return { flagsProcessed: flags.length, triplesWritten };
}
