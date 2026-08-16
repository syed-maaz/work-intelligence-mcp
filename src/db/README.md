# Database Layer

SQLite database layer for work-intelligence-mcp with better-sqlite3.

## Architecture

### Files

- **schema.ts**: Database schema definition, migrations, and Zod validation schemas
- **connection.ts**: Database connection management, transactions, and backups
- **queries.ts**: Type-safe CRUD operations for all entities
- **index.ts**: Public API exports

### Tables

1. **topics**: Work topics/projects
2. **messages**: Messages from Slack, Teams, Jira, etc.
3. **action_items**: Tasks and action items
4. **meetings**: Meeting records
5. **decisions**: Decisions made in meetings or discussions
6. **questions**: Q&A tracking

### Features

- **Type Safety**: All queries validated with Zod schemas
- **SQL Injection Protection**: All queries use prepared statements
- **Foreign Key Constraints**: Automatic cascade deletes
- **Migrations**: Schema versioning system
- **Transactions**: ACID transaction support
- **Backups**: Built-in backup functionality
- **Indexes**: Optimized for common query patterns

## Usage

### Initialize Database

```typescript
import { getDatabase } from './db/connection.js';

const db = getDatabase({
  path: './data/work-intelligence.db',
  enableWAL: true,
  busyTimeout: 5000,
});
```

### Create a Topic

```typescript
import { createTopic } from './db/queries.js';

const topic = createTopic(db, {
  name: 'Project Alpha',
  config: JSON.stringify({ priority: 'high' }),
});
```

### Insert Messages

```typescript
import { insertMessage } from './db/queries.js';

const message = insertMessage(db, {
  topic_id: topic.id,
  source: 'slack',
  content: 'Sprint planning meeting tomorrow',
  author: 'alice@example.com',
});
```

### Search Messages

```typescript
import { searchMessages } from './db/queries.js';

// By topic and date range
const messages = searchMessages(db, {
  topic_id: topic.id,
  start_date: '2024-01-01T00:00:00Z',
  end_date: '2024-12-31T23:59:59Z',
});

// Full-text search
const bugMessages = searchMessages(db, {
  search_text: 'bug',
  source: 'slack',
});
```

### Manage Action Items

```typescript
import { insertActionItem, updateActionItem, getActionItems } from './db/queries.js';

// Create action item
const actionItem = insertActionItem(db, {
  topic_id: topic.id,
  title: 'Fix authentication bug',
  assignee: 'dev@example.com',
  status: 'pending',
  due_date: '2024-12-31',
  source_message_id: message.id,
});

// Update status
updateActionItem(db, actionItem.id, {
  status: 'completed',
});

// Get pending items
const pendingItems = getActionItems(db, {
  topic_id: topic.id,
  status: 'pending',
});
```

### Transactions

```typescript
import { transaction } from './db/connection.js';

transaction(db, () => {
  const topic = createTopic(db, { name: 'New Project' });
  insertMessage(db, {
    topic_id: topic.id,
    source: 'slack',
    content: 'Project kickoff',
    author: 'pm@example.com',
  });
});
```

### Backups

```typescript
import { backupDatabase } from './db/connection.js';

// Create backup with timestamp
backupDatabase();

// Or specify custom path
backupDatabase('./backups/manual-backup.db');
```

## Testing

Run tests with:

```bash
pnpm test tests/db/queries.test.ts
```

Tests use in-memory databases for fast, isolated testing.

## Query Performance

Indexes are created for:
- Message lookups by topic and timestamp
- Message filtering by source and author
- Action item filtering by topic, status, assignee, and due date
- Meeting lookups by topic and date
- Decision lookups by topic, meeting, and date
- Question filtering by topic and status

## Data Integrity

- Foreign key constraints enforce referential integrity
- CASCADE DELETE: Deleting a topic deletes all related records
- SET NULL: Deleting a message sets `source_message_id` to null
- Unique constraints prevent duplicate topic names
- NOT NULL constraints on required fields

## Migration System

Schema version is tracked in `schema_metadata` table. Migrations are applied automatically on initialization.

Current schema version: 1
