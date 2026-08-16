/**
 * UI smoke: sidebar IA (U-1), linkify (U-10), chat-primary (U-6), setup/glossary/search UX,
 * Phase 78a-06: ModeChips + ConversationHeader + PersonaFooter (UI-01..04).
 *
 * Requires Vite on http://localhost:5175 (`npm run web:dev`).
 * First run: npx playwright install chromium
 */

import { chromium } from 'playwright';

const URL = 'http://localhost:5175';

const TEST_SESSION = {
  state: {
    sessions: [
      {
        id: 'smoke',
        title: 'linkify smoke',
        createdAt: Date.now(),
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: [
              'See **DEMO-1234** and DEMO-77.',
              'PR #4242 from @alice — https://jira.example.com/browse/DEMO-1234',
            ].join('\n'),
            ts: Date.now(),
            sources: [],
          },
        ],
      },
    ],
    activeSessionId: 'smoke',
    sessionId: 'smoke',
  },
  version: 0,
};

let passCount = 0;
let failCount = 0;
function pass(msg) { console.log(`  ✓ ${msg}`); passCount++; }
function fail(msg) { console.log(`  ✗ ${msg}`); failCount++; }
function section(title) { console.log(`\n── ${title} ──`); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  page.on('pageerror', (err) => process.stderr.write(`[page-error] ${err.message}\n`));

  // ── U-6: Chat is homepage ─────────────────────────────────────────────
  section('U-6 Chat primary');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const chatPlaceholder = page.locator('textarea[placeholder*="Ask"]');
  if (await chatPlaceholder.count()) {
    pass('Homepage renders full-page chat input');
  } else {
    fail('Homepage missing chat textarea');
  }
  const openAssistantToggle = page.locator('aside button[title="Open assistant"]');
  if ((await openAssistantToggle.count()) === 0) {
    pass('Sidebar chat toggle hidden on chat-primary route');
  } else {
    fail('Sidebar chat toggle should be hidden on /');
  }

  // ── U-1: Sidebar groups ─────────────────────────────────────────────────
  section('U-1 Sidebar IA');
  await page.waitForSelector('aside', { timeout: 10_000 });
  const groupLabels = await page.locator('aside').getByText(/^(Daily|Search|Work|System)$/i).allInnerTexts();
  const sidebarOk = ['Daily', 'Search', 'Work', 'System'].every((g) =>
    groupLabels.map((s) => s.toLowerCase()).includes(g.toLowerCase()),
  );
  if (sidebarOk) pass(`Sidebar groups: ${groupLabels.join(', ')}`);
  else fail(`Sidebar groups missing — found: ${groupLabels.join(', ')}`);

  const navItems = (await page.locator('aside nav a').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  for (const label of ['Chat', 'Dashboard', 'Setup', 'Glossary', 'Search All']) {
    if (navItems.some((n) => n.includes(label))) pass(`Nav includes ${label}`);
    else fail(`Nav missing ${label} — have: ${navItems.join(', ')}`);
  }

  // ── U-10: Linkify on chat-primary (no toggle needed) ────────────────────
  section('U-10 Linkify on chat homepage');
  await page.evaluate((session) => {
    localStorage.setItem('wi-chat-sessions', JSON.stringify(session));
  }, TEST_SESSION);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const linkAudit = await page.evaluate(() => {
    const result = { jiraKeyLinks: [], prLinks: [], mentions: [], urlLinks: [] };
    for (const a of document.querySelectorAll('a')) {
      const text = (a.textContent || '').trim();
      const href = a.getAttribute('href') || '';
      if (/^[A-Z][A-Z0-9_]+-\d+$/.test(text) && href.includes('/browse/')) {
        result.jiraKeyLinks.push({ text, href });
      } else if (/^#\d+$/.test(text) && href.startsWith('/pr-review')) {
        result.prLinks.push({ text, href });
      } else if (text.startsWith('http')) {
        result.urlLinks.push({ text, href });
      }
    }
    for (const s of document.querySelectorAll('span')) {
      const text = (s.textContent || '').trim();
      if (/^@[a-zA-Z][a-zA-Z0-9._-]+$/.test(text)) result.mentions.push(text);
    }
    return result;
  });

  if (linkAudit.jiraKeyLinks.length >= 1) pass(`Jira key links: ${linkAudit.jiraKeyLinks.length}`);
  else fail('No Jira key links in chat');
  if (linkAudit.prLinks.length >= 1) pass(`PR links: ${linkAudit.prLinks.length}`);
  else fail('No PR links in chat');
  if (linkAudit.mentions.length >= 1) pass(`@mentions: ${linkAudit.mentions.length}`);
  else fail('No @mentions in chat');
  if (linkAudit.urlLinks.length >= 1) pass(`URL links: ${linkAudit.urlLinks.length}`);
  else fail('No URL links in chat');

  // ── U-11 / U-19: New pages ──────────────────────────────────────────────
  section('U-11 Setup page');
  await page.goto(`${URL}/setup`, { waitUntil: 'domcontentloaded' });
  if (await page.getByRole('heading', { name: 'Setup' }).count()) pass('Setup page heading');
  else fail('Setup page missing heading');

  section('U-19 Glossary page');
  await page.goto(`${URL}/glossary`, { waitUntil: 'domcontentloaded' });
  if (await page.getByRole('heading', { name: 'Vocabulary' }).count()) pass('Glossary page heading');
  else fail('Glossary page missing heading');
  if (await page.getByText('Topic').count()) pass('Glossary lists Topic entry');

  section('U-6 Dashboard route');
  await page.goto(`${URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  const dashToggle = page.locator('aside button[title="Open assistant"]');
  if (await dashToggle.count()) pass('Dashboard shows sidebar chat toggle');
  else fail('Dashboard should show chat toggle');

  // ── U-15: Search sort toggle ─────────────────────────────────────────────
  section('U-15 Search sort toggle');
  await page.goto(`${URL}/search-all`, { waitUntil: 'domcontentloaded' });
  if (await page.getByRole('button', { name: 'Relevance' }).count()) pass('Search All has Relevance sort');
  else fail('Search All missing Relevance button');
  if (await page.getByRole('button', { name: 'Newest first' }).count()) pass('Search All has Newest first sort');
  else fail('Search All missing Newest first button');

  // ── U-12: macOS banner on system health ─────────────────────────────────
  section('U-12 macOS connector note');
  await page.goto(`${URL}/system-health`, { waitUntil: 'domcontentloaded' });
  if (await page.getByText(/macOS recommended/i).count()) pass('System Health shows macOS note');
  else fail('System Health missing macOS connector banner');

  // ── § 19: ADR-030 Phase A — /bugs page renders ──────────────────────────
  section('19 /bugs page (ADR-030 Phase A)');
  try {
    await page.goto(`${URL}/bugs`, { waitUntil: 'commit', timeout: 10000 });
    await page.waitForSelector('[data-test="bugs-page"]', { timeout: 15000 });
    pass('Bugs page renders');

    // Sidebar entry exists.
    if (await page.locator('a[href="/bugs"]').count()) pass('Sidebar /bugs entry visible');
    else fail('Sidebar missing /bugs entry');

    // Either the table or the empty-state is rendered.
    const hasTable = await page.locator('[data-test="bugs-table"]').count();
    const hasEmpty = await page.getByText(/No bugs captured/i).count();
    if (hasTable || hasEmpty) pass('Bugs page shows table or empty state');
    else fail('Bugs page missing table and empty state');

    // ADR-030 Phase B (Plan 75-05): if any row carries data-investigated="true",
    // clicking it should NOT show the "Not investigated yet" placeholder — the
    // detail panel must render the live investigation block instead.
    const investigatedRow = page.locator('tr[data-investigated="true"]').first();
    if (await investigatedRow.count()) {
      await investigatedRow.click();
      await page.waitForTimeout(300);
      const placeholder = await page.getByText(/Not investigated yet/i).count();
      if (placeholder === 0) pass('Investigated row hides placeholder (Phase B live render)');
      else fail('Investigated row still shows "Not investigated yet" placeholder');
    } else {
      pass('No investigated rows yet — Phase B live-render assertion skipped');
    }
  } catch (err) {
    fail(`Bugs page navigation/render failed: ${err.message}`);
  }

  // ── § 20: Phase 78a-06 — ModeChips + ConversationHeader + PersonaFooter (UI-01..04) ──
  section('20 Phase 78a — ModeChips / ConversationHeader / PersonaFooter');
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('wi-chat-sessions'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);

    // Case 1 — ModeChips render.
    const radiogroup = page.locator('[role="radiogroup"][aria-label="Chat mode"]');
    if (await radiogroup.count()) pass('ModeChips: radiogroup with aria-label="Chat mode" present');
    else fail('ModeChips: radiogroup missing');

    const chipCount = await page.locator('[role="radiogroup"][aria-label="Chat mode"] [role="radio"]').count();
    if (chipCount === 3) pass(`ModeChips: 3 chip buttons rendered`);
    else fail(`ModeChips: expected 3 chips, got ${chipCount}`);

    // Case 2 — Default chip is Auto.
    const checkedChip = page.locator('[role="radiogroup"][aria-label="Chat mode"] [role="radio"][aria-checked="true"]');
    const checkedText = (await checkedChip.first().innerText().catch(() => '')) || '';
    if (/auto/i.test(checkedText)) pass(`Default checked chip is Auto (text="${checkedText.trim()}")`);
    else fail(`Default chip should be Auto, got: "${checkedText.trim()}"`);

    // Case 3 — Chip click changes mode field on next chat POST.
    await page.evaluate(() => {
      const w = window;
      w.__wiChatPosts = [];
      const orig = w.fetch.bind(w);
      w.fetch = async (input, init) => {
        try {
          const url = typeof input === 'string' ? input : input.url;
          if (url && url.includes('/api/chat') && init && init.method === 'POST') {
            let body = init.body;
            if (typeof body === 'string') {
              try { body = JSON.parse(body); } catch {}
            }
            w.__wiChatPosts.push({ url, body });
          }
        } catch {}
        return new Response(JSON.stringify({
          reply: 'stub',
          detectedMode: 'work',
          modeSource: 'auto',
          modeSignals: ['slash:/wi-investigate', 'jira:DEMO-15702'],
          sources: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    });

    // Click the Work chip.
    const workChip = page.locator('[role="radiogroup"][aria-label="Chat mode"] [role="radio"]').filter({ hasText: /Work/i }).first();
    await workChip.click();
    await page.waitForTimeout(150);
    const workChecked = await workChip.getAttribute('aria-checked');
    if (workChecked === 'true') pass('Work chip becomes aria-checked after click');
    else fail(`Work chip aria-checked=${workChecked} after click`);

    // Type a message and submit.
    const textarea = page.locator('textarea[placeholder*="Ask"]').first();
    if (await textarea.count()) {
      await textarea.fill('/wi-investigate DEMO-15702');
      await textarea.press('Enter');
      // Wait for the captured POST.
      await page.waitForFunction(() => Array.isArray(window.__wiChatPosts) && window.__wiChatPosts.length > 0, null, { timeout: 5000 }).catch(() => {});
      const captured = await page.evaluate(() => window.__wiChatPosts || []);
      const lastBody = captured[captured.length - 1]?.body;
      if (lastBody && lastBody.mode === 'work') pass(`Chat POST body carries mode="work"`);
      else fail(`Chat POST body mode field expected "work", got: ${JSON.stringify(lastBody)}`);
    } else {
      fail('No chat textarea found to send a message');
    }

    // Case 4 — ConversationHeader subtitle reflects detection.
    const autoChip = page.locator('[role="radiogroup"][aria-label="Chat mode"] [role="radio"]').filter({ hasText: /Auto/i }).first();
    await autoChip.click();
    await page.waitForTimeout(150);
    if (await textarea.count()) {
      await textarea.fill('/wi-investigate DEMO-15702');
      await textarea.press('Enter');
      await page.waitForTimeout(800);
    }
    const subtitleVisible = await page.getByText(/Auto\s*→\s*Work/).count();
    if (subtitleVisible >= 1) pass('ConversationHeader subtitle shows "Auto → Work"');
    else fail('ConversationHeader subtitle "Auto → Work" not visible');

    await page.screenshot({ path: '/tmp/ui-mode-chips.png', fullPage: false }).catch(() => {});

    // Case 5 — PersonaFooter announces mode change for ~5s.
    const lifeChip = page.locator('[role="radiogroup"][aria-label="Chat mode"] [role="radio"]').filter({ hasText: /Life/i }).first();
    await lifeChip.click();
    await page.waitForTimeout(200);
    const footerVisibleNow = await page.getByText(/^Mode:\s/).count();
    if (footerVisibleNow >= 1) pass('PersonaFooter visible right after chip change');
    else fail('PersonaFooter did not appear after chip change');

    await page.screenshot({ path: '/tmp/ui-persona-footer.png', fullPage: false }).catch(() => {});

    await page.waitForTimeout(6200);
    const footerStillVisible = await page.getByText(/^Mode:\s/).count();
    if (footerStillVisible === 0) pass('PersonaFooter auto-dismisses after ~5s window');
    else fail('PersonaFooter still visible after ~6s — auto-dismiss broken');

    // Case 6 — chip selection persists across reload (localStorage; PLAN.md sessionStorage stale, chat.ts uses localStorage).
    await workChip.click();
    await page.waitForTimeout(150);
    const lsHasWork = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('wi-chat-sessions');
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        const sessions = parsed?.state?.sessions ?? [];
        const active = sessions.find((s) => s.id === parsed?.state?.activeSessionId);
        return active?.mode === 'work';
      } catch { return false; }
    });
    if (lsHasWork) pass('Chip mode persisted to localStorage (mode="work")');
    else fail('Chip mode NOT persisted to localStorage');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    const reloadedChecked = page.locator('[role="radiogroup"][aria-label="Chat mode"] [role="radio"][aria-checked="true"]');
    const reloadedText = (await reloadedChecked.first().innerText().catch(() => '')) || '';
    if (/work/i.test(reloadedText)) pass(`Chip restored to Work after reload (text="${reloadedText.trim()}")`);
    else fail(`Chip after reload should be Work, got: "${reloadedText.trim()}"`);

    // Case 7 — New conversation resets chip to Auto.
    const newChatButton = page.getByRole('button', { name: /^New chat$/i }).first();
    if (await newChatButton.count()) {
      await newChatButton.click();
      await page.waitForTimeout(300);
      const afterNewChecked = page.locator('[role="radiogroup"][aria-label="Chat mode"] [role="radio"][aria-checked="true"]');
      const afterNewText = (await afterNewChecked.first().innerText().catch(() => '')) || '';
      if (/auto/i.test(afterNewText)) pass(`New chat resets chip to Auto (text="${afterNewText.trim()}")`);
      else fail(`New chat should reset chip to Auto, got: "${afterNewText.trim()}"`);
    } else {
      fail('"New chat" button not found in session sidebar');
    }
  } catch (err) {
    fail(`Phase 78a UI block failed: ${err.message}`);
  }

  // ── Dream Gate (/dream) ──────────────────────────────────────────────────
  section('Dream Gate /dream');
  try {
    await page.goto(`${URL}/dream`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('text=Dream Gate', { timeout: 10_000 });
    pass('/dream renders the Dream Gate header');

    // Either pending proposal cards (with Approve/Reject) OR the empty state.
    const hasApprove = await page.getByRole('button', { name: /Approve/ }).count();
    const hasEmpty = await page.getByText(/No pending dream proposals/).count();
    if (hasApprove > 0 || hasEmpty > 0) {
      pass(`/dream shows ${hasApprove > 0 ? 'proposal cards with Approve/Reject' : 'empty state'}`);
    } else {
      fail('/dream shows neither proposal controls nor the empty state');
    }

    // Nav includes Dream in the System group.
    const navItems = (await page.locator('aside nav a').allInnerTexts()).map((s) => s.trim());
    if (navItems.some((n) => n.includes('Dream'))) pass('Sidebar nav includes Dream');
    else fail(`Sidebar nav missing Dream — have: ${navItems.join(', ')}`);
  } catch (err) {
    fail(`Dream Gate UI block failed: ${err.message}`);
  }

  await browser.close();

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`UI smoke: ${passCount} passed, ${failCount} failed`);
  console.log('═══════════════════════════════════════════════════');
  process.exit(failCount > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(2);
});
