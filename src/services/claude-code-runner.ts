import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import PQueue from 'p-queue';

export interface ClaudeCodeRequest {
  prompt: string;
  repos: string[];
  model?: string;
  maxBudget?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  /**
   * Override the default OUTPUT_SCHEMA passed to `claude --json-schema`.
   * Use this when the caller (e.g. wi-investigate) needs a stricter
   * contract than the generic research-findings shape.
   */
  outputSchema?: string;
  /**
   * Validate the parsed JSON before it is wrapped in ClaudeCodeResult.
   * Return `false` to discard the result (runner resolves null).
   * Used by the investigation orchestrator to enforce the wi-investigate
   * structured contract (GAP-002).
   */
  validate?: (parsed: unknown) => boolean;
}

export interface ClaudeCodeResult {
  findings: ResearchFinding[];
  filesExamined: string[];
  confidence: number;
  model: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}

export interface ResearchFinding {
  title: string;
  explanation: string;
  relevantFiles: string[];
  codeSnippets?: CodeSnippet[];
  blastRadius?: string[];
  confidence: number;
}

export interface CodeSnippet {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
}

export interface ContextItem {
  source: string;
  title: string;
  content: string;
  url?: string;
  author?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

const OUTPUT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          explanation: { type: 'string' },
          relevantFiles: { type: 'array', items: { type: 'string' } },
          codeSnippets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' },
                content: { type: 'string' },
                language: { type: 'string' },
              },
              required: ['file', 'startLine', 'endLine', 'content', 'language'],
            },
          },
          blastRadius: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['title', 'explanation', 'relevantFiles', 'confidence'],
      },
    },
    filesExamined: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['findings', 'filesExamined', 'confidence'],
});

const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';

export class ClaudeCodeRunner {
  private queue: PQueue;

  constructor(concurrency = 2) {
    this.queue = new PQueue({ concurrency });
  }

  async execute(request: ClaudeCodeRequest): Promise<ClaudeCodeResult | null> {
    return this.queue.add(() => this.run(request));
  }

  private run(request: ClaudeCodeRequest): Promise<ClaudeCodeResult | null> {
    const {
      prompt,
      repos,
      model = 'sonnet',
      maxBudget = 0.50,
      timeoutMs = 120_000,
      systemPrompt,
      outputSchema,
      validate,
    } = request;

    const args: string[] = [
      '--print',
      '--output-format', 'json',
      '--bare',
      '--dangerously-skip-permissions',
      '--model', model,
      '--max-budget-usd', String(maxBudget),
      '--json-schema', outputSchema ?? OUTPUT_SCHEMA,
    ];

    for (const repo of repos) {
      args.push('--add-dir', repo);
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    args.push('-p', prompt);

    const start = Date.now();

    return new Promise((resolve) => {
      const child = execFile(CLAUDE_CLI, args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        cwd: repos[0] || process.cwd(),
      }, (error, stdout, _stderr) => {
        const durationMs = Date.now() - start;

        if (error) {
          process.stderr.write(`[claude-code-runner] error: ${error.message}\n`);
          resolve(null);
          return;
        }

        try {
          const parsed = JSON.parse(stdout);
          if (validate && !validate(parsed)) {
            // Caller-defined validator rejected the payload (e.g. wi-investigate
            // missing required contract fields). Treat as "skill produced no
            // usable output" so the orchestrator falls back to ReAct alone.
            resolve(null);
            return;
          }
          const result: ClaudeCodeResult = {
            findings: parsed.findings ?? [],
            filesExamined: parsed.filesExamined ?? [],
            confidence: parsed.confidence ?? 0,
            model,
            tokensUsed: 0,
            costUsd: 0,
            durationMs,
          };
          resolve(result);
        } catch (parseErr) {
          process.stderr.write(`[claude-code-runner] parse error: ${(parseErr as Error).message}\n`);
          resolve(null);
        }
      });

      child.on('error', () => resolve(null));
    });
  }
}

export function adaptToContextItems(result: ClaudeCodeResult): ContextItem[] {
  return result.findings.map(f => ({
    source: 'claude-code',
    title: f.title,
    content: f.explanation.slice(0, 500),
    metadata: {
      files: f.relevantFiles,
      confidence: f.confidence,
      blastRadius: f.blastRadius,
      model: result.model,
      durationMs: result.durationMs,
    },
  }));
}

export function computeInputHash(question: string, repos: string[]): string {
  return createHash('sha256').update(`${question}|${repos.sort().join(',')}`).digest('hex').slice(0, 16);
}
