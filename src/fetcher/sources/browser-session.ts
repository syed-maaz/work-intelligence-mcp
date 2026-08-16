/**
 * Browser Session Manager
 *
 * Provides a shared Playwright browser instance reused by all browser-based
 * connectors (Teams, Outlook, Jira). Handles launch with existing Chrome profile
 * so SSO cookies are preserved without requiring re-login.
 *
 * EP-14-5: Supports a configurable slot pool (default 2 slots) so Teams and
 * Jira scraping can run concurrently. Slots are created lazily and released via
 * try/finally to prevent leaks.
 */

import { chromium, BrowserContext, Page } from 'playwright';
import { ConnectorError, ConnectorErrorType } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BrowserSessionConfig {
  /** Path to the Chrome/Chromium user profile directory */
  profilePath: string;
  /** Run browser in headless mode */
  headless: boolean;
  /** Optional path to Chrome executable */
  executablePath?: string;
  /** Navigation timeout in ms (default: 30000) */
  navigationTimeout?: number;
  /** Maximum number of concurrent browser slots (default: 2) */
  maxSlots?: number;
}

/**
 * Loads browser config from environment variables, falling back to defaults.
 */
export function loadBrowserConfigFromEnv(): BrowserSessionConfig {
  const profilePath = process.env.BROWSER_PROFILE_PATH;
  if (!profilePath) {
    throw new Error(
      'BROWSER_PROFILE_PATH env var is required. ' +
      'Find your Chrome profile path at chrome://version → "Profile Path".'
    );
  }

  return {
    profilePath,
    headless: process.env.BROWSER_HEADLESS !== 'false',
    executablePath: process.env.BROWSER_EXECUTABLE,
    navigationTimeout: 30_000,
    maxSlots: Number(process.env.BROWSER_MAX_SLOTS) || 2,
  };
}

// ---------------------------------------------------------------------------
// Pool slot
// ---------------------------------------------------------------------------

interface PoolSlot {
  context: BrowserContext;
  tempProfileDir: string | null;
  busy: boolean;
  /**
   * ADR-044 coarse cancellation (option 3): the fetch source currently holding
   * this slot, set via tagPageSource(). releaseBySource() force-frees all slots
   * carrying a given tag so a timed-out scrape's slot cannot leak.
   */
  source?: string;
  /** The page currently open on this slot — force-closed by releaseBySource(). */
  page?: Page;
}

// ---------------------------------------------------------------------------
// BrowserSessionManager (pool-aware)
// ---------------------------------------------------------------------------

/**
 * Manages a pool of Playwright browser slots shared across all connectors.
 * Slots are created lazily (first request creates the browser) and released
 * after each use via releasePage(). Concurrent callers queue when all slots
 * are busy and receive a page as soon as one becomes free.
 */
export class BrowserSessionManager {
  private config: BrowserSessionConfig;
  private slots: PoolSlot[] = [];
  private maxSlots: number;
  /** Resolve functions for callers waiting for a free slot */
  private waitQueue: Array<() => void> = [];

  constructor(config: BrowserSessionConfig) {
    this.config = config;
    this.maxSlots = config.maxSlots ?? 2;
  }

  /**
   * Returns a Playwright Page navigated to the given URL.
   * Acquires a pool slot (waits if all are busy). Always call releasePage()
   * in a finally block after you're done with the page.
   *
   * @throws ConnectorError(Network) on navigation timeout or net errors
   * @throws ConnectorError(Authentication) if URL redirects to a login page
   */
  async getPage(url: string): Promise<Page> {
    const slot = await this.acquireSlot();

    const timeout = this.config.navigationTimeout ?? 30_000;
    let page: Page;

    try {
      page = await slot.context.newPage();
      page.setDefaultNavigationTimeout(timeout);
      page.setDefaultTimeout(timeout);

      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });

      const finalUrl = page.url();
      if (this.isLoginRedirect(finalUrl, url)) {
        await page.close();
        this.freeSlot(slot);
        throw new ConnectorError(
          `Redirected to login page when navigating to ${url}. SSO session may have expired.`,
          ConnectorErrorType.Authentication
        );
      }

      if (response && !response.ok() && response.status() !== 304) {
        const status = response.status();
        await page.close();
        this.freeSlot(slot);
        throw new ConnectorError(
          `Navigation to ${url} returned HTTP ${status}`,
          status >= 500 ? ConnectorErrorType.Network : ConnectorErrorType.Authentication
        );
      }

      // Attach slot reference to page so releasePage() can free it
      (page as Page & { _poolSlot?: PoolSlot })._poolSlot = slot;
      return page;
    } catch (error) {
      // If we haven't already freed the slot, do it now
      if (slot.busy) {
        this.freeSlot(slot);
      }

      if (error instanceof ConnectorError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('Timeout') || message.includes('timeout')) {
        throw new ConnectorError(
          `Navigation to ${url} timed out after ${timeout}ms`,
          ConnectorErrorType.Network,
          undefined,
          error instanceof Error ? error : undefined
        );
      }

      if (message.includes('net::ERR') || message.includes('NS_ERROR')) {
        throw new ConnectorError(
          `Network error navigating to ${url}: ${message}`,
          ConnectorErrorType.Network,
          undefined,
          error instanceof Error ? error : undefined
        );
      }

      throw new ConnectorError(
        `Failed to navigate to ${url}: ${message}`,
        ConnectorErrorType.Unknown,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Returns the page's slot back to the pool. Call this in a finally block.
   * If the page is already closed that's fine — we still release the slot.
   */
  async releasePage(page: Page): Promise<void> {
    const typed = page as Page & { _poolSlot?: PoolSlot };
    const slot = typed._poolSlot;

    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } catch {
      // best-effort
    }

    if (slot) {
      this.freeSlot(slot);
    }
  }

  /**
   * ADR-044 coarse cancellation (§ Cancellation option 3). Tag the page's slot
   * with its fetch source so a later releaseBySource() can force-free it on
   * timeout. Call this right after getPage() in a fetch that needs a bounded
   * cancel path. No-op if the page has no pool slot.
   */
  tagPageSource(page: Page, source: string): void {
    const slot = (page as Page & { _poolSlot?: PoolSlot })._poolSlot;
    if (slot) {
      slot.source = source;
      slot.page = page;
    }
  }

  /**
   * ADR-044 coarse cancellation. Force-close every page tagged with `source`
   * and free its slot — the release() path the orchestrator awaits after a
   * per-source timeout so the pool slot is FREED, not leaked (re-audit #8).
   * Best-effort and bounded: a page.close() that hangs cannot wedge the pool
   * because it races a short deadline. Returns the number of slots freed.
   */
  async releaseBySource(source: string): Promise<number> {
    const matching = this.slots.filter((s) => s.busy && s.source === source);
    let freed = 0;
    for (const slot of matching) {
      const page = slot.page;
      if (page) {
        try {
          await Promise.race([
            page.isClosed() ? Promise.resolve() : page.close(),
            new Promise<void>((r) => setTimeout(r, 3_000)),
          ]);
        } catch {
          // best-effort: even a failed close must still free the slot below
        }
      }
      slot.source = undefined;
      slot.page = undefined;
      this.freeSlot(slot);
      freed++;
    }
    return freed;
  }

  /**
   * ADR-044 AC-U6 invariant probe. The number of slots currently available to
   * a getPage() caller without queuing: free existing slots plus slots not yet
   * created (up to maxSlots). After any source times out and releaseBySource()
   * runs, this MUST return to its pre-fetch value. Read-only.
   */
  freeSlotCount(): number {
    const freeExisting = this.slots.filter((s) => !s.busy).length;
    const uncreated = this.maxSlots - this.slots.length;
    return freeExisting + uncreated;
  }

  /**
   * Closes all browser slots and releases resources.
   */
  async close(): Promise<void> {
    for (const slot of this.slots) {
      try {
        await slot.context.close();
      } catch {
        // best-effort
      }
      if (slot.tempProfileDir) {
        try {
          fs.rmSync(slot.tempProfileDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
    this.slots = [];
  }

  /**
   * Whether at least one slot is alive and connected.
   */
  get isRunning(): boolean {
    return this.slots.some(s => s.context.browser()?.isConnected() === true);
  }

  // ---------------------------------------------------------------------------
  // Pool internals
  // ---------------------------------------------------------------------------

  private async acquireSlot(): Promise<PoolSlot> {
    // 1. Find a free existing slot
    const free = this.slots.find(s => !s.busy);
    if (free) {
      free.busy = true;
      return free;
    }

    // 2. Create a new slot if under the cap
    if (this.slots.length < this.maxSlots) {
      const slot = await this.createSlot();
      slot.busy = true;
      this.slots.push(slot);
      return slot;
    }

    // 3. Queue — wait until a slot is released
    return new Promise<PoolSlot>((resolve) => {
      this.waitQueue.push(() => {
        const released = this.slots.find(s => !s.busy);
        if (released) {
          released.busy = true;
          resolve(released);
        }
      });
    });
  }

  private freeSlot(slot: PoolSlot): void {
    slot.busy = false;
    // Wake next waiter
    const next = this.waitQueue.shift();
    if (next) next();
  }

  private async createSlot(): Promise<PoolSlot> {
    const profilePath = this.resolveProfilePath();

    process.stderr.write(
      `[BrowserSession] Launching slot ${this.slots.length + 1}/${this.maxSlots}: headless=${this.config.headless}, profile=${profilePath}\n`
    );

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.config.headless,
      executablePath: this.config.executablePath,
      args: ['--disable-blink-features=AutomationControlled'],
    };

    const context = await chromium.launchPersistentContext(profilePath, launchOptions);

    return {
      context,
      tempProfileDir: this.tempProfileDir,
      busy: false,
    };
  }

  /** Transient store so createSlot() can hand the tmpDir reference to the slot */
  private tempProfileDir: string | null = null;

  private resolveProfilePath(): string {
    const source = this.config.profilePath;
    const lockFile = path.join(source, 'SingletonLock');

    const lockExists = (() => { try { fs.lstatSync(lockFile); return true; } catch { return false; } })();
    if (!lockExists) {
      this.tempProfileDir = null;
      return source;
    }

    process.stderr.write('[BrowserSession] Chrome is running (SingletonLock detected). Copying cookies to temp profile.\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wim-chrome-'));
    this.tempProfileDir = tmpDir;

    const filesToCopy = ['Cookies', 'Local State', 'Preferences'];
    for (const file of filesToCopy) {
      const src = path.join(source, file);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(tmpDir, file));
        } catch {
          // locked by Chrome — skip
        }
      }
    }

    return tmpDir;
  }

  private isLoginRedirect(finalUrl: string, intendedUrl: string): boolean {
    try {
      const final = new URL(finalUrl);
      const intended = new URL(intendedUrl);

      if (final.hostname === intended.hostname) {
        return false;
      }

      const loginPatterns = [
        'login', 'signin', 'auth', 'sso', 'microsoftonline',
        'okta', 'ping', 'onelogin', 'accounts.google',
      ];

      return loginPatterns.some(
        (pattern) =>
          final.hostname.includes(pattern) || final.pathname.includes(pattern)
      );
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let sessionInstance: BrowserSessionManager | null = null;

/**
 * Returns the shared BrowserSessionManager instance for this process.
 * Creates it on first call with the provided config; subsequent calls return
 * the same instance (config argument is ignored after first call).
 */
export function getBrowserSession(config?: BrowserSessionConfig): BrowserSessionManager {
  if (!sessionInstance) {
    const resolvedConfig = config ?? loadBrowserConfigFromEnv();
    sessionInstance = new BrowserSessionManager(resolvedConfig);
  }
  return sessionInstance;
}

/**
 * Replaces the singleton (useful for testing or re-initialisation).
 */
export function resetBrowserSession(): void {
  sessionInstance = null;
}
