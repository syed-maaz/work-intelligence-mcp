/**
 * Configuration Manager
 *
 * Manages configuration, API credentials, topic settings, and user preferences
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface RepoConfig {
  name: string;
  localPath: string;
  githubSlug: string;
  testCmd: string;
  e2eCmd?: string;
  defaultBranch: string;
}

export interface TopicConfig {
  id: string;
  name: string;
  sources: {
    teams?: {
      enabled: boolean;
      channels: string[];
      syncInterval?: number;
    };
    email?: {
      enabled: boolean;
      filters: string;
      syncInterval?: number;
    };
    jira?: {
      enabled: boolean;
      projects: string[];
      syncInterval?: number;
    };
  };
  notifications: {
    enabled: boolean;
    actionItems: boolean;
    digest: boolean;
    staleItems: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface APICredentials {
  anthropic?: {
    apiKey: string;
  };
  microsoft?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  jira?: {
    host: string;
    username: string;
    apiToken: string;
  };
}

export interface UserPreferences {
  notifications: {
    enabled: boolean;
    actionItems: {
      enabled: boolean;
      priority: 'low' | 'medium' | 'high';
    };
    digest: {
      enabled: boolean;
      time: string;
    };
    staleItems: {
      enabled: boolean;
      thresholdDays: number;
    };
  };
  sync: {
    intervals: {
      teams: number;
      email: number;
      jira: number;
    };
    retryAttempts: number;
    retryDelay: number;
  };
  ai: {
    model: string;
    maxTokens: number;
    temperature: number;
  };
}

export interface Configuration {
  credentials: APICredentials;
  topics: TopicConfig[];
  preferences: UserPreferences;
  version: string;
}

/**
 * Configuration manager for the work intelligence system
 */
export class ConfigManager {
  private configDir: string;
  private configPath: string;
  private configuration: Configuration;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.work-intelligence');
    this.configPath = join(this.configDir, 'config.json');
    this.configuration = this.loadConfiguration();
  }

  /**
   * Load configuration from disk
   */
  private loadConfiguration(): Configuration {
    try {
      if (!existsSync(this.configPath)) {
        return this.createDefaultConfiguration();
      }

      const data = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(data);

      // Convert date strings back to Date objects
      if (parsed.topics) {
        for (const topic of parsed.topics) {
          topic.createdAt = new Date(topic.createdAt);
          topic.updatedAt = new Date(topic.updatedAt);
        }
      }

      return parsed;
    } catch (error) {
      console.error('Failed to load configuration:', error);
      return this.createDefaultConfiguration();
    }
  }

  /**
   * Save configuration to disk
   */
  save(): void {
    try {
      // Ensure config directory exists
      if (!existsSync(this.configDir)) {
        mkdirSync(this.configDir, { recursive: true });
      }

      const data = JSON.stringify(this.configuration, null, 2);
      writeFileSync(this.configPath, data, 'utf-8');
    } catch (error) {
      console.error('Failed to save configuration:', error);
      throw error;
    }
  }

  /**
   * Create default configuration
   */
  private createDefaultConfiguration(): Configuration {
    return {
      credentials: {},
      topics: [],
      preferences: {
        notifications: {
          enabled: true,
          actionItems: {
            enabled: true,
            priority: 'medium',
          },
          digest: {
            enabled: true,
            time: '09:00',
          },
          staleItems: {
            enabled: true,
            thresholdDays: 7,
          },
        },
        sync: {
          intervals: {
            teams: 5 * 60 * 1000, // 5 minutes
            email: 10 * 60 * 1000, // 10 minutes
            jira: 15 * 60 * 1000, // 15 minutes
          },
          retryAttempts: 3,
          retryDelay: 5000,
        },
        ai: {
          model: 'claude-3-5-sonnet-20241022',
          maxTokens: 4096,
          temperature: 0.7,
        },
      },
      version: '1.0.0',
    };
  }

  /**
   * Get full configuration
   */
  getConfig(): Configuration {
    return { ...this.configuration };
  }

  /**
   * Get API credentials
   */
  getCredentials(): APICredentials {
    return { ...this.configuration.credentials };
  }

  /**
   * Set API credentials
   */
  setCredentials(credentials: Partial<APICredentials>): void {
    this.configuration.credentials = {
      ...this.configuration.credentials,
      ...credentials,
    };
    this.save();
  }

  /**
   * Get specific credential
   */
  getCredential<K extends keyof APICredentials>(service: K): APICredentials[K] | undefined {
    return this.configuration.credentials[service];
  }

  /**
   * Set specific credential
   */
  setCredential<K extends keyof APICredentials>(service: K, credential: APICredentials[K]): void {
    this.configuration.credentials[service] = credential;
    this.save();
  }

  /**
   * Get all topics
   */
  getTopics(): TopicConfig[] {
    return [...this.configuration.topics];
  }

  /**
   * Get topic by ID
   */
  getTopic(topicId: string): TopicConfig | undefined {
    return this.configuration.topics.find((topic) => topic.id === topicId);
  }

  /**
   * Get topic by name
   */
  getTopicByName(name: string): TopicConfig | undefined {
    return this.configuration.topics.find((topic) => topic.name === name);
  }

  /**
   * Add a new topic
   */
  addTopic(topic: Omit<TopicConfig, 'id' | 'createdAt' | 'updatedAt'>): TopicConfig {
    const now = new Date();
    const newTopic: TopicConfig = {
      ...topic,
      id: this.generateTopicId(),
      createdAt: now,
      updatedAt: now,
    };

    this.configuration.topics.push(newTopic);
    this.save();

    return newTopic;
  }

  /**
   * Update an existing topic
   */
  updateTopic(topicId: string, updates: Partial<Omit<TopicConfig, 'id' | 'createdAt'>>): TopicConfig | undefined {
    const index = this.configuration.topics.findIndex((topic) => topic.id === topicId);

    if (index === -1) {
      return undefined;
    }

    this.configuration.topics[index] = {
      ...this.configuration.topics[index],
      ...updates,
      id: topicId, // Ensure ID doesn't change
      createdAt: this.configuration.topics[index].createdAt, // Preserve creation date
      updatedAt: new Date(),
    };

    this.save();

    return this.configuration.topics[index];
  }

  /**
   * Delete a topic
   */
  deleteTopic(topicId: string): boolean {
    const initialLength = this.configuration.topics.length;
    this.configuration.topics = this.configuration.topics.filter((topic) => topic.id !== topicId);

    if (this.configuration.topics.length < initialLength) {
      this.save();
      return true;
    }

    return false;
  }

  /**
   * Get user preferences
   */
  getPreferences(): UserPreferences {
    return { ...this.configuration.preferences };
  }

  /**
   * Update user preferences
   */
  updatePreferences(updates: Partial<UserPreferences>): void {
    this.configuration.preferences = {
      ...this.configuration.preferences,
      ...updates,
      notifications: {
        ...this.configuration.preferences.notifications,
        ...(updates.notifications || {}),
        actionItems: {
          ...this.configuration.preferences.notifications.actionItems,
          ...(updates.notifications?.actionItems || {}),
        },
        digest: {
          ...this.configuration.preferences.notifications.digest,
          ...(updates.notifications?.digest || {}),
        },
        staleItems: {
          ...this.configuration.preferences.notifications.staleItems,
          ...(updates.notifications?.staleItems || {}),
        },
      },
      sync: {
        ...this.configuration.preferences.sync,
        ...(updates.sync || {}),
        intervals: {
          ...this.configuration.preferences.sync.intervals,
          ...(updates.sync?.intervals || {}),
        },
      },
      ai: {
        ...this.configuration.preferences.ai,
        ...(updates.ai || {}),
      },
    };
    this.save();
  }

  /**
   * Get notification preferences
   */
  getNotificationPreferences(): UserPreferences['notifications'] {
    return { ...this.configuration.preferences.notifications };
  }

  /**
   * Get sync preferences
   */
  getSyncPreferences(): UserPreferences['sync'] {
    return { ...this.configuration.preferences.sync };
  }

  /**
   * Get AI preferences
   */
  getAIPreferences(): UserPreferences['ai'] {
    return { ...this.configuration.preferences.ai };
  }

  /**
   * Export configuration as JSON
   */
  exportConfig(): string {
    return JSON.stringify(this.configuration, null, 2);
  }

  /**
   * Import configuration from JSON
   */
  importConfig(jsonData: string): void {
    try {
      const parsed = JSON.parse(jsonData);

      // Validate structure
      if (!parsed.credentials || !parsed.topics || !parsed.preferences) {
        throw new Error('Invalid configuration format');
      }

      // Convert date strings back to Date objects
      if (parsed.topics) {
        for (const topic of parsed.topics) {
          topic.createdAt = new Date(topic.createdAt);
          topic.updatedAt = new Date(topic.updatedAt);
        }
      }

      this.configuration = parsed;
      this.save();
    } catch (error) {
      console.error('Failed to import configuration:', error);
      throw error;
    }
  }

  /**
   * Reset configuration to defaults
   */
  reset(): void {
    this.configuration = this.createDefaultConfiguration();
    this.save();
  }

  /**
   * Generate a unique topic ID
   */
  private generateTopicId(): string {
    return `topic-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Get configured repos: wi.config.json first, env fallback (REPO_PATH / OPERATIONS_PATH).
   */
  getRepos(): RepoConfig[] {
    try {
      const { getWiConfig } = require('./wi-config.js') as typeof import('./wi-config.js');
      const configRepos = getWiConfig().repos;
      if (configRepos && configRepos.length > 0) {
        return configRepos.map(r => ({
          name: r.name,
          localPath: r.localPath,
          githubSlug: r.githubSlug ?? 'org/your-app',
          testCmd: 'npm test',
          defaultBranch: r.defaultBranch ?? 'main',
        }));
      }
    } catch { /* config not available, fall through to env */ }

    const repos: RepoConfig[] = [];
    const repoPath = process.env.REPO_PATH;
    const operationsPath = process.env.OPERATIONS_PATH;
    if (repoPath) {
      repos.push({
        name: 'workspace',
        localPath: repoPath,
        githubSlug: process.env.REPO_GITHUB || 'org/your-app',
        testCmd: 'npm test',
        defaultBranch: 'main',
      });
    }
    if (operationsPath) {
      repos.push({
        name: 'operations',
        localPath: operationsPath,
        githubSlug: process.env.OPERATIONS_GITHUB || 'org/your-ops',
        testCmd: 'npm test',
        defaultBranch: 'main',
      });
    }
    return repos;
  }

  /**
   * Get configuration file path
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Check if configuration file exists
   */
  configExists(): boolean {
    return existsSync(this.configPath);
  }

  /**
   * Get configuration directory
   */
  getConfigDir(): string {
    return this.configDir;
  }
}
