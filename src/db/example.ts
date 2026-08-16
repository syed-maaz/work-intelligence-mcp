/**
 * Example usage of the database layer
 * This file demonstrates common operations
 */

import { getDatabase, closeDatabase } from './connection.js';
import {
  createTopic,
  insertMessage,
  searchMessages,
  insertActionItem,
  updateActionItem,
  getActionItems,
  insertMeeting,
  insertDecision,
  getDecisionsByMeeting,
  insertQuestion,
  updateQuestion,
} from './queries.js';
import { transaction } from './connection.js';

// Initialize database
const db = getDatabase({
  path: './data/work-intelligence.db',
  enableWAL: true,
});

// Example: Create a new project topic
const topic = createTopic(db, {
  name: 'Project Phoenix',
  config: JSON.stringify({
    priority: 'high',
    team: 'Engineering',
  }),
});

console.log('Created topic:', topic);

// Example: Add messages from different sources
insertMessage(db, {
  topic_id: topic.id,
  source: 'slack',
  content: 'Starting sprint planning for Project Phoenix',
  author: 'alice@example.com',
});

insertMessage(db, {
  topic_id: topic.id,
  source: 'teams',
  content: 'Design review scheduled for Friday',
  author: 'bob@example.com',
});

insertMessage(db, {
  topic_id: topic.id,
  source: 'jira',
  content: 'Bug reported: Authentication fails on mobile',
  author: 'system@jira.com',
  metadata: JSON.stringify({
    ticket: 'PROJ-123',
    priority: 'high',
  }),
});

// Example: Search messages
const recentMessages = searchMessages(db, {
  topic_id: topic.id,
  start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
});

console.log(`Found ${recentMessages.length} recent messages`);

// Example: Create action items from messages
const bugMessage = recentMessages.find((message) => message.content.includes('Bug'));
if (bugMessage) {
  insertActionItem(db, {
    topic_id: topic.id,
    title: 'Fix mobile authentication bug',
    description: 'Investigate and fix authentication issue on mobile devices',
    assignee: 'dev@example.com',
    status: 'pending',
    due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    source_message_id: bugMessage.id,
  });
}

// Example: Track pending action items
const pendingItems = getActionItems(db, {
  topic_id: topic.id,
  status: 'pending',
});

console.log(`Pending action items: ${pendingItems.length}`);

// Example: Complete an action item
if (pendingItems[0]) {
  updateActionItem(db, pendingItems[0].id, {
    status: 'completed',
  });
}

// Example: Record a meeting with decisions
const meeting = insertMeeting(db, {
  topic_id: topic.id,
  title: 'Sprint Planning - Project Phoenix',
  date: new Date().toISOString(),
  attendees: JSON.stringify(['alice@example.com', 'bob@example.com', 'carol@example.com']),
  notes: 'Discussed sprint goals and priorities',
});

insertDecision(db, {
  topic_id: topic.id,
  meeting_id: meeting.id,
  decision: 'Prioritize mobile bug fixes over new features',
  context: 'User complaints about mobile authentication increasing',
});

insertDecision(db, {
  topic_id: topic.id,
  meeting_id: meeting.id,
  decision: 'Add automated testing for mobile flows',
  context: 'Prevent future authentication regressions',
});

const decisions = getDecisionsByMeeting(db, meeting.id);
console.log(`Meeting decisions: ${decisions.length}`);

// Example: Track questions and answers
const question = insertQuestion(db, {
  topic_id: topic.id,
  question: 'What is the target release date for v2.0?',
  status: 'open',
});

// Later, answer the question
updateQuestion(db, question.id, {
  status: 'answered',
  answer: 'March 15th, 2024',
  answered_date: new Date().toISOString(),
});

// Example: Use transactions for atomic operations
try {
  transaction(db, () => {
    const newTopic = createTopic(db, { name: 'Emergency Fix' });

    insertMessage(db, {
      topic_id: newTopic.id,
      source: 'slack',
      content: 'Critical security vulnerability discovered',
      author: 'security@example.com',
    });

    insertActionItem(db, {
      topic_id: newTopic.id,
      title: 'Patch security vulnerability',
      status: 'in-progress',
      assignee: 'security-team@example.com',
      due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  console.log('Emergency fix topic created successfully');
} catch (error) {
  console.error('Transaction failed:', error);
}

// Clean up
closeDatabase();
