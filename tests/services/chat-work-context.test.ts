import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  isWorkIntelligenceQuery,
  detectDataGaps,
  buildDataGapReply,
  fetchWorkContextForChat,
  shouldOfferSync,
} from '../../src/services/chat-work-context.js';

describe('isWorkIntelligenceQuery', () => {
  it('matches Teams summarise prompts', () => {
    expect(isWorkIntelligenceQuery("Summarise yesterday's Teams activity")).toBe(true);
  });

  it('does not match pure code questions', () => {
    expect(isWorkIntelligenceQuery('Where is the login handler in example-service?')).toBe(false);
  });
});

describe('shouldOfferSync', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        source TEXT,
        source_id TEXT,
        subject TEXT,
        content TEXT,
        author TEXT,
        timestamp TEXT
      );
    `);
  });

  it('offers sync when Teams data missing for yesterday', () => {
    const result = fetchWorkContextForChat(db, "Summarise yesterday's Teams activity");
    expect(shouldOfferSync(result, "Summarise yesterday's Teams activity")).toBe(true);
    expect(result.gaps.some((g) => g.source === 'teams')).toBe(true);
  });

  it('does not offer sync when messages exist', () => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const day = yesterday.toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO messages (source, source_id, subject, content, author, timestamp)
       VALUES ('teams', 't1', '[Teams] Standup', 'Ship it', 'Bob', ?)`,
    ).run(`${day}T09:00:00.000Z`);

    const result = fetchWorkContextForChat(db, "Summarise yesterday's Teams activity");
    expect(shouldOfferSync(result, "Summarise yesterday's Teams activity")).toBe(false);
    expect(result.items.length).toBeGreaterThan(0);
  });
});

describe('buildDataGapReply', () => {
  it('mentions sync and browser when unconfigured', () => {
    const { gaps } = detectDataGaps(new Database(':memory:'), "Summarise yesterday's Teams activity");
    const reply = buildDataGapReply(gaps, {
      syncRunning: false,
      browserConfigured: false,
      lastSyncAt: null,
      teamsMessageCount: 0,
    });
    expect(reply).toContain('Run sync');
    expect(reply).toContain('BROWSER_PROFILE_PATH');
  });
});
