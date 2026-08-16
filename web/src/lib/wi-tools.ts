/**
 * Web UI client for wi_* tools — same manifest + buildHandler as Atlas/MCP (ADR-025).
 *
 * Chat and other UI surfaces should call these helpers instead of ad-hoc fetch
 * paths so behavior matches the Work Intelligence plugins.
 */

import {
  TOOL_MANIFEST,
  buildHandler,
  type ToolEntry,
  type ToolResult,
} from '@wi/manifest';
import { getBrainUser } from './api';

function bridgeBase(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost:3132';
}

function handlerFor(entry: ToolEntry) {
  return async (rawInput: unknown): Promise<ToolResult> => {
    const user = await getBrainUser();
    const run = buildHandler(entry, {
      consumer: 'ui',
      getUser: () => user,
      bridgeUrl: bridgeBase(),
      defaultTimeoutMs: 30_000,
    });
    return run(rawInput);
  };
}

const toolByName = new Map(TOOL_MANIFEST.map((e) => [e.name, handlerFor(e)]));

/** Invoke any manifest tool by name (e.g. wi_sync, wi_brain_context, wi_teams). */
export async function invokeWiTool(name: string, input: unknown): Promise<ToolResult> {
  const run = toolByName.get(name);
  if (!run) {
    return { ok: false, error: { code: 'unknown_tool', message: `Unknown wi_* tool: ${name}` } };
  }
  return run(input);
}

export async function wiSyncStatus(): Promise<ToolResult> {
  return invokeWiTool('wi_sync', { kind: 'status' });
}

export async function wiSyncAll(): Promise<ToolResult> {
  return invokeWiTool('wi_sync', { kind: 'all' });
}

export async function wiBrainContext(): Promise<ToolResult> {
  return invokeWiTool('wi_brain_context', {});
}

export async function wiTeamsUpdates(query: string, limit = 40): Promise<ToolResult> {
  return invokeWiTool('wi_teams', { kind: 'updates', query, limit });
}

export function wiToolNames(): string[] {
  return TOOL_MANIFEST.map((e) => e.name);
}
