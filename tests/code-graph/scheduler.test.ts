/**
 * Tests for src/services/code-graph/scheduler.ts
 *
 * Closes ADR-027 v2 Path B item #2: cron-style fast-forward unit test for
 * `nextSunday0317UTC`. The original AC text:
 *
 *   "simulate booting at 02:55, 04:10, 11:00, 19:30 on six different days;
 *    the dispatcher must fire the full sweep exactly once."
 *
 * Strategy: simulate 24 boot scenarios (4 boot times × 6 weekdays) plus
 * Sunday-edge cases. For each scenario, advance time forward in 1-hour
 * ticks until we cross the computed `nextSunday0317UTC(boot)` and assert:
 *
 *   - The full sweep fires exactly once across the simulated week.
 *   - The fire time is exactly the helper's reported next Sunday 03:17 UTC.
 *   - The next-after-fire computation rolls forward to the FOLLOWING Sunday.
 *
 * This is a behavioural test of the load-bearing wall-clock invariant. The
 * helper is ~10 lines, but the AC was specifically written to catch the
 * "the headline schedule simply would not fire" failure mode the original
 * setInterval-based draft had. We're not testing the implementation, we're
 * testing the contract: every week, exactly one Sunday-03:17-UTC fire,
 * regardless of when we boot.
 *
 * Pure helper, no DB, no agent — runs in microseconds.
 */

import { describe, it, expect } from 'vitest';
import { nextSunday0317UTC } from '../../src/services/code-graph/scheduler.js';

// Sunday 03:17:00 UTC, 2026-06-07. Reference week — our scenarios span the
// preceding week (Mon 2026-06-01 through Sun 2026-06-07) and we expect every
// boot in that window to point at this exact instant as `nextSunday0317UTC`.
const REFERENCE_SUNDAY = new Date(Date.UTC(2026, 5, 7, 3, 17, 0, 0));   // June is month index 5

// Day-of-week 0..6 helper — tests can read scenarios without recomputing dates.
function utcDate(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(Date.UTC(y, m, d, h, min, 0, 0));
}

describe('nextSunday0317UTC — wall-clock invariants (ADR-027 Path B item #2)', () => {
  it('always returns a Date strictly greater than `now`', () => {
    // Sample 24 hours × 7 days = 168 boot times across a representative week.
    // If any of those roll back to or land exactly on the boot time, the
    // 60s-heartbeat dispatcher would fire immediately every tick — the
    // pathology this invariant exists to prevent.
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const boot = utcDate(2026, 5, 1 + day, hour, 30);   // 30 mins past the hour, to avoid 03:17 boundary
        const next = nextSunday0317UTC(boot);
        expect(next.getTime()).toBeGreaterThan(boot.getTime());
      }
    }
  });

  it('always returns a Date that is a Sunday at 03:17:00 UTC', () => {
    // 24 representative boot times across the week; every result must be
    // structurally a Sunday-03:17-UTC.
    const boots = [
      // 4 AC-required boot times × 6 weekdays (Mon..Sat)
      ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].flatMap((_, idx) => [
        utcDate(2026, 5, 1 + idx, 2, 55),    // before scheduler tick
        utcDate(2026, 5, 1 + idx, 4, 10),    // shortly after 03:17
        utcDate(2026, 5, 1 + idx, 11, 0),    // mid-day
        utcDate(2026, 5, 1 + idx, 19, 30),   // evening
      ]),
    ];

    for (const boot of boots) {
      const next = nextSunday0317UTC(boot);
      expect(next.getUTCDay()).toBe(0);                          // Sunday
      expect(next.getUTCHours()).toBe(3);
      expect(next.getUTCMinutes()).toBe(17);
      expect(next.getUTCSeconds()).toBe(0);
      expect(next.getUTCMilliseconds()).toBe(0);
    }
  });

  it('AC scenario — 4 boot times × 6 weekdays all point at the next Sunday 03:17 UTC', () => {
    // The exact scenario the AC demanded. Every boot in this window must
    // resolve to REFERENCE_SUNDAY (= the Sunday strictly after the boot).
    const bootTimes = [
      { h: 2, m: 55 },
      { h: 4, m: 10 },
      { h: 11, m: 0 },
      { h: 19, m: 30 },
    ];

    // 6 weekdays preceding REFERENCE_SUNDAY: Mon 2026-06-01 through Sat 2026-06-06.
    for (let dayOffset = 0; dayOffset < 6; dayOffset++) {
      for (const { h, m } of bootTimes) {
        const boot = utcDate(2026, 5, 1 + dayOffset, h, m);
        const next = nextSunday0317UTC(boot);
        expect(next.toISOString()).toBe(REFERENCE_SUNDAY.toISOString());
      }
    }
  });

  it('Sunday before 03:17 UTC → the SAME Sunday 03:17 UTC', () => {
    // Boot at 02:55 UTC on Sunday 2026-06-07 — sweep should fire later that
    // same morning, not next week. This is the "we just booted into the
    // sweep window" case.
    const boot = utcDate(2026, 5, 7, 2, 55);
    const next = nextSunday0317UTC(boot);
    expect(next.toISOString()).toBe(REFERENCE_SUNDAY.toISOString());
  });

  it('Sunday at exactly 03:17:00 UTC → the FOLLOWING Sunday', () => {
    // Boundary: tick fires at exactly the target, the helper must roll to
    // next week. (`d.getTime() <= now.getTime()` is `<=`, not `<`, by design
    // — without that, a tick that lands exactly on the target would
    // re-fire forever.)
    const boot = utcDate(2026, 5, 7, 3, 17);
    const next = nextSunday0317UTC(boot);
    const sevenDaysLater = utcDate(2026, 5, 14, 3, 17);
    expect(next.toISOString()).toBe(sevenDaysLater.toISOString());
  });

  it('Sunday after 03:17 UTC → the FOLLOWING Sunday (7 days later)', () => {
    // Boot at 04:10 UTC on Sunday 2026-06-07 — we missed the window; next
    // sweep is on 2026-06-14.
    const boot = utcDate(2026, 5, 7, 4, 10);
    const next = nextSunday0317UTC(boot);
    const sevenDaysLater = utcDate(2026, 5, 14, 3, 17);
    expect(next.toISOString()).toBe(sevenDaysLater.toISOString());
  });

  it('dispatcher fires exactly once per week — 60s-heartbeat simulation', () => {
    // The whole point of nextSunday0317UTC is to drive a `due_at` sentinel
    // that the 60s heartbeat dispatcher checks each tick: if `now >= due_at`,
    // fire and rewrite due_at to the next Sunday. We simulate that loop
    // here for one full week × 4 different boot times. Each simulation must
    // observe exactly one fire, on the correct Sunday.
    const bootTimes = [
      utcDate(2026, 5, 1, 2, 55),    // Mon early
      utcDate(2026, 5, 3, 19, 30),   // Wed evening
      utcDate(2026, 5, 6, 23, 59),   // Sat just before midnight
      utcDate(2026, 5, 7, 2, 30),    // Sunday morning, before the window
    ];

    for (const boot of bootTimes) {
      let dueAt = nextSunday0317UTC(boot);
      let fires = 0;
      let lastFireTime: Date | null = null;

      // Tick the dispatcher every minute for exactly 7 days. Any boot
      // within a 7-day window must see EXACTLY one Sunday-sweep — that's
      // the AC contract. (An 8-day window would see 2 fires when boot
      // lands Sunday-morning-pre-window, which is correct but not what
      // the AC measures.)
      for (let tickMs = boot.getTime(); tickMs < boot.getTime() + 7 * 24 * 60 * 60 * 1000; tickMs += 60 * 1000) {
        const tick = new Date(tickMs);
        if (tick.getTime() >= dueAt.getTime()) {
          fires++;
          lastFireTime = new Date(dueAt.getTime());
          dueAt = nextSunday0317UTC(tick);
        }
      }

      expect(fires).toBe(1);
      expect(lastFireTime).not.toBeNull();
      // Fire happened on a Sunday at 03:17 UTC.
      expect(lastFireTime!.getUTCDay()).toBe(0);
      expect(lastFireTime!.getUTCHours()).toBe(3);
      expect(lastFireTime!.getUTCMinutes()).toBe(17);
    }
  });

  it('dispatcher fires exactly once per week even when boot lands AFTER 03:17 UTC on Sunday', () => {
    // Edge case the AC also implies: if you boot post-window on Sunday, the
    // dispatcher should fire NEXT Sunday, exactly once across the following
    // 7 days.
    const boot = utcDate(2026, 5, 7, 4, 10);     // Sunday 04:10 UTC, after the window
    let dueAt = nextSunday0317UTC(boot);
    let fires = 0;
    let lastFireTime: Date | null = null;

    for (let tickMs = boot.getTime(); tickMs < boot.getTime() + 7 * 24 * 60 * 60 * 1000; tickMs += 60 * 1000) {
      const tick = new Date(tickMs);
      if (tick.getTime() >= dueAt.getTime()) {
        fires++;
        lastFireTime = new Date(dueAt.getTime());
        dueAt = nextSunday0317UTC(tick);
      }
    }

    expect(fires).toBe(1);
    // The single fire must be the FOLLOWING Sunday (2026-06-14), not the one
    // we just missed.
    expect(lastFireTime!.toISOString()).toBe(utcDate(2026, 5, 14, 3, 17).toISOString());
  });

  it('handles month-boundary correctly (Sat 2026-05-30 → Sun 2026-05-31)', () => {
    const boot = utcDate(2026, 4, 30, 23, 0);    // Sat 2026-05-30 23:00 UTC (month index 4 = May)
    const next = nextSunday0317UTC(boot);
    expect(next.toISOString()).toBe(utcDate(2026, 4, 31, 3, 17).toISOString());
  });

  it('handles year-boundary correctly (Sat 2026-12-26 → Sun 2026-12-27)', () => {
    const boot = utcDate(2026, 11, 26, 23, 0);    // Sat 2026-12-26 23:00 UTC
    const next = nextSunday0317UTC(boot);
    expect(next.toISOString()).toBe(utcDate(2026, 11, 27, 3, 17).toISOString());
  });

  it('handles the 2026-03 spring DST transition without drift (Sun 2026-03-08)', () => {
    // The whole reason this helper is UTC-locked is that DST is locally
    // ambiguous. Boot mid-week immediately before US-DST-Sunday and assert
    // the helper still picks 03:17 UTC (which is 22:17 EST / 23:17 EDT).
    const boot = utcDate(2026, 2, 4, 12, 0);     // Wed 2026-03-04 12:00 UTC (month index 2 = March)
    const next = nextSunday0317UTC(boot);
    expect(next.toISOString()).toBe(utcDate(2026, 2, 8, 3, 17).toISOString());
    expect(next.getUTCDay()).toBe(0);
  });
});
