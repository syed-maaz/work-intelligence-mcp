import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { clearWiConfigCache, getDatabasePath, getGitHubEnterpriseHost, getSyncIntervalMs, getBridgePort } from '../../src/services/wi-config.js';
it('isolated config and explicit database paths override repository and legacy settings', () => {
  const dir=mkdtempSync(join(tmpdir(),'wi-demo-config-'));
  const config=join(dir,'config.json');
  writeFileSync(config,JSON.stringify({version:'1.0',database:{pathEnvVar:'LEGACY_FIXTURE_DB'},connectors:{github:{enterpriseHost:'git.example.com'}},features:{syncIntervalMs:2500},bridge:{port:3232}}));
  vi.stubEnv('WI_CONFIG_PATH',config);vi.stubEnv('DATABASE_PATH',join(dir,'safe.db'));vi.stubEnv('LEGACY_FIXTURE_DB','/unknown/database.db');
  vi.stubEnv('PORT','3233');vi.stubEnv('SYNC_INTERVAL_MS','');clearWiConfigCache();
  try {
    expect(getDatabasePath()).toBe(join(dir,'safe.db'));
    expect(getGitHubEnterpriseHost()).toBe('git.example.com');
    expect(getSyncIntervalMs()).toBe(2500);
    expect(getBridgePort()).toBe(3233);
  } finally {clearWiConfigCache();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
});
