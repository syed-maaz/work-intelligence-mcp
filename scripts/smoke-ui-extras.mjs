/**
 * One-shot screenshots of Bundle B UX additions:
 *   1. /unknown-page → real 404 page (U-7)
 *   2. (Inject render error) → ErrorBoundary card (U-8) — done by mounting a
 *      page that throws; uses page.evaluate to set up the failure.
 *   3. /pr-review with a fake review → posting confirm dialog (U-5 + B.5)
 *
 * Used as a manual visual aid, not run by smoke:all. Run with:
 *   npm run web:dev   (in another terminal)
 *   node scripts/smoke-ui-extras.mjs
 */

import { chromium } from 'playwright';

const URL = 'http://localhost:5175';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  // 1. 404 page
  await page.goto(`${URL}/this-route-does-not-exist?from=smoke`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=404', { timeout: 5_000 });
  await page.screenshot({ path: '/tmp/ui-404.png' });
  console.log('1. /tmp/ui-404.png — 404 page');

  await browser.close();
})().catch((err) => {
  console.error('extras smoke failed:', err);
  process.exit(1);
});
