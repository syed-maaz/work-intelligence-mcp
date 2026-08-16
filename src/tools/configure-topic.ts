/**
 * Configure topic tool implementation
 */

import type Database from 'better-sqlite3';
import type { Topic } from '../db/schema.js';
import { z } from 'zod';

export interface ConfigureTopicArgs {
  name: string;
  sources: {
    teams?: {
      channels: string[];
    };
    email?: {
      filters: string;
    };
    jira?: {
      projects: string[];
    };
  };
  /** How many days of history to look back for this topic (default: 30) */
  lookbackDays?: number;
}

// Validation schemas
const TeamsConfigSchema = z.object({
  channels: z.array(z.string()).min(1, 'At least one Teams channel is required'),
});

const EmailConfigSchema = z.object({
  filters: z.string().min(1, 'Email filters are required'),
});

const JiraConfigSchema = z.object({
  projects: z.array(z.string()).min(1, 'At least one Jira project is required'),
});

const SourcesSchema = z
  .object({
    teams: TeamsConfigSchema.optional(),
    email: EmailConfigSchema.optional(),
    jira: JiraConfigSchema.optional(),
  })
  .refine(
    data => data.teams || data.email || data.jira,
    'At least one source (teams, email, or jira) must be configured'
  );

export function validateTopicConfig(args: ConfigureTopicArgs): void {
  // Validate topic name
  if (!args.name || args.name.trim().length === 0) {
    throw new Error('Topic name cannot be empty');
  }

  if (args.name.length > 100) {
    throw new Error('Topic name must be 100 characters or less');
  }

  // Validate sources
  try {
    SourcesSchema.parse(args.sources);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
      throw new Error(`Invalid topic configuration:\n${issues.join('\n')}`);
    }
    throw error;
  }
}

export async function configureTopic(
  db: Database.Database,
  args: ConfigureTopicArgs
): Promise<{ topic: Topic; isNew: boolean }> {
  // Validate configuration
  validateTopicConfig(args);

  // Check if topic already exists
  const existingTopic = db
    .prepare('SELECT id, name, config as sources, created_at FROM topics WHERE name = ?')
    .get(args.name) as { id: number; name: string; sources: string; created_at: string } | undefined;

  const sourcesJson = JSON.stringify(args.sources);
  const lookbackDays = args.lookbackDays ?? 30;

  if (existingTopic) {
    // Update existing topic
    const updateStmt = db.prepare(`
      UPDATE topics
      SET config = ?, lookback_days = ?
      WHERE id = ?
    `);

    updateStmt.run(sourcesJson, lookbackDays, existingTopic.id);

    const updatedTopic = db
      .prepare('SELECT id, name, config as sources, created_at FROM topics WHERE id = ?')
      .get(existingTopic.id) as { id: number; name: string; sources: string; created_at: string };

    return {
      topic: {
        id: updatedTopic.id,
        name: updatedTopic.name,
        created_at: updatedTopic.created_at,
        config: updatedTopic.sources,
      } as Topic,
      isNew: false,
    };
  }

  // Insert new topic
  const insertStmt = db.prepare(`
    INSERT INTO topics (name, config, lookback_days)
    VALUES (?, ?, ?)
  `);

  const result = insertStmt.run(args.name, sourcesJson, lookbackDays);

  const newTopic = db
    .prepare('SELECT id, name, config as sources, created_at FROM topics WHERE id = ?')
    .get(result.lastInsertRowid) as { id: number; name: string; sources: string; created_at: string };

  return {
    topic: {
      id: newTopic.id,
      name: newTopic.name,
      created_at: newTopic.created_at,
      config: newTopic.sources,
    } as Topic,
    isNew: true,
  };
}

export function formatTopicConfiguration(
  result: { topic: Topic; isNew: boolean },
  args: ConfigureTopicArgs
): string {
  const { topic, isNew } = result;

  const lines: string[] = [];

  if (isNew) {
    lines.push(`✅ Successfully configured new topic: "${topic.name}"`);
  } else {
    lines.push(`✅ Successfully updated topic: "${topic.name}"`);
  }

  lines.push('');
  lines.push('## Configuration Details');
  lines.push('');

  // Teams configuration
  if (args.sources.teams) {
    lines.push('### 📱 Microsoft Teams');
    lines.push('');
    lines.push('Monitoring channels:');
    for (const channel of args.sources.teams.channels) {
      lines.push(`  - ${channel}`);
    }
    lines.push('');
  }

  // Email configuration
  if (args.sources.email) {
    lines.push('### 📧 Email');
    lines.push('');
    lines.push(`Search filters: ${args.sources.email.filters}`);
    lines.push('');
  }

  // Jira configuration
  if (args.sources.jira) {
    lines.push('### 🎫 Jira');
    lines.push('');
    lines.push('Monitoring projects:');
    for (const project of args.sources.jira.projects) {
      lines.push(`  - ${project}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Next Steps');
  lines.push('');
  lines.push('1. The system will start monitoring these sources for new messages');
  lines.push('2. Use `search_messages` to search across all sources');
  lines.push('3. Use `get_action_items` to track action items');
  lines.push('4. Use `get_daily_digest` to get daily summaries');
  lines.push('');

  if (isNew) {
    lines.push(
      '💡 **Tip**: It may take a few minutes for the system to sync historical data from your sources.'
    );
  } else {
    lines.push('💡 **Tip**: The updated configuration will be used for future syncs.');
  }

  return lines.join('\n');
}

export async function listTopics(db: Database.Database): Promise<Topic[]> {
  const topics = db.prepare('SELECT id, name, config, created_at FROM topics').all() as Array<{
    id: number;
    name: string;
    config: string | null;
    created_at: string;
  }>;

  return topics.map(topic => ({
    id: topic.id,
    name: topic.name,
    created_at: topic.created_at,
    config: topic.config,
  }));
}

export function formatTopicsList(topics: Topic[]): string {
  if (topics.length === 0) {
    return 'No topics configured yet. Use `configure_topic` to create your first topic.';
  }

  const lines: string[] = [
    `Found ${topics.length} configured topic${topics.length === 1 ? '' : 's'}:`,
    '',
  ];

  for (const topic of topics) {
    lines.push(`## ${topic.name}`);
    lines.push(`Created: ${new Date(topic.created_at).toLocaleDateString()}`);
    lines.push('');

    if (topic.config) {
      const sources = JSON.parse(topic.config);
      const sourceList: string[] = [];
      if (sources.teams) {
        sourceList.push(`Teams (${sources.teams.channels?.length || 0} channels)`);
      }
      if (sources.email) {
        sourceList.push('Email');
      }
      if (sources.jira) {
        sourceList.push(`Jira (${sources.jira.projects?.length || 0} projects)`);
      }

      lines.push(`Sources: ${sourceList.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
