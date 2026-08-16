/**
 * dream/scheduler.ts — in-process nightly trigger for the /dream generate pass.
 *
 * Mirrors the code-graph scheduler pattern (compute next fire, setTimeout,
 * reschedule after each run). Fires at 07:00 local. Because it lives in the
 * bridge process it only runs while the bridge is up — so on boot we also do a
 * CATCH-UP: if today's 07:00 has already passed and no report was generated
 * today, run once now. This gives "07:00 or first bridge boot after".
 *
 * Rollback: never call startDreamScheduler() and nothing schedules — the /dream
 * routes + skills still work for manual/on-demand generation.
 */

import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { generateDreamReport } from './generator.js';

const HOME = process.env.HOME || '';
const MEM_DIR =
  process.env.WI_DREAM_MEM_DIR ||
  join(HOME, '.wi', 'memory');
const REPORT_JSON = join(MEM_DIR, '.dream', 'dream-report.json');
const FIRE_HOUR = 7; // 07:00 local

let timer: NodeJS.Timeout | null = null;

/** ms until the next FIRE_HOUR:00 local from `from`. */
function msUntilNext0700(from: Date): number {
  const next = new Date(from);
  next.setHours(FIRE_HOUR, 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - from.getTime();
}

/** True if a report was already generated today (local date). */
function ranToday(now: Date): boolean {
  if (!existsSync(REPORT_JSON)) return false;
  try {
    const mtime = statSync(REPORT_JSON).mtime;
    return (
      mtime.getFullYear() === now.getFullYear() &&
      mtime.getMonth() === now.getMonth() &&
      mtime.getDate() === now.getDate()
    );
  } catch {
    return false;
  }
}

async function fire(db: Database.Database, apiKey: string | undefined, reason: string): Promise<void> {
  try {
    const report = await generateDreamReport(db, { hours: 24, apiKey });
    const pending = report.items.filter((i) => i.status === 'pending').length;
    process.stderr.write(`[dream] ${reason}: generated report, ${pending} pending proposal(s)\n`);
  } catch (err) {
    process.stderr.write(`[dream] ${reason}: generate failed — ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Start the in-process dream scheduler. Call once at bridge boot.
 * @param db bridge sqlite handle.
 * @param apiKey Anthropic key (from the bridge's config).
 */
export function startDreamScheduler(db: Database.Database, apiKey?: string): void {
  if (timer) return; // idempotent — never double-schedule
  if (process.env.DREAM_SCHEDULER_DISABLED === '1') {
    process.stderr.write('[dream] scheduler disabled via DREAM_SCHEDULER_DISABLED=1\n');
    return;
  }

  const now = new Date();

  // Boot catch-up: past 07:00 today and no report yet today → run now.
  if (now.getHours() >= FIRE_HOUR && !ranToday(now)) {
    void fire(db, apiKey, 'boot-catchup');
  }

  const schedule = () => {
    const delay = msUntilNext0700(new Date());
    timer = setTimeout(async () => {
      await fire(db, apiKey, 'scheduled-0700');
      schedule(); // reschedule for the next day
    }, delay);
    // Don't keep the event loop alive solely for this timer.
    if (timer.unref) timer.unref();
    process.stderr.write(`[dream] next scheduled run in ${Math.round(delay / 3_600_000)}h\n`);
  };
  schedule();
}

export function stopDreamScheduler(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
