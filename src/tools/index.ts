/**
 * Tool implementations index
 * Exports all MCP tools and shared utilities
 */

export * from './search-messages.js';
export * from './action-items.js';
export * from './digest.js';
export * from './configure-topic.js';
export type { SearchAllArgs } from './search-all.js';

// Shared utilities for tool implementations
export interface MCPToolResponse {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export function createTextResponse(text: string): MCPToolResponse {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

export function createErrorResponse(error: Error | string): MCPToolResponse {
  const errorMessage = error instanceof Error ? error.message : error;
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${errorMessage}`,
      },
    ],
    isError: true,
  };
}

// Type guards for tool arguments
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Utility for safe argument extraction
export function getStringArg(args: unknown, key: string, defaultValue?: string): string | undefined {
  if (!isRecord(args)) return defaultValue;
  const value = args[key];
  return typeof value === 'string' ? value : defaultValue;
}

export function getNumberArg(args: unknown, key: string, defaultValue?: number): number | undefined {
  if (!isRecord(args)) return defaultValue;
  const value = args[key];
  return typeof value === 'number' ? value : defaultValue;
}

export function getObjectArg<T = Record<string, unknown>>(
  args: unknown,
  key: string,
  defaultValue?: T
): T | undefined {
  if (!isRecord(args)) return defaultValue;
  const value = args[key];
  return isRecord(value) ? (value as T) : defaultValue;
}
