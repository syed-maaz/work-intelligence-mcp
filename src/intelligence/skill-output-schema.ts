/**
 * Output contract for the /wi-investigate skill.
 *
 * Closes ADR-REVIEW GAP-002 (2026-05-21).
 *
 * Why this file exists
 * --------------------
 * `runSkillInvestigation()` shells out to the Claude CLI with the
 * wi-investigate SKILL.md as the system prompt. The generic
 * `OUTPUT_SCHEMA` in claude-code-runner.ts only requires
 * findings[i].confidence — nothing else. That meant:
 *
 *   - the skill could return any markdown explanation as `title`
 *   - `synthesizeReports()` would blindly use `topFinding.title` as
 *     the merged report's rootCause
 *   - if the skill forgot to emit a confidence field, comparisons
 *     against the ReAct engine silently broke (both sides ~= 0)
 *
 * This module gives us:
 *   1. A strict Zod schema (`SkillInvestigationFindingSchema`) the
 *      orchestrator runs against the parsed result before trusting
 *      the skill output.
 *   2. A JSON-schema string (`SKILL_INVESTIGATION_JSON_SCHEMA`) that
 *      we pass to the CLI via `--json-schema`, forcing the model to
 *      emit the structured contract instead of free-form prose.
 *
 * Keep this file in sync with:
 *   ~/.claude/skills/work-intelligence/wi-investigate/SKILL.md  (Output Contract section)
 *   docs/docs/skills/wi-investigate.md                          (Output Contract section)
 */

import { z } from 'zod';

export const SkillEvidenceSchema = z.object({
  type:        z.string(),
  description: z.string(),
  file:        z.string().optional(),
  sha:         z.string().optional(),
});

export const SkillInvestigationFindingSchema = z.object({
  rootCauseType:  z.enum([
    'dep-upgrade',
    'code-regression',
    'config-change',
    'external-service',
    'unknown',
  ]),
  rootCause:      z.string().min(10),
  fixOwner:       z.string().min(1),
  isExternalDep:  z.boolean(),
  confidence:     z.number().min(0).max(1),
  proposedFix:    z.string().nullable().optional(),
  nextAction: z.string().min(1),
  evidence:       z.array(SkillEvidenceSchema).default([]),
});

export const SkillInvestigationResultSchema = z.object({
  findings:      z.array(SkillInvestigationFindingSchema).min(1),
  filesExamined: z.array(z.string()).default([]),
  confidence:    z.number().min(0).max(1),
});

export type SkillInvestigationFinding = z.infer<typeof SkillInvestigationFindingSchema>;
export type SkillInvestigationResult  = z.infer<typeof SkillInvestigationResultSchema>;

/**
 * JSON-schema string passed to the Claude CLI via `--json-schema`.
 * Forces the wi-investigate skill to emit the structured contract.
 *
 * Hand-mirrored from the Zod schema above. If you change the Zod
 * shape, change this string in the same commit — there's a smoke
 * check (scripts/smoke-bridge.sh) that round-trips both.
 */
export const SKILL_INVESTIGATION_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          rootCauseType: {
            type: 'string',
            enum: ['dep-upgrade', 'code-regression', 'config-change', 'external-service', 'unknown'],
          },
          rootCause:      { type: 'string', minLength: 10 },
          fixOwner:       { type: 'string', minLength: 1 },
          isExternalDep:  { type: 'boolean' },
          confidence:     { type: 'number', minimum: 0, maximum: 1 },
          proposedFix:    { type: ['string', 'null'] },
          nextAction: { type: 'string', minLength: 1 },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type:        { type: 'string' },
                description: { type: 'string' },
                file:        { type: 'string' },
                sha:         { type: 'string' },
              },
              required: ['type', 'description'],
            },
          },
        },
        required: [
          'rootCauseType',
          'rootCause',
          'fixOwner',
          'isExternalDep',
          'confidence',
          'nextAction',
        ],
      },
    },
    filesExamined: { type: 'array', items: { type: 'string' } },
    confidence:    { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['findings', 'confidence'],
});

/**
 * Validate a parsed skill payload. Returns the typed result on
 * success or `null` on any validation failure (orchestrator
 * treats null as "skill produced no usable output").
 *
 * Logs the validation issue to stderr so the failure is visible
 * in the bridge log; we don't throw because the ReAct engine's
 * report is the fallback.
 */
export function parseSkillInvestigationResult(raw: unknown): SkillInvestigationResult | null {
  const parsed = SkillInvestigationResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  process.stderr.write(
    `[skill-schema] wi-investigate output rejected: ${issue?.path.join('.') ?? '<root>'} — ${issue?.message ?? 'unknown'}\n`
  );
  return null;
}
