/**
 * Teams Browser Connector
 *
 * Scrapes Microsoft Teams channel messages from teams.microsoft.com using a
 * shared Playwright browser session that reuses the user's existing SSO cookies.
 * The Microsoft Graph API is NOT used — corporate IT blocks it at the network level.
 *
 * ============================================================
 * EP-2 DOM SPIKE — selectors for teams.microsoft.com (Teams Web App)
 * ============================================================
 *
 * Observed on teams.microsoft.com (April 2025, React-based SPA):
 *
 * CHANNEL MESSAGE LIST:
 *   The Teams web app is a React SPA; CSS class names are obfuscated and change
 *   across deployments. Stable hooks are data-* attributes and ARIA roles.
 *
 *   Message thread container:
 *     div[data-tid="message-list"]          — scrollable region holding all threads
 *     (fallback) div[role="list"]           — accessibility list wrapper
 *
 *   Per-message / per-thread element:
 *     div[data-tid="messageThread"]         — one top-level thread (parent + replies)
 *     div[data-tid="message-body-content"]  — the actual message text/HTML
 *
 *   Message item attributes (on the outer wrapper div):
 *     data-tid="messageThread"
 *     id attribute — format: "message-thread-<messageId>" or numeric
 *
 *   Sender name:
 *     span[data-tid="message-author-name"]
 *     (fallback) span[class*="author"], span[class*="sender"]
 *
 *   Timestamp:
 *     time[datetime]                        — ISO-8601 datetime attribute (most reliable)
 *     (fallback) span[data-tid="message-timestamp"]
 *
 *   Message body:
 *     div[data-tid="message-body-content"]  — may contain nested HTML (mentions, code blocks)
 *     (fallback) div[class*="messageBody"], div[class*="message-body"]
 *
 *   Reply count / thread indicator:
 *     span[data-tid="replyCount"]           — present if thread has replies
 *     button[data-tid="replyButton"]        — reply button; its absence means no replies
 *
 *   Loading more messages (scroll-to-load):
 *     The message list is virtualized. Scrolling to the top triggers loading older
 *     messages. A loading spinner appears as div[data-tid="spinner"] or
 *     div[class*="loadingIndicator"] while messages are loading.
 *
 * LOGIN REDIRECT DETECTION:
 *   URL pattern: login.microsoftonline.com, login.live.com, sts.windows.net
 *   Or: teams.microsoft.com/... → redirects to /signout or /login
 *   Pathname check: page.url().includes('/login') || page.url().includes('microsoftonline')
 *   Element check: input[type="email"][name="loginfmt"] — the AAD email input
 *
 * EMPTY CHANNEL:
 *   If no div[data-tid="messageThread"] elements are found after waiting, return [].
 *
 * NOTES:
 *   - Teams renders lazily; must wait for at least one message to appear.
 *   - Scrolling to the top repeatedly triggers the virtual scroller to load older batches.
 *   - Each scroll-and-wait cycle yields ~20-50 messages depending on viewport height.
 *   - The `id` attribute on message wrappers is the most stable source_id anchor;
 *     fall back to a hash of sender+timestamp+content prefix when absent.
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

export interface TeamsBrowserConfig {
  /**
   * Full URL to a Teams channel, e.g.
   * https://teams.microsoft.com/l/channel/<channelId>/<channelName>?groupId=<teamId>&...
   */
  channelUrl: string;

  /** Human-readable team name (used for metadata; optional) */
  teamName?: string;

  /** Human-readable channel name (used for metadata and message subject; optional) */
  channelName?: string;
}

// ---------------------------------------------------------------------------
// Internal scraped shape before mapping to UnifiedMessage
// ---------------------------------------------------------------------------

interface ScrapedMessage {
  /** Stable DOM id or computed hash */
  sourceId: string;
  senderName: string;
  /** ISO-8601 string from datetime attribute */
  datetimestamp: string;
  createdAt: Date;
  bodyHtml: string;
  isReply: boolean;
  parentSourceId?: string;
}

// ---------------------------------------------------------------------------
// DOM selector constants — ordered from most to least reliable
// ---------------------------------------------------------------------------

const SEL = {
  messageList: [
    'div[data-tid="message-list"]',
    'div[role="list"]',
  ],
  messageThread: [
    'div[data-tid="messageThread"]',
    'div[data-tid="chat-pane-message"]',
  ],
  senderName: [
    'span[data-tid="message-author-name"]',
    'span[class*="authorName"]',
    'span[class*="author-name"]',
    'span[class*="sender"]',
  ],
  timestamp: [
    'time[datetime]',
    'span[data-tid="message-timestamp"]',
  ],
  body: [
    'div[data-tid="message-body-content"]',
    'div[class*="messageBody"]',
    'div[class*="message-body"]',
  ],
  spinner: [
    'div[data-tid="spinner"]',
    'div[class*="loadingIndicator"]',
    'div[class*="loading"]',
  ],
  loginInput: 'input[type="email"][name="loginfmt"]',
};

// ---------------------------------------------------------------------------
// TeamsBrowserConnector
// ---------------------------------------------------------------------------

export class TeamsBrowserConnector implements DataSource {
  private session: BrowserSessionManager;
  private rateLimitConfig: RateLimitConfig;
  private requestTimestamps: number[] = [];

  constructor(session: BrowserSessionManager, rateLimitConfig?: RateLimitConfig) {
    this.session = session;
    this.rateLimitConfig = rateLimitConfig ?? DEFAULT_RATE_LIMITS.teams;
  }

  /**
   * Scrapes Teams channel messages posted since `since` (default: last 24 hours).
   * Navigates to channelUrl, waits for the message list to render, then scrolls
   * upward to load older messages until the cutoff date is reached.
   *
   * @param config  TeamsBrowserConfig — channelUrl, optional teamName/channelName
   * @param since   Only return messages created at or after this timestamp
   *
   * @throws ConnectorError(Authentication) if redirected to a login page
   * @throws ConnectorError(Network)        on page load timeout
   * @throws ConnectorError(InvalidInput)   if config.channelUrl is missing
   */
  async fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]> {
    const { channelUrl, teamName, channelName } = config as unknown as TeamsBrowserConfig;

    if (!channelUrl) {
      throw new ConnectorError(
        'fetchMessages: config.channelUrl is required',
        ConnectorErrorType.InvalidInput
      );
    }

    const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

    await this.checkRateLimit();

    const page = await this.session.getPage(channelUrl);

    try {
      // Extra login check: Teams may redirect within the SPA without changing host
      this.checkForLoginWall(page);

      const scraped = await this.scrapeChannel(page, cutoff, channelName);

      process.stderr.write(
        `[Teams] Done. Total messages collected: ${scraped.length}\n`
      );

      return scraped.map((msg) =>
        this.toUnifiedMessage(msg, teamName, channelName)
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Core scraping logic
  // ---------------------------------------------------------------------------

  private async scrapeChannel(
    page: Page,
    cutoff: Date,
    channelName?: string
  ): Promise<ScrapedMessage[]> {
    // Wait for the message list to appear; empty channel is fine (no messages found).
    const listAppeared = await Promise.race([
      this.waitForAnySelector(page, SEL.messageThread, 20_000),
      this.waitForAnySelector(page, ['div[data-tid="empty-thread-placeholder"]'], 10_000)
        .then(() => false)
        .catch(() => false),
    ]).catch(() => false);

    if (!listAppeared) {
      // Re-check for login wall after waiting (SPA redirect may have fired by now)
      this.checkForLoginWall(page);
      // Genuinely empty channel or no messages in range
      process.stderr.write(
        `[Teams] No messages found in channel${channelName ? ` "${channelName}"` : ''}. Returning [].\n`
      );
      return [];
    }

    const collected = new Map<string, ScrapedMessage>();
    let hitCutoff = false;
    let scrollPage = 0;

    while (!hitCutoff) {
      scrollPage++;

      // Collect all currently visible message threads
      const threads = await page.$$(SEL.messageThread[0]);
      const fallbackThreads =
        threads.length === 0 ? await page.$$(SEL.messageThread[1]) : threads;

      process.stderr.write(
        `[Teams] Page ${scrollPage}: ${fallbackThreads.length} thread elements visible\n`
      );

      for (const thread of fallbackThreads) {
        try {
          // Source ID: prefer DOM id attribute, fall back to computed hash
          let sourceId = (await thread.getAttribute('id') ?? '').trim();

          // Extract sender
          const senderName = await this.extractTextFromElement(thread, SEL.senderName);

          // Extract timestamp
          const timeEl = await thread.$(SEL.timestamp[0]) ??
            await thread.$(SEL.timestamp[1]);
          const datetimestamp =
            (await timeEl?.getAttribute('datetime') ?? '').trim() ||
            (await timeEl?.textContent() ?? '').trim();

          const createdAt = datetimestamp ? new Date(datetimestamp) : new Date(0);

          // Extract body HTML
          const bodyEl = await thread.$(SEL.body[0]) ??
            await thread.$(SEL.body[1]) ??
            await thread.$(SEL.body[2]);
          const bodyHtml = bodyEl
            ? (await bodyEl.innerHTML()).trim()
            : (await thread.textContent() ?? '').trim();

          // Compute fallback source ID if the DOM didn't provide one
          if (!sourceId) {
            sourceId = stableHash(
              senderName,
              datetimestamp,
              bodyHtml.slice(0, 50)
            );
          }

          // Skip if we already have this message
          if (collected.has(sourceId)) continue;

          const msg: ScrapedMessage = {
            sourceId,
            senderName: senderName || 'Unknown',
            datetimestamp,
            createdAt,
            bodyHtml,
            isReply: false,
          };

          collected.set(sourceId, msg);

          // Check if this message is older than cutoff
          if (createdAt !== new Date(0) && createdAt < cutoff) {
            hitCutoff = true;
          }
        } catch {
          // Skip malformed thread elements
        }
      }

      if (hitCutoff) break;

      // Scroll up to load older messages
      const scrolled = await this.scrollUpForMore(page);
      if (!scrolled) {
        // Reached the top of history or no more content loaded
        break;
      }
    }

    // Filter to messages within the requested window
    const results = [...collected.values()].filter(
      (msg) => msg.createdAt >= cutoff || msg.createdAt.getTime() === 0
    );

    return results;
  }

  // ---------------------------------------------------------------------------
  // Scroll to load older messages
  // ---------------------------------------------------------------------------

  private async scrollUpForMore(page: Page): Promise<boolean> {
    // Record how many threads exist before scrolling
    const beforeCount = (await page.$$(SEL.messageThread[0])).length +
      (await page.$$(SEL.messageThread[1])).length;

    // Scroll to the very top of the message list container.
    // page.evaluate runs in the browser; we pass selectors as plain data to
    // avoid TypeScript complaining about DOM globals absent from lib: ["ES2022"].
    await page.evaluate(
      ([listSel, fallbackSel]: [string, string]) => {
        const list: { scrollTop: number } | null =
          // @ts-expect-error — browser context: document is not in lib ES2022
          document.querySelector(listSel) ??
          // @ts-expect-error — browser context
          document.querySelector(fallbackSel);
        if (list) {
          list.scrollTop = 0;
        } else {
          // @ts-expect-error — browser context
          window.scrollTo(0, 0);
        }
      },
      ['div[data-tid="message-list"]', 'div[role="list"]'] as [string, string]
    );

    // Wait briefly for new content to load
    await page.waitForTimeout(1500);

    // Wait for any loading spinner to disappear
    for (const spinnerSel of SEL.spinner) {
      await page
        .waitForSelector(spinnerSel, { state: 'detached', timeout: 5_000 })
        .catch(() => undefined);
    }

    // Check if new threads appeared
    const afterCount = (await page.$$(SEL.messageThread[0])).length +
      (await page.$$(SEL.messageThread[1])).length;

    return afterCount > beforeCount;
  }

  // ---------------------------------------------------------------------------
  // Login wall detection (SPA — host doesn't change but path/element does)
  // ---------------------------------------------------------------------------

  private checkForLoginWall(page: Page): void {
    const url = page.url();
    if (
      url.includes('microsoftonline.com') ||
      url.includes('login.live.com') ||
      url.includes('sts.windows.net') ||
      url.includes('/login') ||
      url.includes('/signout')
    ) {
      throw new ConnectorError(
        `Teams login wall detected at ${url}. SSO session may have expired.`,
        ConnectorErrorType.Authentication
      );
    }
  }

  // ---------------------------------------------------------------------------
  // UnifiedMessage mapping
  // ---------------------------------------------------------------------------

  private toUnifiedMessage(
    msg: ScrapedMessage,
    teamName?: string,
    channelName?: string
  ): UnifiedMessage {
    const subject = channelName
      ? `[Teams] ${channelName}`
      : '[Teams] Channel message';

    return {
      id: msg.sourceId,
      source: MessageSource.Teams,
      subject,
      content: msg.bodyHtml,
      sender: {
        id: msg.senderName,
        name: msg.senderName,
      },
      createdAt: msg.createdAt,
      isReply: msg.isReply,
      parentId: msg.parentSourceId,
      metadata: {
        teams: {
          teamId: teamName ?? '',
          teamName,
          channelId: channelName ?? '',
          channelName,
        },
      },
      raw: msg,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Tries each selector in order on `element`; returns the first non-empty text.
   */
  private async extractTextFromElement(
    element: Awaited<ReturnType<Page['$']>>,
    selectors: string[]
  ): Promise<string> {
    if (!element) return '';
    for (const sel of selectors) {
      try {
        const child = await element.$(sel);
        if (child) {
          const text = (await child.textContent() ?? '').trim();
          if (text) return text;
          const title = (await child.getAttribute('title') ?? '').trim();
          if (title) return title;
        }
      } catch {
        // try next
      }
    }
    return '';
  }

  /**
   * Waits for any of the given selectors to appear; resolves true on success.
   */
  private async waitForAnySelector(
    page: Page,
    selectors: string[],
    timeout: number
  ): Promise<boolean> {
    const promises = selectors.map((sel) =>
      page
        .waitForSelector(sel, { timeout })
        .then(() => true)
        .catch(() => false)
    );
    const results = await Promise.all(promises);
    return results.some(Boolean);
  }

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

// ---------------------------------------------------------------------------
// Stable hash for source_id fallback
// ---------------------------------------------------------------------------

/**
 * Produces a deterministic 12-char hex ID from sender + timestamp + content prefix.
 * Used when the DOM element has no usable `id` attribute.
 */
function stableHash(sender: string, timestamp: string, contentPrefix: string): string {
  const payload = `${sender}|${timestamp}|${contentPrefix}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 12);
}
