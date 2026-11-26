import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { updateConnectorConfig } from '../../src/services/connector-config.js';
import { publicPath } from '../../scripts/demo-sandbox.mjs';
import { clearWiConfigCache, getWiConfig } from '../../src/services/wi-config.js';

let directory: string;
let configPath: string;
let original: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wi-connector-config-'));
  configPath = join(directory, 'config.json');
  original = readFileSync(publicPath('wi.config.json'), 'utf8');
  writeFileSync(configPath, original);
  vi.stubEnv('WI_CONFIG_PATH', configPath);
  clearWiConfigCache();
});
afterEach(() => { vi.unstubAllEnvs(); clearWiConfigCache(); rmSync(directory, { recursive: true, force: true }); });

it.each(['__proto__', 'constructor', 'toString'])('rejects inherited connector name %s before modifying config', name => {
  expect(updateConnectorConfig({ name, enabled: true }).status).toBe(400);
  expect(readFileSync(configPath, 'utf8')).toBe(original);
  expect(Object.hasOwn(Object.prototype, 'enabled')).toBe(false);
});
it('writes only connector structure, preserves credential references and refreshes the configured cache', () => {
  expect(getWiConfig().connectors.jira.enabled).toBe(false);
  const result = updateConnectorConfig({ name: 'jira', enabled: true, mode: 'mcp' });
  expect(result).toEqual({ status: 200, body: { ok: true, name: 'jira', enabled: true, mode: 'mcp' } });
  expect(getWiConfig().connectors.jira.enabled).toBe(true);
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  const expected = JSON.parse(original);
  expected.connectors.jira.enabled = true; expected.connectors.jira.mode = 'mcp';
  expect(written).toEqual(expected);
  expect(readdirSync(directory)).toEqual(['config.json']);
});
it('rejects credential fields and unsupported modes without writing', () => {
  expect(updateConnectorConfig({ name: 'jira', enabled: true, token: 'fictional-token' }).status).toBe(400);
  expect(updateConnectorConfig({ name: 'jira', mode: 'unsupported' }).status).toBe(400);
  expect(readFileSync(configPath, 'utf8')).toBe(original);
});
it('fails closed when the full schema is unavailable', () => {
  expect(updateConnectorConfig({ name: 'jira', enabled: true }, { schemaPath: join(directory, 'missing.json') }).status).toBe(500);
  expect(readFileSync(configPath, 'utf8')).toBe(original);
  expect(readdirSync(directory)).toEqual(['config.json']);
});
it('refuses a malformed existing config rather than saving an unvalidated update', () => {
  const invalid = JSON.parse(original); delete invalid.bridge;
  const bytes = JSON.stringify(invalid); writeFileSync(configPath, bytes);
  expect(updateConnectorConfig({ name: 'jira', enabled: true }).status).toBe(400);
  expect(readFileSync(configPath, 'utf8')).toBe(bytes);
});
