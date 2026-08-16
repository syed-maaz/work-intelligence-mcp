/**
 * ADR-044 S2.5 — ConnectorAdapter interface + registry.
 *
 * STEP 11 (OSS release): every connector is a self-describing adapter. The
 * connector registry (src/services/connector-registry.ts) dispatches purely
 * off the ADAPTERS array — adding a connector no longer touches a switch.
 * Each adapter WRAPS the existing source-spec builder (never re-implements
 * it) and mirrors capabilities.json for capabilities/modes so the manifest
 * and the registry cannot drift silently (manifest-parity.test.ts enforces).
 */

import type Database from 'better-sqlite3';
import type { SourceSpec } from '../orchestrator.js';
import {
  jiraSourceSpecs,
  githubSourceSpecs,
  outlookSourceSpecs,
  teamsSourceSpecs,
  slackSourceSpecs,
  linearSourceSpecs,
} from '../../services/connector-registry.js';

/** Everything an adapter needs to build SourceSpecs for its connector. */
export interface AdapterContext {
  db: Database.Database;
  since?: Date;
  config: any;
}

export interface ConnectorAdapter {
  name: string;
  displayName: string;
  modes: string[];
  capabilities: string[];
  requiredEnv: string[];
  dataIngested: string[];
  buildSourceSpecs(ctx: AdapterContext): SourceSpec[];
}

/**
 * Per-connector adapters. `buildSourceSpecs` DELEGATES to the real builders
 * (jiraSourceSpecs(since?), githubSourceSpecs(db, since?),
 * outlookSourceSpecs(since?), teamsSourceSpecs(db, since?), slack/linear take
 * no args) — the bodies live in connector-registry.ts and are not retyped
 * here. capabilities/modes match capabilities.json exactly.
 */
export const jiraAdapter: ConnectorAdapter = {
  name: 'jira',
  displayName: 'Jira',
  modes: ['mcp', 'browser', 'both'],
  capabilities: ['issues', 'board', 'transitions', 'sprint', 'my-issues'],
  requiredEnv: ['JIRA_MCP_TOKEN'],
  dataIngested: ['issues', 'transitions', 'sprint_config'],
  buildSourceSpecs(ctx) {
    return jiraSourceSpecs(ctx.since);
  },
};

export const githubAdapter: ConnectorAdapter = {
  name: 'github',
  displayName: 'GitHub',
  modes: ['api', 'mcp', 'both'],
  capabilities: ['prs', 'issues', 'commits', 'search'],
  requiredEnv: ['GITHUB_TOKEN'],
  dataIngested: ['prs', 'commits'],
  buildSourceSpecs(ctx) {
    return githubSourceSpecs(ctx.db, ctx.since);
  },
};

export const slackAdapter: ConnectorAdapter = {
  name: 'slack',
  displayName: 'Slack',
  modes: ['api'],
  capabilities: ['messages', 'channels'],
  requiredEnv: ['SLACK_TOKEN'],
  dataIngested: ['messages'],
  buildSourceSpecs() {
    return slackSourceSpecs();
  },
};

export const linearAdapter: ConnectorAdapter = {
  name: 'linear',
  displayName: 'Linear',
  modes: ['api'],
  capabilities: ['issues', 'projects', 'cycles'],
  requiredEnv: ['LINEAR_API_KEY'],
  dataIngested: ['issues'],
  buildSourceSpecs() {
    return linearSourceSpecs();
  },
};

export const teamsAdapter: ConnectorAdapter = {
  name: 'teams',
  displayName: 'Microsoft Teams',
  modes: ['browser'],
  capabilities: ['chats', 'meetings', 'updates'],
  requiredEnv: ['BROWSER_PROFILE_PATH'],
  dataIngested: ['chats', 'meetings'],
  buildSourceSpecs(ctx) {
    return teamsSourceSpecs(ctx.db, ctx.since);
  },
};

export const outlookAdapter: ConnectorAdapter = {
  name: 'outlook',
  displayName: 'Outlook',
  modes: ['browser'],
  capabilities: ['mail', 'calendar'],
  requiredEnv: ['BROWSER_PROFILE_PATH'],
  dataIngested: ['mail', 'calendar'],
  buildSourceSpecs(ctx) {
    return outlookSourceSpecs(ctx.since);
  },
};

/** The registry's single source of truth: add a connector here, not in a switch. */
export const ADAPTERS: ConnectorAdapter[] = [
  jiraAdapter,
  githubAdapter,
  outlookAdapter,
  teamsAdapter,
  slackAdapter,
  linearAdapter,
];