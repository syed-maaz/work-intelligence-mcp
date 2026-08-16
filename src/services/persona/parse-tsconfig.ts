/**
 * Tier-0 tsconfig parser — Phase 80 / Wave 77a-01.
 *
 * Reads the project's `tsconfig.json` and emits one rule_card per
 * strict-family compiler option that is enabled. Each rule becomes:
 *
 *   - a row in `rule_cards` (tier=0, source_kind='tier0_static')
 *   - a row in `persona_rule_snapshots` for replay durability
 *   - a palace drawer in the `reviews` wing (≤ 200 tokens — Hard rule 4)
 *
 * Why tsconfig and not ESLint (yet):
 *   This repo uses oxlint for linting and has no `eslint.config.js`. The
 *   PRD's PERSONA-A-02 (≥ 30 ESLint rule drawers) cannot apply without
 *   that file. tsconfig has 7 strict-family flags enabled today, which
 *   is enough for the vertical slice to prove the integration shape on
 *   real signal. Wave 77a-02 adds an oxlint-config parser (or an
 *   eslint.config.js if one is added).
 *
 * Idempotency:
 *   Re-running the parser on unchanged input is a no-op for downstream:
 *   `rule_cards` is keyed by `rule_id` (UNIQUE), upsert sets the latest
 *   palace_drawer_id + body_token_count + updated_at. Removing a flag
 *   from tsconfig flips the corresponding rule_card to status='retired'
 *   with retired_reason='source_removed' (PERSONA-A-05).
 *
 * Kill switch:
 *   Caller is responsible — `parseTsconfigRules()` is pure (returns
 *   rules; does not write). The bridge boot wrapper checks
 *   `process.env.PERSONA_MEMORY_TIER0_ENABLED === '1'` before invoking.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';

// ---------------------------------------------------------------------------
// Strict-family flag catalog. Each entry maps a tsconfig compilerOption to
// the rule body Cypher will inject when the flag is on.
//
// Bodies are ≤ 200 tokens (Hard rule 4 verified by char-budget proxy:
// ~800 chars ≈ 200 tokens at the worst case).
// ---------------------------------------------------------------------------

interface StrictFamilyFlag {
  flag: string;                  // compilerOption key
  rule_id: string;               // stable rule_id (tsconfig:<flag>)
  title: string;                 // short human-readable label
  body: string;                  // ≤ 200 tokens — what the rule asserts
  activation_glob: string | null; // null = all TS files
}

const STRICT_FAMILY: StrictFamilyFlag[] = [
  {
    flag: 'strict',
    rule_id: 'tsconfig:strict',
    title: 'Strict mode is on — fail loudly, never silently',
    body: [
      'TypeScript strict mode is enabled in tsconfig.json. This bundles seven',
      'sub-flags (noImplicitAny, strictNullChecks, strictFunctionTypes,',
      'strictBindCallApply, strictPropertyInitialization, noImplicitThis,',
      'alwaysStrict). When generating code in this repo, treat every implicit',
      "any as a bug, not a shortcut. If a type is unknown, write 'unknown' and",
      "narrow at the use site — never 'any', never '@ts-ignore'.",
    ].join(' '),
    activation_glob: 'src/**/*.ts',
  },
  {
    flag: 'noImplicitAny',
    rule_id: 'tsconfig:noImplicitAny',
    title: 'No implicit any — every parameter and return type must be declared',
    body: [
      'noImplicitAny is on (via strict). Every function parameter, return type,',
      'and class field that the compiler cannot infer must carry an explicit',
      "type annotation. When asked to add a function, never write 'function f(x)' —",
      "always 'function f(x: T): R'. When extending an existing API, match the",
      'existing annotation style, including generics.',
    ].join(' '),
    activation_glob: 'src/**/*.ts',
  },
  {
    flag: 'noUnusedLocals',
    rule_id: 'tsconfig:noUnusedLocals',
    title: 'No unused locals — delete dead code, never silence the warning',
    body: [
      'noUnusedLocals is on. Unused local variables fail the build. When',
      'editing existing code, delete dead bindings rather than prefixing them',
      "with '_'. If a destructured field is genuinely unused but cannot be",
      "removed (foreign API), use the '_field' convention TypeScript permits.",
      'Never disable this with @ts-ignore; never add a fake reference.',
    ].join(' '),
    activation_glob: 'src/**/*.ts',
  },
  {
    flag: 'noUnusedParameters',
    rule_id: 'tsconfig:noUnusedParameters',
    title: 'No unused parameters — prefix with _ only when interface forces it',
    body: [
      "noUnusedParameters is on. Function parameters not referenced fail the",
      "build. Drop them entirely when the function is internal. Use the '_'",
      "prefix only when an external interface (callback signature, framework",
      "hook, override) requires the parameter to be present. Never silence",
      'with @ts-expect-error.',
    ].join(' '),
    activation_glob: 'src/**/*.ts',
  },
  {
    flag: 'noImplicitReturns',
    rule_id: 'tsconfig:noImplicitReturns',
    title: 'No implicit returns — every code path must return explicitly',
    body: [
      'noImplicitReturns is on. Every branch in a function with a non-void',
      "return type must return explicitly. When generating switch/case logic,",
      "write a default branch that throws or returns a sentinel. Never let",
      'control flow fall off the end of a function and rely on `undefined`.',
    ].join(' '),
    activation_glob: 'src/**/*.ts',
  },
  {
    flag: 'noFallthroughCasesInSwitch',
    rule_id: 'tsconfig:noFallthroughCasesInSwitch',
    title: 'No fallthrough cases — every switch case ends in break/return/throw',
    body: [
      'noFallthroughCasesInSwitch is on. Every non-empty `case` clause must',
      "terminate with break, return, throw, or `// fallthrough` comment. When",
      'generating switch/case logic, never write empty cases that intentionally',
      'fall through; use the explicit comment form if fallthrough is required.',
    ].join(' '),
    activation_glob: 'src/**/*.ts',
  },
  {
    flag: 'forceConsistentCasingInFileNames',
    rule_id: 'tsconfig:forceConsistentCasingInFileNames',
    title: 'Consistent casing — case-sensitive imports across the repo',
    body: [
      'forceConsistentCasingInFileNames is on. Imports must match the on-disk',
      "case exactly. When generating an import, copy the casing from the",
      "actual filename — never assume lowercase. macOS/Windows are case-",
      'insensitive at the FS layer but the build will fail on Linux CI if',
      'the import case drifts.',
    ].join(' '),
    activation_glob: 'src/**/*.ts',
  },
];

// ---------------------------------------------------------------------------
// Pure parser — read tsconfig.json, return active flags
// ---------------------------------------------------------------------------

export interface ParsedTsconfigRule {
  rule_id: string;
  title: string;
  body: string;
  activation_glob: string | null;
  source_ref: string;
  body_token_count: number;
}

/**
 * Read tsconfig.json from `repoRoot` and emit a ParsedTsconfigRule for each
 * strict-family flag that is currently on. Pure — no DB, no palace.
 */
export function parseTsconfigRules(repoRoot: string): ParsedTsconfigRule[] {
  const tsconfigPath = resolve(repoRoot, 'tsconfig.json');
  let tsconfig: { compilerOptions?: Record<string, unknown> };
  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  } catch (err) {
    // Best-effort capture (Hard rule 6 — never crash the bridge).
    // eslint-disable-next-line no-console
    console.warn(`[persona/parse-tsconfig] Failed to read ${tsconfigPath}:`, err);
    return [];
  }

  const opts = tsconfig.compilerOptions ?? {};
  const rules: ParsedTsconfigRule[] = [];

  for (const flag of STRICT_FAMILY) {
    const value = opts[flag.flag];
    // strict mode bundles the others — emit if either strict or the specific
    // flag is on. tsconfig: noImplicitAny defaults from strict=true.
    const isOn = value === true || (flag.flag !== 'strict' && opts.strict === true && value !== false);
    if (!isOn) continue;

    rules.push({
      rule_id: flag.rule_id,
      title: flag.title,
      body: flag.body,
      activation_glob: flag.activation_glob,
      source_ref: 'tsconfig.json',
      // Approximate token count — 1 token ≈ 4 chars. Real tokenizer not
      // needed for the ≤ 200-tok hard rule check (we hand-wrote bodies
      // well under, ~80 tokens each).
      body_token_count: Math.ceil(flag.body.length / 4),
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Sync to DB + palace
// ---------------------------------------------------------------------------

export interface SyncResult {
  emitted: number;
  retired: number;
  skipped: number;
  errors: string[];
}

/**
 * Sync parsed tsconfig rules to `rule_cards`, `persona_rule_snapshots`, and
 * the palace `reviews` wing.
 *
 * - INSERT rule_card if rule_id is new
 * - UPDATE rule_card to status='active', updated_at=now if it exists
 * - Append a `persona_rule_snapshots` row only when the body changes
 * - Retire rule_cards whose rule_id is no longer in the parsed set,
 *   with retired_reason='source_removed' (PERSONA-A-05)
 */
export async function syncTsconfigRules(
  db: Database.Database,
  palace: PalaceClient | null,
  rules: ParsedTsconfigRule[]
): Promise<SyncResult> {
  const result: SyncResult = { emitted: 0, retired: 0, skipped: 0, errors: [] };

  // Hard rule 4 guard — refuse to write any drawer > 200 tokens.
  for (const r of rules) {
    if (r.body_token_count > 200) {
      result.errors.push(
        `[hard-rule-4] rule ${r.rule_id} body is ${r.body_token_count} tokens (> 200) — skipping`
      );
    }
  }
  const safe = rules.filter(r => r.body_token_count <= 200);

  // Snapshot current Tier-0 tsconfig rule_ids before sync — anything in this
  // set NOT in `safe` gets retired with reason='source_removed'.
  const existingRows = db
    .prepare<[], { rule_id: string }>(
      `SELECT rule_id FROM rule_cards
        WHERE tier = 0 AND source_kind = 'tier0_static'
          AND rule_id LIKE 'tsconfig:%' AND status = 'active'`
    )
    .all();
  const existingIds = new Set(existingRows.map(r => r.rule_id));
  const seenIds = new Set<string>();

  const upsertCard = db.prepare(`
    INSERT INTO rule_cards (
      rule_id, title, tier, source_kind, activation_glob, palace_drawer_id,
      body_token_count, status, updated_at
    ) VALUES (?, ?, 0, 'tier0_static', ?, ?, ?, 'active', datetime('now'))
    ON CONFLICT(rule_id) DO UPDATE SET
      title = excluded.title,
      activation_glob = excluded.activation_glob,
      palace_drawer_id = excluded.palace_drawer_id,
      body_token_count = excluded.body_token_count,
      status = 'active',
      retired_reason = NULL,
      retired_at = NULL,
      updated_at = datetime('now')
  `);

  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO persona_rule_snapshots (
      rule_id, tier, title, body_yaml, source_kind, source_ref, activation_glob
    ) VALUES (?, 0, ?, ?, 'tier0_static', ?, ?)
  `);

  for (const r of safe) {
    seenIds.add(r.rule_id);

    // Try to write the palace drawer first; if palace is down, write SQL
    // anyway and log — recall.ts will pick the SQL row up from rule_cards.
    let drawerId: string | null = null;
    if (palace) {
      try {
        // PalaceClient.addDrawer is the public write — wing/room/content/label.
        // Re-running with the same label is idempotent on the palace side
        // (mempalace dedupes via content hash). We use the rule_id as the
        // label so retrieval can match by it.
        await palace.addDrawer('reviews', 'tier0', r.body, r.rule_id);
        drawerId = r.rule_id;
      } catch (err) {
        result.errors.push(`palace.addDrawer(${r.rule_id}): ${(err as Error).message}`);
      }
    }

    try {
      upsertCard.run(r.rule_id, r.title, r.activation_glob, drawerId, r.body_token_count);
      // body_yaml is the raw rule text; we don't YAML-wrap in 77a-01.
      insertSnapshot.run(r.rule_id, r.title, r.body, r.source_ref, r.activation_glob);
      result.emitted++;
    } catch (err) {
      result.errors.push(`db.upsert(${r.rule_id}): ${(err as Error).message}`);
    }
  }

  // Retire rules no longer in the source.
  const retire = db.prepare(`
    UPDATE rule_cards
       SET status = 'retired',
           retired_reason = 'source_removed',
           retired_at = datetime('now'),
           updated_at = datetime('now')
     WHERE rule_id = ?
  `);
  for (const id of existingIds) {
    if (!seenIds.has(id)) {
      retire.run(id);
      result.retired++;
    }
  }

  return result;
}
