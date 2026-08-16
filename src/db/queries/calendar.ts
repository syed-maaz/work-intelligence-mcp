import Database from 'better-sqlite3';

// ── Calendar event queries (EP-25) ────────────────────────────────────────────

export interface CalendarEvent {
  id: number;
  source_id: string;
  title: string;
  start_time: string;       // ISO datetime
  end_time: string | null;
  location: string | null;
  organizer: string | null;
  attendees: string;        // JSON string
  body: string | null;
  is_all_day: number;       // 0 | 1
  response_status: string | null;
  scraped_at: string;
  pre_brief: string | null; // EP-15-4: AI-generated pre-meeting brief
}

export type InsertCalendarEvent = Omit<CalendarEvent, 'id' | 'scraped_at'>;

export function upsertCalendarEvent(db: Database.Database, event: InsertCalendarEvent): void {
  db.prepare(`
    INSERT INTO calendar_events
      (source_id, title, start_time, end_time, location, organizer, attendees, body, is_all_day, response_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      title           = excluded.title,
      end_time        = excluded.end_time,
      location        = excluded.location,
      organizer       = excluded.organizer,
      attendees       = excluded.attendees,
      body            = excluded.body,
      is_all_day      = excluded.is_all_day,
      response_status = excluded.response_status,
      scraped_at      = datetime('now')
  `).run(
    event.source_id,
    event.title,
    event.start_time,
    event.end_time ?? null,
    event.location ?? null,
    event.organizer ?? null,
    event.attendees,
    event.body ?? null,
    event.is_all_day,
    event.response_status ?? null,
  );
}

export function getUpcomingEvents(db: Database.Database, days: number): CalendarEvent[] {
  return db.prepare(`
    SELECT * FROM calendar_events
    WHERE start_time >= datetime('now', 'localtime')
      AND start_time <= datetime('now', 'localtime', '+' || ? || ' days')
    ORDER BY start_time ASC
  `).all(days) as CalendarEvent[];
}

export function getEventsForDate(db: Database.Database, date: string): CalendarEvent[] {
  return db.prepare(`
    SELECT * FROM calendar_events
    WHERE date(start_time) = date(?)
    ORDER BY start_time ASC
  `).all(date) as CalendarEvent[];
}

export function getLatestCalendarScrapeTime(db: Database.Database, days: number): string | null {
  const row = db.prepare(`
    SELECT MAX(scraped_at) as latest FROM calendar_events
    WHERE start_time >= datetime('now')
      AND start_time <= datetime('now', '+' || ? || ' days')
  `).get(days) as { latest: string | null };
  return row?.latest ?? null;
}
