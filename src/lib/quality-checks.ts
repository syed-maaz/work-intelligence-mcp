/**
 * EP-33: Data quality rule checks for messages, meetings, and action items.
 * Pure functions — no DB access. Call these after ingestion to flag anomalies.
 */

export type QualityRule =
  | 'content_truncated'
  | 'null_assignee'
  | 'short_transcript'
  | 'missing_source_id'
  | 'garbled_content'
  | 'bot_noise';

export interface QualityIssue {
  rule: QualityRule;
  severity: 'warning' | 'error';
  detail: string;
}

export interface MessageRow {
  id: number;
  content: string | null;
  source_id: string | null;
  author: string | null;
}

export interface MeetingRow {
  id: number;
  transcript: string | null;
  summary: string | null;
}

export interface ActionItemRow {
  id: number;
  assignee: string | null;
  confidence?: number;
}

const BOT_AUTHORS =
  /T_[A-Z_]+|\[bot\]|serviceuser|noreply|DEVOPS|AppOps|github-actions/i;

export function checkMessage(msg: MessageRow): QualityIssue[] {
  const issues: QualityIssue[] = [];

  if (!msg.source_id) {
    issues.push({ rule: 'missing_source_id', severity: 'warning', detail: 'No source_id set' });
  }

  if (!msg.content || msg.content.trim().length < 5) {
    issues.push({ rule: 'garbled_content', severity: 'warning', detail: 'Content empty or too short' });
  }

  if (msg.content && (msg.content.endsWith('…') || msg.content.endsWith('...'))) {
    issues.push({ rule: 'content_truncated', severity: 'warning', detail: 'Content appears truncated' });
  }

  if (msg.author && BOT_AUTHORS.test(msg.author)) {
    issues.push({ rule: 'bot_noise', severity: 'warning', detail: `Bot/system author: ${msg.author}` });
  }

  return issues;
}

export function checkMeeting(meeting: MeetingRow): QualityIssue[] {
  const issues: QualityIssue[] = [];

  if (!meeting.transcript || meeting.transcript.trim().length < 200) {
    issues.push({
      rule: 'short_transcript',
      severity: 'warning',
      detail: `Transcript length: ${meeting.transcript?.length ?? 0} chars (min 200)`,
    });
  }

  return issues;
}

export function checkActionItem(item: ActionItemRow): QualityIssue[] {
  const issues: QualityIssue[] = [];

  if (!item.assignee) {
    issues.push({ rule: 'null_assignee', severity: 'warning', detail: 'No assignee set' });
  }

  return issues;
}
