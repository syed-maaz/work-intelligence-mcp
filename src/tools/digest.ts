/**
 * Daily digest tool implementation
 */

import type Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type { Message, ActionItem, Decision, Question } from '../db/schema.js';
import { bucketCallParams } from '../services/model-config.js';

export interface GetDailyDigestArgs {
  topic: string;
  date?: string; // ISO date string, defaults to today
}

interface DigestData {
  messages: {
    teams: Message[];
    email: Message[];
    jira: Message[];
  };
  actionItems: ActionItem[];
  decisions: Decision[];
  questions: Question[];
}

export async function getDailyDigest(
  db: Database.Database,
  args: GetDailyDigestArgs,
  anthropicApiKey?: string
): Promise<string> {
  const { topic, date } = args;

  // Use provided date or default to today
  const targetDate = date ? new Date(date) : new Date();
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  // Get the topic ID
  const topicRow = db
    .prepare('SELECT id FROM topics WHERE name = ?')
    .get(topic) as { id: number } | undefined;

  if (!topicRow) {
    throw new Error(`Topic "${topic}" not found. Use configure_topic to create it first.`);
  }

  const topicId = topicRow.id;

  // Collect all data for the digest
  const digestData = await collectDigestData(db, topicId, startOfDay, endOfDay);

  // Check if there's any activity
  const totalActivity =
    digestData.messages.teams.length +
    digestData.messages.email.length +
    digestData.messages.jira.length +
    digestData.actionItems.length +
    digestData.decisions.length +
    digestData.questions.length;

  if (totalActivity === 0) {
    return `No activity found for topic "${topic}" on ${targetDate.toLocaleDateString()}.`;
  }

  // Generate digest with AI if API key is available
  if (anthropicApiKey) {
    return await generateAIDigest(digestData, topic, targetDate, anthropicApiKey, db);
  }

  // Otherwise, generate a simple text digest
  return generateSimpleDigest(digestData, topic, targetDate);
}

async function collectDigestData(
  db: Database.Database,
  topicId: number,
  startDate: Date,
  endDate: Date
): Promise<DigestData> {
  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();

  // Get messages by source
  const messagesQuery = `
    SELECT id, topic_id, source, content, author, timestamp, metadata
    FROM messages
    WHERE topic_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `;

  const allMessages = db.prepare(messagesQuery).all(topicId, startISO, endISO) as Message[];

  const messages = {
    teams: allMessages.filter(m => m.source === 'teams'),
    email: allMessages.filter(m => m.source === 'email'),
    jira: allMessages.filter(m => m.source === 'jira'),
  };

  // Get action items created or updated in the time range
  const actionItemsQuery = `
    SELECT * FROM action_items
    WHERE topic_id = ?
    AND (
      (source_message_id IN (
        SELECT id FROM messages
        WHERE topic_id = ? AND timestamp >= ? AND timestamp <= ?
      ))
      OR (status = 'open' OR status = 'in_progress')
    )
  `;

  const actionItems = db.prepare(actionItemsQuery).all(topicId, topicId, startISO, endISO) as ActionItem[];

  // Decisions: the legacy per-topic `decisions` table was dropped (schema
  // migration, 2026-07-18) — it had 0 rows and was superseded by
  // `brain_decisions` (ADR-024). The digest never surfaced topic-scoped
  // decisions in practice; preserve that behavior with an empty list.
  const decisions: Decision[] = [];

  // Questions: the legacy per-topic `questions` table was dropped (schema
  // migration, 2026-07-18) — 0 rows, superseded by the notebook-chat pattern.
  // Preserve the prior behavior (it always returned []) with an empty list.
  const questions: Question[] = [];

  return { messages, actionItems, decisions, questions };
}

async function generateAIDigest(
  data: DigestData,
  topic: string,
  date: Date,
  apiKey: string,
  db?: Database.Database,
): Promise<string> {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const anthropic = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL ? {
      baseURL,
      defaultHeaders: { 'Authorization': `Bearer ${apiKey}` },
    } : {}),
  });

  const bucketParams = db ? bucketCallParams(db, 'digest', 2000) : {
    model: 'claude-sonnet-4-6' as const,
    max_tokens: 2000,
  };
  const cachedSystem: PromptCachingBetaTextBlockParam[] = [
    { type: 'text', text: 'You are analyzing a day\'s worth of work communications to produce a concise, actionable daily digest.', cache_control: { type: 'ephemeral' } },
  ];

  const context = buildContextForAI(data);

  const prompt = `You are analyzing a day's worth of work communications for the topic "${topic}" on ${date.toLocaleDateString()}.

Your task is to create a concise, actionable daily digest that highlights:
1. Key discussions and themes
2. Important decisions made
3. Open questions that need attention
4. Action items (especially those overdue or due soon)
5. Any blockers or urgent matters

Context:
${context}

Please provide a well-structured digest in markdown format with the following sections:
- Summary (2-3 sentences)
- Key Highlights
- Decisions Made
- Open Questions
- Action Items
- Items Needing Attention

Be concise but informative. Focus on what matters most.`;

  const message = await anthropic.beta.promptCaching.messages.create({
    ...bucketParams,
    system: cachedSystem,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const textContent = message.content.find(block => block.type === 'text');
  return textContent ? textContent.text : generateSimpleDigest(data, topic, date);
}

function buildContextForAI(data: DigestData): string {
  const lines: string[] = [];

  // Messages
  lines.push('=== MESSAGES ===');
  lines.push('');

  if (data.messages.teams.length > 0) {
    lines.push(`Teams Messages (${data.messages.teams.length}):`);
    for (const msg of data.messages.teams.slice(0, 20)) {
      lines.push(`- [${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.author}: ${msg.content.slice(0, 200)}`);
    }
    lines.push('');
  }

  if (data.messages.email.length > 0) {
    lines.push(`Email Messages (${data.messages.email.length}):`);
    for (const msg of data.messages.email.slice(0, 20)) {
      lines.push(`- [${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.author}: ${msg.content.slice(0, 200)}`);
    }
    lines.push('');
  }

  if (data.messages.jira.length > 0) {
    lines.push(`Jira Updates (${data.messages.jira.length}):`);
    for (const msg of data.messages.jira.slice(0, 20)) {
      lines.push(`- [${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.author}: ${msg.content.slice(0, 200)}`);
    }
    lines.push('');
  }

  // Action Items
  if (data.actionItems.length > 0) {
    lines.push('=== ACTION ITEMS ===');
    lines.push('');
    for (const item of data.actionItems) {
      const dueDate = item.due_date ? ` (due: ${new Date(item.due_date).toLocaleDateString()})` : '';
      lines.push(`- [${item.status}] ${item.title}${dueDate} - ${item.assignee || 'Unassigned'}`);
      if (item.description) {
        lines.push(`  ${item.description.slice(0, 150)}`);
      }
    }
    lines.push('');
  }

  // Decisions
  if (data.decisions.length > 0) {
    lines.push('=== DECISIONS ===');
    lines.push('');
    for (const decision of data.decisions) {
      lines.push(`- ${decision.decision}`);
      if (decision.context) {
        lines.push(`  ${decision.context.slice(0, 150)}`);
      }
    }
    lines.push('');
  }

  // Questions
  if (data.questions.length > 0) {
    lines.push('=== QUESTIONS ===');
    lines.push('');
    for (const question of data.questions) {
      const status = question.status === 'open' ? '❓' : '✅';
      lines.push(`${status} ${question.question}`);
      if (question.answer) {
        lines.push(`  Answer: ${question.answer.slice(0, 150)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateSimpleDigest(data: DigestData, topic: string, date: Date): string {
  const lines: string[] = [
    `# Daily Digest: ${topic}`,
    `Date: ${date.toLocaleDateString()}`,
    '',
    '---',
    '',
  ];

  // Summary
  const totalMessages =
    data.messages.teams.length + data.messages.email.length + data.messages.jira.length;

  lines.push('## 📊 Summary');
  lines.push('');
  lines.push(`- ${totalMessages} total messages`);
  lines.push(`  - ${data.messages.teams.length} Teams messages`);
  lines.push(`  - ${data.messages.email.length} Email messages`);
  lines.push(`  - ${data.messages.jira.length} Jira updates`);
  lines.push(`- ${data.actionItems.length} action items`);
  lines.push(`- ${data.decisions.length} decisions made`);
  lines.push(`- ${data.questions.length} questions`);
  lines.push('');

  // Action Items
  if (data.actionItems.length > 0) {
    lines.push('## 📋 Action Items');
    lines.push('');
    for (const item of data.actionItems) {
      const statusEmoji = item.status === 'open' ? '🔴' : item.status === 'in_progress' ? '🟡' : '✅';
      const dueDate = item.due_date
        ? ` | Due: ${new Date(item.due_date).toLocaleDateString()}`
        : '';
      lines.push(
        `${statusEmoji} ${item.title} (${item.assignee || 'Unassigned'})${dueDate}`
      );
    }
    lines.push('');
  }

  // Decisions
  if (data.decisions.length > 0) {
    lines.push('## ✅ Decisions Made');
    lines.push('');
    for (const decision of data.decisions) {
      lines.push(`- **${decision.decision}**`);
      if (decision.context) {
        lines.push(`  ${decision.context}`);
      }
    }
    lines.push('');
  }

  // Questions
  if (data.questions.length > 0) {
    const openQuestions = data.questions.filter(q => q.status === 'open');
    const answeredQuestions = data.questions.filter(q => q.status !== 'open');

    if (openQuestions.length > 0) {
      lines.push('## ❓ Open Questions');
      lines.push('');
      for (const question of openQuestions) {
        lines.push(`- ${question.question}`);
      }
      lines.push('');
    }

    if (answeredQuestions.length > 0) {
      lines.push('## ✅ Answered Questions');
      lines.push('');
      for (const question of answeredQuestions) {
        lines.push(`- ${question.question}`);
        if (question.answer) {
          lines.push(`  ${question.answer}`);
        }
      }
      lines.push('');
    }
  }

  // Key Messages
  if (totalMessages > 0) {
    lines.push('## 💬 Recent Messages');
    lines.push('');

    const allMessages = [
      ...data.messages.teams,
      ...data.messages.email,
      ...data.messages.jira,
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    for (const msg of allMessages.slice(0, 10)) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const preview = msg.content.length > 150 ? `${msg.content.slice(0, 150)}...` : msg.content;
      lines.push(`- [${msg.source.toUpperCase()}] ${time} - ${msg.author}`);
      lines.push(`  ${preview}`);
    }

    if (allMessages.length > 10) {
      lines.push('');
      lines.push(`... and ${allMessages.length - 10} more messages`);
    }
  }

  return lines.join('\n');
}
