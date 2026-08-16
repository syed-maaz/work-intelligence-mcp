/**
 * ADR-044 AC-U6 — pool-slot-leak invariant (browser-session coarse cancellation).
 *
 * Proves the binding invariant from ADR-044 § Cancellation & cleanup (re-audit
 * #8): after a source times out and the orchestrator's release() path runs
 * (session.releaseBySource(source)), the pool's free-slot count returns to its
 * pre-fetch value — the tagged page is force-closed and its slot freed, NOT
 * leaked. A Promise.race-only orchestrator would fail this.
 *
 * Playwright's chromium is mocked so the test is deterministic and needs no
 * real browser / BROWSER_PROFILE_PATH. The mocked context yields fake pages
 * whose close() we observe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock playwright BEFORE importing the module under test.
const closedPages = new Set<object>();
function makeFakePage() {
  const page: Record<string, unknown> = {
    _closed: false,
    setDefaultNavigationTimeout: () => {},
    setDefaultTimeout: () => {},
    goto: async () => ({ ok: () => true, status: () => 200 }),
    url: () => 'https://outlook.office.com/mail/inbox',
    isClosed() { return (this as { _closed: boolean })._closed; },
    async close() { (this as { _closed: boolean })._closed = true; closedPages.add(this as object); },
    $: async () => null,
  };
  return page;
}

vi.mock('playwright', () => {
  return {
    chromium: {
      launchPersistentContext: async () => ({
        newPage: async () => makeFakePage(),
        browser: () => ({ isConnected: () => true }),
        close: async () => {},
      }),
    },
    // Type-only re-exports referenced by the module; runtime values unused.
    BrowserContext: class {},
    Page: class {},
  };
});

// fs lstat for the SingletonLock check — force the "no lock" branch.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, lstatSync: () => { throw new Error('ENOENT'); } };
});

import { BrowserSessionManager } from '../../src/fetcher/sources/browser-session.js';

let mgr: BrowserSessionManager;
beforeEach(() => {
  closedPages.clear();
  mgr = new BrowserSessionManager({ profilePath: '/tmp/fake-profile', headless: true, maxSlots: 2 });
});

describe('BrowserSessionManager — releaseBySource frees slots (AC-U6)', () => {
  it('freeSlotCount returns to its pre-fetch value after a tagged source is released', async () => {
    const before = mgr.freeSlotCount();
    expect(before).toBe(2); // 0 created + 2 uncreated

    // Acquire a slot and tag it 'email' — simulates OutlookBrowserConnector.
    const page = await mgr.getPage('https://outlook.office.com/mail/inbox');
    mgr.tagPageSource(page, 'email');
    expect(mgr.freeSlotCount()).toBe(1); // one slot busy

    // Timeout path: orchestrator calls releaseBySource('email').
    const freed = await mgr.releaseBySource('email');
    expect(freed).toBe(1);
    expect(closedPages.has(page)).toBe(true);      // page force-closed
    expect(mgr.freeSlotCount()).toBe(before);       // INVARIANT: slot count restored
  });

  it('releaseBySource only frees slots matching the tag, leaves others busy', async () => {
    const p1 = await mgr.getPage('https://outlook.office.com/mail/inbox');
    mgr.tagPageSource(p1, 'email');
    const p2 = await mgr.getPage('https://jira.example.com/x');
    mgr.tagPageSource(p2, 'jira');
    expect(mgr.freeSlotCount()).toBe(0); // both slots busy (maxSlots=2)

    const freed = await mgr.releaseBySource('email');
    expect(freed).toBe(1);
    expect(closedPages.has(p1)).toBe(true);
    expect(closedPages.has(p2)).toBe(false); // jira slot untouched
    expect(mgr.freeSlotCount()).toBe(1);     // only the email slot came back
  });

  it('releaseBySource is a no-op (0 freed) when no slot carries the tag', async () => {
    const p = await mgr.getPage('https://x');
    mgr.tagPageSource(p, 'teams');
    const freed = await mgr.releaseBySource('email');
    expect(freed).toBe(0);
    expect(closedPages.has(p)).toBe(false);
  });
});
