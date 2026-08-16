#!/usr/bin/env node

/**
 * Work Intelligence MCP Server
 *
 * This MCP server provides tools for monitoring and analyzing work communications
 * across Microsoft Teams, Email, and Jira.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getDatabase, closeDatabase } from './db/connection.js';
import {
  searchMessages,
  formatSearchResults,
  getActionItems,
  formatActionItems,
  getDailyDigest,
  configureTopic,
  formatTopicConfiguration,
  createTextResponse,
  createErrorResponse,
  type SearchMessagesArgs,
  type GetActionItemsArgs,
  type GetDailyDigestArgs,
  type ConfigureTopicArgs,
} from './tools/index.js';
import { getJiraReport, type GetJiraReportArgs } from './tools/jira-report.js';
import { getTeamsUpdates, type GetTeamsUpdatesArgs } from './tools/teams-updates.js';
import { searchAll, type SearchAllArgs } from './tools/search-all.js';
import { askTopicExpert, type AskTopicExpertArgs } from './tools/topic-expert.js';
import { getTopicSuggestions, dismissTopicSuggestion } from './tools/topic-suggestions.js';
import { getBrainContext, formatBrainContext, type GetContextArgs } from './tools/brain-get-context.js';
import { getBrainDecision, formatDecisionResult, type GetDecisionArgs } from './tools/brain-get-decision.js';
import { verifyBrainClaim, formatVerificationResult, type VerifyClaimArgs } from './tools/brain-verify-claim.js';
import { recallBrainMemory, formatRecallResult, type RecallMemoryArgs } from './tools/brain-recall-memory.js';
import { recordBrainOutcome, formatLearnResult, type RecordOutcomeArgs } from './tools/brain-record-outcome.js';
import { TOOL_MANIFEST, buildHandler } from './tools/manifest.js';
import { zodToJsonSchema } from './tools/zod-to-json-schema.js';
import { getBrowserSession } from './fetcher/sources/browser-session.js';
import { TeamsBrowserConnector } from './fetcher/sources/teams-browser.js';
import { OutlookBrowserConnector } from './fetcher/sources/outlook-browser.js';
import { createJiraDataSource } from './fetcher/sources/jira-adapter.js';
import { SyncService } from './services/sync.js';
import { AIAnalyzer } from './services/analyzer.js';
import type Database from 'better-sqlite3';
import { checkDailyBudget, recordSpend } from './services/brain/budget.js';

/**
 * Per-call budget check for wi_* tools invoked via MCP (not Atlas plugin).
 * Uses the tool_calls bucket so MCP spend is tracked separately from brain calls.
 * Cap controlled by WI_TOOL_CALL_BUDGET env var (default: 30 per user per day).
 */
function makeMcpBudgetCheck(db: Database.Database): () => { allowed: boolean; message?: string } {
  return () => {
    const cap = Number(process.env['WI_TOOL_CALL_BUDGET']) || 30;
    const user = process.env['WI_DEFAULT_USER'] || 'mcp';
    const day = new Date().toISOString().slice(0, 10);
    const status = checkDailyBudget({ db, user, dayIsoUtc: day, bucket: 'tool_calls', limits: { maxCallsPerUserPerDay: cap, maxInputTokensPerUserPerDay: 999_999_999 } });
    if (!status.allowed || status.remainingCalls <= 0) {
      return { allowed: false, message: `Session budget exhausted (${cap} calls)` };
    }
    recordSpend({ db, user, dayIsoUtc: day, inputTokens: 0, outputTokens: 0, bucket: 'tool_calls' });
    return { allowed: true };
  };
}

/**
 * MCP Server for Work Intelligence
 */
class WorkIntelligenceServer {
  private server: Server;
  private db: Database.Database;
  private anthropicApiKey?: string;
  private syncService: SyncService;

  constructor() {
    this.server = new Server(
      {
        name: 'work-intelligence-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize database connection
    this.db = getDatabase();

    // Get Anthropic API key from environment
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    // Set up sync service
    this.syncService = new SyncService({
      intervals: { teams: 900_000, email: 900_000, jira: 900_000 },
      retryAttempts: 3,
      retryDelay: 5_000,
    });

    const analyzer = new AIAnalyzer({
      apiKey: this.anthropicApiKey ?? '',
    });
    this.syncService.configure(this.db, analyzer);

    // Register browser-based connectors if BROWSER_PROFILE_PATH is set
    try {
      const session = getBrowserSession();
      this.syncService.registerDataSource('teams', new TeamsBrowserConnector(session));
      this.syncService.registerDataSource('email', new OutlookBrowserConnector(session));
      this.syncService.registerDataSource('jira', createJiraDataSource(session) as import('./services/sync.js').DataSource);
    } catch {
      console.error('[WorkIntelligenceServer] Browser connectors not available (BROWSER_PROFILE_PATH not set)');
    }

    if (!process.env.SKIP_SYNC) {
      this.syncService.start();
    }

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search_messages',
          description: '[DEPRECATED — use wi_search] Search across Teams, Email, and Jira messages by topic and keywords',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Topic to search within',
              },
              keywords: {
                type: 'string',
                description: 'Keywords to search for',
              },
              source: {
                type: 'string',
                enum: ['teams', 'email', 'jira', 'all'],
                description: 'Which source to search',
                default: 'all',
              },
              dateRange: {
                type: 'object',
                properties: {
                  from: { type: 'string', description: 'Start date (ISO format)' },
                  to: { type: 'string', description: 'End date (ISO format)' },
                },
              },
            },
            required: ['topic'],
          },
        },
        {
          name: 'get_action_items',
          description: '[DEPRECATED — use wi_action_items] Get tracked action items with status and owners',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Topic to filter by',
              },
              status: {
                type: 'string',
                enum: ['open', 'in_progress', 'completed', 'all'],
                default: 'open',
              },
              assignee: {
                type: 'string',
                description: 'Filter by assignee name',
              },
            },
            required: ['topic'],
          },
        },
        {
          name: 'get_daily_digest',
          description: '[DEPRECATED — use wi_digest] Get a daily digest of activity for a topic',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'Topic to get digest for',
              },
              date: {
                type: 'string',
                description: 'Date for digest (ISO format, default: today)',
              },
            },
            required: ['topic'],
          },
        },
        {
          name: 'configure_topic',
          description: '[DEPRECATED — use wi_topics] Configure monitoring for a new topic',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Topic name',
              },
              sources: {
                type: 'object',
                properties: {
                  teams: {
                    type: 'object',
                    properties: {
                      channels: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Teams channel IDs to monitor',
                      },
                    },
                  },
                  email: {
                    type: 'object',
                    properties: {
                      filters: {
                        type: 'string',
                        description: 'Email search filter',
                      },
                    },
                  },
                  jira: {
                    type: 'object',
                    properties: {
                      projects: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Jira project keys',
                      },
                    },
                  },
                },
              },
            },
            required: ['name', 'sources'],
          },
        },
        {
          name: 'get_jira_report',
          description: '[DEPRECATED — use wi_jira_get] Fetch and analyze a Jira project board. Returns a structured team report with issues grouped by status, assignee breakdown, linked Bitbucket PRs, and an AI summary.',
          inputSchema: {
            type: 'object',
            properties: {
              projectKey: {
                type: 'string',
                description: 'Jira project key, e.g. "PROJ"',
              },
              boardUrl: {
                type: 'string',
                description: 'Full URL to the Jira board (RapidBoard or issue navigator)',
              },
              since: {
                type: 'string',
                description: 'ISO date — only include issues updated on/after this date (default: 30 days ago)',
              },
              topicName: {
                type: 'string',
                description: 'DB topic name for caching (default: projectKey)',
              },
            },
            required: ['projectKey', 'boardUrl'],
          },
        },
        {
          name: 'get_teams_updates',
          description: '[DEPRECATED — use wi_teams] Search Teams messages and meeting transcripts by keyword, topic, or question. Returns matching messages grouped by chat, related meetings with decisions, and an AI summary.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Keyword, topic, sentence or question to search for',
              },
              since: {
                type: 'string',
                description: 'Only return results from this date onwards (ISO format, e.g. "2026-01-01")',
              },
              includeMeetings: {
                type: 'boolean',
                description: 'Include meeting transcripts in search (default: true)',
                default: true,
              },
              maxResults: {
                type: 'number',
                description: 'Max results to return before summarizing (default: 50)',
                default: 50,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_all',
          description: '[DEPRECATED — use wi_search] Search a keyword, sentence, or topic across Outlook email, Jira, and Teams. Fetches live from Outlook and Jira, stores everything, then returns AI-summarized results grouped by source.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Keyword, sentence, topic, or question to search for',
              },
              sources: {
                type: 'array',
                items: { type: 'string', enum: ['email', 'jira', 'teams'] },
                description: 'Which sources to search (default: all three)',
              },
              since: {
                type: 'string',
                description: 'Only return results from this date onwards (ISO format, default: 7 days ago)',
              },
              jiraBoardUrl: {
                type: 'string',
                description: 'Jira board URL — falls back to JIRA_BOARD_URL env var',
              },
              outlookFolder: {
                type: 'string',
                description: 'Outlook folder to search (default: inbox)',
              },
              maxResults: {
                type: 'number',
                description: 'Max results per source (default: 50)',
                default: 50,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'ask_topic_expert',
          description: '[DEPRECATED — use wi_topics] Ask a natural language question about a project or topic. Searches Jira, GitHub, Teams, and Email to synthesize a rich answer with narrative summary, key decisions, open items, open PRs, and participants.',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'Natural language question, e.g. "What\'s happening with authentication?"',
              },
              projectKey: {
                type: 'string',
                description: 'Optional Jira project key to anchor the search (e.g. "PROJ")',
              },
              topicName: {
                type: 'string',
                description: 'Optional topic label for the report header',
              },
              sources: {
                type: 'array',
                items: { type: 'string', enum: ['jira', 'teams', 'email', 'github'] },
                description: 'Which sources to search (default: all four)',
              },
              since: {
                type: 'string',
                description: 'Only include content from this date onwards (ISO format, default: uses topic lookback_days)',
              },
              maxResults: {
                type: 'number',
                description: 'Max results per source (default: 50)',
                default: 50,
              },
            },
            required: ['question'],
          },
        },
        {
          name: 'get_topic_suggestions',
          description: '[DEPRECATED — use wi_topics] Returns undismissed topic candidates automatically discovered by clustering recent messages. Suggestions appear when ≥ 10 messages from ≥ 3 authors share a keyword that is not already a configured topic.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'dismiss_topic_suggestion',
          description: '[DEPRECATED — use wi_topics] Dismiss a topic suggestion so it no longer appears in get_topic_suggestions.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'number', description: 'Suggestion ID from get_topic_suggestions' },
            },
            required: ['id'],
          },
        },
        {
          name: 'get_context',
          description:
            'Get the current Unified Brain context: sprint status, stuck Jiras, noise clusters, ' +
            'calendar events, open investigations, relevant memory, and stale-data warnings. ' +
            'TTL-cached (60 s warm, < 100 ms). All brain tools share this context as their baseline.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_decision',
          description:
            'Ask the Unified Brain a question and get a structured decision with rationale, ' +
            'evidence, confidence score, next-action recommendations, and alternatives. ' +
            'Decisions are cached by (question, user, UTC day) and persisted for the learning loop.',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'Natural language question, e.g. "What should I work on today?"',
              },
              user: {
                type: 'string',
                description: 'Caller identity (e.g. an internal user ID). Required — prevents cross-user cache collisions.',
              },
              context: {
                type: 'object',
                description: 'Optional caller context (e.g. {"timezone": "Europe/Berlin"})',
              },
            },
            required: ['question', 'user'],
          },
        },
        {
          name: 'verify_claim',
          description:
            'Turn a claim into a verified fact using available adapters ' +
            '(GitHub MCP, Jira MCP, code grep, build logs). ' +
            'Returns verified flag, evidence, confidence, and per-adapter results.',
          inputSchema: {
            type: 'object',
            properties: {
              claim: {
                type: 'string',
                description: 'Claim to verify, e.g. "checkmarx-github-token-401"',
              },
              evidence_needed: {
                type: 'array',
                items: { type: 'string' },
                description: 'Which adapters to use, e.g. ["github_api_check", "jira_status"]',
              },
            },
            required: ['claim'],
          },
        },
        {
          name: 'recall_memory',
          description:
            'Query the palace + SQLite decision history for past patterns similar to a query. ' +
            'Results are ranked by recency × confidence and include outcomes when recorded. ' +
            'Answers "have we seen this pattern before?"',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Pattern or topic to search for in past decisions and memory',
              },
              limit: {
                type: 'number',
                description: 'Max entries to return (default: 10)',
                default: 10,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'record_outcome',
          description:
            'Record the outcome of a brain decision (success / failed / abandoned). ' +
            'Closes the learning loop: writes outcome to brain_decisions and updates palace ' +
            'via the MemoryEnricher decisions wing. Requires a decision_id from get_decision.',
          inputSchema: {
            type: 'object',
            properties: {
              decision_id: {
                type: 'string',
                description: 'Decision ID from a previous get_decision call (e.g. "dec_01HXY...")',
              },
              outcome: {
                type: 'string',
                enum: ['success', 'failed', 'abandoned'],
                description: 'Whether the decision worked out',
              },
              notes: {
                type: 'string',
                description: 'Optional free-text notes on the outcome',
              },
            },
            required: ['decision_id', 'outcome'],
          },
        },
        ...TOOL_MANIFEST.map(entry => ({
          name: entry.name,
          description: entry.description,
          inputSchema: zodToJsonSchema(entry.inputSchema),
        })),
      ],
    }));

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_messages':
            return await this.handleSearchMessages(args);
          case 'get_action_items':
            return await this.handleGetActionItems(args);
          case 'get_daily_digest':
            return await this.handleGetDailyDigest(args);
          case 'configure_topic':
            return await this.handleConfigureTopic(args);
          case 'get_jira_report':
            return await this.handleGetJiraReport(args);
          case 'get_teams_updates':
            return await this.handleGetTeamsUpdates(args);
          case 'search_all':
            return await this.handleSearchAll(args);
          case 'ask_topic_expert':
            return await this.handleAskTopicExpert(args);
          case 'get_topic_suggestions':
            return this.handleGetTopicSuggestions();
          case 'dismiss_topic_suggestion':
            return this.handleDismissTopicSuggestion(args);
          case 'get_context':
            return await this.handleGetContext();
          case 'get_decision':
            return await this.handleGetDecision(args);
          case 'verify_claim':
            return await this.handleVerifyClaim(args);
          case 'recall_memory':
            return await this.handleRecallMemory(args);
          case 'record_outcome':
            return await this.handleRecordOutcome(args);
          default:
            if (name.startsWith('wi_')) {
              const entry = TOOL_MANIFEST.find(e => e.name === name);
              if (!entry) throw new Error(`Unknown tool: ${name}`);
              const handler = buildHandler(entry, {
                consumer: 'mcp',
                getUser: () => process.env['WI_DEFAULT_USER'] || 'mcp',
                budgetCheck: makeMcpBudgetCheck(this.db),
              });
              const result = await handler(args);
              return createTextResponse(JSON.stringify(result, null, 2));
            }
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
        };
      }
    });
  }

  private async handleSearchMessages(args: unknown) {
    try {
      const result = await searchMessages(this.db, args as SearchMessagesArgs);
      const formattedText = formatSearchResults(result, args as SearchMessagesArgs);
      return createTextResponse(formattedText);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleGetActionItems(args: unknown) {
    try {
      const result = await getActionItems(this.db, args as GetActionItemsArgs);
      const formattedText = formatActionItems(result, args as GetActionItemsArgs);
      return createTextResponse(formattedText);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleGetDailyDigest(args: unknown) {
    try {
      const digest = await getDailyDigest(
        this.db,
        args as GetDailyDigestArgs,
        this.anthropicApiKey
      );
      return createTextResponse(digest);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleConfigureTopic(args: unknown) {
    try {
      const result = await configureTopic(this.db, args as ConfigureTopicArgs);
      this.syncService.triggerSync(String(result.topic.id));
      const formattedText = formatTopicConfiguration(result, args as ConfigureTopicArgs);
      return createTextResponse(formattedText);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleGetJiraReport(args: unknown) {
    try {
      if (!process.env.BROWSER_PROFILE_PATH) {
        return createTextResponse(
          '**get_jira_report requires a browser session.**\n\n' +
          'Set `BROWSER_PROFILE_PATH` in your `.env` to the path of your Chrome profile ' +
          '(find it at `chrome://version` → "Profile Path"), then restart the MCP server.'
        );
      }
      const session = getBrowserSession();
      const result = await getJiraReport(
        this.db,
        args as GetJiraReportArgs,
        session,
        this.anthropicApiKey
      );
      return createTextResponse(result.markdown);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleGetTeamsUpdates(args: unknown) {
    try {
      const result = await getTeamsUpdates(
        this.db,
        args as GetTeamsUpdatesArgs,
        this.anthropicApiKey
      );
      return createTextResponse(result);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleSearchAll(args: unknown) {
    try {
      if (!process.env.BROWSER_PROFILE_PATH) {
        return createTextResponse(
          '**search_all requires a browser session for Outlook and Jira live fetch.**\n\n' +
          'Set `BROWSER_PROFILE_PATH` in your `.env` to the path of your Chrome profile ' +
          '(find it at `chrome://version` → "Profile Path"), then restart the MCP server.'
        );
      }
      const session = getBrowserSession();
      const result = await searchAll(
        this.db,
        args as SearchAllArgs,
        session,
        this.anthropicApiKey
      );
      return createTextResponse(result);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleAskTopicExpert(args: unknown) {
    try {
      const result = await askTopicExpert(
        this.db,
        args as AskTopicExpertArgs,
        this.anthropicApiKey
      );
      return createTextResponse(result);
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private handleGetTopicSuggestions() {
    try {
      return createTextResponse(getTopicSuggestions(this.db));
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private handleDismissTopicSuggestion(args: unknown) {
    try {
      const { id } = args as { id: number };
      return createTextResponse(dismissTopicSuggestion(this.db, id));
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleGetContext() {
    try {
      const result = await getBrainContext({} as GetContextArgs);
      return createTextResponse(formatBrainContext(result));
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleGetDecision(args: unknown) {
    try {
      const result = await getBrainDecision(args as GetDecisionArgs);
      return createTextResponse(formatDecisionResult(result));
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleVerifyClaim(args: unknown) {
    try {
      const result = await verifyBrainClaim(args as VerifyClaimArgs);
      return createTextResponse(formatVerificationResult(result));
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleRecallMemory(args: unknown) {
    try {
      const result = await recallBrainMemory(args as RecallMemoryArgs);
      return createTextResponse(formatRecallResult(result));
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private async handleRecordOutcome(args: unknown) {
    try {
      const result = await recordBrainOutcome(args as RecordOutcomeArgs);
      return createTextResponse(formatLearnResult(result));
    } catch (error) {
      return createErrorResponse(error as Error);
    }
  }

  private setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    const cleanup = async () => {
      try {
        this.syncService.stop();
        closeDatabase();
        await this.server.close();
      } catch (error) {
        console.error('[Cleanup Error]', error);
      }
    };

    process.on('SIGINT', async () => {
      await cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await cleanup();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Work Intelligence MCP server running on stdio');
  }
}

// Start the server
const server = new WorkIntelligenceServer();
server.run().catch(console.error);
