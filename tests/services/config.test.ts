/**
 * Tests for ConfigManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigManager, TopicConfig, APICredentials, UserPreferences } from '../../src/services/config.js';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let testConfigDir: string;

  beforeEach(() => {
    // Create a temporary directory for tests
    testConfigDir = join(tmpdir(), `work-intelligence-test-${Date.now()}`);
    mkdirSync(testConfigDir, { recursive: true });
    configManager = new ConfigManager(testConfigDir);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should create default configuration if none exists', () => {
      const config = configManager.getConfig();

      expect(config).toBeDefined();
      expect(config.version).toBe('1.0.0');
      expect(config.topics).toEqual([]);
      expect(config.credentials).toEqual({});
      expect(config.preferences).toBeDefined();
    });

    it('should create config directory if it does not exist', () => {
      expect(existsSync(testConfigDir)).toBe(true);
    });

    it('should return correct config path', () => {
      const configPath = configManager.getConfigPath();
      expect(configPath).toBe(join(testConfigDir, 'config.json'));
    });
  });

  describe('credentials management', () => {
    it('should set and get credentials', () => {
      const credentials: APICredentials = {
        anthropic: {
          apiKey: 'test-api-key',
        },
        microsoft: {
          tenantId: 'tenant-id',
          clientId: 'client-id',
          clientSecret: 'client-secret',
        },
      };

      configManager.setCredentials(credentials);
      const retrieved = configManager.getCredentials();

      expect(retrieved.anthropic?.apiKey).toBe('test-api-key');
      expect(retrieved.microsoft?.tenantId).toBe('tenant-id');
    });

    it('should set individual credential', () => {
      configManager.setCredential('anthropic', { apiKey: 'new-key' });

      const credential = configManager.getCredential('anthropic');
      expect(credential?.apiKey).toBe('new-key');
    });

    it('should persist credentials to disk', () => {
      configManager.setCredential('anthropic', { apiKey: 'persisted-key' });

      // Create new instance to load from disk
      const newManager = new ConfigManager(testConfigDir);
      const credential = newManager.getCredential('anthropic');

      expect(credential?.apiKey).toBe('persisted-key');
    });
  });

  describe('topics management', () => {
    it('should add a new topic', () => {
      const topic = configManager.addTopic({
        name: 'Test Topic',
        sources: {
          teams: {
            enabled: true,
            channels: ['channel-1'],
          },
        },
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      expect(topic.id).toBeDefined();
      expect(topic.name).toBe('Test Topic');
      expect(topic.createdAt).toBeInstanceOf(Date);
      expect(topic.updatedAt).toBeInstanceOf(Date);
    });

    it('should retrieve all topics', () => {
      configManager.addTopic({
        name: 'Topic 1',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      configManager.addTopic({
        name: 'Topic 2',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      const topics = configManager.getTopics();
      expect(topics).toHaveLength(2);
    });

    it('should get topic by ID', () => {
      const added = configManager.addTopic({
        name: 'Test Topic',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      const retrieved = configManager.getTopic(added.id);
      expect(retrieved?.name).toBe('Test Topic');
    });

    it('should get topic by name', () => {
      configManager.addTopic({
        name: 'Unique Topic Name',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      const retrieved = configManager.getTopicByName('Unique Topic Name');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Unique Topic Name');
    });

    it('should update an existing topic', () => {
      const topic = configManager.addTopic({
        name: 'Original Name',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      const updated = configManager.updateTopic(topic.id, {
        name: 'Updated Name',
        sources: {
          email: {
            enabled: true,
            filters: 'subject:test',
          },
        },
      });

      expect(updated?.name).toBe('Updated Name');
      expect(updated?.sources.email?.enabled).toBe(true);
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(topic.updatedAt.getTime());
    });

    it('should return undefined when updating non-existent topic', () => {
      const result = configManager.updateTopic('non-existent-id', { name: 'Test' });
      expect(result).toBeUndefined();
    });

    it('should delete a topic', () => {
      const topic = configManager.addTopic({
        name: 'To Delete',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      const deleted = configManager.deleteTopic(topic.id);
      expect(deleted).toBe(true);

      const retrieved = configManager.getTopic(topic.id);
      expect(retrieved).toBeUndefined();
    });

    it('should return false when deleting non-existent topic', () => {
      const result = configManager.deleteTopic('non-existent-id');
      expect(result).toBe(false);
    });

    it('should persist topics to disk', () => {
      const topic = configManager.addTopic({
        name: 'Persisted Topic',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      // Create new instance to load from disk
      const newManager = new ConfigManager(testConfigDir);
      const retrieved = newManager.getTopic(topic.id);

      expect(retrieved?.name).toBe('Persisted Topic');
      expect(retrieved?.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('preferences management', () => {
    it('should get default preferences', () => {
      const preferences = configManager.getPreferences();

      expect(preferences.notifications.enabled).toBe(true);
      expect(preferences.sync.intervals.teams).toBe(5 * 60 * 1000);
      expect(preferences.ai.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should update preferences', () => {
      configManager.updatePreferences({
        notifications: {
          enabled: false,
          actionItems: {
            enabled: false,
            priority: 'low',
          },
          digest: {
            enabled: false,
            time: '10:00',
          },
          staleItems: {
            enabled: false,
            thresholdDays: 14,
          },
        },
      });

      const preferences = configManager.getPreferences();
      expect(preferences.notifications.enabled).toBe(false);
      expect(preferences.notifications.actionItems.priority).toBe('low');
      expect(preferences.notifications.digest.time).toBe('10:00');
    });

    it('should get notification preferences', () => {
      const notificationPrefs = configManager.getNotificationPreferences();
      expect(notificationPrefs.enabled).toBe(true);
      expect(notificationPrefs.digest.time).toBe('09:00');
    });

    it('should get sync preferences', () => {
      const syncPrefs = configManager.getSyncPreferences();
      expect(syncPrefs.intervals.teams).toBe(5 * 60 * 1000);
      expect(syncPrefs.retryAttempts).toBe(3);
    });

    it('should get AI preferences', () => {
      const aiPrefs = configManager.getAIPreferences();
      expect(aiPrefs.model).toBe('claude-3-5-sonnet-20241022');
      expect(aiPrefs.maxTokens).toBe(4096);
      expect(aiPrefs.temperature).toBe(0.7);
    });

    it('should persist preferences to disk', () => {
      configManager.updatePreferences({
        ai: {
          model: 'custom-model',
          maxTokens: 8192,
          temperature: 0.5,
        },
      });

      // Create new instance to load from disk
      const newManager = new ConfigManager(testConfigDir);
      const aiPrefs = newManager.getAIPreferences();

      expect(aiPrefs.model).toBe('custom-model');
      expect(aiPrefs.maxTokens).toBe(8192);
    });
  });

  describe('import and export', () => {
    it('should export configuration as JSON', () => {
      configManager.addTopic({
        name: 'Export Test',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      const exported = configManager.exportConfig();
      const parsed = JSON.parse(exported);

      expect(parsed.topics).toHaveLength(1);
      expect(parsed.topics[0].name).toBe('Export Test');
    });

    it('should import configuration from JSON', () => {
      const configData = {
        credentials: {
          anthropic: {
            apiKey: 'imported-key',
          },
        },
        topics: [
          {
            id: 'topic-1',
            name: 'Imported Topic',
            sources: {},
            notifications: {
              enabled: true,
              actionItems: true,
              digest: true,
              staleItems: true,
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        preferences: {
          notifications: {
            enabled: true,
            actionItems: { enabled: true, priority: 'high' as const },
            digest: { enabled: true, time: '08:00' },
            staleItems: { enabled: true, thresholdDays: 5 },
          },
          sync: {
            intervals: { teams: 1000, email: 2000, jira: 3000 },
            retryAttempts: 2,
            retryDelay: 1000,
          },
          ai: {
            model: 'test-model',
            maxTokens: 2048,
            temperature: 0.3,
          },
        },
        version: '1.0.0',
      };

      configManager.importConfig(JSON.stringify(configData));

      const topics = configManager.getTopics();
      expect(topics).toHaveLength(1);
      expect(topics[0].name).toBe('Imported Topic');

      const credentials = configManager.getCredential('anthropic');
      expect(credentials?.apiKey).toBe('imported-key');
    });

    it('should throw error on invalid import data', () => {
      expect(() => configManager.importConfig('invalid json')).toThrow();
      expect(() => configManager.importConfig('{}')).toThrow('Invalid configuration format');
    });
  });

  describe('reset', () => {
    it('should reset configuration to defaults', () => {
      configManager.addTopic({
        name: 'To Remove',
        sources: {},
        notifications: {
          enabled: true,
          actionItems: true,
          digest: true,
          staleItems: true,
        },
      });

      configManager.setCredential('anthropic', { apiKey: 'test-key' });

      configManager.reset();

      const config = configManager.getConfig();
      expect(config.topics).toHaveLength(0);
      expect(config.credentials).toEqual({});
    });
  });

  describe('configExists', () => {
    it('should return true after saving', () => {
      configManager.save();
      expect(configManager.configExists()).toBe(true);
    });

    it('should return false before saving to new directory', () => {
      const newTestDir = join(tmpdir(), `work-intelligence-test-new-${Date.now()}`);
      mkdirSync(newTestDir, { recursive: true });

      const newManager = new ConfigManager(newTestDir);

      // Clean up
      rmSync(newTestDir, { recursive: true, force: true });
    });
  });

  describe('getConfigDir', () => {
    it('should return the configuration directory', () => {
      expect(configManager.getConfigDir()).toBe(testConfigDir);
    });
  });
});
