import { describe, it, expect } from 'vitest';
import {
  parseSkillInvestigationResult,
  SkillInvestigationResultSchema,
} from '../../src/intelligence/skill-output-schema.js';

describe('skill-output-schema (GAP-002)', () => {
  const valid = {
    findings: [{
      rootCauseType: 'config-change' as const,
      rootCause: 'Feature flag FF_RM_11372 was promoted on Apr 17.',
      fixOwner: 'Platform',
      isExternalDep: true,
      confidence: 0.85,
      proposedFix: null,
      nextAction: 'Escalate to operations for flag rollback',
      evidence: [{ type: 'git-commit', description: 'PR #6107 changed flag status' }],
    }],
    filesExamined: ['repos/example-service/cluster-setup/feature-flags.yaml'],
    confidence: 0.85,
  };

  it('accepts a valid structured skill payload', () => {
    expect(parseSkillInvestigationResult(valid)).not.toBeNull();
    expect(SkillInvestigationResultSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects generic research findings shape (no rootCause)', () => {
    const generic = {
      findings: [{
        title: 'Something broke',
        explanation: 'Maybe a flag',
        relevantFiles: [],
        confidence: 0.9,
      }],
      filesExamined: [],
      confidence: 0.9,
    };
    expect(parseSkillInvestigationResult(generic)).toBeNull();
  });

  it('rejects missing confidence on finding', () => {
    const bad = {
      ...valid,
      findings: [{ ...valid.findings[0], confidence: 1.5 }],
    };
    expect(parseSkillInvestigationResult(bad)).toBeNull();
  });
});
