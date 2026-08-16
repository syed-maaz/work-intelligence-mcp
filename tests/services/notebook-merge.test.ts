/**
 * Tests for notebook-merge — verifies the 5 invariants from
 * .planning/updatenotebook-cost-reduction/01-cost-analysis-and-impact-map.md
 * § 7 Option 3 Risk block.
 *
 * These are pure-function tests. No DB, no network, no SDK mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalizePersonName,
  mergePeople,
  appendDeduped,
  removeDeduped,
  applyPatch,
  renderMarkdown,
  parseMarkdownToState,
  emptyState,
  type NotebookState,
  type NotebookPatch,
} from '../../src/services/notebook-merge.js';

describe('canonicalizePersonName', () => {
  it('lowercases and trims', () => {
    expect(canonicalizePersonName('  Maaz Syed  ')).toBe('maaz syed');
  });

  it('flips "Lastname, Firstname" to "firstname lastname"', () => {
    expect(canonicalizePersonName('Syed, Maaz')).toBe('maaz syed');
  });

  it('preserves initial-only forms (merge step will fold them later)', () => {
    expect(canonicalizePersonName('M. Syed')).toBe('m syed');
  });

  it('returns empty string for falsy/whitespace input', () => {
    expect(canonicalizePersonName('')).toBe('');
    expect(canonicalizePersonName('   ')).toBe('');
    expect(canonicalizePersonName(null as unknown as string)).toBe('');
  });

  it('does not flip multi-comma strings (defensive — ambiguous)', () => {
    // "Smith, John, PhD" should NOT be flipped because there are two commas.
    expect(canonicalizePersonName('Smith, John, PhD')).toBe('smith, john, phd');
  });

  it('collapses internal whitespace', () => {
    expect(canonicalizePersonName('Maaz    Syed')).toBe('maaz syed');
  });
});

describe('mergePeople (Invariant 1: dedup with name-form variations)', () => {
  it('treats "Syed, Maaz", "Maaz Syed", and "M. Syed" as the same person', () => {
    const result = mergePeople(['Maaz Syed'], ['Syed, Maaz', 'M. Syed']);
    expect(result).toEqual(['Maaz Syed']);
  });

  it('keeps the existing display form when a new variant arrives', () => {
    const result = mergePeople(['Syed, Maaz'], ['Maaz Syed']);
    expect(result).toEqual(['Syed, Maaz']);  // existing form wins, no churn
  });

  it('appends genuinely new people in input order', () => {
    const result = mergePeople(['Maaz Syed'], ['Alex Park', 'Jane Doe']);
    expect(result).toEqual(['Maaz Syed', 'Alex Park', 'Jane Doe']);
  });

  it('folds an initial-only new entry into an existing fuller form', () => {
    // We have "Maaz Syed"; the patch returns "M Syed" → should fold, not append.
    const result = mergePeople(['Maaz Syed'], ['M Syed']);
    expect(result).toEqual(['Maaz Syed']);
  });

  it('does NOT fold when last name differs', () => {
    const result = mergePeople(['Maaz Syed'], ['M Park']);
    expect(result).toEqual(['Maaz Syed', 'M Park']);
  });

  it('does NOT fold when initial does not match the existing first name', () => {
    // existing: "Alex Park" (canon: "alex park"). New: "M Park" — initial 'm' ≠ 'a'.
    const result = mergePeople(['Alex Park'], ['M Park']);
    expect(result).toEqual(['Alex Park', 'M Park']);
  });

  it('Jaccard regression: a notebook re-merge of the same 4 alias forms produces 1 person', () => {
    // Repro for the silent-breakage risk called out in the doc: if the model
    // returns the same human under 4 name forms over 4 calls, we MUST keep
    // the merged list at length 1, not 4 (else relationship-detector at
    // detectSharedPeople line 90 silently inflates the topic-relationships
    // graph).
    let people: string[] = [];
    people = mergePeople(people, ['Maaz Syed']);
    people = mergePeople(people, ['Syed, Maaz']);
    people = mergePeople(people, ['M. Syed']);
    people = mergePeople(people, ['M Syed']);
    expect(people).toEqual(['Maaz Syed']);
  });
});

describe('appendDeduped (Invariant 4: idempotency)', () => {
  it('appends new items in order', () => {
    expect(appendDeduped(['a', 'b'], ['c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips items already present (case-insensitive, trim-aware)', () => {
    expect(appendDeduped(['Decision A'], ['decision a', ' DECISION A '])).toEqual(['Decision A']);
  });

  it('idempotent: applying the same incoming twice yields the same list', () => {
    const first = appendDeduped(['x'], ['y', 'z']);
    const second = appendDeduped(first, ['y', 'z']);
    expect(second).toEqual(first);
  });

  it('skips empty/whitespace-only entries', () => {
    expect(appendDeduped(['a'], ['', '   ', 'b'])).toEqual(['a', 'b']);
  });
});

describe('removeDeduped', () => {
  it('removes matching items, preserving order of survivors', () => {
    expect(removeDeduped(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('is case-insensitive and trim-aware', () => {
    expect(removeDeduped(['Blocker X'], ['blocker x', '  BLOCKER X '])).toEqual([]);
  });

  it('no-op when toRemove is empty', () => {
    expect(removeDeduped(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('applyPatch', () => {
  const baseState = (): NotebookState => ({
    overview: 'Initial overview.',
    keyPeople: ['Maaz Syed'],
    currentStatus: 'In progress.',
    timeline: ['2026-06-01: kickoff'],
    decisionsMade: ['Use SQLite over Postgres'],
    openQuestionsAndBlockers: ['Need API key from vendor'],
    keyThreads: ['Slack: project channel'],
  });

  it('returns a clone when noChanges is true (pure)', () => {
    const s = baseState();
    const out = applyPatch(s, { noChanges: true });
    expect(out).toEqual(s);
    expect(out).not.toBe(s);
    expect(out.keyPeople).not.toBe(s.keyPeople);
  });

  it('does not mutate the input state', () => {
    const s = baseState();
    const snap = JSON.parse(JSON.stringify(s));
    applyPatch(s, {
      newPeople: ['Alex Park'],
      newDecisions: ['Defer Option 4 until after Option 3 ships'],
      updatedStatus: 'Option 3 in flight',
      resolvedBlockers: ['Need API key from vendor'],
    });
    expect(s).toEqual(snap);
  });

  it('appends new fields and replaces updatedStatus + updatedOverview', () => {
    const s = baseState();
    const out = applyPatch(s, {
      newPeople: ['Alex Park'],
      newTimelineEntries: ['2026-06-23: option 1 shipped'],
      newDecisions: ['Defer Option 4'],
      newBlockers: ['Schema migration risk'],
      newThreads: ['Discussion thread #2'],
      updatedStatus: 'Patch-tool implementation in progress',
      updatedOverview: 'Updated overview text.',
    });
    expect(out.keyPeople).toEqual(['Maaz Syed', 'Alex Park']);
    expect(out.timeline).toEqual(['2026-06-01: kickoff', '2026-06-23: option 1 shipped']);
    expect(out.decisionsMade).toEqual(['Use SQLite over Postgres', 'Defer Option 4']);
    expect(out.openQuestionsAndBlockers).toEqual(['Need API key from vendor', 'Schema migration risk']);
    expect(out.keyThreads).toEqual(['Slack: project channel', 'Discussion thread #2']);
    expect(out.currentStatus).toBe('Patch-tool implementation in progress');
    expect(out.overview).toBe('Updated overview text.');
  });

  it('resolves blockers from openQuestionsAndBlockers', () => {
    const s = baseState();
    const out = applyPatch(s, { resolvedBlockers: ['Need API key from vendor'] });
    expect(out.openQuestionsAndBlockers).toEqual([]);
  });

  it('Invariant 2: decisions are append-only (no removal field)', () => {
    // Confirm the patch shape itself has no decision-removal field.
    const patch = {} as NotebookPatch;
    // @ts-expect-error — this is the assertion we're testing at TYPE level
    patch.removedDecisions = ['something'];
    // (Compile-time check only; the type system rejects removedDecisions.)
    expect(true).toBe(true);
  });

  it('Invariant 3: timeline preserves insertion order', () => {
    const s = baseState();
    const out = applyPatch(s, {
      newTimelineEntries: [
        '2026-06-23: option 1 shipped',
        '2026-06-22: investigation started',  // out-of-order date but kept in input order
      ],
    });
    expect(out.timeline).toEqual([
      '2026-06-01: kickoff',
      '2026-06-23: option 1 shipped',
      '2026-06-22: investigation started',
    ]);
  });

  it('Invariant 4: applying the same patch twice does not duplicate entries', () => {
    const s = baseState();
    const patch: NotebookPatch = {
      newPeople: ['Alex Park'],
      newDecisions: ['Defer Option 4'],
      newTimelineEntries: ['2026-06-23: option 1 shipped'],
      newBlockers: ['Schema migration risk'],
      newThreads: ['Discussion thread #2'],
    };
    const once = applyPatch(s, patch);
    const twice = applyPatch(once, patch);
    expect(twice).toEqual(once);
  });

  it('ignores empty-string updatedStatus / updatedOverview', () => {
    const s = baseState();
    const out = applyPatch(s, { updatedStatus: '', updatedOverview: '' });
    expect(out.currentStatus).toBe('In progress.');
    expect(out.overview).toBe('Initial overview.');
  });
});

describe('renderMarkdown — byte-for-byte legacy compatibility', () => {
  it('emits identical bytes to the legacy 7-section renderer in analyzer.ts:1500-1513', () => {
    // The legacy renderer joins these lines with '\n'. We mirror it exactly.
    // (Cross-checked against src/services/analyzer.ts:1500-1513 at commit 4a758b6.)
    const state: NotebookState = {
      overview: 'Short summary.',
      keyPeople: ['Maaz Syed', 'Alex Park'],
      currentStatus: 'On track.',
      timeline: ['2026-06-01: kickoff', '2026-06-23: shipped Option 1'],
      decisionsMade: ['SQLite over Postgres'],
      openQuestionsAndBlockers: ['Schema migration risk'],
      keyThreads: ['Slack: project channel'],
    };
    const expected = [
      '# Demo Topic',
      '',
      '## Overview',
      'Short summary.',
      '',
      '## Key People',
      '- Maaz Syed',
      '- Alex Park',
      '',
      '## Current Status',
      'On track.',
      '',
      '## Timeline',
      '- 2026-06-01: kickoff',
      '- 2026-06-23: shipped Option 1',
      '',
      '## Decisions Made',
      '- SQLite over Postgres',
      '',
      '## Open Questions & Blockers',
      '- Schema migration risk',
      '',
      '## Key Threads',
      '- Slack: project channel',
    ].join('\n');
    expect(renderMarkdown('Demo Topic', state)).toBe(expected);
  });

  it('handles empty lists gracefully (produces an empty body line for that section)', () => {
    const state = emptyState();
    const out = renderMarkdown('Empty', state);
    expect(out).toContain('## Key People\n\n');  // empty list joins to empty string + trailing newline
    expect(out).toContain('## Timeline\n\n');
  });
});

describe('parseMarkdownToState (Invariant 5: backfill correctness)', () => {
  it('round-trips: render → parse produces the same state', () => {
    const state: NotebookState = {
      overview: 'Round trip overview.',
      keyPeople: ['Maaz Syed', 'Alex Park'],
      currentStatus: 'Tracking.',
      timeline: ['2026-06-01: kickoff', '2026-06-23: shipped Option 1'],
      decisionsMade: ['Use vitest', 'Skip Option 2'],
      openQuestionsAndBlockers: ['Pending review'],
      keyThreads: ['Channel A'],
    };
    const md = renderMarkdown('Round Trip', state);
    const parsed = parseMarkdownToState(md);
    expect(parsed).toEqual(state);
  });

  it('returns null when a required section heading is missing', () => {
    const broken = '# Title\n\n## Overview\nblah\n\n## Key People\n- x';
    expect(parseMarkdownToState(broken)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseMarkdownToState('')).toBeNull();
    expect(parseMarkdownToState(null as unknown as string)).toBeNull();
    expect(parseMarkdownToState('not markdown')).toBeNull();
  });

  it('accepts `* ` list bullets defensively (some legacy notebooks may have them)', () => {
    const md = [
      '# T',
      '',
      '## Overview',
      'x',
      '',
      '## Key People',
      '* Maaz',
      '',
      '## Current Status',
      'y',
      '',
      '## Timeline',
      '- 2026-06-01: a',
      '',
      '## Decisions Made',
      '',
      '## Open Questions & Blockers',
      '',
      '## Key Threads',
      '',
    ].join('\n');
    const parsed = parseMarkdownToState(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyPeople).toEqual(['Maaz']);
    expect(parsed!.timeline).toEqual(['2026-06-01: a']);
  });
});
