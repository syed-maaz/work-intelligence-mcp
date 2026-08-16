/**
 * Error Analyzer Tool (EP-18)
 *
 * Uses Claude Haiku to categorize errors and suggest fixes.
 */

import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { bucketCallParams } from '../services/model-config.js';

export interface ErrorAnalysis {
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: string;
  suggested_fix: string;
}

export async function analyzeError(
  error: { message: string; stack?: string | null; source: string; request_path?: string | null },
  apiKey: string,
  db?: Database.Database,
): Promise<ErrorAnalysis> {
  const client = new Anthropic({ apiKey });

  const bucketParams = db ? bucketCallParams(db, 'fetch', 512) : {
    model: 'claude-haiku-4-5-20251001' as const,
    max_tokens: 512,
  };

  const prompt = [
    `Analyze this application error and provide a brief diagnosis.`,
    ``,
    `Source: ${error.source}`,
    `Path: ${error.request_path ?? 'N/A'}`,
    `Message: ${error.message}`,
    error.stack ? `Stack trace (first 500 chars):\n${error.stack.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');

  const response = await client.messages.create({
    ...bucketParams,
    tools: [
      {
        name: 'error_analysis',
        description: 'Structured error analysis result',
        input_schema: {
          type: 'object' as const,
          properties: {
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'error', 'critical'],
              description: 'How severe is this error?',
            },
            category: {
              type: 'string',
              description: 'Error category, e.g. "Database", "Authentication", "Network", "Configuration", "Parsing"',
            },
            suggested_fix: {
              type: 'string',
              description: 'One or two sentence actionable suggestion to fix this error',
            },
          },
          required: ['severity', 'category', 'suggested_fix'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'error_analysis' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    return {
      severity: 'error',
      category: 'Unknown',
      suggested_fix: 'Could not analyze error automatically.',
    };
  }

  return toolUse.input as ErrorAnalysis;
}
