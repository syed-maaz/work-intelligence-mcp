export const CORPUS = [
  ['teams', 'PROJ-101 widget rollout on acme/widgets — v2 shipped to 40% of users', 'alex'],
  ['jira', 'PROJ-102 acme/widgets flaky e2e after rollout — flake rate 12%', 'bri'],
  ['email', 'rollback plan for acme/widgets v2 drafted; window Sunday 02:00 UTC', 'cara'],
  ['jira', 'widget dashboard migration tracked in PROJ-103; acme/widgets owners cc-ed', 'alex'],
  ['teams', 'postmortem: PROJ-101 rollout — root cause was cache invalidation, not the widget code', 'bri'],
];
export function seedDemo(db) {
  const id = process.env.WI_DEMO_DATABASE_ID;
  if (!id || process.env.WI_DEMO_MODE !== '1') throw new Error('demo requires the isolated launcher');
  const marked = db.prepare("SELECT name FROM sqlite_master WHERE name='wi_demo_identity'").get();
  if (marked && db.prepare('SELECT id FROM wi_demo_identity').get()?.id !== id) throw new Error('demo database identity mismatch');
  if (!marked) {
    if (db.prepare('SELECT COUNT(*) AS n FROM messages').get().n || db.prepare('SELECT COUNT(*) AS n FROM topics').get().n) throw new Error('demo database contains unknown data');
    db.exec('CREATE TABLE wi_demo_identity (id TEXT NOT NULL)');
    db.prepare('INSERT INTO wi_demo_identity VALUES (?)').run(id);
  }
  db.prepare("INSERT OR IGNORE INTO topics(name) VALUES ('demo-topic')").run();
  const topic = db.prepare("SELECT id FROM topics WHERE name='demo-topic'").get().id;
  const insert = db.prepare('INSERT OR IGNORE INTO messages(topic_id,source,source_id,content,author) VALUES (?,?,?,?,?)');
  db.transaction(() => CORPUS.forEach(([source,content,author],i) => insert.run(topic,source,'wi-fictional-'+i,content,author)))();
}
