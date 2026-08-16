#!/usr/bin/env tsx
/**
 * build-mode-eval — produce the 30-intent eval set consumed by
 * `tests/services/chat/mode-eval.test.ts` (Phase 78a-07 / SPEC item 14).
 *
 * Two execution paths:
 *
 *   INTERACTIVE  (default; default behaviour when stdin is a TTY)
 *     1. Open WI SQLite read-only via `getDatabase`.
 *     2. Sample 36 candidates from `messages` (last 90 days, source teams|outlook):
 *          12 WORK-shaped (Jira/file/PR ref OR slash-command)
 *          12 LIFE-shaped (mood/family vocabulary)
 *          12 AMBIGUOUS-shaped (short, no referents)
 *     3. Apply the redact pass (D-78a-10):
 *          /[A-Z][A-Z0-9_]+-\d+/  → `<JIRA-KEY-N>`  (per-message numbering, cross-refs preserved)
 *          colleague-redact-list  → `<COLLEAGUE-N>`
 *          repos/{example-service,operations}/<path> → `<REPO-FILE-N>`
 *          {Saturn, BDS, example-service} → `<PROJECT-A|B|C>`
 *     4. Prompt the user inline for each candidate (w/l/a/s).
 *     5. Enforce 12 WORK / 12 LIFE / 6 AMBIGUOUS distribution. If the canary
 *        shape (mood word + imperative verb + jira-key placeholder) is absent
 *        from the accepted set, append it.
 *     6. Write `tests/services/chat/mode-eval.jsonl`.
 *
 *   SEED-ONLY  (`--seed-only`, or BUILD_MODE_EVAL_SEED_ONLY=1)
 *     Hand-crafted placeholder-shaped seed of the same distribution. Mirrors
 *     real-traffic shapes from SPEC § Examples without ever touching the DB.
 *     Each entry is tagged `seed: true` so a future interactive run can
 *     replace it. Used by autonomous executors (CI, GSD plan runs) where no
 *     human is at the keyboard.
 *
 * The output file is committed alongside this script. Re-runs are safe — the
 * file is overwritten in full.
 *
 * Usage:
 *   node --import tsx/esm scripts/build-mode-eval.ts          # interactive
 *   node --import tsx/esm scripts/build-mode-eval.ts --seed-only
 *   BUILD_MODE_EVAL_SEED_ONLY=1 node --import tsx/esm scripts/build-mode-eval.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  FAMILY_WORDS,
  MOOD_WORDS,
} from '../src/services/chat/mode-detect.signals.js';

type Mode = 'work' | 'life' | 'ambiguous';

interface EvalEntry {
  message: string;
  expected_mode: Mode;
  rationale: string;
  seed?: boolean;
  auto_labeled?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const OUTPUT_PATH = path.join(
  REPO_ROOT,
  'tests/services/chat/mode-eval.jsonl'
);
const REDACT_LIST_PATH = path.join(
  os.homedir(),
  '.work-intelligence-mcp/colleague-redact-list.txt'
);

const PROJECT_NAMES = ['Saturn', 'BDS', 'example-service'] as const;
const PROJECT_TOKENS = ['<PROJECT-A>', '<PROJECT-B>', '<PROJECT-C>'] as const;

// Hand-crafted seed. Each entry mirrors a real-traffic shape from SPEC § Requirements
// and uses placeholder tokens consistent with D-78a-10 redaction conventions.
// Distribution: 12 WORK + 12 LIFE + 6 AMBIGUOUS = 30. Canary at WORK[3].
const SEED: EvalEntry[] = [
  // 12 WORK
  { message: '/wi-investigate <JIRA-KEY-1>', expected_mode: 'work', rationale: 'slash + jira', seed: true },
  { message: 'fix the bug in src/services/foo.ts', expected_mode: 'work', rationale: 'imperative + fileRef', seed: true },
  { message: 'review PR #4105 for <PROJECT-A>', expected_mode: 'work', rationale: 'imperative + prRef', seed: true },
  { message: "I'm exhausted, investigate <JIRA-KEY-1>", expected_mode: 'work', rationale: 'imperative-verb canary (mood + imperative + jira)', seed: true },
  { message: 'deploy the <JIRA-KEY-1> branch tomorrow', expected_mode: 'work', rationale: 'imperative + jira', seed: true },
  { message: 'debug failing tests in tests/services/chat/', expected_mode: 'work', rationale: 'imperative + fileRef', seed: true },
  { message: 'ship <JIRA-KEY-1> before <COLLEAGUE-1> reviews PR #99', expected_mode: 'work', rationale: 'imperative + jira + prRef', seed: true },
  { message: 'update src/services/analyzer.ts to handle the new bucket', expected_mode: 'work', rationale: 'imperative + fileRef', seed: true },
  { message: '<COLLEAGUE-1> wants me to refactor src/db/schema.ts', expected_mode: 'work', rationale: 'imperative + fileRef', seed: true },
  { message: "look at <JIRA-KEY-1> — it's blocking <PROJECT-A>", expected_mode: 'work', rationale: 'imperative + jira (multi-word verb)', seed: true },
  { message: 'add a check in src/services/chat/mode-detect.ts for slash commands', expected_mode: 'work', rationale: 'imperative + fileRef', seed: true },
  { message: 'verify the <JIRA-KEY-1> hotfix landed in <PROJECT-B>', expected_mode: 'work', rationale: 'imperative + jira', seed: true },

  // 12 LIFE — no Jira-shaped placeholders, no imperative verbs, mood/family vocabulary only.
  { message: 'feeling exhausted after this sprint', expected_mode: 'life', rationale: 'mood', seed: true },
  { message: "I'm stressed about tonight's on-call", expected_mode: 'life', rationale: 'mood', seed: true },
  { message: 'my wife is sick, taking her to the doctor', expected_mode: 'life', rationale: 'family + family', seed: true },
  { message: "kids' school holiday next week", expected_mode: 'life', rationale: 'family', seed: true },
  { message: "can't focus, totally drained today", expected_mode: 'life', rationale: 'mood', seed: true },
  { message: 'taking the weekend off, need rest', expected_mode: 'life', rationale: 'family (weekend)', seed: true },
  { message: 'birthday dinner tonight with the family', expected_mode: 'life', rationale: 'family', seed: true },
  { message: 'feeling overwhelmed with everything lately', expected_mode: 'life', rationale: 'mood', seed: true },
  { message: "my dad's anniversary is this saturday", expected_mode: 'life', rationale: 'family', seed: true },
  { message: 'kid had a fever last night, barely slept', expected_mode: 'life', rationale: 'family', seed: true },
  { message: 'vacation next month, finally', expected_mode: 'life', rationale: 'family', seed: true },
  { message: 'worried about the parents these days', expected_mode: 'life', rationale: 'mood + family', seed: true },

  // 6 AMBIGUOUS — empty signals or mood-only-with-question (no explicit referent).
  { message: 'hey', expected_mode: 'ambiguous', rationale: 'empty signals', seed: true },
  { message: 'quick question', expected_mode: 'ambiguous', rationale: 'empty signals', seed: true },
  { message: 'got a sec?', expected_mode: 'ambiguous', rationale: 'empty signals', seed: true },
  { message: 'feeling tired, can we talk?', expected_mode: 'ambiguous', rationale: 'mood-only + question (no referent)', seed: true },
  { message: 'stressed today, got time?', expected_mode: 'ambiguous', rationale: 'mood-only + question', seed: true },
  { message: 'feeling anxious, can we chat?', expected_mode: 'ambiguous', rationale: 'mood-only + question', seed: true },
];

const TARGET_DISTRIBUTION: Record<Mode, number> = { work: 12, life: 12, ambiguous: 6 };

function loadRedactList(): string[] {
  try {
    const raw = fs.readFileSync(REDACT_LIST_PATH, 'utf8');
    return raw.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  } catch {
    process.stderr.write(
      `[warn] redact list not found at ${REDACT_LIST_PATH} — colleague redaction skipped\n`
    );
    return [];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Apply the D-78a-10 redact pass to a single message. Numbering is local to each call. */
export function redactMessage(input: string, colleagues: string[]): string {
  let out = input;

  // Jira-shaped tokens — preserve cross-refs within the message.
  const jiraMap = new Map<string, string>();
  out = out.replace(/\b[A-Z][A-Z0-9_]+-\d+\b/g, (match) => {
    let token = jiraMap.get(match);
    if (!token) {
      token = `<JIRA-KEY-${jiraMap.size + 1}>`;
      jiraMap.set(match, token);
    }
    return token;
  });

  // Colleagues — case-sensitive whole-word replacement.
  const colleagueMap = new Map<string, string>();
  for (const name of colleagues) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
    out = out.replace(re, () => {
      let token = colleagueMap.get(name);
      if (!token) {
        token = `<COLLEAGUE-${colleagueMap.size + 1}>`;
        colleagueMap.set(name, token);
      }
      return token;
    });
  }

  // Repo file paths.
  const fileMap = new Map<string, string>();
  out = out.replace(/\brepos\/(?:example-service|operations)\/[\w./-]+/g, (match) => {
    let token = fileMap.get(match);
    if (!token) {
      token = `<REPO-FILE-${fileMap.size + 1}>`;
      fileMap.set(match, token);
    }
    return token;
  });

  // Project names.
  for (let i = 0; i < PROJECT_NAMES.length; i++) {
    const re = new RegExp(`\\b${escapeRegex(PROJECT_NAMES[i])}\\b`, 'g');
    out = out.replace(re, PROJECT_TOKENS[i]);
  }

  return out;
}

/** True when the entry shape is the canary: mood word + imperative + jira-key placeholder. */
function isCanary(entry: EvalEntry): boolean {
  const lower = entry.message.toLowerCase();
  const hasMood = MOOD_WORDS.some((w) => new RegExp(`\\b${escapeRegex(w)}\\b`).test(lower));
  const hasImperative = /\binvestigate\b/.test(lower);
  const hasJiraPlaceholder = /<JIRA-KEY-\d+>/.test(entry.message);
  return hasMood && hasImperative && hasJiraPlaceholder;
}

function ensureCanary(entries: EvalEntry[]): EvalEntry[] {
  if (entries.some(isCanary)) return entries;
  return [
    ...entries,
    {
      message: "I'm exhausted, investigate <JIRA-KEY-1>",
      expected_mode: 'work',
      rationale: 'imperative-verb canary (auto-appended)',
      seed: true,
    },
  ];
}

function writeJsonl(entries: EvalEntry[], outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(outPath, lines + '\n', 'utf8');
}

function summarize(entries: EvalEntry[]): Record<Mode, number> {
  const counts: Record<Mode, number> = { work: 0, life: 0, ambiguous: 0 };
  for (const e of entries) counts[e.expected_mode]++;
  return counts;
}

async function runInteractive(): Promise<EvalEntry[]> {
  const colleagues = loadRedactList();
  const { getDatabase } = await import('../src/db/connection.js');
  const db = getDatabase();
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

  // Pull a generous candidate pool. JS-side classifies into work/life/ambiguous shapes.
  const rows = db
    .prepare(
      `SELECT content FROM messages
       WHERE source IN ('teams', 'outlook')
         AND timestamp >= ?
         AND length(content) BETWEEN 5 AND 280
       ORDER BY RANDOM()
       LIMIT 200`
    )
    .all(ninetyDaysAgo) as Array<{ content: string }>;

  const moodRe = new RegExp(`\\b(?:${MOOD_WORDS.map(escapeRegex).join('|')})\\b`, 'i');
  const familyRe = new RegExp(`\\b(?:${FAMILY_WORDS.map(escapeRegex).join('|')})\\b`, 'i');
  const workShapeRe = /\b[A-Z][A-Z0-9_]+-\d+\b|\B\/[a-z][\w-]*|\b(?:src|tests|web|repos|scripts|docs)\//;

  const work: string[] = [];
  const life: string[] = [];
  const ambig: string[] = [];

  for (const row of rows) {
    const redacted = redactMessage(row.content, colleagues);
    if (workShapeRe.test(redacted) && work.length < 12) work.push(redacted);
    else if ((moodRe.test(redacted) || familyRe.test(redacted)) && life.length < 12) life.push(redacted);
    else if (redacted.length < 60 && ambig.length < 12) ambig.push(redacted);
    if (work.length === 12 && life.length === 12 && ambig.length === 12) break;
  }

  const candidates = [
    ...work.map((m) => ({ message: m, hint: 'work' as Mode })),
    ...life.map((m) => ({ message: m, hint: 'life' as Mode })),
    ...ambig.map((m) => ({ message: m, hint: 'ambiguous' as Mode })),
  ];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const accepted: EvalEntry[] = [];
  let idx = 0;
  while (idx < candidates.length) {
    const counts = summarize(accepted);
    const need = (Object.keys(TARGET_DISTRIBUTION) as Mode[]).filter(
      (m) => counts[m] < TARGET_DISTRIBUTION[m]
    );
    if (need.length === 0) break;

    const cand = candidates[idx++];
    const choice = (
      await ask(
        `[${idx}/${candidates.length}] (hint: ${cand.hint}) (w/l/a/s) ?\n  Message: ${cand.message}\n  Choice: `
      )
    ).trim().toLowerCase();
    let mode: Mode | null = null;
    if (choice === 'w') mode = 'work';
    else if (choice === 'l') mode = 'life';
    else if (choice === 'a') mode = 'ambiguous';
    else continue;

    if (counts[mode] >= TARGET_DISTRIBUTION[mode]) {
      process.stdout.write(`  (${mode} bucket full — skipped)\n`);
      continue;
    }
    accepted.push({ message: cand.message, expected_mode: mode, rationale: '' });
  }

  rl.close();
  return accepted;
}

async function main(): Promise<void> {
  const seedOnly =
    process.argv.includes('--seed-only') ||
    process.env.BUILD_MODE_EVAL_SEED_ONLY === '1' ||
    !process.stdin.isTTY;

  let entries: EvalEntry[];
  if (seedOnly) {
    process.stdout.write(`[build-mode-eval] seed-only mode — using hand-crafted seed\n`);
    entries = SEED;
  } else {
    process.stdout.write(`[build-mode-eval] interactive mode — sampling messages…\n`);
    entries = await runInteractive();
  }

  entries = ensureCanary(entries);

  const counts = summarize(entries);
  const expected = TARGET_DISTRIBUTION;
  for (const mode of Object.keys(expected) as Mode[]) {
    if (counts[mode] !== expected[mode]) {
      process.stderr.write(
        `[error] distribution mismatch: ${mode} got ${counts[mode]}, expected ${expected[mode]}\n`
      );
      process.exit(1);
    }
  }

  writeJsonl(entries, OUTPUT_PATH);
  process.stdout.write(
    `Wrote ${entries.length} entries to ${path.relative(REPO_ROOT, OUTPUT_PATH)}: ` +
      `${counts.work} WORK / ${counts.life} LIFE / ${counts.ambiguous} AMBIGUOUS\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[fatal] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
