import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { bucketCallParams } from '../services/model-config.js';
import { recordTokenUsage } from '../db/queries/system.js';
import { computeCost } from '../services/analyzer.js';
import { dispatchResearchTool, getToolsForTier, type ResearchTier, type ToolContext } from './research-tools.js';
import { getArchitectureKnowledge } from '../db/queries/investigation.js';
import { defaultRepoName, repoDisplayNames } from './repo-names.js';

export interface ResearchConfig {
  question: string;
  tier?: ResearchTier;
  maxIterations?: number;
  timeoutMs?: number;
  model?: string;
  repoContext?: string;
  additionalContext?: string;
}

export interface ResearchResult {
  answer: string;
  confidence: number;
  filesExamined: string[];
  searchesPerformed: string[];
  iterations: number;
  tokensUsed: { input: number; output: number; cacheRead: number };
  durationMs: number;
  blockerReport?: string;
}

interface ReActEntry {
  iteration: number;
  thought: string;
  tool: string;
  toolInput: Record<string, unknown>;
  observation: string;
}

const TIER_DEFAULTS: Record<ResearchTier, { maxIterations: number; timeoutMs: number; model: string }> = {
  1: { maxIterations: 5, timeoutMs: 15_000, model: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-latest' },
  2: { maxIterations: 8, timeoutMs: 30_000, model: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-latest' },
  3: { maxIterations: 8, timeoutMs: 45_000, model: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-latest' },
};

export class ResearchEngine {
  private client: Anthropic;
  private db: Database.Database;
  private toolCtx: ToolContext;

  constructor(db: Database.Database, toolCtx: ToolContext) {
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    this.client = new Anthropic({
      apiKey: baseURL ? 'x-proxy' : apiKey,
      ...(baseURL ? {
        baseURL,
        defaultHeaders: { 'Authorization': `Bearer ${apiKey}` },
      } : {}),
    });
    this.db = db;
    this.toolCtx = toolCtx;
  }

  async investigate(config: ResearchConfig): Promise<ResearchResult> {
    const startTime = Date.now();
    const tier: ResearchTier = config.tier ?? this.classifyTier(config.question);
    const defaults = TIER_DEFAULTS[tier];
    const maxIterations = config.maxIterations ?? defaults.maxIterations;
    const timeoutMs = config.timeoutMs ?? defaults.timeoutMs;
    // ADR-031: the model comes from a bucket (bucketCallParams), tier-mapped
    // (tier-1 → 'fetch'/Haiku, tier-2/3 → 'dispatch'/Sonnet) — NOT the tier
    // default constant. Cost tracking (trackTokens below) MUST record the
    // bucket's actual model, not defaults.model, or token_usage mis-reports the
    // research engine. Resolve once here (bucket + tier are stable per call) and
    // reuse for both the API call and the cost ledger.
    const researchParams = bucketCallParams(this.db, tier === 1 ? 'fetch' : 'dispatch', 1024);
    const model = researchParams.model;
    const tools = getToolsForTier(tier);

    const systemPrompt = this.buildSystemPrompt(config);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: config.question },
    ];

    const reactTrace: ReActEntry[] = [];
    const filesExamined: string[] = [];
    const searchesPerformed: string[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let iteration = 0;
    let answer = '';
    let confidence = 0;

    const concludeTool: Anthropic.Tool = {
      name: 'conclude',
      description: 'Call this when you have enough information to answer the question. Provide your answer and confidence level.',
      input_schema: {
        type: 'object' as const,
        properties: {
          answer: { type: 'string', description: 'Your complete answer to the question' },
          confidence: { type: 'number', description: 'Confidence 0.0-1.0 in this answer' },
        },
        required: ['answer', 'confidence'],
      },
    };

    const allTools = [...tools, concludeTool];

    try {
      while (iteration < maxIterations) {
        if (Date.now() - startTime > timeoutMs) break;
        iteration++;

        const loopDetected = this.detectLoop(reactTrace);
        const compressedMessages = iteration > 4
          ? this.compressEarlyIterations(messages, iteration)
          : messages;

        const callMessages = loopDetected
          ? [...compressedMessages, {
              role: 'user' as const,
              content: 'You seem to be repeating searches. Try a DIFFERENT approach: search for a different term, read a different file, or conclude with what you know so far.',
            }]
          : compressedMessages;

        // researchParams + model hoisted above the loop (bucket + tier are
        // stable per investigate() call); reuse so the API call and trackTokens
        // agree on the model.
        const response = await Promise.race([
          this.client.messages.create({
            ...researchParams,
            system: [{
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            } as Anthropic.TextBlockParam & { cache_control: { type: 'ephemeral' } }],
            tools: allTools,
            tool_choice: { type: 'auto' },
            messages: callMessages,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Research timeout')), Math.max(timeoutMs - (Date.now() - startTime), 5000))
          ),
        ]);

        totalInput += response.usage?.input_tokens ?? 0;
        totalOutput += response.usage?.output_tokens ?? 0;
        totalCacheRead += (response.usage as unknown as Record<string, number>)?.cache_read_input_tokens ?? 0;

        const toolUses = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
        const textBlock = response.content.find(b => b.type === 'text') as Anthropic.TextBlock | undefined;

        if (toolUses.length === 0) {
          answer = textBlock?.text ?? '';
          confidence = 0.5;
          break;
        }

        const toolResults = await Promise.all(
          toolUses.map(async (toolUse) => {
            if (toolUse.name === 'conclude') {
              return { toolUse, observation: 'Conclusion recorded.' };
            }
            let observation: string;
            try {
              observation = await dispatchResearchTool(toolUse.name, toolUse.input, this.toolCtx);
            } catch (err) {
              observation = `Tool error: ${(err as Error).message}`;
            }
            this.trackToolUsage(toolUse.name, toolUse.input as Record<string, unknown>, filesExamined, searchesPerformed);
            return { toolUse, observation };
          })
        );

        for (const { toolUse, observation } of toolResults) {
          reactTrace.push({
            iteration,
            thought: textBlock?.text ?? '',
            tool: toolUse.name,
            toolInput: toolUse.input as Record<string, unknown>,
            observation: observation.slice(0, 500),
          });
        }

        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: toolResults.map(({ toolUse, observation }) => ({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: observation.slice(0, 3000),
          })),
        });

        const concludeResult = toolResults.find(({ toolUse }) => toolUse.name === 'conclude');
        if (concludeResult) {
          const input = concludeResult.toolUse.input as { answer: string; confidence: number };
          answer = input.answer;
          confidence = input.confidence;
          break;
        }
      }
    } catch (err) {
      if (!answer) {
        answer = `Research interrupted: ${(err as Error).message}`;
        confidence = 0.1;
      }
    }

    const durationMs = Date.now() - startTime;

    this.trackTokens(model, totalInput, totalOutput, totalCacheRead);

    if (!answer && reactTrace.length > 0) {
      answer = this.buildBlockerReport(config.question, reactTrace);
      confidence = 0.2;
    }

    return {
      answer: answer || 'Unable to find relevant information.',
      confidence,
      filesExamined: [...new Set(filesExamined)],
      searchesPerformed: [...new Set(searchesPerformed)],
      iterations: iteration,
      tokensUsed: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead },
      durationMs,
      blockerReport: confidence < 0.4 ? this.buildBlockerReport(config.question, reactTrace) : undefined,
    };
  }

  classifyTier(question: string): ResearchTier {
    const lower = question.toLowerCase();
    const complexSignals = [
      'how does', 'why does', 'trace', 'call graph', 'architecture',
      'flow', 'explain the', 'relationship between', 'investigate',
    ];
    const deepSignals = ['compare', 'all places', 'every', 'comprehensive', 'across repos'];

    if (deepSignals.some(s => lower.includes(s))) return 3;
    if (complexSignals.some(s => lower.includes(s))) return 2;
    return 1;
  }

  private buildSystemPrompt(config: ResearchConfig): string {
    const archContext = getArchitectureKnowledge(this.db, config.repoContext ?? defaultRepoName(), 1500);
    const tier = config.tier ?? this.classifyTier(config.question);

    return `You are a code research agent investigating a codebase question. Your goal is to find accurate, specific answers with file paths and line numbers where possible.

## Available Repositories
- ${repoDisplayNames().join(': Main application\n- ')}: Deployment configs, feature flags, cluster setup

## Architecture Context
${archContext || 'No pre-indexed architecture available. Use grep_code and list_files to explore.'}
${config.additionalContext ? `\n## Additional Context\n${config.additionalContext}` : ''}

## Research Rules
1. Start with grep_code to locate relevant code — never guess file paths
2. After finding files, use read_file with offset+limit to examine specific sections (max 100 lines)
3. If grep returns nothing, try alternative terms or broader patterns
4. Track what you've searched — do NOT repeat the same search
5. When you have enough evidence, call conclude with your answer and confidence (0.0-1.0)
6. ${tier === 1 ? 'You have 5 iterations — be direct and focused' : 'Explore thoroughly but stay on-topic'}
7. If you cannot find the answer after exhausting searches, conclude with confidence < 0.3 and explain what you tried

## Anti-Patterns (AVOID)
- Searching for the same pattern twice
- Reading entire files when you only need a function
- Giving up after one failed search — try synonyms and related terms
- Concluding without evidence — always cite file paths`;
  }

  private detectLoop(trace: ReActEntry[]): boolean {
    if (trace.length < 4) return false;
    const recent = trace.slice(-4);
    const patterns = recent.map(e => `${e.tool}:${JSON.stringify(e.toolInput)}`);
    const unique = new Set(patterns);
    return unique.size <= 2;
  }

  private compressEarlyIterations(messages: Anthropic.MessageParam[], currentIter: number): Anthropic.MessageParam[] {
    if (messages.length <= 5) return messages;
    const keepFirst = messages.slice(0, 1);
    const compressible = messages.slice(1, -4);
    const keepRecent = messages.slice(-4);

    if (compressible.length === 0) return messages;

    const summary: Anthropic.MessageParam = {
      role: 'user',
      content: `[Context from iterations 1-${currentIter - 2}: ${compressible.length / 2} tool calls were made. Recent results are shown below. Focus on what you still need to find.]`,
    };

    return [...keepFirst, summary, ...keepRecent];
  }

  private trackToolUsage(
    toolName: string,
    input: Record<string, unknown>,
    files: string[],
    searches: string[],
  ): void {
    if (toolName === 'read_file') {
      const file = input['file'] as string;
      if (file) files.push(file);
    } else if (toolName === 'grep_code') {
      searches.push(`grep: ${input['pattern']}`);
    } else if (toolName === 'search_codebase_knowledge') {
      searches.push(`knowledge: ${(input['keywords'] as string[])?.join(', ')}`);
    } else if (toolName === 'search_docs') {
      searches.push(`docs: ${input['query']}`);
    } else if (toolName === 'list_files') {
      files.push(`${input['repo']}/${input['subPath'] ?? ''}`);
    }
  }

  private trackTokens(model: string, input: number, output: number, cacheRead: number): void {
    try {
      const costUsd = computeCost(model, input, output, cacheRead, 0);
      recordTokenUsage(this.db, 'research-engine', model, input, output, cacheRead, 0, costUsd);
    } catch { /* never break caller */ }
  }

  private buildBlockerReport(question: string, trace: ReActEntry[]): string {
    const searches = trace.filter(e => e.tool === 'grep_code').map(e => (e.toolInput as Record<string, unknown>)['pattern']);
    const filesRead = trace.filter(e => e.tool === 'read_file').map(e => (e.toolInput as Record<string, unknown>)['file']);
    return [
      `## What I tried for: "${question}"`,
      searches.length > 0 ? `\n**Searches:** ${searches.join(', ')}` : '',
      filesRead.length > 0 ? `\n**Files examined:** ${filesRead.join(', ')}` : '',
      `\n**Iterations:** ${trace.length}`,
      `\n**Outcome:** Could not find sufficient evidence to answer confidently.`,
    ].filter(Boolean).join('');
  }
}
