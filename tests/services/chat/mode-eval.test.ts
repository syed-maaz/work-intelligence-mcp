/**
 * Mode-detection accuracy gate (Phase 78a-07 / SPEC item 14).
 *
 * Loads the committed `tests/services/chat/mode-eval.jsonl` (30 entries —
 * 12 WORK / 12 LIFE / 6 AMBIGUOUS, placeholder-shaped per D-78a-10), runs
 * each through `detectMode`, and asserts top-1 accuracy ≥ 90% (≥ 27/30).
 *
 * The eval set is regenerated via `npm run build:mode-eval` (interactive)
 * or `npm run build:mode-eval -- --seed-only` (autonomous). Re-run after
 * the redact list changes or when refreshing the distribution.
 *
 * Failure mode: when accuracy drops, the test prints a diagnostic table of
 * mis-classified entries (message, expected, actual, signals) so the
 * detector or the eval set can be adjusted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectMode } from '../../../src/services/chat/mode-detect.js';

interface EvalEntry {
  message: string;
  expected_mode: 'work' | 'life' | 'ambiguous';
  rationale?: string;
  seed?: boolean;
  auto_labeled?: boolean;
}

const EVAL_PATH = path.join(import.meta.dirname, 'mode-eval.jsonl');
const TARGET_TOTAL = 30;
const TARGET_DISTRIBUTION = { work: 12, life: 12, ambiguous: 6 };
const ACCURACY_THRESHOLD = 0.9;
const MIN_CORRECT = Math.ceil(ACCURACY_THRESHOLD * TARGET_TOTAL); // 27

function loadEvalSet(): EvalEntry[] {
  const raw = fs.readFileSync(EVAL_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalEntry);
}

describe('mode-detection accuracy on 30-intent eval set', () => {
  const entries = loadEvalSet();

  it(`set has ${TARGET_TOTAL} entries with ${TARGET_DISTRIBUTION.work}/${TARGET_DISTRIBUTION.life}/${TARGET_DISTRIBUTION.ambiguous} distribution`, () => {
    expect(entries).toHaveLength(TARGET_TOTAL);
    const counts = { work: 0, life: 0, ambiguous: 0 };
    for (const e of entries) counts[e.expected_mode]++;
    expect(counts).toEqual(TARGET_DISTRIBUTION);
  });

  it(`top-1 accuracy ≥ ${ACCURACY_THRESHOLD * 100}% (≥ ${MIN_CORRECT}/${TARGET_TOTAL})`, () => {
    let correct = 0;
    const wrong: Array<{
      message: string;
      expected: string;
      actual: string;
      signals: string[];
      confidence: number;
    }> = [];

    for (const entry of entries) {
      const result = detectMode({ message: entry.message });
      if (result.mode === entry.expected_mode) {
        correct++;
      } else {
        wrong.push({
          message: entry.message,
          expected: entry.expected_mode,
          actual: result.mode,
          signals: result.signals,
          confidence: result.confidence,
        });
      }
    }

    if (correct < MIN_CORRECT) {
      const dump = wrong
        .map(
          (w) =>
            `    "${w.message}" — expected ${w.expected}, got ${w.actual} ` +
            `(conf ${w.confidence.toFixed(2)}, signals: ${JSON.stringify(w.signals)})`
        )
        .join('\n');
      throw new Error(
        `Accuracy ${correct}/${entries.length} below threshold ${MIN_CORRECT}/${entries.length}.\n` +
          `Mis-classified entries:\n${dump}`
      );
    }

    expect(correct).toBeGreaterThanOrEqual(MIN_CORRECT);
  });

  it('imperative-verb canary entry routes WORK with confidence ≥ 0.7', () => {
    const canary = entries.find(
      (e) =>
        /\binvestigate\b/i.test(e.message) &&
        /<JIRA-KEY-\d+>/.test(e.message) &&
        /\b(?:exhausted|tired|stressed|overwhelmed|drained)\b/i.test(e.message)
    );
    expect(canary, 'eval set must contain a mood + imperative + jira-placeholder canary').toBeDefined();
    const result = detectMode({ message: canary!.message });
    expect(result.mode).toBe('work');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.signals).toContain('imperative:investigate');
  });
});
