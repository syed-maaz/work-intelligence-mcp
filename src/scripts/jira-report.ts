#!/usr/bin/env node

/**
 * CLI script: npm run report
 *
 * Scrapes the configured Jira board and prints a markdown report to stdout.
 * Stats (issue count, timing) go to stderr so the markdown can be piped.
 *
 * Usage:
 *   npm run report                         # recent DEMO issues
 *   JIRA_MODE=sprint npm run report        # active sprint issues
 *   JIRA_MODE=mine npm run report          # issues assigned to you
 *   npm run report > report.md             # save to file
 *
 * Environment variables (all optional — defaults shown):
 *   JIRA_MODE           'recent' | 'sprint' | 'mine' (default: recent)
 *   JIRA_BOARD_URL      Full board URL (default: DEMO RapidBoard)
 *   JIRA_PROJECT_KEY    Project key (default: DEMO)
 *   JIRA_DOMAIN         Jira hostname (default: jira.example.com)
 *   JIRA_SINCE_DAYS     How many days back to look for 'recent' mode (default: 2)
 *   ANTHROPIC_API_KEY   Claude API key (if omitted, AI analysis section is skipped)
 *   ANTHROPIC_BASE_URL  Proxy base URL (e.g. http://localhost:8080/anthropic)
 */

import { getDatabase, closeDatabase } from '../db/connection.js';
import { getBrowserSession } from '../fetcher/sources/browser-session.js';
import { getJiraReport } from '../tools/jira-report.js';

const MODE = (process.env.JIRA_MODE ?? 'recent') as 'recent' | 'sprint' | 'mine';
const BOARD_URL =
  process.env.JIRA_BOARD_URL ??
  'https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=DEMO';
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY ?? 'DEMO';
const JIRA_DOMAIN = process.env.JIRA_DOMAIN ?? 'jira.example.com';
const SINCE_DAYS = Number.parseInt(process.env.JIRA_SINCE_DAYS ?? '2', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function buildBoardUrl(): { url: string; topicName: string } {
  const base = `https://${JIRA_DOMAIN}`;
  switch (MODE) {
    case 'sprint': {
      const jql = encodeURIComponent(
        `project = ${PROJECT_KEY} AND sprint in openSprints() ORDER BY updated DESC`
      );
      return {
        url: `${base}/issues/?jql=${jql}`,
        topicName: `${PROJECT_KEY}-sprint`,
      };
    }
    case 'mine': {
      const jql = encodeURIComponent(
        `assignee = ${process.env.JIRA_MY_USERNAME ? `"${process.env.JIRA_MY_USERNAME}"` : 'currentUser()'} AND project = ${PROJECT_KEY} AND statusCategory != Done ORDER BY updated DESC`
      );
      return {
        url: `${base}/issues/?jql=${jql}`,
        topicName: `${PROJECT_KEY}-mine`,
      };
    }
    default: {
      // 'recent' — use the board URL with server-side date filter
      return { url: BOARD_URL, topicName: PROJECT_KEY };
    }
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  const { url, topicName } = buildBoardUrl();
  process.stderr.write(`Fetching Jira report [mode=${MODE}] for ${PROJECT_KEY}...\n`);

  const db = getDatabase();
  const session = getBrowserSession();

  try {
    const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const result = await getJiraReport(
      db,
      {
        projectKey: PROJECT_KEY,
        boardUrl: url,
        since: MODE === 'recent' ? since : undefined,
        topicName,
      },
      session,
      ANTHROPIC_API_KEY
    );

    process.stdout.write(result.markdown + '\n');
    process.stderr.write(
      `Done in ${((Date.now() - start) / 1000).toFixed(1)}s | Issues: ${result.issueCount}\n`
    );
  } finally {
    await session.close().catch(() => undefined);
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Report generation failed:', error);
  process.exit(1);
});
