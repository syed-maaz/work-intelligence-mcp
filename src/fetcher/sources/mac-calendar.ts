/**
 * macOS Calendar Connector
 *
 * Reads calendar events via EventKit (primary) or AppleScript (fallback).
 * No browser / Playwright required.
 *
 * Strategy:
 *   1. Try EventKit via `swift` CLI — the ONLY path that expands recurring
 *      meetings into individual occurrences in the requested window. The
 *      AppleScript paths return the recurring master record only, whose
 *      `start date` is the original first occurrence (often months in the
 *      past), which gets filtered out by `start date >= now`.
 *   2. Fall back to Microsoft Outlook AppleScript (richer metadata when
 *      Outlook is the active app).
 *   3. Fall back to Calendar.app AppleScript ("Calendar" + "Work").
 *
 * AppleScript date format returned by Calendar.app (EU locale):
 *   "Thursday, 17. April 2026 at 09:00:00"
 * EventKit format returned by Swift:
 *   ISO 8601 — "2026-06-09T11:30:00Z"
 * Both are recognized by parseDateString below.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Matches "Thursday, 17. April 2026 at 09:00:00"
const DATE_RE_EU = /\w+,\s+(\d+)\.\s+(\w+)\s+(\d+)\s+at\s+(\d+):(\d+):(\d+)/;
// Matches "Thursday, April 17, 2026 at 9:00:00 AM"
const DATE_RE_US = /\w+,\s+(\w+)\s+(\d+),\s+(\d+)\s+at\s+(\d+):(\d+):(\d+)\s+([AP]M)/i;

const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Field separator — chosen to be safe across all event title/location values */
const SEP = '\x1F'; // ASCII Unit Separator (unlikely in calendar data)
const ROW_SEP = '\x1E'; // ASCII Record Separator

export interface MacCalendarEvent {
  sourceId: string;
  title: string;
  startTime: string;       // ISO datetime
  endTime: string | null;
  location: string | null;
  description: string | null;
  isAllDay: boolean;
  calendarName: string;
  responseStatus: 'accepted';
}

export class MacCalendarConnector {
  /**
   * Fetch upcoming events for the next `days` days.
   * Returns events sorted by start time ascending.
   */
  fetchUpcoming(days = 14): MacCalendarEvent[] {
    // 1. Try EventKit via Swift — the only path that expands recurring meetings.
    try {
      const ekEvents = this.fetchFromEventKit(days);
      if (ekEvents.length > 0) {
        return ekEvents.sort((a, b) => a.startTime.localeCompare(b.startTime));
      }
    } catch {
      // Swift not installed, EventKit denied, or no events — fall through
    }

    // 2. Try Microsoft Outlook AppleScript
    try {
      const outlookEvents = this.fetchFromOutlook(days);
      if (outlookEvents.length > 0) {
        return outlookEvents.sort((a, b) => a.startTime.localeCompare(b.startTime));
      }
    } catch {
      // Outlook not running or no events — fall through
    }

    // 3. Fall back to Calendar.app AppleScript
    try {
      const calEvents = this.fetchFromCalendarApp(days);
      return calEvents.sort((a, b) => a.startTime.localeCompare(b.startTime));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // EventKit (via Swift CLI)
  // ---------------------------------------------------------------------------
  // EventKit's `predicateForEvents(withStart:end:calendars:)` natively expands
  // recurring series into individual occurrences inside the window — the
  // critical capability missing from AppleScript. We invoke a tiny Swift
  // program via `swift -` reading stdin so no on-disk helper is required.
  // First run prompts for Calendar permission (TCC); subsequent runs are
  // silent. If permission is denied we return [] and the caller falls back.

  private fetchFromEventKit(days: number): MacCalendarEvent[] {
    const swift = this.eventKitSwiftSource(days);
    let raw: string;
    try {
      raw = execFileSync('swift', ['-'], {
        input: swift,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // swift not installed, EventKit access denied, or a compile error
      return [];
    }
    if (!raw || raw.startsWith('ERR_')) return [];
    return this.parseOutput(raw, 'EventKit');
  }

  private eventKitSwiftSource(days: number): string {
    // Emits the same SEP/ROW_SEP shape parseOutput already understands:
    //   title <SEP> startISO <SEP> endISO <SEP> location <SEP> isAllDay <SEP> calName <SEP> notes <ROW_SEP>
    // SEP = U+001F, ROW_SEP = U+001E.
    return `import Foundation
import EventKit

let store = EKEventStore()
let sema = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14, *) {
  store.requestFullAccessToEvents { ok, _ in granted = ok; sema.signal() }
} else {
  store.requestAccess(to: .event) { ok, _ in granted = ok; sema.signal() }
}
sema.wait()
guard granted else { print("ERR_NO_PERM"); exit(0) }

let now = Date()
let end = now.addingTimeInterval(86400 * Double(${days}))
let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
let events = store.events(matching: predicate)
let fmt = ISO8601DateFormatter()
fmt.formatOptions = [.withInternetDateTime]
let SEP = "\\u{1F}"
let ROW = "\\u{1E}"
var out = ""
for e in events {
  let title = (e.title ?? "").replacingOccurrences(of: SEP, with: " ").replacingOccurrences(of: ROW, with: " ")
  let loc = (e.location ?? "").replacingOccurrences(of: SEP, with: " ").replacingOccurrences(of: ROW, with: " ")
  let notes = (e.notes ?? "").replacingOccurrences(of: SEP, with: " ").replacingOccurrences(of: ROW, with: " ")
  let calName = e.calendar?.title ?? "EventKit"
  let startISO = fmt.string(from: e.startDate)
  let endISO = fmt.string(from: e.endDate)
  let allDay = e.isAllDay ? "true" : "false"
  out += title + SEP + startISO + SEP + endISO + SEP + loc + SEP + allDay + SEP + calName + SEP + notes + ROW
}
print(out)
`;
  }

  // ---------------------------------------------------------------------------
  // Microsoft Outlook
  // ---------------------------------------------------------------------------

  private fetchFromOutlook(days: number): MacCalendarEvent[] {
    const script = `
tell application "Microsoft Outlook"
  set SEP to character id 31
  set ROW_SEP to character id 30
  set now to current date
  set endDate to now + (${days} * days)
  set evts to calendar events whose start time >= now and start time <= endDate
  set output to ""
  repeat with e in evts
    set t to subject of e
    set sd to start time of e
    set ed to end time of e
    set loc to ""
    try
      set loc to location of e
    end try
    set isAllDay to false
    try
      set isAllDay to is all day event of e
    end try
    set output to output & t & SEP & (sd as string) & SEP & (ed as string) & SEP & loc & SEP & (isAllDay as string) & SEP & "Outlook" & SEP & "" & ROW_SEP
  end repeat
  return output
end tell`;

    const raw = this.runScript(script);
    return this.parseOutput(raw, 'Outlook');
  }

  // ---------------------------------------------------------------------------
  // macOS Calendar.app
  // ---------------------------------------------------------------------------

  private fetchFromCalendarApp(days: number): MacCalendarEvent[] {
    const targetCalendars = ['Calendar', 'Work'];
    const all: MacCalendarEvent[] = [];
    const seen = new Set<string>();

    for (const calName of targetCalendars) {
      try {
        const events = this.fetchCalendarAppCalendar(calName, days);
        for (const ev of events) {
          if (!seen.has(ev.sourceId)) {
            seen.add(ev.sourceId);
            all.push(ev);
          }
        }
      } catch {
        // Calendar may not exist — skip
      }
    }

    return all;
  }

  private fetchCalendarAppCalendar(calName: string, days: number): MacCalendarEvent[] {
    const script = `
tell application "Calendar"
  set SEP to character id 31
  set ROW_SEP to character id 30
  set now to current date
  set endDate to now + (${days} * days)
  set c to calendar "${calName}"
  set evts to (every event of c whose start date >= now and start date <= endDate)
  set output to ""
  repeat with e in evts
    set t to summary of e
    set sd to start date of e
    set ed to end date of e
    set loc to ""
    try
      set loc to location of e
    end try
    set isAllDay to allday event of e
    set descr to ""
    try
      set descr to description of e
    end try
    set output to output & t & SEP & (sd as string) & SEP & (ed as string) & SEP & loc & SEP & (isAllDay as string) & SEP & "${calName}" & SEP & descr & ROW_SEP
  end repeat
  return output
end tell`;

    const raw = this.runScript(script);
    return this.parseOutput(raw, calName);
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private runScript(script: string): string {
    // Write to a temp file to avoid shell quoting issues with multi-line scripts
    const tmpFile = join(tmpdir(), `wi-cal-${Date.now()}.applescript`);
    try {
      writeFileSync(tmpFile, script, 'utf8');
      const result = execFileSync('osascript', [tmpFile], {
        encoding: 'utf8',
        timeout: 90_000,   // Calendar.app can take 30-60s to respond
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return result;
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }
  }

  private parseOutput(raw: string, defaultCalendar: string): MacCalendarEvent[] {
    if (!raw) return [];
    const events: MacCalendarEvent[] = [];
    const seen = new Set<string>();

    // Split on record separator
    const rows = raw.split(ROW_SEP).filter(r => r.trim());

    for (const row of rows) {
      const parts = row.split(SEP);
      if (parts.length < 5) continue;

      const [title, startStr, endStr, location, isAllDayStr, calName, description] = parts;
      if (!title?.trim() || !startStr?.trim()) continue;

      const startTime = this.parseDateString(startStr.trim());
      if (!startTime) continue;

      const endTime = endStr?.trim() ? this.parseDateString(endStr.trim()) : null;
      const isAllDay = isAllDayStr?.trim().toLowerCase() === 'true';
      const calendarName = calName?.trim() || defaultCalendar;

      const sourceId = this.generateSourceId(title.trim(), startTime);
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);

      events.push({
        sourceId,
        title: title.trim(),
        startTime,
        endTime,
        location: location?.trim() || null,
        description: description?.trim() || null,
        isAllDay,
        calendarName,
        responseStatus: 'accepted',
      });
    }

    return events;
  }

  /**
   * Parse AppleScript date strings into ISO datetime.
   *
   * EU format:  "Thursday, 17. April 2026 at 09:00:00"
   * US format:  "Thursday, April 17, 2026 at 9:00:00 AM"
   * ISO 8601:   "2026-06-09T11:30:00Z" or "2026-06-09T13:30:00+02:00"
   *             (emitted by the EventKit/Swift path — recurring expansion).
   */
  parseDateString(s: string): string | null {
    // ISO 8601 — emitted by fetchFromEventKit. Fast-path: trust Date.parse.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
      const ts = Date.parse(s);
      if (!isNaN(ts)) return new Date(ts).toISOString().replace(/\.\d+Z$/, '');
    }

    // EU format
    const euMatch = s.match(DATE_RE_EU);
    if (euMatch) {
      const [, day, monthName, year, hh, mm, ss] = euMatch;
      const month = MONTH_MAP[monthName.toLowerCase()];
      if (!month) return null;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hh}:${mm}:${ss}`;
    }

    // US format
    const usMatch = s.match(DATE_RE_US);
    if (usMatch) {
      const [, monthName, day, year, rawH, mm, ss, period] = usMatch;
      const month = MONTH_MAP[monthName.toLowerCase()];
      if (!month) return null;
      let hours = parseInt(rawH, 10);
      if (period.toUpperCase() === 'PM' && hours !== 12) hours += 12;
      if (period.toUpperCase() === 'AM' && hours === 12) hours = 0;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${mm}:${ss}`;
    }

    return null;
  }

  private generateSourceId(title: string, startTime: string): string {
    const key = title + startTime.replace(/[-:T]/g, '').slice(0, 12);
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }
}
