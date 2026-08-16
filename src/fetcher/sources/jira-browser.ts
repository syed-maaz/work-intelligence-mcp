/**
 * Jira Browser Connector
 *
 * Scrapes Jira issues and comments from a config-driven Jira instance using a shared
 * Playwright browser session that reuses the user's existing SSO cookies. The Jira
 * REST API (/rest/api/2/) is NOT used here — some Data Center instances rate-limit
 * every API request at the IP level regardless of token validity.
 *
 * ============================================================
 * EP-4-1 DOM SPIKE — selectors for Jira Data Center 9.x
 * ============================================================
 *
 * ISSUE LIST (board backlog / project issue navigator):
 *   Board URL typically ends in /issues/?jql=... or /projects/<KEY>/issues
 *   Issue navigator:  https://jira.example.com/issues/?jql=...
 *
 *   Issue row (GH-style backlog): tr.issuerow
 *     - Issue key:    td.issuekey a           (text content: "PROJ-123", href: /browse/PROJ-123)
 *     - Summary:      td.summary a            (text content: summary text)
 *     - Updated date: td[data-field-id="updated"] time[datetime]  (datetime attr is ISO string)
 *     - Status:       td[data-field-id="status"] span.jira-issue-status-lozenge
 *     - Assignee:     td[data-field-id="assignee"] span.user-avatar (title attr) or text
 *
 *   Pagination: a.nav-next (next page link), absent when on last page
 *   Issue count: div.results-count-total  (inner text: "1–50 of 143")
 *
 * ISSUE DETAIL PAGE:  /browse/<ISSUE-KEY>
 *   Title:       h1#summary-val  (or #summary) text content
 *   Description: div#description-val  (HTML or text — may contain wiki markup rendered to HTML)
 *   Status:      span#status-val  (text content: "In Progress")
 *   Assignee:    span#assignee-val a  (text content), or span.user-avatar title attr
 *   Reporter:    span#reporter-val a  (text content)
 *   Created:     span#create-date time[datetime]  (ISO string in datetime attr)
 *   Issue key:   a#key-val  (text: "PROJ-123")
 *   Issue type:  img#type-val  (alt attr: "Story", "Bug", "Task")
 *   Priority:    img#priority-val  (alt attr: "Major", "Minor", etc.)
 *
 * COMMENTS:
 *   Container:   div#comment-tabpanel  (or div.issue-data-block .activity-comment)
 *   Per comment: div.comment-item[id^="comment-"]
 *     - ID:      div.comment-item  → id attr (e.g. "comment-123456")
 *     - Author:  a.user-avatar  (title or text content)
 *     - Body:    div.action-body  (HTML)
 *     - Date:    time[datetime]  (ISO string, or unix timestamp in title)
 *
 * LOGIN REDIRECT DETECTION:
 *   URL contains: /login.jsp  or  microsoftonline.com  or  /secure/Dashboard.jspa
 *   (redirected when session expired — final URL host differs from configured Jira host)
 *
 * ============================================================
 */

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
import { getJiraBrowserBaseUrl } from '../../services/wi-config.js';

function getJiraBrowserBaseUrlForScraper(): string {
  try { return getJiraBrowserBaseUrl(); } catch { /* fall through */ }
  const domain = process.env.JIRA_DOMAIN;
  if (domain) return `https://${domain}`;
  return 'https://jira.example.com';
}

// ---------------------------------------------------------------------------
// Standalone URL conversion utility (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Converts a Jira RapidBoard URL to an issue navigator JQL URL that can be
 * scraped with standard tr.issuerow selectors.
 *
 * Input:  https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=JIRA
 * Output: https://jira.example.com/issues/?jql=project%3DJIRA+ORDER+BY+updated+DESC
 *
 * Optionally adds an `updated >= "YYYY-MM-DD"` clause when sinceDate is provided.
 */
export function convertRapidBoardToNavigatorUrl(rawUrl: string, sinceDate?: Date): string {
  try {
    const url = new URL(rawUrl);
    if (!url.pathname.includes('RapidBoard.jspa')) {
      return rawUrl; // Already a navigator or browse URL
    }
    const projectKey = url.searchParams.get('projectKey');
    const base = `${url.protocol}//${url.host}`;

    const dateClause = sinceDate
      ? ` AND updated >= "${sinceDate.toISOString().slice(0, 10)}"`
      : '';

    if (projectKey) {
      const jql = encodeURIComponent(`project = ${projectKey}${dateClause} ORDER BY updated DESC`);
      return `${base}/issues/?jql=${jql}`;
    }
    // No projectKey: fall back to all recent issues
    const jql = encodeURIComponent(`updated >= "2020-01-01"${dateClause} ORDER BY updated DESC`);
    return `${base}/issues/?jql=${jql}`;
  } catch {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// Config type for fetchMessages
// ---------------------------------------------------------------------------

export interface JiraBrowserConfig {
  /** Full URL to the Jira board or issue navigator, e.g.
   *  https://jira.example.com/issues/?jql=project%3DJIRA+ORDER+BY+updated+DESC
   *  https://jira.example.com/projects/JIRA/issues
   */
  boardUrl: string;

  /** Optional project key filter (e.g. "PROJ"). When set, filters issues to
   *  this project even if boardUrl points to a broader query. */
  projectKey?: string;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

export interface ScrapedPR {
  id: string;
  title: string;
  url: string;
  status: string;    // "OPEN", "MERGED", "DECLINED"
  author: string;
  repoSlug: string;
}

interface ScrapedIssue {
  key: string;
  summary: string;
  url: string;
  updatedAt: Date;
  status: string;
  assigneeName: string;
}

interface ScrapedIssueDetail {
  key: string;
  title: string;
  description: string;
  status: string;
  assigneeName: string;
  reporterName: string;
  createdAt: Date;
  updatedAt: Date;
  issueType: string;
  priority: string;
  projectKey: string;
  epicKey: string;
  epicName: string;
  comments: ScrapedComment[];
  bitbucketPRs: ScrapedPR[];
}

interface ScrapedComment {
  id: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// JiraBrowserConnector
// ---------------------------------------------------------------------------

export class JiraBrowserConnector implements DataSource {
  private session: BrowserSessionManager;
  private rateLimitConfig: RateLimitConfig;
  private requestTimestamps: number[] = [];

  constructor(session: BrowserSessionManager, rateLimitConfig?: RateLimitConfig) {
    this.session = session;
    this.rateLimitConfig = rateLimitConfig ?? DEFAULT_RATE_LIMITS.jira;
  }

  /**
   * Scrapes Jira issues updated since `since` (default: last 24 hours).
   * Navigates to the boardUrl, collects issue keys, then opens each issue's
   * detail page to extract full content and comments.
   *
   * @param config  JiraBrowserConfig — boardUrl and optional projectKey
   * @param since   Only return issues updated at or after this timestamp
   *
   * @throws ConnectorError(Authentication) if redirected to a login page
   * @throws ConnectorError(Network)        on page load timeout
   */
  async fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]> {
    const { boardUrl, projectKey } = config as unknown as JiraBrowserConfig;

    if (!boardUrl) {
      throw new ConnectorError(
        'fetchMessages: config.boardUrl is required',
        ConnectorErrorType.InvalidInput
      );
    }

    const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

    // ---- 1. Navigate to the issue list ----
    const navigatorUrl = convertRapidBoardToNavigatorUrl(boardUrl, cutoff);
    const listPage = await this.session.getPage(navigatorUrl).catch((err) => {
      throw err; // ConnectorError already set by BrowserSessionManager
    });

    let allIssues: ScrapedIssue[] = [];

    try {
      allIssues = await this.scrapeIssueList(listPage, cutoff, projectKey, 2);
    } finally {
      await listPage.close().catch(() => undefined);
    }

    if (allIssues.length === 0) {
      return [];
    }

    // ---- 2. For each issue, scrape detail + comments ----
    const messages: UnifiedMessage[] = [];
    process.stderr.write(`[Jira] Scraped ${allIssues.length} issues from list. Fetching details...\n`);

    for (let i = 0; i < allIssues.length; i++) {
      const issue = allIssues[i];
      process.stderr.write(`[Jira] Detail ${i + 1}/${allIssues.length}: ${issue.key}\n`);
      await this.checkRateLimit();

      const detailPage = await this.session.getPage(issue.url).catch((err) => {
        // If we get an auth error mid-run, propagate it
        if (err instanceof ConnectorError) throw err;
        console.warn(`Skipping ${issue.key}: failed to load detail page`, err);
        return null;
      });

      if (!detailPage) continue;

      let detail: ScrapedIssueDetail | null = null;

      try {
        detail = await this.scrapeIssueDetail(detailPage, issue);
      } catch (err) {
        console.warn(`Skipping ${issue.key}: scrape failed`, err);
      } finally {
        await detailPage.close().catch(() => undefined);
      }

      if (!detail) continue;

      // Map issue to UnifiedMessage
      messages.push(this.issueToMessage(detail));

      // Map each comment as a separate reply message
      for (const comment of detail.comments) {
        messages.push(this.commentToMessage(comment, detail));
      }
    }

    return messages;
  }

  // ---------------------------------------------------------------------------
  // Issue list scraping
  // ---------------------------------------------------------------------------

  private async scrapeIssueList(
    page: Page,
    _cutoff: Date,
    projectKey?: string,
    maxPages = 5
  ): Promise<ScrapedIssue[]> {
    const issues: ScrapedIssue[] = [];
    let hasNextPage = true;
    let pageNum = 0;

    while (hasNextPage && pageNum < maxPages) {
      pageNum++;
      await page.waitForSelector('table#issuetable, div.issue-list, tr.issuerow', {
        timeout: 20_000,
      }).catch(() => {
        // No issue rows found — could be empty board
      });

      const rows = await page.$$('tr.issuerow');
      process.stderr.write(`[Jira] List page ${pageNum}: ${rows.length} rows\n`);

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        try {
          const keyEl = await row.$('td.issuekey a');
          const summaryEl = await row.$('td.summary a');
          const updatedEl = await row.$('td[data-field-id="updated"] time');

          if (!keyEl || !summaryEl) continue;

          const key = (await keyEl.textContent() ?? '').trim();
          const summary = (await summaryEl.textContent() ?? '').trim();
          const href = await keyEl.getAttribute('href') ?? '';
          const updatedDatetime = await updatedEl?.getAttribute('datetime') ?? '';
          const updatedTitle = await updatedEl?.getAttribute('title') ?? '';
          const updatedAt = updatedDatetime
            ? new Date(updatedDatetime)
            : updatedTitle
              ? new Date(updatedTitle)
              : new Date();

          // Project filter (server-side JQL already filters but guard here too)
          if (projectKey && !key.startsWith(`${projectKey}-`)) continue;

          // Try progressively broader selectors — Jira Data Center wraps status in a lozenge
          const statusEl = await row.$(
            '[data-field-id="status"] span.jira-issue-status-lozenge, ' +
            '[data-field-id="status"] .jira-issue-status-lozenge, ' +
            '[data-field-id="status"] span'
          );
          const status = (await statusEl?.textContent() ?? '').trim();

          const assigneeEl = await row.$('[data-field-id="assignee"] span, [data-field-id="assignee"] a');
          const assigneeName = (
            await assigneeEl?.getAttribute('title') ??
            await assigneeEl?.textContent() ??
            ''
          ).trim();

          // Build full URL
          const issueUrl = this.resolveIssueUrl(page.url(), href);

          issues.push({ key, summary, url: issueUrl, updatedAt, status, assigneeName });
        } catch {
          // Skip malformed rows
        }
      }

      // Check for next page link
      const nextLink = await page.$('a.nav-next:not([disabled])');
      if (nextLink) {
        const nextHref = await nextLink.getAttribute('href');
        if (nextHref) {
          // nextHref may be relative (e.g. /issues/?jql=...&startIndex=50)
          const absoluteNext = nextHref.startsWith('http')
            ? nextHref
            : `${new URL(page.url()).origin}${nextHref}`;
          await page.goto(absoluteNext, { waitUntil: 'domcontentloaded' });
          continue;
        }
      }

      hasNextPage = false;
    }

    return issues;
  }

  // ---------------------------------------------------------------------------
  // Issue detail scraping
  // ---------------------------------------------------------------------------

  private async scrapeIssueDetail(
    page: Page,
    issueStub: ScrapedIssue
  ): Promise<ScrapedIssueDetail> {
    // Wait for the detail page to be ready
    await page.waitForSelector('#summary-val, #summary, h1[data-issue-key]', {
      timeout: 20_000,
    }).catch(() => undefined);

    const title = await this.extractText(page, [
      '#summary-val',
      '#summary',
      'h1[data-issue-key]',
    ]) || issueStub.summary;

    const description = await this.extractHtml(page, [
      '#description-val',
      'div#description .field-ignore-highlight',
      'div.description-text',
    ]);

    const status = await this.extractText(page, [
      'span#status-val',
      '#status-val span.jira-issue-status-lozenge',
      '#status-val .jira-issue-status-lozenge',
      '#status-val span',
      '#status-val',
      'div#status-val span',
    ]) || issueStub.status;

    const assigneeName = await this.extractText(page, [
      '#assignee-val a',
      '#assignee-val span',
      'span#assignee-val',
    ]) || issueStub.assigneeName;

    const reporterName = await this.extractText(page, [
      '#reporter-val a',
      '#reporter-val span',
      'span#reporter-val',
    ]);

    const issueType = await this.extractAttr(page, '#type-val', 'alt') ||
      await this.extractText(page, ['#type-val', 'span#type-val']) || 'Unknown';

    const priority = await this.extractAttr(page, '#priority-val', 'alt') ||
      await this.extractText(page, ['#priority-val', 'span#priority-val']) || 'Unknown';

    // Epic link — Jira Data Center stores it as a custom field (customfield_10014) or
    // as a sidebar link with id "epic-link-val". Fall back to empty strings if absent.
    const epicKey = await this.extractText(page, [
      '#customfield_10014-val',
      'span#customfield_10014-val',
      '#epic-link-val',
      'span#epic-link-val',
      'a#epic-link-val',
    ]);
    const epicName = await this.extractText(page, [
      '#customfield_10014-val a',
      '#epic-link-val span',
      'span#customfield_10014-val a',
    ]) || epicKey;

    const createdDatetime = await this.extractAttr(page, '#create-date time', 'datetime') ||
      await this.extractAttr(page, 'span#created-date time', 'datetime') || '';
    const createdAt = createdDatetime ? new Date(createdDatetime) : issueStub.updatedAt;

    // Extract issue key (may differ from URL if redirected)
    const keyText = await this.extractText(page, ['a#key-val', '#key-val']) || issueStub.key;
    const projectKey = keyText.split('-')[0] ?? issueStub.key.split('-')[0];

    const comments = await this.scrapeComments(page);
    const bitbucketPRs = await this.scrapeBitbucketPRs(page);

    return {
      key: keyText || issueStub.key,
      title,
      description,
      status,
      assigneeName,
      reporterName: reporterName || 'Unknown',
      createdAt,
      updatedAt: issueStub.updatedAt,
      issueType,
      priority,
      projectKey,
      epicKey,
      epicName,
      comments,
      bitbucketPRs,
    };
  }

  // ---------------------------------------------------------------------------
  // Comment scraping
  // ---------------------------------------------------------------------------

  private async scrapeComments(page: Page): Promise<ScrapedComment[]> {
    const comments: ScrapedComment[] = [];

    const commentItems = await page.$$('div.comment-item[id^="comment-"]');

    for (const item of commentItems) {
      try {
        const idAttr = await item.getAttribute('id') ?? '';
        const commentId = idAttr.replace('comment-', '') || idAttr;

        const authorEl = await item.$('a.user-avatar, span.user-avatar, a[data-username]');
        const authorName = (
          await authorEl?.getAttribute('title') ??
          await authorEl?.textContent() ??
          'Unknown'
        ).trim();

        const bodyEl = await item.$('div.action-body');
        const body = bodyEl
          ? (await bodyEl.innerHTML()).trim()
          : (await item.textContent() ?? '').trim();

        const timeEl = await item.$('time[datetime]');
        const datetimeAttr = await timeEl?.getAttribute('datetime') ?? '';
        const createdAt = datetimeAttr ? new Date(datetimeAttr) : new Date();

        comments.push({ id: commentId, authorName, body, createdAt });
      } catch {
        // Skip malformed comments
      }
    }

    return comments;
  }

  // ---------------------------------------------------------------------------
  // Bitbucket PR scraping (best-effort — development panel loads async)
  // ---------------------------------------------------------------------------

  private async scrapeBitbucketPRs(page: Page): Promise<ScrapedPR[]> {
    const prs: ScrapedPR[] = [];

    // Wait briefly for the development panel to load (it's async / lazy)
    await page.waitForSelector(
      '#development-panel, div[data-module="jira.view.issue.development-info"]',
      { timeout: 2_000 }
    ).catch(() => undefined); // Panel may not exist — that's fine

    const panelEl = await page.$(
      '#development-panel, div[data-module="jira.view.issue.development-info"]'
    );

    const prLinks = panelEl
      ? await panelEl.$$('a[href*="pull-requests"]')
      : await page.$$('a[href*="bitbucket"][href*="pull-requests"]');

    for (const link of prLinks) {
      try {
        const href = await link.getAttribute('href') ?? '';
        const title = (await link.textContent() ?? '').trim();

        const prMatch = href.match(/pull-requests\/(\d+)/);
        const prId = prMatch?.[1] ?? '';
        if (!prId) continue;

        const repoMatch = href.match(/repos\/([^/]+)\/pull-requests/);
        const repoSlug = repoMatch?.[1] ?? '';

        // Status lozenge near the link (e.g. "OPEN", "MERGED", "DECLINED")
        const statusEl = await link.$('xpath=../span[contains(@class,"lozenge")]');
        const rawStatus = (await statusEl?.textContent() ?? 'OPEN').trim().toUpperCase();
        const status = ['OPEN', 'MERGED', 'DECLINED'].includes(rawStatus) ? rawStatus : 'OPEN';

        // Author — look for a user-avatar near the PR link
        const authorEl = await link.$('xpath=../span[@class="aui-avatar-inner"]/img');
        const author = (await authorEl?.getAttribute('alt') ?? '').trim();

        prs.push({ id: prId, title, url: href, status, author, repoSlug });
      } catch {
        // Skip malformed PR entries
      }
    }

    return prs;
  }

  // ---------------------------------------------------------------------------
  // UnifiedMessage mapping
  // ---------------------------------------------------------------------------

  private issueToMessage(detail: ScrapedIssueDetail): UnifiedMessage {
    return {
      id: detail.key,
      source: MessageSource.Jira,
      subject: `[${detail.key}] ${detail.title}`,
      content: detail.description,
      sender: {
        id: detail.reporterName,
        name: detail.reporterName,
      },
      createdAt: detail.createdAt,
      modifiedAt: detail.updatedAt,
      isReply: false,
      metadata: {
        jira: {
          issueKey: detail.key,
          projectKey: detail.projectKey,
          issueType: detail.issueType,
          status: detail.status,
          priority: detail.priority,
          assignee: detail.assigneeName
            ? { id: detail.assigneeName, name: detail.assigneeName }
            : undefined,
          epicKey: detail.epicKey || undefined,
          epicName: detail.epicName || undefined,
        },
      },
      raw: detail,
    };
  }

  private commentToMessage(
    comment: ScrapedComment,
    issue: ScrapedIssueDetail
  ): UnifiedMessage {
    return {
      id: `${issue.key}-comment-${comment.id}`,
      source: MessageSource.Jira,
      subject: `Comment on ${issue.key}`,
      content: comment.body,
      sender: {
        id: comment.authorName,
        name: comment.authorName,
      },
      createdAt: comment.createdAt,
      parentId: issue.key,
      isReply: true,
      metadata: {
        jira: {
          issueKey: issue.key,
          projectKey: issue.projectKey,
        },
      },
      raw: comment,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async extractText(page: Page, selectors: string[]): Promise<string> {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = (await el.textContent() ?? '').trim();
          if (text) return text;
        }
      } catch {
        // try next selector
      }
    }
    return '';
  }

  private async extractHtml(page: Page, selectors: string[]): Promise<string> {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const html = (await el.innerHTML()).trim();
          if (html) return html;
        }
      } catch {
        // try next selector
      }
    }
    return '';
  }

  private async extractAttr(
    page: Page,
    selector: string,
    attribute: string
  ): Promise<string> {
    try {
      const el = await page.$(selector);
      return (await el?.getAttribute(attribute) ?? '').trim();
    } catch {
      return '';
    }
  }

  private resolveIssueUrl(pageUrl: string, href: string): string {
    if (href.startsWith('http')) return href;
    try {
      const base = new URL(pageUrl);
      return `${base.protocol}//${base.host}${href}`;
    } catch {
      return href;
    }
  }

  // ---------------------------------------------------------------------------
  // EP-48-1: Hierarchical fetch — epic children + linked issues
  // ---------------------------------------------------------------------------

  /**
   * Scrape child issues of an epic via the Jira issue navigator (browser path).
   * Uses `withJiraReadLock` pattern — caller must pass a lock function if needed.
   */
  async scrapeEpicChildren(
    epicKey: string,
  ): Promise<Array<{ key: string; title: string; status: string; issueType: string; assignee: string | null; url: string }>> {
    const baseUrl = getJiraBrowserBaseUrlForScraper();
    const jqlUrl = `${baseUrl}/issues/?jql=parent+%3D+${encodeURIComponent(epicKey)}+ORDER+BY+updated+DESC`;
    const page = await this.session.getPage(jqlUrl);
    const results: Array<{ key: string; title: string; status: string; issueType: string; assignee: string | null; url: string }> = [];

    try {
      await page.waitForSelector('tr.issuerow, .issue-row, li[data-issuekey]', { timeout: 15_000 }).catch(() => undefined);

      const rows = await page.evaluate(() => {
        // @ts-expect-error — browser context
        const issueRows = Array.from(document.querySelectorAll('tr.issuerow'));
        return issueRows.map((row) => {
          // @ts-expect-error — browser context
          const keyEl = row.querySelector('td.issuekey a');
          // @ts-expect-error — browser context
          const summaryEl = row.querySelector('td.summary a');
          // @ts-expect-error — browser context
          const statusEl = row.querySelector('td.status .jira-issue-status-lozenge, td.status span');
          // @ts-expect-error — browser context
          const assigneeEl = row.querySelector('td.assignee span, td.assignee a');
          // @ts-expect-error — browser context
          const typeEl = row.querySelector('td.issuetype img');
          return {
            key: keyEl?.textContent?.trim() ?? '',
            title: summaryEl?.textContent?.trim() ?? '',
            url: keyEl?.href ?? '',
            status: statusEl?.textContent?.trim() ?? 'Unknown',
            issueType: typeEl?.alt ?? 'Story',
            assignee: assigneeEl?.textContent?.trim() ?? null,
          };
        }).filter((r) => r.key);
      });

      results.push(...rows);
    } finally {
      await page.close().catch(() => undefined);
    }

    return results;
  }

  /**
   * Scrape linked issues for a given issue key (browser path).
   * Returns a flat list of linked issues from the "Issue Links" panel.
   */
  async scrapeLinkedIssues(
    issueKey: string,
  ): Promise<Array<{ key: string; title: string; linkType: string; status: string; url: string }>> {
    const baseUrl = getJiraBrowserBaseUrlForScraper();
    const url = `${baseUrl}/browse/${encodeURIComponent(issueKey)}`;
    const page = await this.session.getPage(url);
    const results: Array<{ key: string; title: string; linkType: string; status: string; url: string }> = [];

    try {
      await page.waitForSelector('#issue-links, #linkingmodule', { timeout: 15_000 }).catch(() => undefined);

      const links = await page.evaluate(() => {
        // @ts-expect-error — browser context
        const container = document.querySelector('#issue-links, #linkingmodule');
        if (!container) return [];
        const groups = Array.from(container.querySelectorAll('.link-group'));
        const out: Array<{ key: string; title: string; linkType: string; status: string; url: string }> = [];
        for (const group of groups) {
          // @ts-expect-error — browser context
          const linkTypeEl = group.querySelector('.link-type');
          const linkType = linkTypeEl?.textContent?.trim() ?? 'relates to';
          // @ts-expect-error — browser context
          const issueEls = Array.from(group.querySelectorAll('dl.link-issue'));
          for (const el of issueEls) {
            // @ts-expect-error — browser context
            const keyEl = el.querySelector('a.link-title');
            // @ts-expect-error — browser context
            const statusEl = el.querySelector('.jira-issue-status-lozenge, .link-status');
            if (keyEl) {
              out.push({
                key: keyEl.textContent?.trim() ?? '',
                title: keyEl.title ?? keyEl.textContent?.trim() ?? '',
                linkType,
                status: statusEl?.textContent?.trim() ?? 'Unknown',
                url: keyEl.href ?? '',
              });
            }
          }
        }
        return out;
      });

      results.push(...links);
    } finally {
      await page.close().catch(() => undefined);
    }

    return results;
  }

  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.rateLimitConfig.windowMs;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > windowStart);

    if (this.requestTimestamps.length >= this.rateLimitConfig.maxRequests) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = oldestTimestamp + this.rateLimitConfig.windowMs - now;
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.requestTimestamps.push(now);
  }
}
