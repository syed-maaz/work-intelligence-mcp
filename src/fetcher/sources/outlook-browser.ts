/**
 * Outlook Browser Connector
 *
 * Scrapes Outlook on the web (outlook.office.com) using a shared Playwright
 * browser session that reuses the user's existing SSO cookies. The Microsoft
 * Graph API is not used — corporate IT blocks it at the network level.
 *
 * ============================================================
 * EP-3 DOM SPIKE — selectors for outlook.office.com (OWA)
 * ============================================================
 *
 * INBOX / FOLDER LIST (verified against live outlook.office.com 2026-04-15):
 *   URL:  https://outlook.office.com/mail/inbox
 *         https://outlook.office.com/mail/<folder-slug>
 *
 *   Email list container:
 *     div[aria-label="Message list"]          — confirmed present, 1 element
 *     Scrollable virtualized list — ~6-30 rows rendered at a time.
 *
 *   Per-row element:
 *     div[aria-label="Message list"] div[role="option"]   — 6 elements confirmed
 *     Each row also has attribute data-convid (conversation ID)
 *
 *   From each row (verified from live innerHTML):
 *     Sender name:  span[title] inside the sender block — title attr = email address,
 *                   text content = display name.
 *                   The sender block is the first div.S2NDX > div > div span[title]
 *                   Reliable selector: 'div.S2NDX span[title]'
 *     Sender email: same span[title].title attribute
 *     Subject:      span.TtcXM[title]  — title attr = full subject, text = possibly truncated
 *     Date display: span._rWRU  — text content = short form ("4:52 PM")
 *                   title attr  = full date string "Wed 4/15/2026 4:52 PM" ← USE THIS
 *
 *   Internet message ID:
 *     NOT exposed in the list DOM. Available only after opening the message.
 *     STRATEGY: generate a stable hash from sender+subject+ISO-date (day granularity).
 *
 * READING PANE (email body after clicking a row):
 *   Wait for reading pane to render — look for a div containing the body.
 *   The reading pane uses heavily obfuscated Fluent UI class names that change.
 *   Most reliable approach: use aria-label and role attributes.
 *   Body:      div[role="document"]  OR  div[aria-label*="Message body"]
 *   From name: div containing sender info — span[title] in the header area
 *   Subject:   already known from the list row (use stub.subject)
 *   Date:      already known from row title attr (full date)
 *
 * DATE FILTERING:
 *   The date span._rWRU has title="Wed 4/15/2026 4:52 PM" — parseable directly
 *   with new Date(). No fuzzy parsing needed for today's emails.
 *   For older emails the title will still be a full date string.
 *   Filter strategy: sort newest-first (default), scrape rows, stop when the
 *   parsed date is older than `since`.
 *
 * PAGINATION / LOAD MORE:
 *   Virtualised infinite scroll — no next-page button.
 *   Scroll div[aria-label="Message list"] to bottom, wait for new rows.
 *   Stop when: a) oldest visible row < since, or b) max scroll attempts reached.
 *
 * LOGIN REDIRECT DETECTION:
 *   URL contains: microsoftonline.com, login.live.com, /login, /logon
 *   OR inline login form: input[type="password"]
 *   BrowserSessionManager already catches host-change redirects.
 *
 * ============================================================
 */

import crypto from 'crypto';
import type { Page } from 'playwright';
import {
  UnifiedMessage,
  MessageSource,
  ConnectorError,
  ConnectorErrorType,
  RateLimitConfig,
  DEFAULT_RATE_LIMITS,
} from './types.js';
import type { BrowserSessionManager } from './browser-session.js';
import type { DataSource } from '../types.js';

// ---------------------------------------------------------------------------
// Config type for fetchMessages
// ---------------------------------------------------------------------------

export interface OutlookBrowserConfig {
  /** Folder slug: 'inbox' (default), 'sentitems', 'archive', etc. */
  folder?: string;

  /** Only return emails whose subject contains this string (case-insensitive). */
  subjectFilter?: string;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface ScrapedEmailRow {
  senderName: string;
  senderEmail: string;
  subject: string;
  receivedText: string;    // raw title string, e.g. "Wed 4/15/2026 4:52 PM"
  receivedAt: Date;
  convId: string;          // data-convid for stable ID fallback
}

interface ScrapedEmailDetail {
  senderName: string;
  senderEmail: string;
  recipients: Array<{ name: string; email: string }>;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  sentAt: Date;
  sourceId: string;        // stable hash (sender+subject+day)
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const OUTLOOK_BASE = 'https://outlook.office.com';

function folderUrl(folder: string): string {
  // OWA accepts /mail/<folder> for standard folders and custom ones
  const slug = folder.trim().toLowerCase() || 'inbox';
  return `${OUTLOOK_BASE}/mail/${slug}`;
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * Parses the short date strings that OWA shows in the message list.
 * Examples (all relative to the moment of scrape):
 *   "10:35 AM"          → today at 10:35
 *   "Mon 10:35 AM"      → most recent Monday at 10:35
 *   "Apr 14"            → April 14 of the current or previous year
 *   "3/15/2024"         → March 15 2024 (US locale)
 *   "15/03/2024"        → 15 March 2024 (EU locale)
 *
 * Returns `new Date(0)` when the string cannot be parsed, so rows with
 * unparseable dates are always included (fail-open).
 */
export function parseOutlookDate(raw: string, now: Date = new Date()): Date {
  const s = raw.trim();
  if (!s) return new Date(0);

  // --- Time-only: "10:35 AM" ---
  const timeOnly = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (timeOnly) {
    const d = new Date(now);
    let hours = Number(timeOnly[1]);
    const minutes = Number(timeOnly[2]);
    const meridiem = timeOnly[3].toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    d.setHours(hours, minutes, 0, 0);
    // If this time is in the future, assume yesterday
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }

  // --- Weekday + time: "Mon 10:35 AM" ---
  const weekdayTime = s.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (weekdayTime) {
    const days = ['sun','mon','tue','wed','thu','fri','sat'];
    const targetDay = days.indexOf(weekdayTime[1].toLowerCase());
    let hours = Number(weekdayTime[2]);
    const minutes = Number(weekdayTime[3]);
    const meridiem = weekdayTime[4].toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;

    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
    // Walk backwards until we hit the right weekday (max 7 days)
    let tries = 0;
    while (d.getDay() !== targetDay && tries < 7) {
      d.setDate(d.getDate() - 1);
      tries++;
    }
    return d;
  }

  // --- Month + day: "Apr 14" ---
  const monthDay = s.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
  if (monthDay) {
    const months: Record<string, number> = {
      jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
      jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
    };
    const month = months[monthDay[1].toLowerCase()];
    const day = Number(monthDay[2]);
    if (month !== undefined) {
      let year = now.getFullYear();
      const candidate = new Date(year, month, day, 12, 0, 0, 0);
      // If the candidate is in the future, use last year
      if (candidate > now) candidate.setFullYear(year - 1);
      return candidate;
    }
  }

  // --- Numeric date: "3/15/2024" or "15/03/2024" ---
  const numericDate = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numericDate) {
    const a = Number(numericDate[1]);
    const b = Number(numericDate[2]);
    const year = Number(numericDate[3]);
    // Heuristic: if first part > 12, it must be the day (EU format)
    const [month, day] = a > 12 ? [b - 1, a] : [a - 1, b];
    return new Date(year, month, day, 12, 0, 0, 0);
  }

  // --- ISO or other parseable strings ---
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? new Date(0) : fallback;
}

// ---------------------------------------------------------------------------
// Stable source_id
// ---------------------------------------------------------------------------

/**
 * Generates a stable, deterministic ID for an email based on sender+subject+day.
 * Used when the internet message ID is not available in the DOM.
 */
export function stableEmailId(senderName: string, subject: string, receivedAt: Date): string {
  const day = isNaN(receivedAt.getTime())
    ? '1970-01-01'
    : receivedAt.toISOString().slice(0, 10);
  const raw = `${senderName.trim().toLowerCase()}|${subject.trim().toLowerCase()}|${day}`;
  return 'outlook-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// HTML → plain text (minimal, no dependency)
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// OutlookBrowserConnector
// ---------------------------------------------------------------------------

export class OutlookBrowserConnector implements DataSource {
  private session: BrowserSessionManager;
  private rateLimitConfig: RateLimitConfig;
  private requestTimestamps: number[] = [];

  /** Maximum scroll attempts when loading more messages */
  private static readonly MAX_SCROLL_ATTEMPTS = 10;

  constructor(session: BrowserSessionManager, rateLimitConfig?: RateLimitConfig) {
    this.session = session;
    this.rateLimitConfig = rateLimitConfig ?? DEFAULT_RATE_LIMITS.email;
  }

  /**
   * Scrapes Outlook inbox (or another folder) for emails received since `since`
   * (default: last 24 hours).
   *
   * @param config  OutlookBrowserConfig — optional folder and subjectFilter
   * @param since   Only return emails received at or after this timestamp
   *
   * @throws ConnectorError(Authentication) if redirected to a login page
   * @throws ConnectorError(Network)        on page load timeout
   */
  async fetchMessages(
    config: Record<string, unknown>,
    since?: Date,
    signal?: AbortSignal
  ): Promise<UnifiedMessage[]> {
    const { folder = 'inbox', subjectFilter } = config as unknown as OutlookBrowserConfig;
    const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

    const url = folderUrl(folder);
    const page = await this.session.getPage(url);
    // ADR-044 coarse cancellation (§ Cancellation option 3): tag this slot with
    // its source so the orchestrator's release() (session.releaseBySource('email'))
    // can force-close the page and free the pool slot on a per-source timeout,
    // rather than leaking it while the scrape runs on to completion (re-audit #8).
    this.session.tagPageSource(page, 'email');

    try {
      await this.assertNotLoginPage(page);
      await this.waitForMessageList(page);

      const rows = await this.scrapeVisibleRows(page, cutoff);

      if (rows.length === 0) {
        return [];
      }

      const filtered = subjectFilter
        ? rows.filter((r) => r.subject.toLowerCase().includes(subjectFilter.toLowerCase()))
        : rows;

      process.stderr.write(`[Outlook] Found ${filtered.length} emails in ${folder} since ${cutoff.toISOString()}\n`);

      const messages: UnifiedMessage[] = [];

      for (let i = 0; i < filtered.length; i++) {
        // Honor cancellation at the loop boundary: on abort, stop opening more
        // emails and return what we have. The slot itself is freed by the
        // orchestrator's releaseBySource('email') release path.
        if (signal?.aborted) {
          process.stderr.write(`[Outlook] Aborted after ${messages.length}/${filtered.length} emails\n`);
          break;
        }
        const row = filtered[i];
        process.stderr.write(`[Outlook] Email ${i + 1}/${filtered.length}: ${row.subject}\n`);
        await this.checkRateLimit();

        const detail = await this.openAndScrapeEmail(page, i, row).catch((err) => {
          if (err instanceof ConnectorError) throw err;
          process.stderr.write(`[Outlook] Skipping email "${row.subject}": ${String(err)}\n`);
          return null;
        });

        if (!detail) continue;

        messages.push(this.emailToMessage(detail));
      }

      return messages;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Login page guard
  // ---------------------------------------------------------------------------

  private async assertNotLoginPage(page: Page): Promise<void> {
    const url = page.url();
    const loginPatterns = [
      'microsoftonline.com',
      'login.live.com',
      '/login',
      '/logon',
      'logon.aspx',
    ];
    if (loginPatterns.some((p) => url.includes(p))) {
      throw new ConnectorError(
        `Outlook redirected to login page: ${url}. SSO session may have expired.`,
        ConnectorErrorType.Authentication
      );
    }

    // Also check for inline sign-in prompt (same-host redirect)
    const hasLoginForm = await page.$('input[type="password"], form[action*="login"]')
      .then((el) => el !== null)
      .catch(() => false);

    if (hasLoginForm) {
      throw new ConnectorError(
        'Outlook shows an inline sign-in form. SSO session may have expired.',
        ConnectorErrorType.Authentication
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Wait for the message list to render
  // ---------------------------------------------------------------------------

  private async waitForMessageList(page: Page): Promise<void> {
    try {
      await page.waitForSelector(
        'div[aria-label="Message list"], div[role="list"][aria-label*="mail"], div[data-testid="mailListContainer"]',
        { timeout: 20_000 }
      );
    } catch {
      // If the selector times out, check for login redirect one more time
      await this.assertNotLoginPage(page);
      // Otherwise assume empty folder — scrapeVisibleRows will return []
    }
  }

  // ---------------------------------------------------------------------------
  // Scrape visible email rows, scrolling until all are older than cutoff
  // ---------------------------------------------------------------------------

  private async scrapeVisibleRows(page: Page, cutoff: Date): Promise<ScrapedEmailRow[]> {
    const seen = new Set<string>();
    const results: ScrapedEmailRow[] = [];
    let scrollAttempts = 0;
    let allOlderThanCutoff = false;

    while (!allOlderThanCutoff && scrollAttempts <= OutlookBrowserConnector.MAX_SCROLL_ATTEMPTS) {
      const rows = await this.extractRows(page);

      let foundNew = false;

      for (const row of rows) {
        const key = `${row.senderName}|${row.subject}|${row.receivedText}`;
        if (seen.has(key)) continue;
        seen.add(key);
        foundNew = true;
        results.push(row);
      }

      // Check if the oldest visible row is before the cutoff
      const oldestVisible = rows.reduce<Date | null>((oldest, row) => {
        const d = row.receivedAt;
        if (!oldest || d < oldest) return d;
        return oldest;
      }, null);

      if (oldestVisible && oldestVisible < cutoff) {
        allOlderThanCutoff = true;
        break;
      }

      if (!foundNew) {
        // No new rows after scroll — we've hit the end of the list
        break;
      }

      // Scroll the message list container to load more
      const scrolled = await this.scrollMessageList(page);
      if (!scrolled) break;

      scrollAttempts++;
    }

    // Filter to only rows within the cutoff window
    return results.filter((r) => r.receivedAt >= cutoff || r.receivedAt.getTime() === 0);
  }

  // ---------------------------------------------------------------------------
  // Extract all currently-rendered rows from the DOM
  // ---------------------------------------------------------------------------

  private async extractRows(page: Page): Promise<ScrapedEmailRow[]> {
    const rowEls = await page.$$('div[aria-label="Message list"] div[role="option"]');

    const results: ScrapedEmailRow[] = [];

    for (const row of rowEls) {
      try {
        // Sender: span[title] in the sender block — title=email, text=display name
        const senderSpan = await row.$('div.S2NDX span[title]');
        const senderName = senderSpan ? (await senderSpan.textContent() ?? '').trim() : '';
        const senderEmail = senderSpan ? (await senderSpan.getAttribute('title') ?? '').trim() : '';

        // Subject: span.TtcXM — title attr has full subject (text may be truncated)
        const subjectSpan = await row.$('span.TtcXM');
        const subject = subjectSpan
          ? ((await subjectSpan.getAttribute('title') ?? '') || (await subjectSpan.textContent() ?? '')).trim()
          : '';

        if (!senderName && !subject) continue;

        // Date: span._rWRU — title="Wed 4/15/2026 4:52 PM" (full, parseable)
        const dateSpan = await row.$('span._rWRU');
        const receivedText = dateSpan
          ? (await dateSpan.getAttribute('title') ?? await dateSpan.textContent() ?? '').trim()
          : '';

        // Conversation ID for stable fallback ID
        const convId = (await row.getAttribute('data-convid') ?? '').trim();

        const receivedAt = receivedText ? new Date(receivedText) : new Date(0);
        const finalReceivedAt = isNaN(receivedAt.getTime()) ? parseOutlookDate(receivedText) : receivedAt;

        results.push({ senderName, senderEmail, subject, receivedText, receivedAt: finalReceivedAt, convId });
      } catch {
        // Skip malformed rows
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Scroll the message list container
  // ---------------------------------------------------------------------------

  private async scrollMessageList(page: Page): Promise<boolean> {
    // Use Playwright's locator to scroll the message list container
    const selectors = [
      'div[aria-label="Message list"]',
      'div[role="list"][aria-label*="mail"]',
      'div[data-testid="mailListContainer"]',
    ];

    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        await el.evaluate((node) => {
          // node is a browser-side Element; cast via unknown to avoid missing dom lib
          const scrollable = node as unknown as { scrollTop: number; scrollHeight: number };
          scrollable.scrollTop = scrollable.scrollHeight;
        });
        // Give OWA time to render new rows
        await page.waitForTimeout(1500);
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Click email row → scrape reading pane → close
  // ---------------------------------------------------------------------------

  private async openAndScrapeEmail(
    page: Page,
    rowIndex: number,
    stub: ScrapedEmailRow
  ): Promise<ScrapedEmailDetail> {
    // Re-query rows by index (DOM may have shifted after scrolling)
    const rowSelectors = [
      'div[aria-label="Message list"] div[role="option"]',
      'div[role="list"] div[role="option"]',
      'div[data-testid="mailListContainer"] div[role="option"]',
    ];

    let clicked = false;
    for (const sel of rowSelectors) {
      const rows = await page.$$(sel);
      if (rows[rowIndex]) {
        await rows[rowIndex].click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Fall back to clicking by subject text match
      const subjectEls = await page.$$(
        '[data-testid="ConversationSubject"], [class*="subject"]'
      );
      for (const el of subjectEls) {
        const text = (await el.textContent() ?? '').trim();
        if (text === stub.subject) {
          await el.click();
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) {
      throw new Error(`Could not click email row for "${stub.subject}"`);
    }

    // Wait for reading pane body
    try {
      await page.waitForSelector(
        'div[role="document"], div[aria-label*="Message body"], div[data-testid="messageBody"]',
        { timeout: 10_000 }
      );
    } catch {
      // Body may not have loaded — return partial data with empty body
    }

    // Extract reading pane data using Playwright element handles (no page.evaluate/DOM)
    // Body: div[role="document"] is the most stable aria-role selector in OWA
    const bodyEl =
      await page.$('div[role="document"]') ??
      await page.$('div[aria-label*="Message body"]') ??
      await page.$('div[data-testid="messageBody"]');
    const bodyHtml = bodyEl ? (await bodyEl.innerHTML()).trim() : '';

    // Subject: already in stub from the list row — reading pane subject is unreliable
    const subject = stub.subject;

    // Sender: from list row (stub) — already extracted reliably
    const senderName = stub.senderName;
    const senderEmail = stub.senderEmail;

    const recipientEls = await page.$$(
      'div[class*="toRecipients"] span[class*="displayName"], ' +
      '[data-testid="RecipientWell"] span[class*="displayName"], ' +
      '[class*="recipientName"]'
    );
    const recipients: Array<{ name: string; email: string }> = [];
    for (const el of recipientEls) {
      const name = (await el.textContent() ?? '').trim();
      const email = (
        await el.getAttribute('data-email') ??
        await el.getAttribute('title') ??
        ''
      ).trim();
      if (name) recipients.push({ name, email });
    }

    const sentTimeEl =
      await page.$('[data-testid="SentTime"]') ??
      await page.$('time[datetime]') ??
      await page.$('[class*="sentTime"]');
    const sentRaw = sentTimeEl
      ? (
          await sentTimeEl.getAttribute('datetime') ??
          await sentTimeEl.textContent() ??
          ''
        ).trim()
      : '';

    // Parse sent date — prefer ISO from datetime attr, fall back to display string
    let sentAt: Date;
    if (sentRaw) {
      const iso = new Date(sentRaw);
      sentAt = isNaN(iso.getTime()) ? parseOutlookDate(sentRaw, stub.receivedAt) : iso;
    } else {
      sentAt = stub.receivedAt;
    }

    // Source ID: prefer convId from the list row (stable OWA conversation ID),
    // fall back to hash of sender+subject+day
    const sourceId = stub.convId
      ? `outlook-conv-${stub.convId.slice(-16)}`
      : stableEmailId(senderName || stub.senderName, subject || stub.subject, sentAt);

    return {
      senderName: senderName || stub.senderName,
      senderEmail,
      recipients,
      subject: subject || stub.subject,
      bodyHtml,
      bodyText: htmlToText(bodyHtml),
      sentAt,
      sourceId,
    };
  }

  // ---------------------------------------------------------------------------
  // UnifiedMessage mapping
  // ---------------------------------------------------------------------------

  private emailToMessage(detail: ScrapedEmailDetail): UnifiedMessage {
    return {
      id: detail.sourceId,
      source: MessageSource.Email,
      subject: detail.subject,
      content: detail.bodyText,
      sender: {
        id: detail.senderEmail || detail.senderName,
        name: detail.senderName,
        email: detail.senderEmail || undefined,
      },
      recipients: detail.recipients.map((r) => ({
        id: r.email || r.name,
        name: r.name,
        email: r.email || undefined,
      })),
      createdAt: detail.sentAt,
      isReply: false,
      metadata: {
        email: {
          internetMessageId: detail.sourceId,
        },
      },
      raw: detail,
    };
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.rateLimitConfig.windowMs;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > windowStart);

    if (this.requestTimestamps.length >= this.rateLimitConfig.maxRequests) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = oldestTimestamp + this.rateLimitConfig.windowMs - now;
      if (waitTime > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimestamps.push(now);
  }
}
