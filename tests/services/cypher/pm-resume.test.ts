import Database from 'better-sqlite3';
import { pmResume, readUnresolvedEvents, resolveEvent } from '../../../src/services/cypher/pm-resume.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal schema for sub_task_events
  db.exec(`
    CREATE TABLE sub_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sub_task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT
    );
  `);
  return db as unknown as Database.Database;
}

describe('pmResume()', () => {
  it('resolves ack decisions and leaves escalations open', () => {
    const db = makeDb();
    const sid = 'smk-subtask';
    db.prepare(`INSERT INTO sub_task_events(sub_task_id, kind, payload_json) VALUES (?, ?, ?)`) 
      .run(sid, 'question', '{"q":"?"}');
    db.prepare(`INSERT INTO sub_task_events(sub_task_id, kind, payload_json) VALUES (?, ?, ?)`) 
      .run(sid, 'blocker', '{"b":"!"}');

    const decide = (kind: string) => kind === 'question' ? { action: 'ack' as const } : { action: 'escalate' as const };
    const res = pmResume(db as any, sid, decide);

    expect(res.resolved).toBe(1);
    expect(res.escalated).toBe(1);
    const open = readUnresolvedEvents(db as any, sid);
    expect(open.length).toBe(1);
    expect(open[0]?.kind).toBe('blocker');
  });
});
