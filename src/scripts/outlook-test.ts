#!/usr/bin/env node

/**
 * Manual test script for OutlookBrowserConnector (EP-3).
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm src/scripts/outlook-test.ts
 *
 * Optional env overrides:
 *   OUTLOOK_FOLDER     folder slug (default: inbox)
 *   OUTLOOK_SINCE_DAYS how many days back to look  (default: 1)
 *   OUTLOOK_SUBJECT    subject filter substring     (default: none)
 *   BROWSER_HEADLESS   set to 'false' to watch the browser (default: true)
 */

import { getBrowserSession } from '../fetcher/sources/browser-session.js';
import { OutlookBrowserConnector } from '../fetcher/sources/outlook-browser.js';

const FOLDER = process.env.OUTLOOK_FOLDER ?? 'inbox';
const SINCE_DAYS = Number.parseInt(process.env.OUTLOOK_SINCE_DAYS ?? '1', 10);
const SUBJECT_FILTER = process.env.OUTLOOK_SUBJECT;

async function main(): Promise<void> {
  const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);

  process.stderr.write(
    `[outlook-test] folder=${FOLDER} since=${since.toISOString()}` +
    (SUBJECT_FILTER ? ` subjectFilter="${SUBJECT_FILTER}"` : '') +
    '\n'
  );

  const session = getBrowserSession();
  const connector = new OutlookBrowserConnector(session);

  try {
    const messages = await connector.fetchMessages(
      { folder: FOLDER, subjectFilter: SUBJECT_FILTER },
      since
    );

    process.stderr.write(`[outlook-test] Fetched ${messages.length} message(s)\n`);

    if (messages.length === 0) {
      process.stdout.write('(no messages found in the specified time window)\n');
      return;
    }

    for (const msg of messages) {
      process.stdout.write('---\n');
      process.stdout.write(`id:      ${msg.id}\n`);
      process.stdout.write(`from:    ${msg.sender.name}${msg.sender.email ? ` <${msg.sender.email}>` : ''}\n`);
      process.stdout.write(`subject: ${msg.subject}\n`);
      process.stdout.write(`date:    ${msg.createdAt.toISOString()}\n`);
      if (msg.recipients && msg.recipients.length > 0) {
        const toLine = msg.recipients.map((r) => r.email ? `${r.name} <${r.email}>` : r.name).join(', ');
        process.stdout.write(`to:      ${toLine}\n`);
      }
      const preview = msg.content.slice(0, 300).replace(/\n+/g, ' ');
      process.stdout.write(`body:    ${preview}${msg.content.length > 300 ? '…' : ''}\n`);
    }
    process.stdout.write('---\n');
  } finally {
    await session.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[outlook-test] FAILED:', error);
  process.exit(1);
});
