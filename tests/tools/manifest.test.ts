/**
 * Tests for src/tools/manifest.ts
 *
 * Tests both manifest shape (D-01..D-04 compliance) and buildHandler contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  TOOL_MANIFEST,
  buildHandler,
  type ToolEntry,
  type BuildHandlerOpts,
} from '../../src/tools/manifest.js';

// ─── Shared test entry ────────────────────────────────────────────────────────

const mockEntry: ToolEntry = {
  name: 'wi_test',
  description: 'test',
  endpoint: '/api/test',
  method: 'GET',
  inputSchema: z.object({ q: z.string() }).strict(),
  outputSchema: z.object({ result: z.string() }).strict(),
};

const defaultOpts: BuildHandlerOpts = {
  consumer: 'atlas',
  getUser: () => 'test-user',
  bridgeUrl: 'http://127.0.0.1:3132',
};

// ─── Manifest contents tests ──────────────────────────────────────────────────

describe('TOOL_MANIFEST shape', () => {
  it('has exactly 22 entries', () => {
    expect(TOOL_MANIFEST).toHaveLength(22);
  });

  it('every entry name starts with wi_', () => {
    for (const entry of TOOL_MANIFEST) {
      expect(entry.name).toMatch(/^wi_/);
    }
  });

  it('every entry has required fields: name, description, endpoint, method, inputSchema, outputSchema', () => {
    for (const entry of TOOL_MANIFEST) {
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('description');
      expect(entry).toHaveProperty('endpoint');
      expect(entry).toHaveProperty('method');
      expect(entry).toHaveProperty('inputSchema');
      expect(entry).toHaveProperty('outputSchema');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.description).toBe('string');
    }
  });

  it('no entry has a handler property (D-01)', () => {
    for (const entry of TOOL_MANIFEST) {
      expect(entry).not.toHaveProperty('handler');
    }
  });

  it('every name appears exactly once', () => {
    const names = TOOL_MANIFEST.map((e) => e.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('wi_jira_analyze has timeoutMs: 30000', () => {
    const entry = TOOL_MANIFEST.find((e) => e.name === 'wi_jira_analyze');
    expect(entry).toBeDefined();
    expect(entry!.timeoutMs).toBe(30000);
  });

  it('wi_sync has timeoutMs: 30000', () => {
    const entry = TOOL_MANIFEST.find((e) => e.name === 'wi_sync');
    expect(entry).toBeDefined();
    expect(entry!.timeoutMs).toBe(30000);
  });

  it('wi_jira_get inputSchema: valid kind issues parses OK, invalid kind fails', () => {
    const entry = TOOL_MANIFEST.find((e) => e.name === 'wi_jira_get');
    expect(entry).toBeDefined();

    const validResult = entry!.inputSchema.safeParse({ kind: 'issues' });
    expect(validResult.success).toBe(true);

    const invalidResult = entry!.inputSchema.safeParse({ kind: 'not_a_kind' });
    expect(invalidResult.success).toBe(false);
  });
});

// ─── buildHandler tests ───────────────────────────────────────────────────────

describe('buildHandler', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(
    status: number,
    body: unknown,
    isJson = true,
  ) {
    const responseBody = isJson ? JSON.stringify(body) : String(body);
    const mockResponse = {
      ok: status >= 200 && status < 300,
      status,
      json: isJson
        ? vi.fn().mockResolvedValue(body)
        : vi.fn().mockRejectedValue(new SyntaxError('not JSON')),
      text: vi.fn().mockResolvedValue(responseBody),
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);
  }

  it('returns {ok:true, data} on 200 with valid body', async () => {
    mockFetch(200, { result: 'hello' });
    const handler = buildHandler(mockEntry, defaultOpts);
    const result = await handler({ q: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: 'hello' });
  });

  it('returns {ok:false, error:{code:not_found}} on 404 with JSON error body', async () => {
    mockFetch(404, { error: 'not_found' });
    const handler = buildHandler(mockEntry, defaultOpts);
    const result = await handler({ q: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_found');
  });

  it('returns {ok:false, error:{code:http_500}} on 500 with non-JSON body', async () => {
    mockFetch(500, 'Internal Server Error', false);
    const handler = buildHandler(mockEntry, defaultOpts);
    const result = await handler({ q: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('http_500');
  });

  it('returns {ok:false, error:{code:invalid_input}} when inputSchema rejects', async () => {
    const handler = buildHandler(mockEntry, defaultOpts);
    const result = await handler({ q: 123 }); // q must be string
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns {ok:false, error:{code:timeout}} when fetch throws AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);
    const handler = buildHandler(mockEntry, defaultOpts);
    const result = await handler({ q: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('timeout');
  });

  it('returns {ok:false, error:{code:network_error}} when fetch throws non-abort Error', async () => {
    const networkError = new Error('Connection refused');
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(networkError);
    const handler = buildHandler(mockEntry, defaultOpts);
    const result = await handler({ q: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('network_error');
  });

  it("sets X-WI-Consumer: 'atlas' when consumer='atlas'", async () => {
    mockFetch(200, { result: 'ok' });
    const handler = buildHandler(mockEntry, { ...defaultOpts, consumer: 'atlas' });
    await handler({ q: 'test' });
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers['X-WI-Consumer']).toBe('atlas');
  });

  it("sets X-WI-Consumer: 'mcp' when consumer='mcp'", async () => {
    mockFetch(200, { result: 'ok' });
    const handler = buildHandler(mockEntry, { ...defaultOpts, consumer: 'mcp' });
    await handler({ q: 'test' });
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers['X-WI-Consumer']).toBe('mcp');
  });

  it('forwards ?user= from getUser()', async () => {
    mockFetch(200, { result: 'ok' });
    const handler = buildHandler(mockEntry, {
      ...defaultOpts,
      getUser: () => 'alice',
    });
    await handler({ q: 'test' });
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const calledUrl = new URL(callArgs[0] as string);
    expect(calledUrl.searchParams.get('user')).toBe('alice');
  });

  it('GET method folds input fields (excluding kind) into query string', async () => {
    mockFetch(200, { result: 'ok' });
    const handler = buildHandler(mockEntry, defaultOpts);
    await handler({ q: 'hello world' });
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const calledUrl = new URL(callArgs[0] as string);
    expect(calledUrl.searchParams.get('q')).toBe('hello world');
  });

  it('POST method serializes input as JSON body', async () => {
    const postEntry: ToolEntry = {
      ...mockEntry,
      method: 'POST',
      inputSchema: z.object({ q: z.string() }).strict(),
    };
    mockFetch(200, { result: 'ok' });
    const handler = buildHandler(postEntry, defaultOpts);
    await handler({ q: 'test' });
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].body).toBe(JSON.stringify({ q: 'test' }));
  });

it('kind discriminator routes wi_jira_get correctly: kind=board → /api/board/issues', () => {
    const entry = TOOL_MANIFEST.find((e) => e.name === 'wi_jira_get')!;
    const endpoint = entry.endpoint as (input: unknown) => string;
    expect(endpoint({ kind: 'board' })).toBe('/api/board/issues');
    expect(endpoint({ kind: 'saturn' })).toBe('/api/board/issues');
    expect(endpoint({ kind: 'issues' })).toBe('/api/jira/issues');
    expect(endpoint({ kind: 'my_issues' })).toBe('/api/jira/my-issues');
  });

  it('returns {ok:false, error:{code:budget_exceeded}} when budgetCheck returns {allowed:false}', async () => {
    const handler = buildHandler(mockEntry, {
      ...defaultOpts,
      budgetCheck: () => ({ allowed: false, message: 'out of budget' }),
    });
    const result = await handler({ q: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('budget_exceeded');
    expect(result.error?.message).toBe('out of budget');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('budgetCheck is NOT called when input validation fails', async () => {
    const budgetCheck = vi.fn().mockReturnValue({ allowed: true });
    const handler = buildHandler(mockEntry, {
      ...defaultOpts,
      budgetCheck,
    });
    const result = await handler({ q: 999 }); // invalid
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_input');
    expect(budgetCheck).not.toHaveBeenCalled();
  });

  it('output schema mismatch logs console.warn but returns {ok:true, data: rawBody}', async () => {
    const mismatchedBody = { unexpected_field: 42 }; // missing 'result' string
    mockFetch(200, mismatchedBody);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = buildHandler(mockEntry, defaultOpts);
    const result = await handler({ q: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(mismatchedBody);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[wi-tools] wi_test: output schema mismatch'),
    );
    warnSpy.mockRestore();
  });
});
