/**
 * Universal MCP OAuth Client (EP-46 — headless daemon)
 *
 * Owns the full OAuth 2.1 + PKCE + Dynamic Client Registration lifecycle
 * for any remote HTTP MCP server (jira, github-tools, etc.).
 *
 * Completely independent of Claude Code's session — no subprocess, no keychain
 * dependency, no browser profile. Works headlessly after one-time setup.
 *
 * ## Token storage
 * Tokens are stored in the SQLite DB table `mcp_oauth_tokens` (schema v26).
 * The setup script (`npm run mcp-setup`) does the initial PKCE flow and
 * writes the first refresh token. Auto-refresh handles the rest indefinitely.
 *
 * ## Adding a new MCP server
 * 1. Run: `npm run mcp-setup -- --name github --url https://mcp.example.com/github`
 * 2. Open the printed OAuth URL in your browser
 * 3. Done — MCP calls work immediately, token refreshes automatically
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Token storage (SQLite)
// ---------------------------------------------------------------------------

export interface McpOAuthToken {
  serverName: string;        // e.g. "jira"
  serverUrl: string;         // e.g. "https://mcp.jira.example.com/mcp"
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;         // ms since epoch
  scope: string;
}

/** Read stored token for a named MCP server */
export function getStoredToken(db: Database.Database, serverName: string): McpOAuthToken | null {
  const row = db.prepare(
    `SELECT * FROM mcp_oauth_tokens WHERE server_name = ?`
  ).get(serverName) as Record<string, unknown> | undefined;

  if (!row) return null;
  return {
    serverName: row.server_name as string,
    serverUrl: row.server_url as string,
    clientId: row.client_id as string,
    accessToken: row.access_token as string,
    refreshToken: row.refresh_token as string,
    expiresAt: row.expires_at as number,
    scope: row.scope as string,
  };
}

/** Write / update token for a named MCP server */
export function saveToken(db: Database.Database, token: McpOAuthToken): void {
  db.prepare(`
    INSERT INTO mcp_oauth_tokens
      (server_name, server_url, client_id, access_token, refresh_token, expires_at, scope, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(server_name) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      client_id = excluded.client_id,
      updated_at = unixepoch()
  `).run(
    token.serverName, token.serverUrl, token.clientId,
    token.accessToken, token.refreshToken, token.expiresAt, token.scope
  );
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  grant_types_supported?: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/** Fetch OAuth metadata from well-known endpoint */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata> {
  const base = new URL(serverUrl).origin;
  const resp = await fetch(`${base}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`OAuth metadata fetch failed: ${resp.status}`);
  return resp.json() as Promise<OAuthMetadata>;
}

/** Register a new OAuth client via Dynamic Client Registration */
export async function registerClient(
  registrationEndpoint: string,
  clientName: string,
  redirectUri: string
): Promise<{ client_id: string }> {
  const resp = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client — uses PKCE
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Client registration failed (${resp.status}): ${body}`);
  }
  return resp.json() as Promise<{ client_id: string }>;
}

/** Exchange auth code for tokens (PKCE) */
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }
  return resp.json() as Promise<TokenResponse>;
}

/** Refresh an expired access token */
export async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string
): Promise<TokenResponse> {
  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${body}. Run: npm run mcp-setup -- --name <server>`);
  }
  return resp.json() as Promise<TokenResponse>;
}

// ---------------------------------------------------------------------------
// McpClient — main class for calling MCP tools
// ---------------------------------------------------------------------------

export class McpClient {
  private readonly MCP_URL: string;

  constructor(
    private readonly db: Database.Database,
    private readonly serverName: string,
    serverUrl?: string,
    private readonly staticHeaders?: Record<string, string>
  ) {
    const stored = staticHeaders ? null : getStoredToken(db, serverName);
    this.MCP_URL = serverUrl ?? stored?.serverUrl ?? '';
    if (!this.MCP_URL) {
      throw new Error(`McpClient: no server URL for "${serverName}". Run: npm run mcp-setup -- --name ${serverName}`);
    }
  }

  /** Build request headers — uses staticHeaders if provided, otherwise OAuth Bearer token */
  private async getHeaders(): Promise<Record<string, string>> {
    if (this.staticHeaders) {
      return {
        ...this.staticHeaders,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      };
    }
    const token = await this.getAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
  }

  /** Get a valid access token, auto-refreshing if needed */
  async getAccessToken(): Promise<string> {
    const token = getStoredToken(this.db, this.serverName);
    if (!token) {
      throw new Error(
        `No OAuth token for "${this.serverName}". Run: npm run mcp-setup -- --name ${this.serverName} --url <mcp-url>`
      );
    }

    const bufferMs = 60_000; // refresh 60s before expiry
    if (token.expiresAt - Date.now() > bufferMs) {
      return token.accessToken; // still valid
    }

    // Refresh
    process.stderr.write(`[McpClient:${this.serverName}] Token expired, refreshing...\n`);
    const meta = await discoverOAuthMetadata(this.MCP_URL);
    const refreshed = await refreshAccessToken(meta.token_endpoint, token.refreshToken, token.clientId);

    const updated: McpOAuthToken = {
      ...token,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
    saveToken(this.db, updated);
    process.stderr.write(`[McpClient:${this.serverName}] Token refreshed, valid for ${refreshed.expires_in}s\n`);
    return updated.accessToken;
  }

  /** Call an MCP tool and return the text result */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const headers = await this.getHeaders();

    const resp = await fetch(this.MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`MCP HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }

    const raw = await resp.text();
    return this.parseSseResponse(raw, toolName);
  }

  /** List available tools on this MCP server */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const headers = await this.getHeaders();

    const resp = await fetch(this.MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) throw new Error(`MCP tools/list failed: ${resp.status}`);
    const raw = await resp.text();
    const text = this.parseSseResponse(raw, 'tools/list');
    try {
      const parsed = JSON.parse(text) as { tools?: Array<{ name: string; description: string }> };
      return parsed.tools ?? [];
    } catch {
      return [];
    }
  }

  private parseSseResponse(raw: string, toolName: string): string {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const envelope = JSON.parse(line.slice(5)) as {
        result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean; tools?: unknown };
        error?: { message: string };
      };
      if (envelope.error) throw new Error(`MCP error in ${toolName}: ${envelope.error.message}`);

      // tools/list returns result directly
      if (envelope.result?.tools) return JSON.stringify({ tools: envelope.result.tools });

      const content = envelope.result?.content ?? [];
      const textBlock = content.find(c => c.type === 'text');
      if (!textBlock?.text) throw new Error(`MCP ${toolName}: no text content in response`);
      if (envelope.result?.isError) throw new Error(`${toolName} error: ${textBlock.text.slice(0, 200)}`);
      return textBlock.text;
    }
    throw new Error(`MCP ${toolName}: no data line in SSE response. Raw: ${raw.slice(0, 200)}`);
  }
}
