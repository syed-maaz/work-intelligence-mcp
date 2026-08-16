// @vitest-environment node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// PalaceClient v2 — Phase 58 Wave 1
// Wraps MemPalace Python functions via persistent MCP child process using
// StdioClientTransport. Eliminates 594ms/call execFileSync blocking.
//
// All methods are no-ops when MemPalace is not installed or the palace path
// does not exist (graceful degradation).
// ---------------------------------------------------------------------------

// Module-level singleton: register signal handlers ONCE, maintain active client set
const activeClients = new Set<PalaceClient>();
let _handlersRegistered = false;

function _registerGlobalHandlers(): void {
  if (_handlersRegistered) return;
  _handlersRegistered = true;

  process.on('exit', () => {
    for (const c of activeClients) {
      try { void c['transport']?.close(); } catch { /* ignore on exit */ }
    }
  });

  const gracefulShutdown = () => {
    for (const c of activeClients) {
      c.shutdown().catch(() => { /* ignore */ });
    }
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

/**
 * Resolves the Python executable and args prefix to use for launching mempalace.
 * Returns null if mempalace is not available.
 */
function resolvePython(): { command: string; baseArgs: string[] } | null {
  // 1. Explicit env var override
  const envPython = process.env.MEMPALACE_PYTHON;
  if (envPython) {
    return { command: envPython, baseArgs: ['-m', 'mempalace.mcp_server'] };
  }

  // 2. Try `mempalace` CLI — extract its shebang Python for the MCP server
  try {
    const mempalaceBin = execFileSync('which', ['mempalace'], { timeout: 5_000, stdio: 'pipe' }).toString().trim();
    const shebang = readFileSync(mempalaceBin, 'utf-8').split('\n')[0];
    const pythonMatch = shebang.match(/^#!(.+)/);
    if (pythonMatch) {
      const pythonPath = pythonMatch[1].trim();
      return { command: pythonPath, baseArgs: ['-m', 'mempalace.mcp_server'] };
    }
  } catch {
    // not found via which or shebang unreadable
  }

  // 3. Try `python3 -m mempalace.mcp_server`
  try {
    execFileSync('python3', ['-m', 'mempalace.mcp_server', '--help'], {
      timeout: 5_000,
      stdio: 'pipe',
    });
    return { command: 'python3', baseArgs: ['-m', 'mempalace.mcp_server'] };
  } catch {
    // not available
  }

  return null;
}

export class PalaceClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly available: boolean;
  private connected: boolean = false;
  private connecting: Promise<void> | null = null;
  private readonly palacePath: string;
  private readonly command: string | null;
  private readonly baseArgs: string[];

  // Health / observability
  private callCount: number = 0;
  private lastError: string | null = null;
  private startedAt: number = 0;

  // EP-59: Retrieval hit rate counters
  private palaceHits: number = 0;
  private totalQueries: number = 0;

  // EP-59: Graph cache (59-C5: 5-min TTL)
  private graphCache: string | null = null;
  private graphCacheTime: number = 0;
  private readonly GRAPH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Restart state
  private restartCount: number = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_BACKOFF_MS = 30_000;

  constructor(palacePath: string) {
    this.palacePath = palacePath;
    const resolved = resolvePython();
    this.command = resolved?.command ?? null;
    this.baseArgs = resolved?.baseArgs ?? [];
    this.available = this.command !== null && existsSync(palacePath);

    // Register module-level handlers (once) and track this instance
    _registerGlobalHandlers();
    activeClients.add(this);
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        // Strip PYTHONPATH/PYTHONHOME from the child env. MemPalace runs under
        // its own uv-managed Python 3.13 (`~/.local/share/uv/tools/mempalace/…`);
        // inheriting Hermes/Cursor/other-tool Python 3.11 paths from the parent
        // process poisons sys.path and produces:
        //   ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'
        // (a Python 3.11-compiled C-extension loaded into a 3.13 process).
        // See ADR-047 D2 and the palace-offline TC-10 invariant.
        const { PYTHONPATH: _unused_pp, PYTHONHOME: _unused_ph, ...cleanEnv } = process.env;

        const serverParams = {
          command: this.command!,
          args: [...this.baseArgs, '--palace', this.palacePath],
          stderr: 'pipe' as const,
          env: cleanEnv as Record<string, string>,
        };

        this.transport = new StdioClientTransport(serverParams);
        this.client = new Client({ name: 'work-intelligence-mcp', version: '1.0.0' });

        // Wire up transport events
        this.transport.onclose = () => {
          this.connected = false;
          this.scheduleRestart();
        };

        this.transport.onerror = (err: Error) => {
          process.stderr.write(`[palace-client] transport error: ${err.message?.slice(0, 200)}\n`);
        };

        // Pipe child stderr to parent stderr
        const stderrStream = this.transport.stderr;
        if (stderrStream) {
          stderrStream.on('data', (chunk: Buffer | string) => {
            process.stderr.write('[palace-stderr] ' + chunk.toString());
          });
        }

        await this.client.connect(this.transport);

        this.connected = true;
        this.startedAt = Date.now();
        this.restartCount = 0;
      } catch (err) {
        this.lastError = (err as Error).message?.slice(0, 200) ?? 'unknown';
        this.connected = false;
        this.client = null;
        this.transport = null;
        process.stderr.write(`[palace-client] connection failed: ${this.lastError}\n`);
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  private scheduleRestart(): void {
    if (!this.available) return;
    const delay = Math.min(1000 * Math.pow(2, this.restartCount), this.MAX_BACKOFF_MS);
    this.restartCount++;
    process.stderr.write(
      `[palace-client] scheduling restart in ${delay}ms (attempt ${this.restartCount})\n`
    );
    this.restartTimer = setTimeout(() => {
      this.connect().catch((err: Error) => {
        process.stderr.write(`[palace-client] restart failed: ${err.message?.slice(0, 200)}\n`);
      });
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Internal tool call dispatcher
  // ---------------------------------------------------------------------------

  private async _callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.available) return '';

    await this.connect();

    if (!this.connected || !this.client) return '';

    try {
      this.callCount++;
      const result = await this.client.callTool({ name, arguments: args });
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
      const text = content?.find((c) => c.type === 'text')?.text ?? '';
      return text;
    } catch (err) {
      this.lastError = (err as Error).message?.slice(0, 200) ?? 'unknown';
      process.stderr.write(`[palace-client] callTool(${name}) error: ${this.lastError}\n`);
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — identical signatures to v1
  // ---------------------------------------------------------------------------

  /**
   * Search the palace for semantically similar content.
   * @returns JSON string from MemPalace search results, or '' on error/unavailable.
   */
  async search(query: string, wing?: string, limit = 5): Promise<string> {
    return this._callTool('mempalace_search', {
      query,
      limit,
      ...(wing ? { wing } : {}),
    });
  }

  /**
   * Query the knowledge graph for an entity and its relationships.
   * @returns JSON string with triples, or '' on error/unavailable.
   */
  async kgQuery(entity: string, predicate?: string): Promise<string> {
    return this._callTool('mempalace_kg_query', {
      entity,
      ...(predicate ? { direction: predicate } : {}),
    });
  }

  /**
   * Add a triple to the knowledge graph.
   * Idempotent — running with the same triple twice is safe.
   */
  async kgAdd(subject: string, predicate: string, object: string, start?: string): Promise<void> {
    await this._callTool('mempalace_kg_add', {
      subject,
      predicate,
      object,
      ...(start ? { valid_from: start } : {}),
    });
  }

  /**
   * Invalidate (soft-delete) a triple in the knowledge graph.
   * Sets valid_to to mark the triple as no longer current.
   */
  async kgInvalidate(
    subject: string,
    predicate: string,
    object: string,
    ended?: string
  ): Promise<void> {
    await this._callTool('mempalace_kg_invalidate', {
      subject,
      predicate,
      object,
      ...(ended ? { valid_to: ended } : {}),
    });
  }

  /**
   * Add a drawer (document) to the palace.
   * @param wing    Top-level namespace (e.g. 'investigations')
   * @param room    Category within the wing (e.g. 'config-change')
   * @param content JSON/text content to store
   * @param label   Optional label used as source_file identifier
   */
  async addDrawer(wing: string, room: string, content: string, label?: string): Promise<void> {
    await this._callTool('mempalace_add_drawer', {
      wing,
      room,
      content,
      ...(label ? { source_file: label } : {}),
    });
  }

  /**
   * Write a diary entry (structured log for an agent).
   * @param agent  Agent identifier (e.g. 'investigator')
   * @param entry  Free-text diary entry
   * @param topic  Topic/tag for the entry (e.g. issue key)
   */
  async diaryWrite(agent: string, entry: string, topic: string): Promise<void> {
    await this._callTool('mempalace_diary_write', {
      agent_name: agent,
      entry,
      topic,
    });
  }

  /**
   * Read recent diary entries for an agent.
   * @returns JSON string with diary entries, or '' on error/unavailable.
   */
  async diaryRead(agent: string, n = 10): Promise<string> {
    return this._callTool('mempalace_diary_read', {
      agent_name: agent,
      last_n: n,
    });
  }

  /**
   * Traverse the knowledge graph starting from an entity.
   * Uses cached graph with 5-min TTL. maxHops default from PALACE_MAX_HOPS env or 2.
   * maxNodes=15 safety cap (client-side slice).
   * @returns JSON string with traversal paths, or '' on error/unavailable.
   */
  async traverse(
    entity: string,
    _maxHops: number = parseInt(process.env.PALACE_MAX_HOPS || '2', 10),
    maxNodes: number = 15
  ): Promise<string> {
    const now = Date.now();

    // Use cached graph if fresh
    if (this.graphCache && (now - this.graphCacheTime) < this.GRAPH_CACHE_TTL_MS) {
      return this.graphCache;
    }

    const raw = await this._callTool('mempalace_kg_query', { entity });
    if (!raw) return '';

    // Client-side cap at maxNodes
    try {
      const parsed = JSON.parse(raw);
      const triples = Array.isArray(parsed) ? parsed : (parsed.triples || parsed.results || []);
      const capped = triples.slice(0, maxNodes);
      const result = JSON.stringify(capped);

      // Cache the result
      this.graphCache = result;
      this.graphCacheTime = now;

      return result;
    } catch {
      return raw; // Return raw if not parseable
    }
  }

  /** Invalidate graph cache (call after sync completion). */
  invalidateGraphCache(): void {
    this.graphCache = null;
    this.graphCacheTime = 0;
  }

  /**
   * Call an arbitrary palace tool by name. Used by health/observability endpoints.
   * Returns raw JSON string from the tool, or '' on error/unavailable.
   */
  async callToolRaw(name: string, args: Record<string, unknown>): Promise<string> {
    return this._callTool(name, args);
  }

  // ---------------------------------------------------------------------------
  // EP-59: Retrieval hit rate tracking
  // ---------------------------------------------------------------------------

  /**
   * Record a palace retrieval query result for hit rate tracking.
   * Called by chat handlers after each palace search attempt.
   */
  recordQuery(hadResults: boolean): void {
    this.totalQueries++;
    if (hadResults) this.palaceHits++;
  }

  // ---------------------------------------------------------------------------
  // Health accessors (for Wave 5 dashboard)
  // ---------------------------------------------------------------------------

  get isConnected(): boolean {
    return this.connected;
  }

  get uptime(): number {
    return this.connected ? Date.now() - this.startedAt : 0;
  }

  get stats(): { connected: boolean; uptime: number; callCount: number; lastError: string | null; palaceHits: number; totalQueries: number; retrievalHitRate: number } {
    return {
      connected: this.connected,
      uptime: this.uptime,
      callCount: this.callCount,
      lastError: this.lastError,
      palaceHits: this.palaceHits,
      totalQueries: this.totalQueries,
      retrievalHitRate: this.totalQueries > 0 ? this.palaceHits / this.totalQueries : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    activeClients.delete(this);
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore close errors
      }
    }
    this.connected = false;
    this.client = null;
    this.transport = null;
  }
}
