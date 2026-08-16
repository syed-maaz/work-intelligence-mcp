/**
 * ADR-039 AC-8 — refined_goal JSON schema + validator.
 *
 * The SCOPE phase of runLoop emits a structured brief — `refined_goal` —
 * that the EXECUTE phase reads as authoritative context. This module is
 * the single source of truth for the shape:
 *
 *   - `RefinedGoal` — the TypeScript type the loop and persistence layer
 *     speak. Mirrors `cypher_sessions.refined_goal` (TEXT/JSON column
 *     added by migration v85).
 *   - `validateRefinedGoal(value)` — a hand-rolled validator that returns
 *     `{ ok: true, value: RefinedGoal }` on success or `{ ok: false,
 *     errors: string[] }` on failure. We don't pull in `ajv` for this —
 *     the schema is small, the loop is hot, and a hand-rolled validator
 *     keeps the dependency footprint flat (matches the rest of `src/`).
 *
 * Required fields per ADR-039 § Scope phase:
 *   - intent: enum
 *   - target: non-empty string
 *   - constraints: string[]
 *   - success_criteria: string[] (must be non-empty)
 *   - out_of_scope: string[]
 *   - linkage: { jira: string[], prs: string[], adrs: string[], files: string[] }
 *   - expected_output_shape: enum
 *   - evidence_cited: { source: string, ref: string, snippet: string }[]
 *
 * When a refiner emits a payload missing any required field — or with a
 * field of the wrong shape — the loop's contract is to fail the SCOPE
 * phase with `verdict='halted'` and an error surface naming the missing
 * field. AC-8 is the gate that catches that fail-closed.
 *
 * Linked:
 *   - docs/docs/adr/adr-039-cypher-refinement-phase.md § Scope phase
 *   - src/db/migrations/v85_cypher_sessions_refined_goal.ts (schema)
 *   - src/services/cypher/loop.ts (consumer; T8 wires the call site)
 *   - tests/cypher/refined-goal-schema.test.ts (5 valid + 5 invalid)
 */

export type RefinedGoalIntent =
  | 'investigate'
  | 'build'
  | 'review'
  | 'analyze'
  | 'refactor'
  | 'other'
  // ── Deliberative intents (AC-A1, 2026-07-17) ──────────────────────────
  // The six above are all *doing* verbs → EXECUTE (Cypher dispatches them).
  // These three are *deliberation* verbs → the PM capture hook parks them on
  // the board instead of dispatching (ADR-043 mapRefinedIntent routes exactly
  // brainstorm|plan|decide to capturable). Before this, the refiner had no way
  // to express "this is thinking-work, not doing-work", so AC-A1 could never
  // fire (every goal collapsed to execute). See task-memory.ts REFINED_INTENT_
  // TO_PM_INTENT for the downstream mapping (+ synonyms ideate/explore/…).
  | 'brainstorm'
  | 'plan'
  | 'decide';

export type RefinedGoalOutputShape =
  | 'rca'
  | 'patch'
  | 'brief'
  | 'code'
  | 'answer';

export interface RefinedGoalLinkage {
  jira: string[];
  prs: string[];
  adrs: string[];
  files: string[];
}

export interface RefinedGoalEvidence {
  source: string;
  ref: string;
  snippet: string;
}

/**
 * ADR-042 multi-intent extension (2026-07-15).
 *
 * When Stage 1's classifier detects that the raw goal is compound
 * (e.g. "investigate X AND refactor Y AND ship it"), the refiner
 * emits one SubBrief per atomic sub-intent, each independently
 * enriched by its own Stage 1 fetch. The top-level `RefinedGoal`
 * fields mirror the FIRST sub-intent for back-compat with EXECUTE
 * consumers that expect the flat shape.
 *
 * A single-intent goal produces a `RefinedGoal` with `intents.length === 1`
 * or with the field omitted entirely (either is valid).
 */
export interface SubBrief {
  intent: RefinedGoalIntent;
  target: string;
  constraints: string[];
  success_criteria: string[];
  out_of_scope: string[];
  linkage: RefinedGoalLinkage;
  expected_output_shape: RefinedGoalOutputShape;
  evidence_cited: RefinedGoalEvidence[];
}

export interface RefinedGoal {
  intent: RefinedGoalIntent;
  target: string;
  constraints: string[];
  success_criteria: string[];
  out_of_scope: string[];
  linkage: RefinedGoalLinkage;
  expected_output_shape: RefinedGoalOutputShape;
  evidence_cited: RefinedGoalEvidence[];
  /**
   * ADR-042 multi-intent (2026-07-15). Optional — present when Stage 1
   * classified the goal as compound. Each sub-intent is independently
   * enriched (own Stage 1 fetch), all emitted in ONE Anthropic response.
   * When present, `intents[0]` MUST match the top-level fields (mirror
   * for back-compat with flat-shape consumers).
   */
  intents?: SubBrief[];
}

export type ValidateResult =
  | { ok: true; value: RefinedGoal }
  | { ok: false; errors: string[] };

const VALID_INTENTS: ReadonlyArray<RefinedGoalIntent> = [
  'investigate',
  'build',
  'review',
  'analyze',
  'refactor',
  'other',
  // Deliberative — routed to the PM board by the capture hook (AC-A1).
  'brainstorm',
  'plan',
  'decide',
];

const VALID_OUTPUT_SHAPES: ReadonlyArray<RefinedGoalOutputShape> = [
  'rca',
  'patch',
  'brief',
  'code',
  'answer',
];

/**
 * Near-miss coercion for `expected_output_shape` (2026-07-16).
 *
 * The refiner LLM intermittently emits output-shape tokens that aren't in the
 * schema enum — most commonly `'plan'` (it conflates the Stage-1 brief with a
 * Stage-2 plan), plus the legacy `pr | branch | summary` that an older fallback
 * prompt advertised. Hard-rejecting these halted the WHOLE dispatch at iter 0
 * (the SCOPE schema-validation halt). These are all safely representable as an
 * existing shape, so we COERCE the near-miss to its closest valid shape and
 * proceed instead of failing. The prompt is also aligned to the enum (loop.ts)
 * so this is a belt-and-suspenders backstop, not the primary control.
 */
const OUTPUT_SHAPE_COERCION: Readonly<Record<string, RefinedGoalOutputShape>> = {
  plan: 'brief',
  summary: 'brief',
  pr: 'patch',
  branch: 'patch',
  diff: 'patch',
  fix: 'patch',
  report: 'rca',
  investigation: 'rca',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function validateLinkage(
  v: unknown,
  errors: string[],
): v is RefinedGoalLinkage {
  if (!isObject(v)) {
    errors.push('linkage: expected object');
    return false;
  }
  let ok = true;
  for (const k of ['jira', 'prs', 'adrs', 'files'] as const) {
    if (!isStringArray(v[k])) {
      errors.push(`linkage.${k}: expected string[]`);
      ok = false;
    }
  }
  return ok;
}

function validateEvidence(
  v: unknown,
  errors: string[],
): v is RefinedGoalEvidence[] {
  if (!Array.isArray(v)) {
    errors.push('evidence_cited: expected array');
    return false;
  }
  let ok = true;
  v.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`evidence_cited[${i}]: expected object`);
      ok = false;
      return;
    }
    for (const k of ['source', 'ref', 'snippet'] as const) {
      if (typeof entry[k] !== 'string') {
        errors.push(`evidence_cited[${i}].${k}: expected string`);
        ok = false;
      }
    }
  });
  return ok;
}

/**
 * Validate a refined_goal payload against the ADR-039 schema.
 *
 * On success returns `{ ok: true, value }` where `value` is the
 * structurally-typed object (same reference, narrowed type). On
 * failure returns `{ ok: false, errors }` with one error per missing
 * or wrong-shape field. The errors array is suitable for inclusion in
 * the loop's halted surface.
 */
export function validateRefinedGoal(input: unknown): ValidateResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { ok: false, errors: ['refined_goal: expected object'] };
  }

  // intent
  if (typeof input.intent !== 'string') {
    errors.push('intent: expected string');
  } else if (!VALID_INTENTS.includes(input.intent as RefinedGoalIntent)) {
    errors.push(
      `intent: expected one of ${VALID_INTENTS.join('|')}; got '${input.intent}'`,
    );
  }

  // target
  if (typeof input.target !== 'string') {
    errors.push('target: expected string');
  } else if (input.target.trim().length === 0) {
    errors.push('target: expected non-empty string');
  }

  // constraints
  if (!isStringArray(input.constraints)) {
    errors.push('constraints: expected string[]');
  }

  // success_criteria
  if (!isStringArray(input.success_criteria)) {
    errors.push('success_criteria: expected string[]');
  } else if (input.success_criteria.length === 0) {
    errors.push('success_criteria: expected non-empty string[]');
  }

  // out_of_scope
  if (!isStringArray(input.out_of_scope)) {
    errors.push('out_of_scope: expected string[]');
  }

  // linkage
  validateLinkage(input.linkage, errors);

  // expected_output_shape — coerce near-misses (plan→brief, pr→patch, …)
  // before rejecting, so a single off-enum token doesn't halt the dispatch.
  if (typeof input.expected_output_shape !== 'string') {
    errors.push('expected_output_shape: expected string');
  } else if (
    !VALID_OUTPUT_SHAPES.includes(
      input.expected_output_shape as RefinedGoalOutputShape,
    )
  ) {
    const coerced = OUTPUT_SHAPE_COERCION[input.expected_output_shape.toLowerCase().trim()];
    if (coerced) {
      // Coerce in place — the validated value returned below is `input` cast.
      (input as { expected_output_shape: RefinedGoalOutputShape }).expected_output_shape = coerced;
    } else {
      errors.push(
        `expected_output_shape: expected one of ${VALID_OUTPUT_SHAPES.join('|')} (or a coercible near-miss); got '${input.expected_output_shape}'`,
      );
    }
  }

  // evidence_cited
  validateEvidence(input.evidence_cited, errors);

  // intents[] — optional multi-intent extension (ADR-042).
  // When present, must be a non-empty array of SubBriefs, and intents[0]
  // must mirror the top-level fields (that's the "primary" contract).
  if (input.intents !== undefined) {
    if (!Array.isArray(input.intents)) {
      errors.push('intents: expected array when present');
    } else if (input.intents.length === 0) {
      errors.push('intents: expected non-empty array when present');
    } else {
      input.intents.forEach((sub, i) => {
        if (!isObject(sub)) {
          errors.push(`intents[${i}]: expected object`);
          return;
        }
        // Each sub-brief validated by re-using the same field checks.
        if (typeof sub.intent !== 'string' || !VALID_INTENTS.includes(sub.intent as RefinedGoalIntent)) {
          errors.push(`intents[${i}].intent: expected one of ${VALID_INTENTS.join('|')}`);
        }
        if (typeof sub.target !== 'string' || sub.target.trim().length === 0) {
          errors.push(`intents[${i}].target: expected non-empty string`);
        }
        if (!isStringArray(sub.constraints)) errors.push(`intents[${i}].constraints: expected string[]`);
        if (!isStringArray(sub.success_criteria) || sub.success_criteria.length === 0) {
          errors.push(`intents[${i}].success_criteria: expected non-empty string[]`);
        }
        if (!isStringArray(sub.out_of_scope)) errors.push(`intents[${i}].out_of_scope: expected string[]`);
        validateLinkage(sub.linkage, errors);
        if (
          typeof sub.expected_output_shape !== 'string' ||
          !VALID_OUTPUT_SHAPES.includes(sub.expected_output_shape as RefinedGoalOutputShape)
        ) {
          errors.push(`intents[${i}].expected_output_shape: expected one of ${VALID_OUTPUT_SHAPES.join('|')}`);
        }
        validateEvidence(sub.evidence_cited, errors);
      });
      // intents[0] must mirror the flat top-level fields — the back-compat
      // contract for EXECUTE consumers that only read the flat shape.
      const first = input.intents[0] as Record<string, unknown> | undefined;
      if (isObject(first)) {
        if (first.intent !== input.intent) {
          errors.push(`intents[0].intent must mirror top-level intent (got '${first.intent}' vs '${input.intent}')`);
        }
        if (first.target !== input.target) {
          errors.push('intents[0].target must mirror top-level target');
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: input as unknown as RefinedGoal };
}

/**
 * Convenience: parse a JSON string into a validated RefinedGoal. Used by
 * the loop when reading `cypher_sessions.refined_goal` from disk.
 * Returns `{ ok: false, errors }` on either parse failure or shape failure.
 */
export function parseRefinedGoal(json: string): ValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [`json_parse: ${msg}`] };
  }
  return validateRefinedGoal(parsed);
}
