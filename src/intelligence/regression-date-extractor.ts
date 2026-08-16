/**
 * Regression Date Extractor — Phase 55 Wave 2
 *
 * Pure deterministic function. No AI required. Extracts the most likely
 * "regression start date" from a Jira issue title + description so the
 * investigation can query a tight git-log window instead of a broad one.
 */

export interface RegressionDateResult {
  date: string;         // ISO date YYYY-MM-DD
  windowStart: string;  // date - 3 days
  windowEnd: string;    // date + 2 days
  source: 'explicit' | 'relative' | 'created_at';
  confidence: 'high' | 'medium' | 'low';
  rawMatch: string | null;
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const EXPLICIT_PATTERNS = [
  /since\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i,
  /after\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/i,
  /starting\s+(\d{4}-\d{2}-\d{2})/i,
  /broken\s+since\s+(\d{4}-\d{2}-\d{2})/i,
  /(\d{4}-\d{2}-\d{2})\s+(?:regression|broke|stopped|failed)/i,
];

const RELATIVE_PATTERNS = [
  { re: /since\s+yesterday/i,               offset: -1 },
  { re: /after\s+last\s+(?:week|sprint)/i,  offset: -7 },
  { re: /today/i,                            offset: 0 },
  { re: /this\s+morning/i,                   offset: 0 },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractRegressionDate(
  title: string,
  description: string,
  createdAt: string,    // ISO date YYYY-MM-DD (or ISO datetime — only date portion used)
  currentDate: string = new Date().toISOString().split('T')[0],
): RegressionDateResult {
  const text = `${title}\n${description}`;

  // Try explicit date patterns first
  for (const pattern of EXPLICIT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const date = parseMatchToISO(match, currentDate);
      if (date) {
        return { date, ...window(date), source: 'explicit', confidence: 'high', rawMatch: match[0] };
      }
    }
  }

  // Try relative patterns
  for (const { re, offset } of RELATIVE_PATTERNS) {
    if (re.test(text)) {
      const date = addDays(currentDate, offset);
      return { date, ...window(date), source: 'relative', confidence: 'medium', rawMatch: text.match(re)![0] };
    }
  }

  // Fallback: createdAt - 3 days
  const date = addDays(createdAt.split('T')[0], -3);
  return { date, ...window(date), source: 'created_at', confidence: 'low', rawMatch: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a regex match from one of EXPLICIT_PATTERNS into a YYYY-MM-DD string.
 * Returns null if the match cannot be reliably converted.
 */
export function parseMatchToISO(
  match: RegExpMatchArray,
  currentDate: string,
): string | null {
  const raw = match[0].toLowerCase();

  // Pattern: "since <month> <day>" — e.g. "since April 17"
  if (/since\s+[a-z]+\s+\d/.test(raw)) {
    const monthName = match[1].toLowerCase();
    const day = parseInt(match[2], 10);
    const month = MONTH_NAMES[monthName];
    if (!month || isNaN(day)) return null;
    const year = parseInt(currentDate.substring(0, 4), 10);
    return isoDate(year, month, day);
  }

  // Pattern: "after DD/MM[/YYYY]" or "after DD-MM[-YYYY]"
  if (/after\s+\d/.test(raw)) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = match[3] ? parseInt(match[3], 10) : parseInt(currentDate.substring(0, 4), 10);
    if (isNaN(day) || isNaN(month)) return null;
    return isoDate(year, month, day);
  }

  // Pattern: "starting YYYY-MM-DD" — match[1] is the ISO string
  if (/starting\s+\d{4}/.test(raw) && match[1]) {
    return match[1];
  }

  // Pattern: "broken since YYYY-MM-DD" — match[1] is the ISO string
  if (/broken\s+since\s+\d{4}/.test(raw) && match[1]) {
    return match[1];
  }

  // Pattern: "YYYY-MM-DD regression|broke|…" — match[1] is the ISO string
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) && match[1]) {
    return match[1];
  }

  return null;
}

/** Add (or subtract) N calendar days from an ISO date string. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.split('T')[0]}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/** Return { windowStart: date-3, windowEnd: date+2 } */
export function window(date: string): { windowStart: string; windowEnd: string } {
  return {
    windowStart: addDays(date, -3),
    windowEnd:   addDays(date, +2),
  };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
