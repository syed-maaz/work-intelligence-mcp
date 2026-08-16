/**
 * Tests for connector registry — manifest loading, enabled-flag discovery,
 * statuses, and SourceSpec wiring with the committed all-disabled config.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCapabilitiesManifest,
  getEnabledConnectors,
  getConnectorCapabilities,
  getConnectorStatuses,
  buildSourceSpecs,
  wireFetcher,
} from '../../src/services/connector-registry.js';
import { MessageSource } from '../../src/fetcher/sources/types.js';

describe('connector registry — capabilities manifest', () => {
  it('loads capabilities.json with all 6 connectors', () => {
    const manifest = getCapabilitiesManifest();
    expect(manifest.version).toBe('1.0');
    expect(manifest.registry.loadsFrom).toBe('wi.config.json');
    expect(Object.keys(manifest.connectors).sort()).toEqual(
      ['github', 'jira', 'linear', 'outlook', 'slack', 'teams'].sort(),
    );
  });

  it('declares slack + linear capabilities', () => {
    expect(getConnectorCapabilities('slack')).toContain('messages');
    expect(getConnectorCapabilities('linear')).toContain('issues');
  });

  it('returns null for unknown connector', () => {
    expect(getConnectorCapabilities('nonexistent')).toBeNull();
  });
});

describe('connector registry — enabled-flags discovery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns [] when all connectors disabled (committed config)', () => {
    expect(getEnabledConnectors()).toEqual([]);
  });

  it('reports per-connector status with enabled:false', () => {
    const statuses = getConnectorStatuses();
    expect(Object.keys(statuses).sort()).toEqual(
      ['github', 'jira', 'linear', 'outlook', 'slack', 'teams'].sort(),
    );
    for (const status of Object.values(statuses)) {
      expect(status.enabled).toBe(false);
      expect(typeof status.mode).toBe('string');
      expect(typeof status.hasRequiredEnv).toBe('boolean');
    }
  });
});

describe('connector registry — source wiring', () => {
  it('buildSourceSpecs returns [] when nothing enabled (never throws)', () => {
    const specs = buildSourceSpecs(null as never);
    expect(specs).toEqual([]);
  });

  it('wireFetcher returns a working fetcher with zero sources', async () => {
    const fetcher = wireFetcher(null as never);
    expect(fetcher).toBeDefined();
    const messages = await fetcher.fetch('jira');
    expect(messages).toEqual([]);
  });

  it('MessageSource has slack + linear sources', () => {
    expect(MessageSource.Slack).toBe('slack');
    expect(MessageSource.Linear).toBe('linear');
  });
});