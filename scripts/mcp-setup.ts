#!/usr/bin/env node
/**
 * MCP OAuth Setup — one-time PKCE authentication for any HTTP MCP server.
 *
 * Usage:
 *   npm run mcp-setup -- --name my-jira --url https://mcp.example.com/jira
 *   npm run mcp-setup -- --name my-github --url https://mcp.example.com/github
 *
 * What it does:
 *   1. Registers a new OAuth client via Dynamic Client Registration
 *   2. Opens a local callback server on port 3999
 *   3. Prints the authorization URL — open it in your browser
 *   4. Captures the callback, exchanges code for tokens
 *   5. Saves tokens to SQLite DB (mcp_oauth_tokens table)
 *
 * After this runs once, McpClient handles all token refreshes automatically.
 */

import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { getDatabase } from '../src/db/connection.js';
import {
  discoverOAuthMetadata,
  registerClient,
  exchangeCodeForTokens,
  saveToken,
  getStoredToken,
} from '../src/fetcher/sources/mcp-oauth-client.js';

// ---------------------------------------------------------------------------
// Preflight: Node ABI guard. better-sqlite3 (loaded by getDatabase() below) is
// a native module compiled against a specific Node ABI. If this script runs on
// the wrong Node major, `new Database()` throws a raw ERR_DLOPEN_FAILED stack
// trace (NODE_MODULE_VERSION mismatch) that's opaque to a first-time reader.
// The repo pins its Node in .nvmrc; a common trap is a shell whose `node`
// resolves to a different install (e.g. a Hermes/system Node shadowing nvm).
// Fail fast here with the exact fix instead of a dlopen trace. Guard only —
// never blocks a matching version.
// ---------------------------------------------------------------------------
{
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  let pinnedMajor: number | null = null;
  try {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const here = dirname(fileURLToPath(import.meta.url));
    pinnedMajor = Number(readFileSync(join(here, '..', '.nvmrc'), 'utf8').trim().replace(/^v/, '').split('.')[0]);
  } catch { /* no .nvmrc → skip the guard */ }

  if (pinnedMajor && Number.isFinite(pinnedMajor) && nodeMajor !== pinnedMajor) {
    console.error(
      `\n❌ Node version mismatch: running v${process.versions.node}, but this repo needs Node ${pinnedMajor} (.nvmrc).\n` +
      `   better-sqlite3 is compiled for the Node ${pinnedMajor} ABI — it will crash with ERR_DLOPEN_FAILED otherwise.\n\n` +
      `   Fix (run one, then re-run this command):\n` +
      `     • nvm use ${pinnedMajor}\n` +
      `     • or: export PATH="$HOME/.nvm/versions/node/v${pinnedMajor}.7.0/bin:$PATH"\n`,
    );
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Preflight: confirm callback port is free BEFORE we register an OAuth client.
//
// If a previous mcp-setup run was abandoned mid-flow (browser tab closed,
// Ctrl-C didn't fire cleanup, terminal closed), it leaves a Node process
// squatting on port 3999. Without this check we'd burn a Dynamic Client
// Registration round-trip and only crash on `server.listen()` AFTER printing
// an auth URL the user might be tempted to click — and that URL's state
// would be invalid against the now-dead listener.
//
// Surface the squatting PID via `lsof` (best-effort; no-op if unavailable)
// so the user knows what to kill.
// ---------------------------------------------------------------------------

function findSquattingPid(port: number): string | null {
  try {
    const out = execSync(`lsof -ti :${port}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out || null;
  } catch {
    // lsof not present, port not bound, or otherwise — caller will hit
    // the EADDRINUSE path with a clear message anyway.
    return null;
  }
}

async function ensurePortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const pid = findSquattingPid(port);
        const hint = pid
          ? `\n  → A process (pid ${pid}) is already listening on port ${port}.`
            + `\n  → Likely a previous mcp-setup run that didn't complete the browser callback.`
            + `\n  → Kill it: kill ${pid}    (or: kill -9 ${pid} if it ignores SIGTERM)`
            + `\n  → Then re-run this command.`
          : `\n  → Port ${port} is in use but lsof isn't available to identify the holder.`
            + `\n  → Free the port (or pass --port <other> to use a different one) and retry.`;
        reject(new Error(`Callback port ${port} is already in use.${hint}`));
        return;
      }
      reject(err);
    });
    probe.once('listening', () => {
      probe.close(() => resolve());
    });
    probe.listen(port);
  });
}

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
};

const serverName = getArg('name');
const serverUrl = getArg('url');
const callbackPort = parseInt(getArg('port') ?? '3999', 10);

if (!serverName || !serverUrl) {
  console.error('Usage: npm run mcp-setup -- --name <server-name> --url <mcp-url>');
  console.error('Example: npm run mcp-setup -- --name my-jira --url https://mcp.example.com/jira');
  process.exit(1);
}

const REDIRECT_URI = `http://localhost:${callbackPort}/callback`;
const CLIENT_NAME = `work-intelligence-${serverName}`;

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

console.log(`\nMCP OAuth Setup — ${serverName}`);
console.log(`Server: ${serverUrl}`);
console.log('');

const db = getDatabase();

// Check if already set up
const existing = getStoredToken(db, serverName);
if (existing && existing.expiresAt > Date.now()) {
  console.log(`✅ Already authenticated (token valid until ${new Date(existing.expiresAt).toLocaleTimeString()})`);
  console.log('Re-run with --force to re-authenticate');
  if (!args.includes('--force')) process.exit(0);
}

// Preflight: callback port must be free BEFORE we register an OAuth client.
// (See comment block above ensurePortFree for rationale.)
try {
  await ensurePortFree(callbackPort);
} catch (err) {
  console.error(`\n❌ ${(err as Error).message}\n`);
  process.exit(2);
}

// Step 1: Discover OAuth metadata
console.log('Step 1: Discovering OAuth metadata...');
const meta = await discoverOAuthMetadata(serverUrl);
console.log(`  token_endpoint: ${meta.token_endpoint}`);
console.log(`  registration: ${meta.registration_endpoint ? '✅' : '❌ not supported'}`);

if (!meta.registration_endpoint) {
  console.error('This server does not support Dynamic Client Registration.');
  console.error('Provide client_id manually via --client-id flag (not yet implemented).');
  process.exit(1);
}

// Step 2: Register OAuth client
console.log('\nStep 2: Registering OAuth client...');
const { client_id } = await registerClient(meta.registration_endpoint, CLIENT_NAME, REDIRECT_URI);
console.log(`  client_id: ${client_id}`);

// Step 3: Generate PKCE and build auth URL
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');

const authUrl = new URL(meta.authorization_endpoint ?? `${new URL(serverUrl).origin}/authorize`);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', client_id);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('code_challenge', challenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('scope', 'mcp');
authUrl.searchParams.set('resource', serverUrl);

console.log('\n┌─────────────────────────────────────────────────────────┐');
console.log('│  Open this URL in your browser to authenticate:         │');
console.log('└─────────────────────────────────────────────────────────┘');
console.log(authUrl.toString());
console.log('');
console.log(`Waiting for callback on http://localhost:${callbackPort}/callback ...`);

// Step 4: Start callback server and wait for redirect
await new Promise<void>((resolve, reject) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${callbackPort}`);
    if (url.pathname !== '/callback') { res.end(); return; }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.end(`<h1>Error: ${error}</h1>`);
      server.close();
      reject(new Error(`OAuth error: ${error}`));
      return;
    }

    if (!code) { res.end('<h1>No code received</h1>'); return; }
    if (returnedState !== state) { res.end('<h1>State mismatch</h1>'); return; }

    res.end('<h1>✅ Authentication successful! You can close this tab.</h1>');
    server.close();

    try {
      // Step 5: Exchange code for tokens
      console.log('\nExchanging authorization code for tokens...');
      const tokens = await exchangeCodeForTokens(
        meta.token_endpoint, code, client_id, REDIRECT_URI, verifier
      );

      if (!tokens.access_token) throw new Error('No access_token in response');

      // Step 6: Save to DB
      saveToken(db, {
        serverName,
        serverUrl,
        clientId: client_id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? '',
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scope: 'mcp',
      });

      console.log(`\n✅ Authentication successful!`);
      console.log(`   Token valid for: ${tokens.expires_in}s (~${Math.round(tokens.expires_in / 60)} min)`);
      console.log(`   Refresh token: ${tokens.refresh_token ? '✅ stored' : '❌ not provided'}`);
      console.log(`   Saved to DB as: "${serverName}"`);
      console.log('');
      console.log('Done. web-server.js will now use this token automatically.');
      console.log('Token auto-refreshes — no further action needed.\n');

      resolve();
    } catch (err) {
      reject(err);
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    // The preflight should have caught EADDRINUSE already, but a race window
    // exists between probe close and main bind, so re-emit the helpful hint
    // here too rather than dump a raw stack trace.
    if (err.code === 'EADDRINUSE') {
      const pid = findSquattingPid(callbackPort);
      const hint = pid
        ? ` (pid ${pid} grabbed it between preflight and main bind — kill ${pid} and retry)`
        : '';
      reject(new Error(`Callback port ${callbackPort} is in use${hint}.`));
      return;
    }
    reject(err);
  });
  server.listen(callbackPort);
});

process.exit(0);
