# Services

This directory contains the core business logic services for the work intelligence system.

## Services Overview

### AIAnalyzer (`analyzer.ts`)

AI-powered analyzer using Anthropic Claude for extracting insights from work communications.

**Features:**
- Detect action items from messages with assignees, due dates, and status
- Summarize content with key points and discussion threads
- Extract open questions and track answers
- Generate daily digests with highlights and metrics

**Usage:**
```typescript
import { AIAnalyzer } from './services/analyzer.js';

const analyzer = new AIAnalyzer({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-3-5-sonnet-20241022',
  maxTokens: 4096,
  temperature: 0.7,
});

// Detect action items
const actionItems = await analyzer.detectActionItems(messages);

// Generate summary
const summary = await analyzer.summarizeContent(messages);

// Extract questions
const questions = await analyzer.extractQuestions(messages);

// Generate daily digest
const digest = await analyzer.generateDigest({
  topic: 'Product Development',
  date: new Date(),
  messages,
  existingActionItems,
});
```

### SyncService (`sync.ts`)

Background polling service for syncing data from multiple sources.

**Features:**
- Periodic sync for Teams, Email, and Jira
- Configurable sync intervals per source
- Retry logic with exponential backoff
- Last sync timestamp tracking
- Topic-based sync management

**Usage:**
```typescript
import { SyncService } from './services/sync.js';

const syncService = new SyncService({
  intervals: {
    teams: 5 * 60 * 1000,  // 5 minutes
    email: 10 * 60 * 1000,  // 10 minutes
    jira: 15 * 60 * 1000,   // 15 minutes
  },
  retryAttempts: 3,
  retryDelay: 5000,
});

// Register data sources
syncService.registerDataSource('teams', teamsConnector);
syncService.registerDataSource('email', emailConnector);
syncService.registerDataSource('jira', jiraConnector);

// Start service
syncService.start();

// Start syncing a topic
syncService.startTopicSync(topic);

// One-time sync
const results = await syncService.syncTopic(topic);
```

### NotificationManager (`notification.ts`)

Manages macOS notifications for action items, digests, and stale items.

**Features:**
- Action item notifications with priority levels
- Daily digest scheduling
- Stale item detection and alerts
- Open question notifications
- Sync error alerts
- Configurable notification rules

**Usage:**
```typescript
import { NotificationManager } from './services/notification.js';

const notificationManager = new NotificationManager({
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
});

// Notify about action items
await notificationManager.notifyActionItem(actionItem);
await notificationManager.notifyActionItems(actionItems);

// Notify about daily digest
await notificationManager.notifyDailyDigest(digest);

// Check for stale items
await notificationManager.checkStaleItems(actionItems, questions);

// Schedule daily digest
const timer = notificationManager.scheduleDailyDigest(async () => {
  return await generateDigest();
});
```

### ConfigManager (`config.ts`)

Manages configuration, API credentials, topic settings, and user preferences.

**Features:**
- Persistent configuration storage
- API credentials management
- Topic configuration CRUD
- User preferences management
- Import/export configuration
- Default configuration setup

**Usage:**
```typescript
import { ConfigManager } from './services/config.js';

const configManager = new ConfigManager();

// Manage credentials
configManager.setCredential('anthropic', { apiKey: 'key' });
configManager.setCredential('microsoft', {
  tenantId: 'tenant',
  clientId: 'client',
  clientSecret: 'secret',
});

// Manage topics
const topic = configManager.addTopic({
  name: 'Product Development',
  sources: {
    teams: {
      enabled: true,
      channels: ['channel-id-1', 'channel-id-2'],
    },
    email: {
      enabled: true,
      filters: 'subject:feature',
    },
  },
  notifications: {
    enabled: true,
    actionItems: true,
    digest: true,
    staleItems: true,
  },
});

// Update preferences
configManager.updatePreferences({
  notifications: {
    digest: {
      enabled: true,
      time: '10:00',
    },
  },
  ai: {
    temperature: 0.5,
  },
});

// Export/Import
const configJson = configManager.exportConfig();
configManager.importConfig(configJson);
```

## Dependency Injection

All services are designed with dependency injection in mind for easy testing and loose coupling:

- **AIAnalyzer**: Takes configuration object with API key and model settings
- **SyncService**: Accepts `DataSource` implementations via `registerDataSource()`
- **NotificationManager**: Custom notification handlers via `setNotificationHandler()`
- **ConfigManager**: Optional config directory path for testing

## Testing

Comprehensive tests are provided for all services in the `tests/services/` directory:

- `analyzer.test.ts` - AIAnalyzer tests with mocked Anthropic SDK
- `sync.test.ts` - SyncService tests with mock data sources
- `notification.test.ts` - NotificationManager tests with custom handlers
- `config.test.ts` - ConfigManager tests with temporary directories

Run tests:
```bash
npm test
```

## Design Principles

1. **Loose Coupling**: Services communicate through well-defined interfaces
2. **Testability**: All external dependencies are injectable
3. **Error Handling**: Graceful degradation with detailed error messages
4. **Type Safety**: Full TypeScript typing for all APIs
5. **Persistence**: Configuration and state are persisted to disk
6. **Async/Await**: Modern async patterns throughout

## Configuration File Location

By default, configuration is stored at:
- macOS/Linux: `~/.work-intelligence/config.json`
- Windows: `%USERPROFILE%\.work-intelligence\config.json`

You can override this location by passing a custom directory to `ConfigManager`.
