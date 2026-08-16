/**
 * scripts/smoke-tool-catalog.ts — ADR-037 Phase 2 close gate.
 *
 * Validates the in-memory TOOL_CATALOG without needing a running bridge
 * or a database. Exits non-zero on any failure; the parent shell script
 * (smoke-bridge.sh § 23) treats non-zero as a smoke failure.
 *
 * Checks (mirrors execution plan § 2.4):
 *   1. Every ToolDefinition has the 7 required fields.
 *   2. Every input_schema is a well-formed JSON Schema object literal.
 *   3. Every wi-* skill in SKILL_CATALOG has a corresponding wi_* tool.
 *   4. No two tools share a name.
 *   5. Every 'confirm'-category tool's description signals when-to-call
 *      (heuristic: contains "Call" or "Use" — Phase 1 spike voice rule).
 *   6. codegenExemptCount() === 0  — Phase 2 acceptance gate.
 *
 * Runs in-process via `tsx` so it can `import` the catalog directly. No
 * bridge boot, no DB; total wall-clock < 1s on a warm cache.
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed; details printed to stderr
 *
 * Usage:
 *   npm run smoke:tool-catalog
 *   node --import tsx/esm scripts/smoke-tool-catalog.ts
 */

import { TOOL_CATALOG, codegenExemptCount } from '../src/services/cypher/tool-catalog.js';
import { SKILL_CATALOG } from '../src/services/cypher/skills.js';

type Failure = { check: string; detail: string };
const failures: Failure[] = [];
const passes: string[] = [];

function fail(check: string, detail: string): void {
  failures.push({ check, detail });
}
function pass(check: string): void {
  passes.push(check);
}

// ─── Check 1: ToolDefinition shape ───────────────────────────────────────────

const REQUIRED_FIELDS = [
  'name',
  'description',
  'category',
  'posture_eligibility',
  'input_schema',
  'estimated_duration_ms',
  'handler',
] as const;

const VALID_CATEGORIES = new Set(['auto', 'confirm', 'cli']);
const VALID_POSTURES = new Set(['pr-review', 'bug-investigate', 'pm', 'generic']);

let shapeOk = true;
for (const t of TOOL_CATALOG) {
  for (const f of REQUIRED_FIELDS) {
    if (!(f in t)) {
      fail('1.shape', `${t.name ?? '<unnamed>'} missing required field "${f}"`);
      shapeOk = false;
    }
  }
  if (typeof t.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(t.name)) {
    fail('1.shape', `${t.name} — name must be snake_case`);
    shapeOk = false;
  }
  if (!VALID_CATEGORIES.has(t.category)) {
    fail('1.shape', `${t.name} — invalid category "${t.category}"`);
    shapeOk = false;
  }
  if (!Array.isArray(t.posture_eligibility) || t.posture_eligibility.length === 0) {
    fail('1.shape', `${t.name} — posture_eligibility must be a non-empty string array`);
    shapeOk = false;
  } else {
    for (const p of t.posture_eligibility) {
      if (!VALID_POSTURES.has(p)) {
        fail('1.shape', `${t.name} — invalid posture "${p}"`);
        shapeOk = false;
      }
    }
  }
  if (typeof t.estimated_duration_ms !== 'number' || t.estimated_duration_ms <= 0) {
    fail('1.shape', `${t.name} — estimated_duration_ms must be a positive number`);
    shapeOk = false;
  }
  if (typeof t.handler !== 'function') {
    fail('1.shape', `${t.name} — handler must be a function`);
    shapeOk = false;
  }
}
if (shapeOk) pass(`1.shape — all ${TOOL_CATALOG.length} tools have the 7 required fields`);

// ─── Check 2: input_schema well-formed ───────────────────────────────────────

let schemaOk = true;
for (const t of TOOL_CATALOG) {
  const s = t.input_schema as Record<string, unknown>;
  if (s == null || typeof s !== 'object' || Array.isArray(s)) {
    fail('2.schema', `${t.name} — input_schema is not an object`);
    schemaOk = false;
    continue;
  }
  if (s.type !== 'object') {
    fail('2.schema', `${t.name} — input_schema.type must be "object" (got ${JSON.stringify(s.type)})`);
    schemaOk = false;
  }
  if (s.properties == null || typeof s.properties !== 'object' || Array.isArray(s.properties)) {
    fail('2.schema', `${t.name} — input_schema.properties must be an object`);
    schemaOk = false;
    continue;
  }
  // every property must be an object with a type field (string/integer/boolean/array/object)
  for (const [pname, pval] of Object.entries(s.properties as Record<string, unknown>)) {
    if (pval == null || typeof pval !== 'object' || Array.isArray(pval)) {
      fail('2.schema', `${t.name}.${pname} — property value must be an object`);
      schemaOk = false;
      continue;
    }
    const pType = (pval as Record<string, unknown>).type;
    if (typeof pType !== 'string') {
      fail('2.schema', `${t.name}.${pname} — property must declare a type (got ${JSON.stringify(pType)})`);
      schemaOk = false;
    }
  }
  // if required is present, it must be a string array
  if (s.required != null) {
    if (!Array.isArray(s.required)) {
      fail('2.schema', `${t.name} — input_schema.required must be an array`);
      schemaOk = false;
    } else {
      for (const r of s.required) {
        if (typeof r !== 'string') {
          fail('2.schema', `${t.name} — required entry "${r}" is not a string`);
          schemaOk = false;
        }
        if (!(s.properties as Record<string, unknown>)[r as string]) {
          fail('2.schema', `${t.name} — required field "${r}" not declared in properties`);
          schemaOk = false;
        }
      }
    }
  }
}
if (schemaOk) pass(`2.schema — all ${TOOL_CATALOG.length} input_schemas are well-formed`);

// ─── Check 3: wi-* skills have catalog entries ───────────────────────────────

const catalogNames = new Set(TOOL_CATALOG.map((t) => t.name));
const missingWi: string[] = [];
for (const skillKey of Object.keys(SKILL_CATALOG)) {
  if (!skillKey.startsWith('wi-')) continue;
  // SKILL_CATALOG keys are kebab-case (e.g. 'wi-search'); catalog names are snake_case ('wi_search').
  const expectedName = skillKey.replace(/-/g, '_');
  if (!catalogNames.has(expectedName)) {
    missingWi.push(`${skillKey} → expected catalog entry "${expectedName}"`);
  }
}
if (missingWi.length === 0) {
  pass(`3.wi-coverage — all ${Object.keys(SKILL_CATALOG).length} SKILL_CATALOG wi-* entries have catalog tools`);
} else {
  for (const m of missingWi) fail('3.wi-coverage', m);
}

// ─── Check 4: no duplicate names ─────────────────────────────────────────────

const seen = new Map<string, number>();
for (const t of TOOL_CATALOG) {
  seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
}
const dups = Array.from(seen.entries()).filter(([, n]) => n > 1);
if (dups.length === 0) {
  pass(`4.unique — all ${TOOL_CATALOG.length} names are unique`);
} else {
  for (const [name, n] of dups) fail('4.unique', `${name} appears ${n} times`);
}

// ─── Check 5: confirm-tools name when-to-call ────────────────────────────────

let confirmOk = true;
const confirmTools = TOOL_CATALOG.filter((t) => t.category === 'confirm');
for (const t of confirmTools) {
  const desc = typeof t.description === 'string' ? t.description : '';
  // Heuristic: a verb-first when-to-call phrase. Match either "Use" or "Call"
  // (case-insensitive) as a standalone word — Phase 1 spike voice rule.
  if (!/\b(use|call|reserve)\b/i.test(desc)) {
    fail('5.confirm-voice', `${t.name} — confirm-class tool description lacks when-to-call signal (no "Use" / "Call" / "Reserve")`);
    confirmOk = false;
  }
}
if (confirmOk) pass(`5.confirm-voice — all ${confirmTools.length} confirm tools name when-to-call`);

// ─── Check 6: D21 acceptance gate — N=0 codegen_exempt ───────────────────────

const exempt = codegenExemptCount();
if (exempt === 0) {
  pass(`6.exempt — codegenExemptCount() === 0 (D21 Phase 2 acceptance gate)`);
} else {
  fail('6.exempt', `codegenExemptCount() === ${exempt} (expected 0 for Phase 2)`);
}

// ─── Report ──────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════');
console.log(`Tool catalog smoke (Phase 2 close gate)`);
console.log('═══════════════════════════════════════════════════');
for (const p of passes) console.log(`  ✓ ${p}`);
for (const f of failures) console.error(`  ✗ ${f.check} — ${f.detail}`);
console.log('───────────────────────────────────────────────────');
console.log(
  `Catalog: ${TOOL_CATALOG.length} tools, ${exempt} exempt. ` +
    `${passes.length} checks passed, ${failures.length} failed.`,
);
console.log('═══════════════════════════════════════════════════');

if (failures.length > 0) process.exit(1);
process.exit(0);
