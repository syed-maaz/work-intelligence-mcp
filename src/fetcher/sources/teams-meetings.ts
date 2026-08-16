/**
 * Teams Meetings Scraper
 *
 * Scrapes the Recap tab of Teams chats to extract meeting transcripts,
 * attendees, and notes. Then uses Claude to analyze and categorize.
 *
 * ============================================================
 * DOM SPIKE FINDINGS — Recap tab (teams.microsoft.com/v2, April 2026)
 * ============================================================
 *
 * After clicking button[data-tid="tab-item-com.microsoft.chattabs.recap"]:
 *
 *   Recap root:     [data-tid="intelligent-recap-header"]
 *   Main panel:     [data-tid="meeting-recap-main-panel"]
 *   Left panel:     [data-tid="Meeting-Recap-left-panel-container"]
 *   Left pills:     [data-tid="recap-left-panel-pill-list"]
 *                     → Speakers, Topics, Chapters pills
 *   Right pills:    [data-tid="recap-right-panel-pill-list"]
 *                     → Notes, AINotes, Transcript pills
 *
 *   Transcript:     click button[data-tid="Transcript"] (right panel pill)
 *                   → content loads inside [data-tid="meeting-recap-main-panel"]
 *                   → speaker turns: no stable data-tid; use class patterns or
 *                     just dump full text from the main panel after clicking
 *
 *   Speakers:       [data-tid="Speakers"] pill → left panel shows speaker list
 *   Topics:         [data-tid="Topics"] pill → left panel shows topic list
 *   AI Notes:       [data-tid="AINotes"] pill → right panel shows AI-generated notes
 *   Notes:          [data-tid="Notes"] pill → right panel shows manual notes
 *
 *   APC (AI Platform Content):
 *     [data-tid="apc-renderer"]        — AI content wrapper
 *     [data-tid="apc-body"]            — body of AI content
 *     [data-tid="apc-items-vertical-renderer"] — list of AI items
 *     [data-tid="apc-item-renderer"]   — individual AI item
 *     [data-tid="ai-insights-content-wrapper"] — AI insights section
 *
 *   Recording:      [data-tid="Meeting-Recap-recording-container"]
 *
 * LOGIN REDIRECT: same as chat scraper — check URL for microsoftonline.com
 * ============================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type { Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { BrowserSessionManager } from './browser-session.js';
import { bucketCallParams } from '../../services/model-config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScrapedMeeting {
  sourceId: string;
  chatName: string;
  title: string;
  date: Date;
  attendees: string[];
  transcriptText: string;
  notes: string;
  /** Claude-extracted fields */
  topics: string[];
  summary: string;
  decisions: string[];
  actionItems: string[];
}

// ---------------------------------------------------------------------------
// Confirmed data-tid selectors from DOM spike
// ---------------------------------------------------------------------------

const SEL = {
  recapTab:      'button[data-tid="tab-item-com.microsoft.chattabs.recap"]',
  recapHeader:   '[data-tid="intelligent-recap-header"]',
  mainPanel:     '[data-tid="meeting-recap-main-panel"]',
  leftPanel:     '[data-tid="Meeting-Recap-left-panel-container"]',
  transcriptPill:'button[data-tid="Transcript"]',
  notesPill:     'button[data-tid="Notes"]',
  aiNotesPill:   'button[data-tid="AINotes"]',
  topicsPill:    'button[data-tid="Topics"]',
  speakersPill:  'button[data-tid="Speakers"]',
  apcBody:       '[data-tid="apc-body"]',
  apcItem:       '[data-tid="apc-item-renderer"]',
  aiInsights:    '[data-tid="ai-insights-content-wrapper"]',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to parse a meeting date from the recap header title text.
 * Teams recap headers begin with the meeting date/time, e.g.:
 *   "Monday, April 13, 2026 8:00 AM -  9:00 AM"
 *   "Thursday, April 2, 2026 1:15 PM -  2:00 PM"
 * Returns null when the title doesn't match the expected pattern.
 */
function parseDateFromTitle(title: string): Date | null {
  // Match "Month DD, YYYY" optionally preceded by "Weekday, "
  const match = title.match(
    /(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+)?(\w+ \d{1,2}, \d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/i
  );
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}`);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// TeamsMeetingsScraper
// ---------------------------------------------------------------------------

export class TeamsMeetingsScraper {
  private anthropic: Anthropic | null;
  private db: Database.Database | null;

  constructor(_session: BrowserSessionManager, anthropicApiKey?: string, db?: Database.Database) {
    this.db = db ?? null;
    if (anthropicApiKey) {
      const baseURL = process.env.ANTHROPIC_BASE_URL;
      this.anthropic = new Anthropic({
        apiKey: baseURL ? 'x-proxy' : anthropicApiKey,
        ...(baseURL ? {
          baseURL,
          defaultHeaders: { 'Authorization': `Bearer ${anthropicApiKey}` },
        } : {}),
      });
    } else {
      this.anthropic = null;
    }
  }

  /**
   * Given a page already showing a chat, click Recap tab and scrape everything.
   * Returns null if no Recap tab or no content found.
   */
  async scrapeRecapTab(page: Page, chatName: string): Promise<ScrapedMeeting | null> {
    const recapBtn = await page.$(SEL.recapTab);
    if (!recapBtn) {
      process.stderr.write(`[Teams/Recap] No Recap tab for "${chatName}"\n`);
      return null;
    }

    process.stderr.write(`[Teams/Recap] Opening Recap tab for "${chatName}"\n`);
    await recapBtn.click();

    // Wait for the recap root to appear — confirms the view loaded
    const recapRoot = await page.waitForSelector(SEL.recapHeader, { timeout: 15_000 })
      .catch(() => null);

    if (!recapRoot) {
      process.stderr.write(`[Teams/Recap] Recap header never appeared for "${chatName}"\n`);
      return null;
    }

    // Extra settle time — the panels load async after the header
    await page.waitForTimeout(2000);

    // --- Title: from the recap header text or chat name ---
    const title = (await recapRoot.textContent() ?? chatName).trim().slice(0, 120) || chatName;

    // --- Date: parse from title text first (most reliable on Teams Recap tab) ---
    // The recap header typically starts with "Day, Month DD, YYYY HH:MM AM/PM - HH:MM AM/PM"
    // e.g. "Monday, April 13, 2026 8:00 AM -  9:00 AM"
    // Fallback to first time[datetime] in the RECAP panel only (not the full page — chat
    // message timestamps elsewhere on the page would give wrong results).
    let date = parseDateFromTitle(title);
    if (!date) {
      // Try a time[datetime] scoped to the recap main panel only
      const recapPanel = await page.$(SEL.mainPanel ?? '[data-tid="meeting-recap-main-panel"]');
      const timeEl = recapPanel
        ? await recapPanel.$('time[datetime]')
        : null;
      const datetime = (await timeEl?.getAttribute('datetime') ?? '').trim();
      date = datetime ? new Date(datetime) : new Date();
    }

    // --- Speakers / Attendees: click Speakers pill, read left panel ---
    const attendees = await this.scrapeAttendees(page);

    // --- Transcript: click Transcript pill, read main panel ---
    const transcriptText = await this.scrapeTranscript(page);

    // --- Notes: click Notes pill, read main panel ---
    const notes = await this.scrapeNotes(page);

    // --- AI Notes as additional context ---
    const aiNotes = await this.scrapeAINotes(page);

    const fullContent = [
      transcriptText,
      aiNotes,
      notes,
    ].filter(Boolean).join('\n\n');

    if (!fullContent.trim()) {
      process.stderr.write(`[Teams/Recap] No content scraped for "${chatName}"\n`);
      return null;
    }

    process.stderr.write(
      `[Teams/Recap] "${chatName}": transcript=${transcriptText.length}ch, notes=${notes.length}ch, attendees=${attendees.length}\n`
    );

    // --- Claude analysis ---
    const analysis = await this.analyzeMeeting(title, fullContent);

    const sourceId = `${chatName}|${date.toISOString()}`;

    return {
      sourceId,
      chatName,
      title,
      date,
      attendees,
      transcriptText,
      notes: [notes, aiNotes].filter(Boolean).join('\n\n'),
      topics: analysis.topics,
      summary: analysis.summary,
      decisions: analysis.decisions,
      actionItems: analysis.actionItems,
    };
  }

  // ---------------------------------------------------------------------------
  // Attendees — click Speakers pill, read list from left panel
  // ---------------------------------------------------------------------------

  private async scrapeAttendees(page: Page): Promise<string[]> {
    const pill = await page.$(SEL.speakersPill);
    if (pill) {
      await pill.click();
      await page.waitForTimeout(1000);
    }

    const attendees: string[] = [];
    const leftPanel = await page.$(SEL.leftPanel);
    if (!leftPanel) return attendees;

    // Speaker names appear as text in the left panel after clicking Speakers
    const items = await leftPanel.$$('[role="listitem"], [role="option"], button, span[title]');
    for (const item of items) {
      const name = (
        await item.getAttribute('title') ??
        await item.getAttribute('aria-label') ??
        await item.textContent() ??
        ''
      ).trim();
      if (name && name.length > 1 && name.length < 80 && !attendees.includes(name)) {
        attendees.push(name);
      }
    }

    // Fallback: APC items in the left panel (Teams puts speaker list there)
    if (attendees.length === 0) {
      const apcItems = await leftPanel.$$(SEL.apcItem);
      for (const item of apcItems) {
        const name = (await item.textContent() ?? '').trim();
        if (name && name.length > 1 && name.length < 80 && !attendees.includes(name)) {
          attendees.push(name);
        }
      }
    }

    return attendees;
  }

  // ---------------------------------------------------------------------------
  // Transcript — click Transcript pill, dump main panel text
  // ---------------------------------------------------------------------------

  private async scrapeTranscript(page: Page): Promise<string> {
    const pill = await page.$(SEL.transcriptPill);
    if (!pill) return '';

    await pill.click();
    await page.waitForTimeout(2000);

    const mainPanel = await page.$(SEL.mainPanel);
    if (!mainPanel) return '';

    // Full text dump of the main panel — contains speaker: utterance lines
    const text = (await mainPanel.textContent() ?? '').trim();

    // Clean up: remove repeated whitespace, normalise newlines
    return text.replace(/\s{3,}/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------------------------------------------------------------------------
  // Notes — click Notes pill, read main panel
  // ---------------------------------------------------------------------------

  private async scrapeNotes(page: Page): Promise<string> {
    const pill = await page.$(SEL.notesPill);
    if (!pill) return '';

    await pill.click();
    await page.waitForTimeout(1000);

    const mainPanel = await page.$(SEL.mainPanel);
    if (!mainPanel) return '';

    return (await mainPanel.textContent() ?? '').trim();
  }

  // ---------------------------------------------------------------------------
  // AI Notes — click AINotes pill, read APC items
  // ---------------------------------------------------------------------------

  private async scrapeAINotes(page: Page): Promise<string> {
    const pill = await page.$(SEL.aiNotesPill);
    if (!pill) return '';

    await pill.click();
    await page.waitForTimeout(1500);

    // Try the AI insights wrapper first, then APC body, then main panel
    for (const sel of [SEL.aiInsights, SEL.apcBody, SEL.mainPanel]) {
      const el = await page.$(sel);
      if (el) {
        const text = (await el.textContent() ?? '').trim();
        if (text.length > 20) return text;
      }
    }

    return '';
  }

  // ---------------------------------------------------------------------------
  // Claude analysis
  // ---------------------------------------------------------------------------

  private async analyzeMeeting(title: string, content: string): Promise<{
    topics: string[];
    summary: string;
    decisions: string[];
    actionItems: string[];
  }> {
    if (!this.anthropic || !content.trim()) {
      return { topics: [], summary: '', decisions: [], actionItems: [] };
    }

    try {
      const systemPrompt = 'You are an expert at analyzing meeting transcripts and extracting structured information.';
      const cachedSystem: PromptCachingBetaTextBlockParam[] = [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ];

      const truncated = content.length > 8000
        ? content.slice(0, 8000) + '\n...[truncated]'
        : content;

      const meetingParams = this.db
        ? bucketCallParams(this.db, 'fetch', 1024)
        : { model: 'claude-haiku-4-5-20251001' as const, max_tokens: 1024 };
      const response = await this.anthropic.beta.promptCaching.messages.create({
        ...meetingParams,
        system: cachedSystem,
        tools: [{
          name: 'analyze_meeting',
          description: 'Extract structured data from a meeting transcript',
          input_schema: {
            type: 'object' as const,
            properties: {
              summary:     { type: 'string', description: '2-3 sentence summary of the meeting' },
              topics:      { type: 'array', items: { type: 'string' }, description: 'Main topics discussed' },
              decisions:   { type: 'array', items: { type: 'string' }, description: 'Decisions made' },
              actionItems: { type: 'array', items: { type: 'string' }, description: 'Action items with owner if known' },
            },
            required: ['summary', 'topics', 'decisions', 'actionItems'],
          },
        }],
        tool_choice: { type: 'tool', name: 'analyze_meeting' },
        messages: [{ role: 'user', content: `Analyze this meeting titled "${title}":\n\n${truncated}` }],
      });

      const toolUse = response.content.find((b) => b.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        return { topics: [], summary: '', decisions: [], actionItems: [] };
      }

      const input = toolUse.input as {
        summary: string; topics: string[]; decisions: string[]; actionItems: string[];
      };

      return {
        summary:     input.summary     ?? '',
        topics:      input.topics      ?? [],
        decisions:   input.decisions   ?? [],
        actionItems: input.actionItems ?? [],
      };
    } catch (err) {
      process.stderr.write(
        `[Teams/Recap] Claude analysis failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return { topics: [], summary: '', decisions: [], actionItems: [] };
    }
  }
}
