// Runtime imports happen only inside the isolated child process.
if (process.env.WI_DEMO_MODE !== '1' || !process.env.WI_DEMO_DATABASE_ID) throw new Error('use a demo launcher');
const { getDatabase, closeDatabase } = await import('../src/db/connection.js');
const { seedDemo } = await import('./demo-data.mjs');
const db = getDatabase({path:process.env.DATABASE_PATH});
try {
  seedDemo(db);
  const action = process.argv[2];
  if (action === 'seed') {
    console.log('[demo] seeded 5 fictional messages; no connectors or model calls.');
  } else if (action === 'recall') {
    const { runDemoRecall } = await import('./demo-recall-worker.mjs');
    await runDemoRecall();
  } else if (action === 'trace' || action === 'eval') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('[demo] SKIPPED: provide a model key in the process environment for a real paid run; published evidence unchanged.');
    } else {
      const module = await import(action === 'trace' ? './demo-trace-worker.mjs' : './demo-eval-worker.mjs');
      await (action === 'trace' ? module.runDemoTrace() : module.runDemoEval());
    }
  } else throw new Error('unknown demo action');
} catch {
  console.error('[demo] isolated run failed; diagnostic payload withheld');
  process.exitCode=1;
} finally { closeDatabase(); }
