/**
 * Services Index
 *
 * Exports all service classes and types
 */

export { AIAnalyzer } from './analyzer.js';
export type {
  Message,
  ActionItem,
  Summary,
  Question,
  Digest,
  AIAnalyzerConfig
} from './analyzer.js';

export { SyncService } from './sync.js';
export type {
  SyncConfig,
  Topic,
  TopicSource,
  SyncResult,
  DataSource
} from './sync.js';

export { NotificationManager } from './notification.js';
export type {
  NotificationConfig,
  NotificationOptions,
  StaleItem
} from './notification.js';

export { ConfigManager } from './config.js';
export type {
  TopicConfig,
  APICredentials,
  UserPreferences,
  Configuration
} from './config.js';

export { ChangeWatcher } from './change-watcher.js';
export type { ChangeEvent } from './change-watcher.js';

export { OrchestratorAgent } from './orchestrator-agent.js';
