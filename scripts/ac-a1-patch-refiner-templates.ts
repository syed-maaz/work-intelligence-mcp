/**
 * AC-A1 (2026-07-17) — patch goal_refinement prompt templates so the refiner
 * knows the three DELIBERATIVE intents (brainstorm | plan | decide).
 *
 * WHY A SCRIPT, NOT A MIGRATION: prompt_templates rows are OPRO-evolved at
 * runtime — the active row flips over time (id 5 today, could be any of the
 * 39 versions tomorrow). A migration that patches "the active row" would rot
 * the moment OPRO activates a different, unpatched version and silently
 * regress AC-A1. This script patches EVERY goal_refinement template that is
 * missing the deliberative verbs, so whichever row OPRO activates next already
 * carries them. Idempotent — re-running is a no-op once all rows are patched.
 *
 * The seed (src/intelligence/prompt-seeds.ts) already carries the new verbs for
 * fresh installs; this reconciles EXISTING databases. Run once against the live
 * DB after deploying the AC-A1 change:
 *
 *   node --env-file=.env --import tsx/esm scripts/ac-a1-patch-refiner-templates.ts
 *
 * Reports how many rows it patched / were already current.
 */
import { getDatabase } from '../src/db/connection.js';

const DELIBERATIVE_MARKER = 'brainstorm';

// The guidance appended to any intent line lacking the deliberative verbs.
// Phrased to match the active template's existing "EXACTLY one of: …" style.
const DELIBERATIVE_GUIDANCE =
  ' PLUS three DELIBERATIVE intents that park the goal on the PM backlog as a ' +
  'thinking-card instead of executing it: brainstorm (generate ideas/options) | ' +
  'plan (design an approach/roadmap) | decide (choose between options). Use a ' +
  'deliberative verb ONLY when the user wants to think/explore/choose before any ' +
  'work is scoped; if they want a concrete artifact now, use a doing-verb. When ' +
  'unsure between analyze and brainstorm, prefer analyze.';

function main(): void {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, template FROM prompt_templates WHERE trigger_type = 'goal_refinement'`,
    )
    .all() as Array<{ id: number; template: string }>;

  let patched = 0;
  let alreadyCurrent = 0;
  let noIntentLine = 0;

  const update = db.prepare(`UPDATE prompt_templates SET template = ? WHERE id = ?`);

  for (const row of rows) {
    if (row.template.includes(DELIBERATIVE_MARKER)) {
      alreadyCurrent++;
      continue;
    }
    // Find the intent bullet line and append the deliberative guidance to it.
    const lines = row.template.split('\n');
    const idx = lines.findIndex((l) => /\*\*intent\*\*/.test(l) || /"intent"\s*[—:-]/.test(l));
    if (idx === -1) {
      // No recognizable intent line — skip rather than guess (fail-safe).
      noIntentLine++;
      continue;
    }
    lines[idx] = lines[idx]!.replace(/\s*$/, '') + DELIBERATIVE_GUIDANCE;
    update.run(lines.join('\n'), row.id);
    patched++;
  }

  process.stdout.write(
    `[ac-a1] goal_refinement templates: patched=${patched} already_current=${alreadyCurrent} ` +
      `no_intent_line=${noIntentLine} total=${rows.length}\n`,
  );
}

main();
