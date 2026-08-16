// @vitest-environment node
/**
 * PalaceClient v2 Integration Test
 *
 * Tests StdioClientTransport round-trips with the actual mempalace MCP server.
 * Satisfies ADR-016 B2 (integration test gate).
 *
 * Tests skip cleanly when mempalace is not installed.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { PalaceClient } from '../../src/intelligence/palace-client.js';

// ---------------------------------------------------------------------------
// Skip guard — skip all tests if mempalace is not installed
// ---------------------------------------------------------------------------

const hasMempalace = (() => {
  try {
    execFileSync('python3', ['-m', 'mempalace.mcp_server', '--help'], {
      timeout: 5_000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
})();

const describeIfPalace = hasMempalace ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test setup — use a temporary palace directory
// ---------------------------------------------------------------------------

const PALACE_PATH = process.env.MEMPALACE_PATH ?? `/tmp/test-palace-${Date.now()}`;

let client: PalaceClient;

describeIfPalace('PalaceClient v2 Integration — StdioClientTransport round-trip', () => {
  afterAll(async () => {
    if (client) {
      await client.shutdown();
    }
  });

  it('connects and reports healthy status', async () => {
    client = new PalaceClient(PALACE_PATH);
    // Force connection by doing a search
    await client.search('test');
    expect(client.isConnected).toBe(true);
    expect(client.stats.connected).toBe(true);
  });

  it('round-trips addDrawer + search', async () => {
    // Write a known document
    await client.addDrawer(
      'test-wing',
      'test-room',
      'Hello from integration test',
      'test-label'
    );
    // Search should find it
    const result = await client.search('Hello integration');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('round-trips kgAdd + kgQuery', async () => {
    await client.kgAdd('TestEntity', 'has-type', 'integration-test');
    const result = await client.kgQuery('TestEntity');
    expect(typeof result).toBe('string');
    expect(result).toContain('integration-test');
  });

  it('round-trips diaryWrite + diaryRead', async () => {
    await client.diaryWrite('test-agent', 'test entry from integration', 'test-topic');
    const result = await client.diaryRead('test-agent', 1);
    expect(typeof result).toBe('string');
    expect(result).toContain('test entry');
  });

  it('returns empty string when unavailable (bad path)', async () => {
    const badClient = new PalaceClient('/nonexistent/path/that/does/not/exist');
    const result = await badClient.search('anything');
    expect(result).toBe('');
    await badClient.shutdown();
  });

  it('kgInvalidate does not throw', async () => {
    // First add the triple so invalidation has something to work with
    await client.kgAdd('TestEntity', 'has-type', 'integration-test');
    // Invalidation should complete without error
    await expect(
      client.kgInvalidate('TestEntity', 'has-type', 'integration-test', '2026-01-01')
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Always-run test: graceful degradation when mempalace not installed
// ---------------------------------------------------------------------------

describe('PalaceClient v2 — graceful degradation', () => {
  it('returns empty string for search when palace path does not exist', async () => {
    const unavailable = new PalaceClient('/nonexistent/palace/path');
    const result = await unavailable.search('query');
    expect(result).toBe('');
    await unavailable.shutdown();
  });

  it('does not throw for void methods when unavailable', async () => {
    const unavailable = new PalaceClient('/nonexistent/palace/path');
    await expect(unavailable.kgAdd('S', 'P', 'O')).resolves.toBeUndefined();
    await expect(unavailable.addDrawer('w', 'r', 'c')).resolves.toBeUndefined();
    await expect(unavailable.diaryWrite('a', 'e', 't')).resolves.toBeUndefined();
    await expect(unavailable.kgInvalidate('S', 'P', 'O')).resolves.toBeUndefined();
    await unavailable.shutdown();
  });

  it('exposes health stats', () => {
    const unavailable = new PalaceClient('/nonexistent/palace/path');
    expect(unavailable.isConnected).toBe(false);
    expect(unavailable.uptime).toBe(0);
    const stats = unavailable.stats;
    expect(stats.connected).toBe(false);
    expect(stats.callCount).toBe(0);
  });
});
