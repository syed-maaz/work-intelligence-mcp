// DepChange interface mirrors the shape from dep-diff.ts (plan 55-02)
export interface DepChange {
  packageName: string;
  from:        string | null;
  to:          string | null;
  type:        'added' | 'removed' | 'changed';
}

// TraceOutput imported from call-graph-tracer (plan 55-03 T1)
import type { TraceOutput } from './call-graph-tracer.js';

export interface ExternalDepSignal {
  triggered:    boolean;
  depName:      string | null;
  fromVersion:  string | null;
  toVersion:    string | null;
  affectedPath: string | null;   // which part of the application calls into this dep
  confidence:   'high' | 'medium' | 'low';
  reason:       string;
}

export function evaluateExternalDepSignal(
  depChanges:   DepChange[],
  traceResult:  TraceOutput,
  _ticketTitle:  string
): ExternalDepSignal {
  // Condition: dep bump exists AND call graph hits external boundary
  const hasBump = depChanges.length > 0;
  const hasExternalBoundary = traceResult.crossRepoBoundaries.length > 0;

  if (!hasBump && !hasExternalBoundary) {
    return { triggered: false, depName: null, fromVersion: null, toVersion: null,
             affectedPath: null, confidence: 'low', reason: 'No dep bump and no external boundary found.' };
  }

  if (hasBump && hasExternalBoundary) {
    const dep = depChanges[0];
    const boundary = traceResult.crossRepoBoundaries[0];
    return {
      triggered:   true,
      depName:     dep.packageName,
      fromVersion: dep.from,
      toVersion:   dep.to,
      affectedPath: boundary.via,
      confidence:  'high',
      reason:      `Dep bump (${dep.packageName} ${dep.from}→${dep.to}) coincides with cross-repo boundary at ${boundary.via}. Likely the external code relies on the changed API.`,
    };
  }

  if (hasBump) {
    const dep = depChanges[0];
    return {
      triggered:   true,
      depName:     dep.packageName,
      fromVersion: dep.from,
      toVersion:   dep.to,
      affectedPath: null,
      confidence:  'medium',
      reason:      `Dep bump found (${dep.packageName}) but no clear call path to external code. Investigate ${dep.packageName} changelog for breaking changes.`,
    };
  }

  // External boundary but no dep bump
  return {
    triggered:   true,
    depName:     null,
    fromVersion: null,
    toVersion:   null,
    affectedPath: traceResult.crossRepoBoundaries[0]?.via ?? null,
    confidence:  'low',
    reason:      'Call path crosses repo boundary but no dep version changes detected. May be a runtime configuration or behavior change in external system.',
  };
}
