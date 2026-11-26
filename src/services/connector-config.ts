import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCapabilitiesManifest } from './connector-registry.js';
import { clearWiConfigCache } from './wi-config.js';

interface ConfigPaths { configPath?: string; schemaPath?: string }
interface UpdateResult { status: 200 | 400 | 500; body: Record<string, unknown> }
interface StoredConfig { connectors: Record<string, { enabled?: boolean; mode?: string }> }

/** Update connector structure only, using the same full schema as config:validate. */
export function updateConnectorConfig(input: unknown, paths: ConfigPaths = {}): UpdateResult {
  const fail = (status: 400 | 500, error: string): UpdateResult => ({ status, body: { error } });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'Expected a connector update object');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !['name', 'enabled', 'mode'].includes(key))) return fail(400, 'Only name, enabled and mode may be updated');
  const { name, enabled, mode } = body;
  let temporaryPath: string | undefined;
  let createdTemporary = false;
  try {
    const manifest = getCapabilitiesManifest();
    if (typeof name !== 'string' || !Object.hasOwn(manifest.connectors, name)) return fail(400, 'Unknown connector');
    const entry = manifest.connectors[name];
    if (enabled !== undefined && typeof enabled !== 'boolean') return fail(400, 'enabled must be a boolean');
    if (mode !== undefined && (typeof mode !== 'string' || !entry.modes.includes(mode))) return fail(400, 'Unsupported connector mode');
    if (enabled === undefined && mode === undefined) return fail(400, 'Send enabled and/or mode');
    const configPath = paths.configPath ?? process.env.WI_CONFIG_PATH ?? fileURLToPath(new URL('../../wi.config.json', import.meta.url));
    const schemaPath = paths.schemaPath ?? fileURLToPath(new URL('../../wi.config.schema.json', import.meta.url));
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({ validateFormats: false }).compile<StoredConfig>(schema);
    if (!validate(config)) return fail(400, 'Configuration does not match wi.config.schema.json');
    config.connectors[name] = { ...config.connectors[name], ...(enabled === undefined ? {} : { enabled }), ...(mode === undefined ? {} : { mode }) };
    if (!validate(config)) return fail(400, 'Configuration does not match wi.config.schema.json');
    temporaryPath = configPath + '.' + randomUUID() + '.tmp';
    writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + String.fromCharCode(10), { flag: 'wx', mode: 0o600 });
    createdTemporary = true;
    renameSync(temporaryPath, configPath);
    createdTemporary = false;
    clearWiConfigCache();
    return { status: 200, body: { ok: true, name, enabled: config.connectors[name].enabled === true, mode: config.connectors[name].mode ?? null } };
  } catch {
    return fail(500, 'Configuration update failed; changes were not saved');
  } finally {
    if (createdTemporary && temporaryPath) { try { unlinkSync(temporaryPath); } catch { /* Preserve the original failure. */ } }
  }
}
