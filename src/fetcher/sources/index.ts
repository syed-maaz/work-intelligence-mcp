/**
 * Generic API connector barrel — Slack + Linear.
 *
 * First generic (non-browser, non-MCP) connectors for OSS WI. Both are pure
 * fetch adapters that normalize into UnifiedMessage[] (MessageSource.Slack /
 * MessageSource.Linear) following the GitHub connector pattern. Future generic
 * connectors (GitLab, Notion, etc.) export from here too.
 */

export { fetchSlackMessages } from './slack.js';
export type { SlackFetchOptions } from './slack.js';

export { fetchLinearIssues } from './linear.js';
export type { LinearFetchOptions } from './linear.js';
