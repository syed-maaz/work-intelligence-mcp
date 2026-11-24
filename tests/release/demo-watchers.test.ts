import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '3') }));
vi.mock('node:fs', () => ({ watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })) }));
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { OutlookWatcher, getTeamsBadgeCount } from '../../src/fetcher/sources/outlook-watcher.js';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('demo bridge watchers never read Outlook or inspect the running Teams application', () => {
  vi.stubEnv('WI_DEMO_MODE', '1');
  const watcher = new OutlookWatcher(vi.fn());
  try {
    expect(watcher.start()).toBe(false);
    expect(getTeamsBadgeCount()).toBe(-1);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  } finally { watcher.stop(); }
});
