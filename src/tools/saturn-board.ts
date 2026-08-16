/**
 * Board Tool (EP-20)
 *
 * Fetches sprint board Jira issues via JiraBrowserConnector and maps
 * them to a flat issue shape for the web UI dashboard section.
 */

import {
  createJiraDataSource,
} from '../fetcher/sources/jira-adapter.js';
import type { BrowserSessionManager } from '../fetcher/sources/browser-session.js';
import { getWiConfig } from '../services/wi-config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BoardIssue {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  epicKey: string | null;
  epicName: string | null;
  issueType: string | null;
  labels: string[];
  updatedAt: string;   // ISO datetime
  url: string;
}

/** @deprecated Use BoardIssue instead */
export type SaturnIssue = BoardIssue;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

const BOARD_URL = process.env.BOARD_URL
  ?? process.env.SATURN_BOARD_URL  // legacy env name
  ?? (() => { try { const cfg = getWiConfig(); const u = cfg.connectors.jira.boardUrl; return u || ''; } catch { return ''; } })()
  ?? 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=DEMO';

const JIRA_BASE = (() => {
  try { const cfg = getWiConfig(); return cfg.connectors.jira.browser.baseUrl || 'https://jira.example.com'; }
  catch { return 'https://jira.example.com'; }
})();

export async function getBoardIssues(
  session: BrowserSessionManager
): Promise<BoardIssue[]> {
  const connector = createJiraDataSource(session);
  const messages = await connector.fetchMessages({ boardUrl: BOARD_URL });

  return messages
    .filter((m) => m.metadata?.jira)
    .map((m) => {
      const jira = m.metadata!.jira!;
      const key: string = (jira.issueKey as string) ?? m.id;
      return {
        key,
        title: (m.subject ?? m.content.slice(0, 80)).replace(/^\[[\w-]+\]\s*/, ''),
        status: (jira.status as string) ?? 'Unknown',
        assignee: (jira.assignee as { name: string } | undefined)?.name ?? null,
        priority: (jira.priority as string) ?? null,
        epicKey: (jira.epicKey as string | undefined) ?? null,
        epicName: (jira.epicName as string | undefined) ?? null,
        issueType: (jira.issueType as string | undefined) ?? null,
        labels: Array.isArray(jira.labels) ? (jira.labels as string[]) : [],
        updatedAt: (m.modifiedAt ?? m.createdAt).toISOString(),
        url: `${JIRA_BASE}/browse/${key}`,
      };
    });
}

/** @deprecated Use getBoardIssues instead */
export const getSaturnIssues = getBoardIssues;
