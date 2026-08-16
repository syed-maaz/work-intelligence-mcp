/**
 * Teams Chat Scraper
 *
 * Discovers all group chats from the Teams sidebar and scrapes their messages.
 * Uses the real DOM structure confirmed via DevTools spike on teams.microsoft.com/v2:
 *
 * ============================================================
 * DOM SPIKE FINDINGS (teams.microsoft.com/v2, May 2026)
 * ============================================================
 *
 * NAVIGATION:
 *   The page often lands inside an open chat on startup — the rail is absent.
 *   Must click the Chat nav button (aria-label="Chat...") to activate the module.
 *   Chat button data-tid is a UUID (rotates per tenant); use aria-label selector.
 *
 * SIDEBAR:
 *   Container:  div[data-tid="simple-collab-dnd-rail"]  role="tree"
 *   Chat items: role="treeitem" DIVs (no data-tid) — identified by text structure
 *   Text format per item: "{chat name}{DD/MM or HH:MM AM/PM}{last message preview}"
 *   Unread chats: text starts with "Unread" prefix
 *   Skip items:  text starts with Quick views | Mentions | Drafts | New | Chats | Favourites
 *   Navigation:  click the treeitem DIV — Teams SPA handles routing internally
 *                URL stays at teams.microsoft.com/v2/ throughout
 *
 * CHAT VIEW (after clicking a sidebar item):
 *   Chat name:       h2[data-tid="chat-title"]
 *   Scroll region:   div[data-tid="message-pane-list-viewport"]
 *   Message rows:    div[data-tid="chat-pane-item"]   — one per message/event
 *   Message content: div[data-tid="chat-pane-message"] inside each chat-pane-item
 *   Author:          span[data-tid="message-author-name"]
 *   Timestamp:       time[datetime]
 *   Recap tab:       button[data-tid="tab-item-com.microsoft.chattabs.recap"]
 *
 * ACTIVITY DETECTION:
 *   "Unread" prefix in sidebar item text = new messages since last visit
 *   Date on sidebar item = date of last message (DD/MM = current year, DD/MM/YYYY = past)
 *   Time (HH:MM AM/PM) = same-day message
 *   Inactive threshold: no new messages for INACTIVE_DAYS (default 7)
 * ============================================================
 */

import crypto from 'crypto';
import type { Page, ElementHandle } from 'playwright';
import {
  ConnectorError,
  ConnectorErrorType,
  RateLimitConfig,
  DEFAULT_RATE_LIMITS,
} from './types.js';
import type { BrowserSessionManager } from './browser-session.js';
import type { TeamsMeetingsScraper, ScrapedMeeting } from './teams-meetings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAMS_URL = 'https://teams.microsoft.com/v2/';

const SEL = {
  // Chat nav button — aria-label is stable; data-tid is a UUID that rotates per tenant config
  chatNavBtn: '[aria-label^="Chat"][role="button"]',
  rail: 'div[data-tid="simple-collab-dnd-rail"]',
  chatTitle: '[data-tid="chat-title"]',
  viewport: 'div[data-tid="message-pane-list-viewport"]',
  chatPaneItem: 'div[data-tid="chat-pane-item"]',
  chatPaneMessage: 'div[data-tid="chat-pane-message"]',
  authorName: 'span[data-tid="message-author-name"]',
  timestamp: 'time[datetime]',
  recapTab: 'button[data-tid="tab-item-com.microsoft.chattabs.recap"]',
  loginInput: 'input[name="loginfmt"]',
};

// Sidebar items to skip — they are section headers, not chats
const SKIP_PREFIXES = ['Quick views', 'Mentions', 'Drafts', 'New', 'Chats', 'Favourites', 'Unread\n'];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScrapedChatMessage {
  sourceId: string;
  chatName: string;
  senderName: string;
  createdAt: Date;
  bodyHtml: string;
  bodyText: string;
  isUnread: boolean;
}

export interface ScrapedChat {
  name: string;
  isUnread: boolean;
  lastMessageAt: Date | null;
  messages: ScrapedChatMessage[];
  hasRecap: boolean;
  meeting: ScrapedMeeting | null;
}

export interface ChatScrapeOptions {
  /** Only scrape chats with unread messages (fast mode) */
  unreadOnly?: boolean;
  /** How far back to load messages (default: 90 days) */
  sinceDays?: number;
  /** Max messages per chat (default: 500) */
  maxMessagesPerChat?: number;
  /** Max chats to scrape in one run (default: 50) */
  maxChats?: number;
  /** If provided, Recap tabs are scraped inline on the same page */
  meetingScraper?: TeamsMeetingsScraper;
}

// ---------------------------------------------------------------------------
// TeamsChatScraper
// ---------------------------------------------------------------------------

export class TeamsChatScraper {
  private session: BrowserSessionManager;
  private rateLimitConfig: RateLimitConfig;
  private requestTimestamps: number[] = [];

  constructor(session: BrowserSessionManager, rateLimitConfig?: RateLimitConfig) {
    this.session = session;
    this.rateLimitConfig = rateLimitConfig ?? DEFAULT_RATE_LIMITS.teams;
  }

  /**
   * Opens Teams, reads the sidebar, and returns all (or unread-only) chats
   * with their full message history.
   */
  async scrapeChats(options: ChatScrapeOptions = {}): Promise<ScrapedChat[]> {
    const {
      unreadOnly = false,
      sinceDays = 90,
      maxMessagesPerChat = 500,
      maxChats = 50,
      meetingScraper,
    } = options;

    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    process.stderr.write(`[Teams] Opening ${TEAMS_URL}\n`);
    await this.checkRateLimit();

    const page = await this.session.getPage(TEAMS_URL);

    try {
      this.assertNotLoginWall(page);

      // Navigate to Chat view — the rail only loads after clicking the Chat nav button.
      // Teams v2 (May 2026+) lands inside an open chat rather than the chat list,
      // so the rail is absent until we explicitly activate the Chat module.
      await this.navigateToChatView(page);
      process.stderr.write('[Teams] Sidebar loaded.\n');

      // Read all sidebar items
      const sidebarItems = await this.readSidebar(page);
      process.stderr.write(`[Teams] Found ${sidebarItems.length} chats in sidebar.\n`);

      // Filter
      const toScrape = sidebarItems
        .filter((item) => !unreadOnly || item.isUnread)
        .slice(0, maxChats);

      process.stderr.write(
        `[Teams] Scraping ${toScrape.length} chats (unreadOnly=${unreadOnly}).\n`
      );

      const results: ScrapedChat[] = [];

      for (let i = 0; i < toScrape.length; i++) {
        const item = toScrape[i];
        process.stderr.write(
          `[Teams] Chat ${i + 1}/${toScrape.length}: "${item.name}" (unread=${item.isUnread})\n`
        );

        await this.checkRateLimit();

        try {
          const chat = await this.scrapeOneChat(page, item, cutoff, maxMessagesPerChat, meetingScraper);
          results.push(chat);
        } catch (err) {
          if (err instanceof ConnectorError && err.type === ConnectorErrorType.Authentication) {
            throw err;
          }
          process.stderr.write(
            `[Teams] Warning: failed to scrape "${item.name}": ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }

      process.stderr.write(`[Teams] Done. Scraped ${results.length} chats.\n`);
      return results;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /**
   * Ensures the Chat module is active so the sidebar rail is visible.
   * Teams v2 (May 2026+) often lands inside an open chat on startup, leaving the
   * rail absent. We wait for the loading screen to clear, then click the Chat nav
   * button if the rail still isn't visible.
   *
   * The loading screen (#loading-screen) can take 40+ seconds on a fresh temp profile
   * — we must wait for it to disappear before any nav interaction works.
   */
  private async navigateToChatView(page: Page): Promise<void> {
    // Fast path: rail already rendered (page was already in Chat view, no loading screen)
    const railAlready = await page.$(SEL.rail);
    if (railAlready) return;

    // Wait for the Teams loading screen to clear (can take 40+ seconds on first load)
    process.stderr.write('[Teams] Waiting for loading screen to clear...\n');
    await page.waitForSelector('#loading-screen', { state: 'hidden', timeout: 90_000 }).catch(() => {
      // If selector not found, loading screen is already gone — safe to continue
    });

    // Check again after loading screen clears
    const railAfterLoad = await page.$(SEL.rail);
    if (railAfterLoad) return;

    // Rail still absent — click the Chat nav button to activate the module
    const chatBtn = await page.$(SEL.chatNavBtn);
    if (chatBtn) {
      // @ts-expect-error — browser context
      await page.evaluate((el) => (el as HTMLElement).click(), chatBtn);
    }

    await page.waitForSelector(SEL.rail, { timeout: 30_000 });
  }

  // ---------------------------------------------------------------------------
  // Sidebar reading
  // ---------------------------------------------------------------------------

  private async readSidebar(page: Page): Promise<Array<{ name: string; isUnread: boolean; lastMessageAt: Date | null; element: ElementHandle }>> {
    const rail = await page.$(SEL.rail);
    if (!rail) {
      throw new ConnectorError('Teams sidebar rail not found', ConnectorErrorType.Network);
    }

    // Scroll the sidebar down repeatedly to force all chats to virtualise into the DOM
    await this.scrollSidebarToLoadAll(page, rail);

    // Chat items are DIV descendants of the rail at varying depth.
    // Each real chat item contains a date stamp (DD/MM or HH:MM) right after the name.
    const allDivs = await rail.$$('div');
    const items: Array<{ name: string; isUnread: boolean; lastMessageAt: Date | null; element: ElementHandle }> = [];
    const seenNames = new Set<string>();

    for (const div of allDivs) {
      try {
        const rawText = (await div.textContent() ?? '').trim();
        if (!rawText || rawText.length < 5) continue;

        // Must contain a date/time stamp to be a real chat item
        const hasDate = /\d{2}\/\d{2}(\/\d{4})?/.test(rawText);
        const hasTime = /\d{1,2}:\d{2}/.test(rawText);
        if (!hasDate && !hasTime) continue;

        // Skip section headers and container wrappers (too long = parent div)
        if (rawText.length > 250) continue;
        if (SKIP_PREFIXES.some((p) => rawText.startsWith(p))) continue;

        // Detect unread
        const isUnread = rawText.startsWith('Unread');
        const text = isUnread ? rawText.slice('Unread'.length).trim() : rawText;

        // Extract name: everything before the FIRST date/time occurrence.
        // Cap at 60 chars to avoid swallowing preview text when date is missing.
        const dateMatch = text.match(/(\d{2}\/\d{2}(?:\/\d{4})?)/);
        const timeMatch = text.match(/^([\s\S]{2,60}?)(\d{1,2}:\d{2})/);

        let name = '';
        if (dateMatch) {
          const idx = text.indexOf(dateMatch[0]);
          name = text.slice(0, idx).trim();
        } else if (timeMatch) {
          name = timeMatch[1].trim();
        }

        // Reject names that are obviously preview fragments (start with lowercase
        // mid-sentence words, URLs, or are too long)
        if (!name || name.length < 2 || name.length > 80) continue;
        if (/^(http|www|you:|recording)/i.test(name)) continue;
        if (seenNames.has(name)) continue;

        // Parse date
        let lastMessageAt: Date | null = null;
        if (dateMatch) {
          const parts = dateMatch[0].split('/');
          if (parts.length === 2) {
            lastMessageAt = new Date(`${new Date().getFullYear()}-${parts[1]}-${parts[0]}`);
          } else if (parts.length === 3) {
            lastMessageAt = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          }
        } else {
          lastMessageAt = new Date(); // today
        }

        seenNames.add(name);
        items.push({ name, isUnread, lastMessageAt, element: div });
      } catch {
        // skip
      }
    }

    return items;
  }

  // Scrolls the sidebar rail down in steps to force virtual list to render all items
  private async scrollSidebarToLoadAll(page: Page, _rail: ElementHandle): Promise<void> {
    const subNav = await page.$('[data-tid="app-layout-area--sub-nav"]');
    if (!subNav) return;

    let prevHeight = 0;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(
        ([sel]: [string]) => {
          // @ts-expect-error — browser context
          const el: HTMLElement | null = document.querySelector(sel);
          if (el) el.scrollTop += 600;
        },
        ['[data-tid="app-layout-area--sub-nav"]'] as [string]
      );
      await page.waitForTimeout(400);

      // Stop if no new content loaded (scroll height stable)
      const newHeight = await page.evaluate(
        ([sel]: [string]) => {
          // @ts-expect-error — browser context
          return (document.querySelector(sel) as HTMLElement | null)?.scrollHeight ?? 0;
        },
        ['[data-tid="app-layout-area--sub-nav"]'] as [string]
      );
      if (newHeight === prevHeight) break;
      prevHeight = newHeight;
    }

    // Scroll back to top so the first chats are visible when we click them
    await page.evaluate(
      ([sel]: [string]) => {
        // @ts-expect-error — browser context
        const el: HTMLElement | null = document.querySelector(sel);
        if (el) el.scrollTop = 0;
      },
      ['[data-tid="app-layout-area--sub-nav"]'] as [string]
    );
    await page.waitForTimeout(300);
  }

  // ---------------------------------------------------------------------------
  // Single chat scraping
  // ---------------------------------------------------------------------------

  private async scrapeOneChat(
    page: Page,
    item: { name: string; isUnread: boolean; lastMessageAt: Date | null; element: ElementHandle },
    cutoff: Date,
    maxMessages: number,
    meetingScraper?: TeamsMeetingsScraper
  ): Promise<ScrapedChat> {
    // Click the sidebar item to open the chat
    await item.element.click();

    // Wait for the chat view to load
    await page.waitForSelector(SEL.viewport, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForSelector(SEL.chatPaneItem, { timeout: 10_000 }).catch(() => undefined);

    // Small settling delay for the SPA render
    await page.waitForTimeout(800);

    // Confirm the chat title
    const titleEl = await page.$(SEL.chatTitle);
    const chatName = (await titleEl?.textContent() ?? item.name).trim();

    // Scrape messages first (scrolls up through history)
    const messages = await this.scrapeMessages(page, chatName, item.isUnread, cutoff, maxMessages);

    // Check for Recap tab AFTER message scraping — gives more time for tab bar to render
    // Also wait briefly for the tab bar to settle
    await page.waitForTimeout(500);
    const recapBtn = await page.waitForSelector(SEL.recapTab, { timeout: 3_000 }).catch(() => null);
    const hasRecap = recapBtn !== null;

    process.stderr.write(
      `[Teams]   "${chatName}": ${messages.length} messages, recap=${hasRecap}\n`
    );

    // Scrape Recap inline on same page while chat is still open
    let meeting: ScrapedMeeting | null = null;
    if (hasRecap && meetingScraper) {
      meeting = await meetingScraper.scrapeRecapTab(page, chatName).catch((err) => {
        process.stderr.write(
          `[Teams]   Recap failed for "${chatName}": ${err instanceof Error ? err.message : String(err)}\n`
        );
        return null;
      });
    }

    return {
      name: chatName,
      isUnread: item.isUnread,
      lastMessageAt: item.lastMessageAt,
      messages,
      hasRecap,
      meeting,
    };
  }

  // ---------------------------------------------------------------------------
  // Message scraping within a chat
  // ---------------------------------------------------------------------------

  private async scrapeMessages(
    page: Page,
    chatName: string,
    isUnread: boolean,
    cutoff: Date,
    maxMessages: number
  ): Promise<ScrapedChatMessage[]> {
    const collected = new Map<string, ScrapedChatMessage>();
    let hitCutoff = false;
    let scrollPass = 0;
    let noNewCount = 0;

    while (!hitCutoff && collected.size < maxMessages) {
      scrollPass++;

      const items = await page.$$(SEL.chatPaneItem);

      for (const item of items) {
        try {
          // Only process items that have a message body
          const msgEl = await item.$(SEL.chatPaneMessage);
          if (!msgEl) continue;

          const authorEl = await item.$(SEL.authorName);
          const senderName = (await authorEl?.textContent() ?? '').trim() || 'Unknown';

          const timeEl = await item.$(SEL.timestamp);
          const datetime = (await timeEl?.getAttribute('datetime') ?? '').trim();
          const createdAt = datetime ? new Date(datetime) : new Date(0);

          const bodyHtml = (await msgEl.innerHTML()).trim();
          const bodyText = (await msgEl.textContent() ?? '').trim();

          // Build stable source ID
          const sourceId = stableHash(chatName, senderName, datetime, bodyText.slice(0, 50));

          if (collected.has(sourceId)) continue;

          collected.set(sourceId, {
            sourceId,
            chatName,
            senderName,
            createdAt,
            bodyHtml,
            bodyText,
            isUnread,
          });

          if (createdAt.getTime() > 0 && createdAt < cutoff) {
            hitCutoff = true;
          }
        } catch {
          // skip malformed items
        }
      }

      process.stderr.write(
        `[Teams]   scroll ${scrollPass}: ${collected.size} messages collected\n`
      );

      if (hitCutoff || collected.size >= maxMessages) break;

      // Scroll up to load older messages
      const prevSize = collected.size;
      await this.scrollUp(page);
      await page.waitForTimeout(1200);

      // Stop if no new messages appeared after scrolling
      if (collected.size === prevSize) {
        noNewCount++;
        if (noNewCount >= 2) break; // two passes with no new content = top of history
      } else {
        noNewCount = 0;
      }
    }

    // Return sorted by time ascending, filter within window
    return [...collected.values()]
      .filter((m) => m.createdAt.getTime() === 0 || m.createdAt >= cutoff)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // ---------------------------------------------------------------------------
  // Scroll up to load older messages
  // ---------------------------------------------------------------------------

  private async scrollUp(page: Page): Promise<void> {
    await page.evaluate(
      ([vpSel]: [string]) => {
        const vp: { scrollTop: number } | null =
          // @ts-expect-error — browser context
          document.querySelector(vpSel);
        if (vp) vp.scrollTop = 0;
      },
      [SEL.viewport] as [string]
    );
  }

  // ---------------------------------------------------------------------------
  // Login wall detection
  // ---------------------------------------------------------------------------

  private assertNotLoginWall(page: Page): void {
    const url = page.url();
    if (
      url.includes('microsoftonline.com') ||
      url.includes('login.live.com') ||
      url.includes('/login') ||
      url.includes('/signout')
    ) {
      throw new ConnectorError(
        `Teams login wall at ${url}. SSO session may have expired.`,
        ConnectorErrorType.Authentication
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  /**
   * Opens Teams, finds a specific chat by name (substring match), and scrapes it.
   * Returns null if no matching chat is found in the sidebar.
   */
  async scrapeSpecificChat(
    chatName: string,
    meetingScraper?: TeamsMeetingsScraper,
    sinceDays = 90,
  ): Promise<ScrapedChat | null> {
    await this.checkRateLimit();
    const page = await this.session.getPage(TEAMS_URL);

    try {
      this.assertNotLoginWall(page);
      await page.waitForSelector(SEL.rail, { timeout: 30_000 });

      const sidebarItems = await this.readSidebar(page);

      const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const needle = normalize(chatName);
      const match = sidebarItems.find(item => normalize(item.name).includes(needle));

      if (!match) {
        process.stderr.write(`[Teams] scrapeSpecificChat: no chat matching "${chatName}"\n`);
        return null;
      }

      process.stderr.write(`[Teams] scrapeSpecificChat: found "${match.name}"\n`);
      const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      return await this.scrapeOneChat(page, match, cutoff, 200, meetingScraper);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.rateLimitConfig.windowMs;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > windowStart);

    if (this.requestTimestamps.length >= this.rateLimitConfig.maxRequests) {
      const oldest = this.requestTimestamps[0];
      const wait = oldest + this.rateLimitConfig.windowMs - now;
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    }

    this.requestTimestamps.push(now);
  }
}

// ---------------------------------------------------------------------------
// Stable hash
// ---------------------------------------------------------------------------

function stableHash(chat: string, sender: string, timestamp: string, contentPrefix: string): string {
  return crypto
    .createHash('sha256')
    .update(`${chat}|${sender}|${timestamp}|${contentPrefix}`)
    .digest('hex')
    .slice(0, 16);
}
