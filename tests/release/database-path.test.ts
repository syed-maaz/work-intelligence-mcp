import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/services/wi-config.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getDatabasePath: vi.fn(() => { throw new Error('configuration unavailable'); }),
}));
import { getDatabase, closeDatabase, backupDatabase } from '../../src/db/connection.js';
import { getDatabasePath } from '../../src/services/wi-config.js';
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'wi-explicit-db-')); vi.stubEnv('DATABASE_PATH', ''); vi.mocked(getDatabasePath).mockClear(); });
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
it('uses DATABASE_PATH without reading an unavailable config file', () => {
  const file = join(directory, 'environment.db'); vi.stubEnv('DATABASE_PATH', file);
  expect(getDatabase().name).toBe(file);
  expect(getDatabasePath).not.toHaveBeenCalled();
});
it('uses an explicit database config path and backs up that database without global config', async () => {
  const file = join(directory, 'explicit.db');
  expect(getDatabase({ path: file }).name).toBe(file);
  await backupDatabase();
  expect(readdirSync(join(directory, 'backups'))).toHaveLength(1);
  expect(getDatabasePath).not.toHaveBeenCalled();
});
