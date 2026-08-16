/**
 * STEP 11 parity gate — capabilities.json ⇄ ADAPTERS must not drift.
 *
 * A name-only parity check would let capabilities/modes drift silently
 * (e.g. a connector gains a new capability in capabilities.json but the
 * adapter doesn't know about it). So this asserts BOTH:
 *   1. manifest connector names === ADAPTERS names
 *   2. per connector: capabilities AND modes match exactly.
 */

import { describe, it, expect } from 'vitest';
import { ADAPTERS } from '../../src/fetcher/sources/adapter.js';
import { getCapabilitiesManifest } from '../../src/services/connector-registry.js';

describe('capabilities.json ⇄ ConnectorAdapter parity', () => {
  it('manifest connector names match ADAPTERS names exactly', () => {
    const manifest = getCapabilitiesManifest();
    expect(Object.keys(manifest.connectors).sort()).toEqual(
      ADAPTERS.map((a) => a.name).sort(),
    );
  });

  it('capabilities match per connector', () => {
    const manifest = getCapabilitiesManifest();
    for (const adapter of ADAPTERS) {
      const entry = manifest.connectors[adapter.name];
      expect(entry, `capabilities.json missing connector ${adapter.name}`).toBeDefined();
      expect([...adapter.capabilities].sort()).toEqual([...entry.capabilities].sort());
    }
  });

  it('modes match per connector', () => {
    const manifest = getCapabilitiesManifest();
    for (const adapter of ADAPTERS) {
      const entry = manifest.connectors[adapter.name];
      expect(entry, `capabilities.json missing connector ${adapter.name}`).toBeDefined();
      expect([...adapter.modes].sort()).toEqual([...entry.modes].sort());
    }
  });

  it('displayName / requiredEnv / dataIngested mirror the manifest', () => {
    const manifest = getCapabilitiesManifest();
    for (const adapter of ADAPTERS) {
      const entry = manifest.connectors[adapter.name];
      expect(adapter.displayName).toBe(entry.displayName);
      expect([...adapter.requiredEnv].sort()).toEqual([...entry.config.requiredEnv].sort());
      expect([...adapter.dataIngested].sort()).toEqual([...entry.dataIngested].sort());
    }
  });
});