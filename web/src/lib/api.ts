const BASE = '/api';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function requestDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function requestPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function requestPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────

export interface Status {
  messages: number;
  openActions: number;
  topics: number;
  meetings: number;
  lastSync: string | null;
  dbPath: string;
  anthropicConnected: boolean;
  browserConnected: boolean;
  githubConnected: boolean;
  /** JIRA_MY_USERNAME when set — used for brain decide/recall cache keys. */
  brainUser?: string;
}

/** Connector registry status — GET /api/connectors (ADR-044). */
export interface ConnectorStatus {
  name: string;
  enabled: boolean;
  mode: string | null;
  hasRequiredEnv: boolean;
}

export interface ConnectorsResponse {
  /** Enabled connector names (in wi.config.json declaration order). */
  registry: string[];
  /** capabilities.json manifest (per-connector capabilities, modes, config). */
  capabilities: CapabilitiesManifest;
  /** Per-connector status keyed by connector name. */
  configured: Record<string, ConnectorStatus>;
}

/** capabilities.json shape — per-connector wizard data (STEP 11). */
export interface CapabilitiesManifest {
  version: string;
  registry: { loadsFrom: string; discovery: string };
  connectors: Record<
    string,
    {
      displayName: string;
      modes: string[];
      capabilities: string[];
      config: { enabled?: string; mode?: string; requiredEnv: string[] };
      dataIngested: string[];
    }
  >;
}

let cachedBrainUser: string | null = null;

/** Resolve brain user id (JIRA_MY_USERNAME or anon:ui). Cached after first /api/status. */
export async function getBrainUser(): Promise<string> {
  if (cachedBrainUser) return cachedBrainUser;
  try {
    const s = await request<Status>('/status');
    cachedBrainUser = s.brainUser?.trim() || 'anon:ui';
  } catch {
    cachedBrainUser = 'anon:ui';
  }
  return cachedBrainUser;
}

export interface Topic {
  id: number;
  name: string;
  created_at?: string;
  config?: string | null;
  lookback_days?: number;
}

export interface ActionItem {
  id: number;
  title: string;
  description: string | null;
  assignee: string | null;
  status: 'open' | 'in_progress' | 'completed' | 'pending';
  due_date: string | null;
  source: string | null;
  topic_id: number;
  created_at: string | null;
}

export interface Message {
  id: number;
  source: 'jira' | 'teams' | 'email' | 'github';
  source_id: string;
  subject: string | null;
  content: string;
  author: string;
  timestamp: string;
  metadata: string | null;
  topic_id: number | null;
}

export interface Meeting {
  id: number;
  chat_name: string | null;
  summary: string | null;
  decisions: string | null;
  topics: string | null;
  timestamp: string;
}

export interface SyncState {
  topic_id: string;
  source: string;
  last_synced_at: string;
  last_message_count: number;
}

export interface MarkdownResult {
  markdown: string;
}

export interface JiraReportResult {
  markdown: string;
  issueCount: number;
  generatedAt: string;
}

export interface JiraIssue {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  epicKey: string | null;
  epicName: string | null;
  updatedAt: string;
  url: string;
  similarLearning?: { summary: string; solution: string } | null;
}

export interface JiraAnalysis {
  id: number;
  issue_key: string;
  analysis: string | null;
  effort: string | null;
  explanation: string | null;
  solution: string | null;
  code_impact: string | null;
  linked_content: string | null;
  notes: string | null;
  status: 'pending' | 'done' | 'not_analyzed';
  analyzed_at: string;
}

export interface EpicChildIssue {
  key: string;
  title: string;
  status: string;
  issueType: string;
  assignee: string | null;
  url: string;
}

export interface TeamsFavKeyword {
  id: number;
  keyword: string;
  added_at: string;
}

// EP-53: Teams Intelligence Feed types
export interface ChatSummary {
  name: string;
  messageCount: number;
  last24hCount: number;
  last7dCount: number;
  lastMessageAt: string | null;
  lastMessageAuthor: string;
  lastMessagePreview: string;
  memberCount: number;
  hasUnanalyzedMeetings: boolean;
  jiraLinks: string[];
  mentionsMe: boolean;
  digest: string | null;
  digestAge: number | null;
}

export interface ChatMessage {
  id: number;
  author: string;
  content: string;
  timestamp: string;
  jiraLinks: string[];
}

export interface ChatMeeting {
  id: number;
  title: string;
  date: string;
  summary: string | null;
  decisions: string[];
  attendees: string[];
}

export interface ChatActionItem {
  id: number;
  title: string;
  assignee: string | null;
  status: string;
  due_date: string | null;
}

export interface ChatFeed {
  messages: ChatMessage[];
  meetings: ChatMeeting[];
  actionItems: ChatActionItem[];
  jiraLinks: string[];
}

export interface SyncProgress {
  running: boolean;
  currentTopic: string | null;
  completedTopics: string[];
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  watcher?: SyncWatcher;
}

export interface ErrorLog {
  id: number;
  occurred_at: string;
  source: string;
  message: string;
  stack: string | null;
  request_path: string | null;
  severity: string;
  category: string | null;
  suggested_fix: string | null;
  resolved: number;
  jira_ticket_key: string | null;
}

// EP-32: Token usage tracking
export interface TokenStats {
  days: number;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  by_method: Array<{
    method: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
  by_day: Array<{
    day: string;
    calls: number;
    cost_usd: number;
  }>;
}

export interface DigestRecord {
  id: number;
  topic_name: string;
  date: string;
  markdown: string;
  generated_at: string;
  expires_at: string;
}

export interface DailySummary {
  markdown: string;
  sections?: {
    yesterdaySummary: string;
    todayPriorities: string[];
    saturnReadyIssues: JiraIssue[];
    actionItemsDueToday: Array<{ title: string; assignee: string | null; due_date: string }>;
  };
  cached: boolean;
  generatedAt: string;
}

export interface CalendarEvent {
  id: number;
  source_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  organizer: string | null;
  attendees: string;
  body: string | null;
  is_all_day: number;
  response_status: 'accepted' | 'tentative' | 'declined' | 'none' | null;
  scraped_at: string;
  pre_brief: string | null; // EP-15-4
}

export interface MeetingContext {
  attendees: Array<{ name: string; email: string | null }>;
  recentMessages: Array<{ id: number; subject: string | null; content: string; author: string; source: string; timestamp: string }>;
  pastMeetings: Array<{ id: number; chat_name: string; title: string; date: string; summary: string | null; decisions: string }>;
  openActionItems: Array<{ id: number; title: string; assignee: string | null; due_date: string | null; status: string }>;
  jiraTickets: Array<{ issue_key: string; summary: string; status: string; assignee: string | null }>;
  error?: string;
}

export interface TopicNotebook {
  topic_name: string;
  content: string;
  last_updated: string;
  message_count: number;
  fresh?: boolean;
  user_annotation?: string | null;
  sources?: string[];
  stale?: boolean;
  stale_reason?: string;
  cached_at?: string;
}

export interface VaultStatus {
  configured: boolean;
  vaultPath: string | null;
  noteCount: number;
}

export interface VaultExportResult {
  exported: number;
  skipped: number;
  errors: string[];
  lastExportedAt: string;
}

export interface GraphNode {
  topicName: string;
  messageCount: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  sharedPeople: string[];
  sharedTickets?: string[];
}

export interface JiraTicketSummary {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  description: string;
  url: string;
}

export interface NotebookChatEntry {
  id: number;
  topic_name: string;
  question: string;
  answer: string;
  asked_at: string;
}

export interface TopicSuggestion {
  id: number;
  keyword: string;
  message_count: number;
  author_count: number;
  sample_msgs: string[];
  suggested_at: string;
}

// EP-15: Alert feed
export interface Alert {
  id: string;
  type: 'overdue' | 'high_activity' | 'meeting_soon' | 'stale_item' | 'new_blocker' | 'missing_transcript' | 'brain_decision';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  topic?: string;
  link?: string;
  cta?: string;
  decision_id?: number;
  generatedAt: string;
}

export interface AlertFeedResponse {
  alerts: Alert[];
  generatedAt: string | null;
}

// EP-15: Workload intensity
export interface WorkloadTopic {
  name: string;
  messagesThisWeek: number;
  messagesLastWeek: number;
  messageTrend: 'up' | 'down' | 'steady';
  openActionItems: number;
  overdueItems: number;
  intensity: 'calm' | 'active' | 'intense';
  intensityScore: number;
}

export interface WorkloadResponse {
  topics: WorkloadTopic[];
  generatedAt: string | null;
}

// EP-15: Morning brief
export interface MorningBrief {
  date: string;
  cached: boolean;
  generatedAt: string;
  sections: {
    summary: string;
    alerts: Alert[];
    workload: WorkloadTopic[];
    calendar: CalendarEvent[];
    priorities: ActionItem[];
    sprintDelta: { opened: number; closed: number; net: number };
  };
  slackMarkdown: string;
  stale?: boolean;
  stale_reason?: string;
}

export interface SyncWatcher {
  outlookEnabled: boolean;
  teamsEnabled: boolean;
  lastOutlookCheck: string | null;
  lastTeamsCheck: string | null;
  lastTriggerAt: string | null;
  lastTriggerReason: string | null;
  triggerCount: number;
}

// EP-33: Data quality
export interface DataQualityIssue {
  id: number;
  message_id: number | null;
  meeting_id: number | null;
  rule: string;
  severity: 'warning' | 'error';
  detail: string | null;
  resolved_at: string | null;
  detected_at: string;
}

// EP-38: Weekly report
export interface WeeklyReport {
  summary: string;
  topThemes: string[];
  risks: string[];
  recommendations: string[];
  generatedAt: string;
  cached: boolean;
  stats?: {
    totalMessages: number;
    totalMeetings: number;
    totalActionItems: number;
    topicsActive: number;
    topTopics: Array<{ name: string; msg_count: number }>;
  };
}

// EP-39: Topic relationships
export interface TopicRelationship {
  topicA?: string;
  topicB?: string;
  other?: string;
  type: string;
  strength: number;
  evidence: string;
}

export interface TopicHealth {
  topic_name: string;
  health_score: number;
  recency_score: number;
  activity_ratio: number;
  completion_rate: number;
  transcript_coverage: number;
  color: 'green' | 'yellow' | 'red';
}

export interface VelocityStats {
  project_key: string;
  week_of: string;
  completed_count: number;
  avg_cycle_time_hours: number;
  stuck_count: number;
  completed_delta: number | null;
  cycle_time_delta: number | null;
}

export interface TicketLearning {
  id: number;
  issue_key: string;
  project_key: string;
  summary: string;
  solution: string;
  files_changed: string | null;
  traps: string | null;
  cycle_time_hours: number | null;
  auto_captured: number;
  learned_at: string;
}

// EP-45: Teammate Intelligence
export interface MemberProfileSummary {
  summary: string | null;
  activity_level: 'high' | 'medium' | 'low' | 'new' | 'unknown' | null;
  activity_score: number | null;
  workload_signal: 'available' | 'busy' | 'overloaded' | 'unknown' | null;
  domains: string[];
  jira_open_count: number;
  jira_overdue_count: number;
  top_topics: Array<{ name: string; count: number; relevanceWeight: number }>;
  last_updated: string;
}

export interface TeamMember {
  id: number;
  name: string;
  email: string | null;
  github_handle: string | null;
  jira_username: string | null;
  teams_display_name: string | null;
  marked: number;
  added_at: string;
  message_count: number;
  last_active: string | null;
  profile: MemberProfileSummary | null;
}

export interface MemberFullProfile {
  member: Omit<TeamMember, 'profile'>;
  profile: MemberProfileSummary & {
    profile_content: string;
    currentFocus?: string;
    code_files_owned: string[];
  };
}

// System Health page
export interface SystemHealth {
  dataQuality: { open: number; errors: number };
  actionTriage: { pending: number };
  relationships: { total: number };
  embeddings: { enabled: boolean; indexed: number };
  lastSync: string | null;
}

export interface IngestionLogEntry {
  id: number;
  source: string;
  topic_name: string | null;
  started_at: string;
  completed_at: string | null;
  records_fetched: number | null;
  records_inserted: number | null;
  error_message: string | null;
  status: string;
}

export interface AllRelationship {
  topic_a: string;
  topic_b: string;
  type: string;
  strength: number;
  evidence: string;
  detected_at: string;
}

// ── EP-50: Jira My Work Cockpit ────────────────────────────────

export interface EnhancedIssue {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  epicKey: string | null;
  epicName: string | null;
  issueType: string | null;
  labels: string[];
  updatedAt: string;
  url: string;
  sprintContext: 'current_sprint' | 'closed_sprint' | 'backlog' | 'no_sprint';
  sprintName: string | null;
  similarLearning?: { summary: string; solution: string } | null;
}

export interface SprintMeta {
  name: string;
  start: string | null;
  end: string | null;
  total: number;
}

export interface JiraBoardResponse {
  sprint: SprintMeta | null;
  issues: EnhancedIssue[];
  cachedAt: string | null;
  isRefreshing: boolean;
  dataSource: string;
  missingConfig?: boolean;
}

export interface TicketDetail {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  reporter: string | null;
  priority: string | null;
  issueType: string | null;
  labels: string[];
  description: string | null;
  url: string;
  comments: Array<{ author: string; body: string; created: string }>;
}

// ── PR Follow (EP-54) ─────────────────────────────────────────
export interface WatchedPRSummary {
  repo: string;
  prNum: number;
  title: string;
  headRefName: string | null;
  url: string | null;
  updatedAt: string | null;
  state: string;
  additions: number;
  deletions: number;
  watchedAt: string | null;
}

// ── PR Intelligence (EP-44) ────────────────────────────────────
export interface GithubPR {
  number: number;
  title: string;
  body: string | null;
  headRefName: string;
  baseRefName: string;
  url: string;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  additions: number | null;
  deletions: number | null;
}

export interface PRReview {
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
  workContextSummary: string;
  testCoverageSummary: string;
  crossRepoImpact: string[];
  suggestedReviewers: string[];
  missingTests: string[];
  markdownBody: string;
}

export interface PRWorkContextSummary {
  jiraKey?: string;
  teamsCount: number;
  relatedMeetings: Array<{ title: string; summary: string; decisions: string; date: string }>;
  openActionItems: Array<{ content: string; assignee: string }>;
  ticketLearnings: Array<{ solution: string; traps: string; cycleHours: number | null }>;
}

export interface PRCommit {
  oid: string;
  messageHeadline: string;
  messageBody: string;
  authoredDate: string;
  authors: Array<{ login: string; name: string }>;
}

export interface PRFileImpact {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
  blastRadius: Array<{ repo: string; file_path: string; ref_type: string; depth: number }>;
}

export interface PRCommitsResponse {
  prNum: number;
  repo: string;
  commits: PRCommit[];
  files: PRFileImpact[];
  crossRepoImpact: boolean;
  totalImpactedFiles: number;
}

// ── Phase 55: Bug Investigation Engine ────────────────────────

export interface ReActEntry {
  iteration: number;
  thought: string;
  tool: string;
  toolInput: Record<string, unknown>;
  observation: string;
}

export interface EvidenceEntry {
  type: string;
  description: string;
  file?: string;
  sha?: string;
}

export interface InvestigationReport {
  rootCauseType: string;
  isExternalDep: boolean;
  fixOwner: string;
  rootCause: string;
  nextAction: string;
  confidence: number;
  proposedFix: { steps: string[] } | null;
  evidence: EvidenceEntry[];
  issueKey: string;
}

export interface InvestigationSession {
  issueKey: string;
  status: 'running' | 'done' | 'failed';
  reactTrace: ReActEntry[];
  report: InvestigationReport | null;
  startedAt: string;
  completedAt: string | null;
}

// ── Phase 69-70: Unified Brain API ────────────────────────────

export interface BrainEvidence {
  source: string;
  id: string;
  count?: number;
  note?: string;
  /** U-10 phase 2: optional structured fields when backend supplies them */
  url?: string;
  snippet?: string;
  timestamp?: string;
}

export interface BrainNextAction {
  type: 'verify' | 'fix' | 'monitor' | string;
  tool: string;
  args: string;
}

export interface BrainAlternative {
  decision: string;
  score: number;
}

export interface DecisionResult {
  decision_id: string;
  decision: string;
  rationale: string;
  confidence: number;
  evidence: BrainEvidence[];
  next_actions: BrainNextAction[];
  alternatives?: BrainAlternative[];
  // U-18: present once the learning loop is closed. 'pending' = not yet rated.
  outcome?: 'pending' | 'success' | 'failed' | 'abandoned' | string;
}

// ── Phase 56: Self-Learning Brain ─────────────────────────────
export interface BrainStats {
  toolEffectiveness: Array<{
    toolName: string;
    rootCauseType: string;
    effectivenessScore: number;
    invocations: number;
  }>;
  accuracyByRootCause: Array<{
    rootCauseType: string;
    total: number;
    correct: number;
    accuracy: number;
  }>;
  patternCount: number;
  staleKnowledgeCount: number;
}

// ── API ────────────────────────────────────────────────────────

// ── ADR-030 Phase A: bug capture types ─────────────────────────────────────

export type BugSource = 'bridge' | 'agent' | 'web-ui' | 'sync' | 'bug-investigator';
/**
 * v56 — widened with three resolver-flow states ('resolving',
 * 'auto-resolved', 'unable-to-resolve'). Mirrors src/types/bugs.ts.
 */
export type BugStatus =
  | 'new'
  | 'investigating'
  | 'proposed'
  | 'auto-merged'
  | 'resolved'
  | 'wont-fix'
  | 'resolving'
  | 'auto-resolved'
  | 'unable-to-resolve';
export type BugSeverity = 'low' | 'medium' | 'high';

export interface BugRow {
  id: number;
  fingerprint: string;
  source: BugSource;
  error_name: string;
  message: string;
  top_frame: string | null;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  status: BugStatus;
  severity: BugSeverity;
  context_json: string | null;
  investigation_attempts: number;
  last_investigation_id: number | null;
  // v55 — manual severity override (escalation UX). Override wins over the
  // ring-buffer-computed severity. severity_override_at is set when the
  // override is applied; cleared when the override is removed.
  severity_override: BugSeverity | null;
  severity_override_reason: string | null;
  severity_override_at: string | null;
}

export interface BugInvestigation {
  id: number;
  bug_id: number;
  root_cause: string;
  files_to_change: string;
  lines_changed: number;
  confidence: number;
  suggested_patch: string | null;
  decided_at: string;
  brain_decision_id: number | null;
}

/**
 * v56 — Phase 76 BugResolverAgent audit row. One row per resolver attempt
 * regardless of outcome. `commit_sha` set on success; `failure_reason`
 * set on `unable-to-resolve`. `brain_decision_id` is always NULL in
 * Phase 76 (reserved for Phase 77 brain-escalation).
 */
export type BugResolutionOutcome = 'auto-resolved' | 'unable-to-resolve';

export interface BugResolution {
  id: number;
  bug_id: number;
  attempt_at: string;
  outcome: BugResolutionOutcome;
  cwd: string;
  files_changed: string | null;
  commit_sha: string | null;
  failure_reason: string | null;
  brain_decision_id: number | null;
}

export interface BugReportPayload {
  source: BugSource;
  errorName: string;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  context?: Record<string, unknown>;
  build?: 'dev' | 'preview' | 'production';
}

export interface DreamItem {
  id: number;
  type: 'add' | 'update' | 'prune';
  target: string;
  room?: string;
  frontmatter?: unknown;
  body?: string;
  index_line?: string;
  evidence: string;
  rationale: string;
  status: 'pending' | 'applied' | 'rejected';
}
export interface DreamReport {
  generated_at: string | null;
  window_hours: number;
  items: DreamItem[];
}
export interface DreamApplyResult {
  id: number;
  action: string;
  target?: string;
  commit?: string;
  surfaces?: { auto_memory: boolean; palace: boolean; claude_mem: boolean };
  error?: string;
}

export const api = {
  status: () => request<Status>('/status'),
  connectors: () => request<ConnectorsResponse>('/connectors'),
  /** STEP 11 — wizard writes enabled/mode for one connector (structure only). */
  saveConnector: (body: { name: string; enabled?: boolean; mode?: string }) =>
    request<{ ok: boolean; name: string; enabled: boolean; mode: string | null }>('/connectors', body),
  topics: () => request<Topic[]>('/topics'),
  syncState: () => request<SyncState[]>('/sync-state'),

  dreamReport: () => request<DreamReport>('/dream/report'),
  dreamApply: (body: { approved?: number[]; rejected?: number[]; all?: boolean }) =>
    request<{ ok: boolean; noop?: boolean; results: DreamApplyResult[] }>('/dream/apply', body),

  actionItems: (p: { topic?: string; status?: string; assignee?: string } = {}) => {
    const qs = new URLSearchParams();
    if (p.topic) qs.set('topic', p.topic);
    if (p.status) qs.set('status', p.status);
    if (p.assignee) qs.set('assignee', p.assignee);
    return request<ActionItem[]>(`/action-items?${qs}`);
  },

  recentMessages: (p: { limit?: number; source?: string } = {}) => {
    const qs = new URLSearchParams();
    if (p.limit) qs.set('limit', String(p.limit));
    if (p.source) qs.set('source', p.source);
    return request<Message[]>(`/messages/recent?${qs}`);
  },

  recentMeetings: (limit = 8) =>
    request<Meeting[]>(`/meetings/recent?limit=${limit}`),

  search: (body: { topic: string; keywords?: string; source?: string }) =>
    request<{ results: Message[] }>('/search', body),

  searchAll: (body: { query: string; sources?: string[]; since?: string; jiraBoardUrl?: string; maxResults?: number; sortBy?: 'relevance' | 'recency' }) =>
    request<MarkdownResult>('/search-all', body),

  digest: (body: { topic: string; date?: string; refresh?: boolean }) =>
    request<MarkdownResult & { cached?: boolean }>('/digest', body),

  jiraReport: (body: { projectKey: string; boardUrl: string; since?: string }) =>
    request<JiraReportResult>('/jira-report', body),

  teamsUpdates: (body: { query: string; since?: string; includeMeetings?: boolean; maxResults?: number }) =>
    request<MarkdownResult>('/teams-updates', body),

  listFavKeywords: () =>
    request<{ keywords: TeamsFavKeyword[] }>('/teams-fav-keywords'),

  addFavKeyword: (keyword: string) =>
    request<TeamsFavKeyword>('/teams-fav-keywords', { keyword }),

  deleteFavKeyword: (id: number) =>
    requestDelete<{ ok: boolean }>(`/teams-fav-keywords/${id}`),

  // EP-53: Teams Intelligence Feed
  teamsChats: () =>
    request<{ chats: ChatSummary[] }>('/teams/chats'),

  teamsChatFeed: (chatName: string) =>
    request<ChatFeed>(`/teams/chats/${encodeURIComponent(chatName)}/feed`),

  generateChatDigest: (chatName: string) =>
    request<{ status: string; chatName: string } | { digest: string; digestAge: number; cached: boolean }>(
      `/teams/chats/${encodeURIComponent(chatName)}/digest`,
      {}
    ),

  topicExpert: (body: { question: string; projectKey?: string; sources?: string[]; since?: string; maxResults?: number }) =>
    request<MarkdownResult>('/topic-expert', body),

  configureTopic: (body: { name: string; sources: Record<string, unknown> }) =>
    request<{ topic: Topic }>('/configure-topic', body),

  deleteTopic: (id: number) =>
    fetch(`/api/topics/${id}`, { method: 'DELETE' }).then(r => r.json()) as Promise<{ ok: boolean }>,

  updateTopic: (id: number, body: { name?: string; config?: unknown; lookback_days?: number }) =>
    fetch(`/api/topics/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()) as Promise<Topic>,

  saturnIssues: (opts?: { refresh?: boolean }) =>
    request<{ issues: JiraIssue[]; cachedAt?: string; error?: string; isRefreshing?: boolean; lastFailedAt?: string | null; dataSource?: string }>(
      `/saturn/issues${opts?.refresh ? '?refresh=true' : ''}`
    ),

  /** @deprecated Use getTicketDetail instead — same endpoint, richer return type (WR-50-3) */
  getJiraTicket: (key: string) =>
    request<JiraTicketSummary>(`/jira/ticket/${encodeURIComponent(key)}`),

  jiraMcpStatus: () =>
    request<{ connected: boolean; error?: string }>('/jira/mcp-status'),

  myIssues: (opts?: { refresh?: boolean }) =>
    request<{ issues: JiraIssue[]; cachedAt?: string; error?: string; isRefreshing?: boolean }>(
      `/jira/my-issues${opts?.refresh ? '?refresh=true' : ''}`
    ),

  analyzeTicket: (body: { issueKey: string; title: string; status: string; assignee: string | null; epic: string | null }) =>
    request<{ issueKey: string; status: 'pending'; codeFiles: string[] }>('/jira/analyze', body),

  getJiraAnalysis: (issueKey: string) =>
    request<JiraAnalysis>(`/jira/analysis/${encodeURIComponent(issueKey)}`),

  listJiraAnalyses: () =>
    request<{ analyses: JiraAnalysis[] }>('/jira/analyses'),

  saveJiraNotes: (issueKey: string, notes: string) =>
    requestPut<{ issueKey: string; notes: string }>(`/jira/analysis/${encodeURIComponent(issueKey)}/notes`, { notes }),

  getEpicChildren: (epicKey: string) =>
    request<{ children: EpicChildIssue[] }>(`/jira/epic/${encodeURIComponent(epicKey)}/children`),

  draftPR: (issueKey: string, body: { title: string; prBody?: string; repo?: string }) =>
    request<{ url: string }>(`/jira/ticket/${encodeURIComponent(issueKey)}/draft-pr`, body),

  syncAll: () =>
    request<{ status: string } & SyncProgress>('/sync/all', {}),

  syncStatus: () =>
    request<SyncProgress>('/sync/status'),

  // EP-18: Error tracking
  listErrors: (opts: { limit?: number; resolved?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.resolved !== undefined) qs.set('resolved', String(opts.resolved));
    return request<{ errors: ErrorLog[]; count: number }>(`/errors?${qs}`);
  },

  analyzeError: (id: number) =>
    request<{ analysis: { severity: string; category: string; suggested_fix: string } }>(
      `/errors/${id}/analyze`, {}
    ),

  resolveError: (id: number) =>
    request<{ ok: boolean }>(`/errors/${id}/resolve`, {}),

  // EP-19: Digest list/delete
  listDigests: (limit = 20) =>
    request<{ digests: DigestRecord[]; count: number }>(`/digests?limit=${limit}`),

  deleteDigest: (id: number) =>
    request<{ ok: boolean }>(`/digests/${id}`),

  // EP-23: Daily summary
  dailySummary: (opts?: { date?: string; refresh?: boolean }) => {
    const qs = new URLSearchParams();
    if (opts?.date) qs.set('date', opts.date);
    if (opts?.refresh) qs.set('refresh', 'true');
    return request<DailySummary>(`/daily-summary?${qs}`);
  },

  // EP-24: Smart Chat
  // Phase 78a-05 — `mode` is the chip-selected value sent on every turn.
  // 'auto' (default) lets the server detect; 'work'/'life' force a manual
  // override. Response carries the resolved `detectedMode` plus telemetry
  // so the UI can render "Auto → Work" subtitles / PersonaFooter copy.
  chat: (body: {
    message: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    context: { page: string; projectKey?: string };
    injectedContext?: string;
    mode?: 'auto' | 'work' | 'life';
    conversationId?: string;
  }) => request<{
    reply: string;
    sources: Array<{ type: string; title: string; url?: string }>;
    suggestedFollowUps: string[];
    needsSync?: boolean;
    gaps?: Array<{ source: string; label: string; reason: string }>;
    researchPerformed?: boolean;
    researchTrace?: { iterations: number; confidence: number; durationMs: number } | null;
    // Phase 78a-04 response shape (consumed in 78a-05):
    detectedMode: 'work' | 'life' | 'ambiguous';
    modeSource: 'auto' | 'manual';
    modeSignals: string[];
    /** AMBIGUOUS short-circuit — when set, `reply` already IS the clarifying prompt. */
    clarifyingPrompt?: string;
  }>('/chat', body),

  // EP-25: Calendar
  upcomingCalendar: (opts?: { days?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.days) qs.set('days', String(opts.days));
    return request<{ events: CalendarEvent[]; count: number; error?: string }>(`/calendar/upcoming?${qs}`);
  },

  // Topic Notebooks (LLM memory)
  listNotebooks: () =>
    request<{ notebooks: Pick<TopicNotebook, 'topic_name' | 'last_updated' | 'message_count'>[] }>('/notebooks'),

  getNotebook: (topicName: string) =>
    request<TopicNotebook>(`/notebooks/${encodeURIComponent(topicName)}`),

  rebuildNotebook: (topicName: string) =>
    request<TopicNotebook>(`/notebooks/${encodeURIComponent(topicName)}/rebuild`, {}),

  notebookChat: (topicName: string, body: {
    message: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }) =>
    request<{ reply: string; suggestedFollowUps: string[]; hasNotebook: boolean }>(
      `/notebooks/${encodeURIComponent(topicName)}/chat`, body
    ),

  notebookChatHistory: (topicName: string) =>
    request<{ history: NotebookChatEntry[] }>(
      `/notebooks/${encodeURIComponent(topicName)}/history`
    ),

  // EP-27: Annotations + Vault
  getAnnotation: (topicName: string) =>
    request<{ annotation: string | null }>(`/notebooks/${encodeURIComponent(topicName)}/annotation`),

  saveAnnotation: (topicName: string, annotation: string) =>
    requestPut<{ ok: boolean }>(`/notebooks/${encodeURIComponent(topicName)}/annotation`, { annotation }),

  // EP-49-4: Human corrections
  submitNotebookFeedback: (topicName: string, correction: string) =>
    request<{ ok: boolean }>(`/notebooks/${encodeURIComponent(topicName)}/feedback`, { correction }),

  getVaultStatus: () =>
    request<VaultStatus>('/vault/status'),

  exportVault: () =>
    request<VaultExportResult>('/vault/export', {}),

  notebookGraph: () =>
    request<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/notebooks/graph'),

  // EP-14-3: Topic suggestions
  topicSuggestions: () =>
    request<{ suggestions: TopicSuggestion[] }>('/topic-suggestions'),

  dismissTopicSuggestion: (id: number) =>
    request<{ ok: boolean; message: string }>(`/topic-suggestions/${id}/dismiss`, {}),

  // EP-15: Alert feed, workload, morning brief, pre-brief regeneration
  alerts: () =>
    request<AlertFeedResponse>('/alerts'),

  workload: () =>
    request<WorkloadResponse>('/workload'),

  morningBrief: (opts?: { refresh?: boolean }) =>
    request<MorningBrief>(`/morning-brief${opts?.refresh ? '?refresh=true' : ''}`),

  regeneratePreBrief: (eventId: number) =>
    request<{ brief: string; generatedAt: string }>(`/calendar/events/${eventId}/regenerate-brief`, {}),

  getMeetingContext: (eventId: number) =>
    request<MeetingContext>(`/calendar/events/${eventId}/context`),

  getMeetingTopicLinks: (meetingId: number) =>
    request<{ suggestions: Array<{ topic_id: number; topic_name: string; confidence: number; confirmed: number }> }>(`/meetings/${meetingId}/topic-suggestions`),

  confirmMeetingTopicLink: (meetingId: number, topicId: number) =>
    request<{ ok: boolean }>(`/meetings/${meetingId}/topic-suggestions/${topicId}/confirm`, {}),

  removeMeetingTopicLink: (meetingId: number, topicId: number) =>
    requestDelete<{ ok: boolean }>(`/meetings/${meetingId}/topic-suggestions/${topicId}`),

  // EP-32: Token usage stats
  tokenStats: (days = 30) =>
    request<TokenStats>(`/token-stats?days=${days}`),

  // EP-33: Data quality
  dataQuality: (status: 'open' | 'resolved' = 'open') =>
    request<{ issues: DataQualityIssue[] }>(`/data-quality?status=${status}`),

  resolveDataQualityIssue: (id: number) =>
    request<{ ok: boolean }>(`/data-quality/${id}/resolve`, {}),

  // EP-35: Action item confidence triage
  pendingReviewItems: (topic?: string) =>
    request<{ items: ActionItem[] }>(`/action-items/pending-review${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`),

  confirmActionItem: (id: number) =>
    request<{ ok: boolean }>(`/action-items/${id}/confirm`, {}),

  dismissActionItem: (id: number) =>
    request<{ ok: boolean }>(`/action-items/${id}/dismiss`, {}),

  // EP-38: Weekly report
  weeklyReport: () =>
    request<WeeklyReport>('/weekly-report'),

  // EP-39: Cross-topic relationships
  detectRelationships: () =>
    request<{ detected: number; relationships: TopicRelationship[] }>('/relationships/detect', {}),

  getRelationships: (topicName: string) =>
    request<{ topicName: string; relationships: TopicRelationship[] }>(`/relationships/${encodeURIComponent(topicName)}`),

  // System Health page
  systemHealth: () =>
    request<SystemHealth>('/system-health'),

  ingestionLog: (limit = 20) =>
    request<{ logs: IngestionLogEntry[] }>(`/ingestion-log?limit=${limit}`),

  allRelationships: () =>
    request<{ relationships: AllRelationship[] }>('/relationships'),

  // EP-41: Topic Health Score
  topicHealth: () =>
    request<{ topics: TopicHealth[] }>('/topics/health'),

  // EP-42-3: Jira analytics
  jiraVelocity: (project: string, weeks = 8) =>
    request<{ project: string; weeks: number; stats: VelocityStats[] }>(`/jira/velocity?project=${project}&weeks=${weeks}`),
  jiraStuck: (project: string, days = 3) =>
    request<{ project: string; days: number; stuck: Array<{ issue_key: string; current_status: string; transitioned_at: string; title: string | null; assignee: string | null; url: string | null }>; count: number }>(`/jira/stuck?project=${project}&days=${days}`),

  // EP-42-5: Unified issues
  jiraIssues: (filter: 'mine' | 'saturn' | 'sprint' | 'backlog' = 'saturn') =>
    request<{ filter: string; issues: JiraIssue[]; cachedAt: string | null; isRefreshing: boolean }>(`/jira/issues?filter=${filter}`),

  // EP-42-7: Ticket learnings
  getTicketLearning: (issueKey: string) =>
    request<{ learning: TicketLearning | null }>(`/jira/ticket/${issueKey}/learn`),
  saveTicketLearning: (issueKey: string, body: { summary: string; solution: string; files_changed?: string[]; traps?: string; cycle_time_hours?: number }) =>
    request<{ ok: boolean }>(`/jira/ticket/${issueKey}/learn`, body),
  searchLearnings: (project: string, q?: string) =>
    request<{ learnings: TicketLearning[] }>(`/jira/learnings?project=${project}${q ? `&q=${encodeURIComponent(q)}` : ''}`),

  // EP-45: Teammate Intelligence
  teammates: () => request<TeamMember[]>('/teammates'),
  addTeammate: (body: { name: string; email?: string; github_handle?: string; jira_username?: string; teams_display_name?: string }) =>
    request<{ id: number }>('/teammates', body),
  markTeammate: (id: number, marked: boolean) =>
    requestPatch<{ ok: boolean }>(`/teammates/${id}/mark`, { marked }),
  deleteTeammate: (id: number) => requestDelete<{ ok: boolean }>(`/teammates/${id}`),
  teammateProfile: (id: number) => request<MemberFullProfile>(`/teammates/${id}/profile`),
  teammateExpert: (repo: string, file: string) =>
    request<{ member: TeamMember | null; reasoning: string }>(`/teammates/expert?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}`),
  teammatesSync: () => request<{ ok: boolean; count: number }>('/teammates/sync', {}),

  // EP-44: PR Intelligence
  listPRs: (repo: string, state = 'open') =>
    request<{ prs: GithubPR[]; source?: string }>(`/pr/list?repo=${repo}&state=${state}`),
  reviewPR: (repo: string, prNum: number, forceRefresh = false) =>
    request<{ prNum: number; repo: string; review: PRReview; blastRadius: unknown[]; workContext: PRWorkContextSummary | null; cached: boolean; cachedAt?: string }>(`/pr/review?repo=${repo}&pr=${prNum}${forceRefresh ? '&refresh=1' : ''}`),
  enrichPR: (repo: string, prNum: number) =>
    request<{ prNum: number; description: string }>(`/pr/enrich?repo=${repo}&pr=${prNum}`),
  // OP-2 / U-5: default to dry_run preview. Pass { execute: true } from the
  // UI's confirmation button to actually open the PR.
  createPR: (body: { repo: string; branch: string; title: string; body?: string; base?: string; execute?: boolean }) =>
    request<{ url?: string; repo: string; branch?: string; dry_run?: boolean; preview?: Record<string, unknown> }>(
      '/pr/create',
      { ...body, dry_run: !body.execute }
    ),
  prCommits: (repo: string, prNum: number) =>
    request<PRCommitsResponse>(`/pr/commits?repo=${repo}&pr=${prNum}`),
  // OP-2 / U-5: default to dry_run preview. Pass { execute: true } to actually post.
  postPRReview: (body: { repo: string; pr: number; body: string; event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; execute?: boolean }) =>
    request<{ url?: string; prNum?: number; repo: string; dry_run?: boolean; preview?: Record<string, unknown> }>(
      '/pr/post-review',
      { ...body, dry_run: !body.execute }
    ),

  // EP-54: PR Watch (DB-backed follow state)
  getWatchedPRs: (repo: string) =>
    request<{ prs: number[] }>(`/pr/watch?repo=${encodeURIComponent(repo)}`),
  watchPR: (repo: string, pr: number) =>
    request<{ ok: boolean }>('/pr/watch', { repo, pr }),
  unwatchPR: (repo: string, pr: number) =>
    requestDelete<void>(`/pr/watch?repo=${encodeURIComponent(repo)}&pr=${pr}`),
  watchedPRsSummary: () =>
    request<{ items: WatchedPRSummary[] }>('/pr/watched-summary'),

  // EP-50: Jira My Work Cockpit
  jiraBoard: (tab: 'mine' | 'sprint' | 'all', refresh = false): Promise<JiraBoardResponse> =>
    request<JiraBoardResponse>(`/jira/board?tab=${tab}${refresh ? '&refresh=true' : ''}`),

  getTicketDetail: (key: string): Promise<TicketDetail> =>
    request<TicketDetail>(`/jira/ticket/${encodeURIComponent(key)}`),

  // Phase 56: Self-Learning Brain
  brainStats: () => request<BrainStats>('/jira/brain/stats'),
  brainRefresh: () => request<{ refreshed: number }>('/jira/brain/refresh-knowledge', {}),
  recordOutcome: (key: string, body: { actualRootCause: string; actualFixOwner?: string }) =>
    requestPut<{ ok: boolean }>(`/jira/investigation/${key}/outcome`, body),

  // Phase 55: Bug Investigation Engine
  startInvestigation: async (input: {
    issueKey: string; title: string; status: string;
    assignee: string | null; description: string; createdAt: string;
  }): Promise<{ issueKey: string; status: string }> => {
    const res = await fetch(`${BASE}/jira/investigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return res.json() as Promise<{ issueKey: string; status: string }>;
  },

  getInvestigation: async (issueKey: string): Promise<InvestigationSession | null> => {
    const res = await fetch(`${BASE}/jira/investigation/${encodeURIComponent(issueKey)}`);
    if (res.status === 404) return null;
    return res.json() as Promise<InvestigationSession>;
  },

  // U-18 / Phase 71-01: close the learning loop from the UI
  brainLearn: async (body: { decision_id: string; outcome: 'success' | 'failed' | 'abandoned'; notes?: string }) => {
    const res = await fetch(`${BASE}/brain/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WI-Consumer': 'ui' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<{ ok: boolean; palace_updated?: boolean }>;
  },

  // Phase 70-03: Brain Decision API
  postBrainDecide: async (body: { question: string; context?: Record<string, unknown>; user?: string }): Promise<DecisionResult> => {
    const user = body.user ?? (await getBrainUser());
    const res = await fetch(`${BASE}/brain/decide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WI-Consumer': 'ui',
      },
      body: JSON.stringify({ ...body, user }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<DecisionResult>;
  },

  /**
   * OP-7 / U-3: streaming variant. Opens an SSE connection to
   * GET /api/brain/decide/stream and forwards each stage event to `onStage`.
   * Returns a cancel function. Resolves with the final DecisionResult, or
   * rejects with an Error whose `.code` mirrors the bridge's `error` field
   * (`'daily_budget_exceeded' | 'invalid_consumer' | 'internal_error' | ...`).
   *
   * The caller is responsible for invoking `cancel()` if it wants to abort
   * (e.g. user navigates away). The promise will resolve when the bridge
   * sends the `result` event and the stream closes naturally.
   */
  streamBrainDecide(
    body: { question: string; user?: string; context?: Record<string, unknown> },
    handlers: {
      onStage?: (stage: string, meta: Record<string, unknown>) => void;
      onResult?: (result: DecisionResult) => void;
      onError?: (err: { code: string; message: string }) => void;
    },
  ): { promise: Promise<DecisionResult>; cancel: () => void } {
    let es: EventSource | null = null;
    let settled = false;

    const promise = (async () => {
      const user = body.user ?? (await getBrainUser());
      const params = new URLSearchParams();
      params.set('question', body.question);
      params.set('user', user);
      if (body.context) params.set('context', JSON.stringify(body.context));
      // EventSource lacks header support — we depend on the CORS allow-list
      // gating instead. (Consumer defaults to 'ui' on the bridge.)
      es = new EventSource(`${BASE}/brain/decide/stream?${params.toString()}`);

      return new Promise<DecisionResult>((resolve, reject) => {
      es!.addEventListener('stage', (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data);
          const { stage, ...meta } = data;
          handlers.onStage?.(stage, meta);
        } catch { /* ignore malformed line */ }
      });
      es!.addEventListener('result', (ev: MessageEvent) => {
        try {
          const result = JSON.parse(ev.data) as DecisionResult;
          settled = true;
          handlers.onResult?.(result);
          es!.close();
          resolve(result);
        } catch (e) {
          settled = true;
          es!.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      es!.addEventListener('error', (ev: MessageEvent | Event) => {
        // SSE 'error' fires both on server-sent error events AND on network drops.
        // Disambiguate by checking for a data payload.
        const data = (ev as MessageEvent).data;
        if (data) {
          try {
            const parsed = JSON.parse(data);
            const code = parsed.error ?? 'internal_error';
            const message = parsed.message ?? code;
            handlers.onError?.({ code, message });
            const err = new Error(message);
            (err as Error & { code?: string }).code = code;
            settled = true;
            es!.close();
            reject(err);
            return;
          } catch { /* fall through to generic */ }
        }
        if (!settled) {
          es!.close();
          reject(new Error('SSE stream closed before result'));
        }
      });
      });
    })();

    return {
      promise,
      cancel: () => { try { es?.close(); } catch { /* already closed */ } },
    };
  },

  // ── ADR-030 Phase A: bug capture ────────────────────────────────────────
  reportBug: (payload: BugReportPayload) =>
    request<{ ok: true; fingerprint: string; occurrence_count: number; is_new: boolean; severity: BugSeverity }>(
      '/bugs/report',
      payload,
    ),

  listBugs: (p: { status?: BugStatus; source?: BugSource; severity?: BugSeverity; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (p.status) qs.set('status', p.status);
    if (p.source) qs.set('source', p.source);
    if (p.severity) qs.set('severity', p.severity);
    if (p.limit !== undefined) qs.set('limit', String(p.limit));
    if (p.offset !== undefined) qs.set('offset', String(p.offset));
    return request<{ ok: true; bugs: BugRow[]; total: number }>(`/bugs?${qs}`);
  },

  getBug: (id: number) =>
    request<{
      ok: true;
      bug: BugRow;
      recent_occurrences: Array<{ seen_at: string }>;
      investigation: BugInvestigation | null;
      latest_resolution: BugResolution | null;
    }>(
      `/bugs/${id}`,
    ),

  resolveBug: (id: number, resolution: 'resolved' | 'wont-fix', note?: string) =>
    request<{ ok: true; bug: BugRow }>(`/bugs/${id}/resolve`, { resolution, note }),

  // ADR-030 Phase B (Plan 75-05): re-investigate. Resets status='new',
  // last_investigation_id=NULL, investigation_attempts=0. Next agent
  // tick (≤ BUG_INVESTIGATOR_INTERVAL_MS) picks the row up.
  reinvestigateBug: (id: number) =>
    request<{ ok: true; bug: BugRow }>(`/bugs/${id}/reinvestigate`, {}),

  // ADR-030 Phase C (Plan 76): user-clicked resolver attempt. Flips status
  // 'proposed' → 'resolving' atomically and enqueues the BugResolverAgent.
  // Returns 400 'resolver_disabled' when BUG_RESOLVER_ENABLED!=1, 400
  // 'invalid_status' when bug isn't in 'proposed' state.
  resolveBugAttempt: (id: number) =>
    request<{ ok: true; bug: BugRow }>(`/bugs/${id}/resolve-attempt`, {}),

  // v55 — manual severity override (escalation UX). Pass severity=null to
  // clear the override and let the ring-buffer recompute take over again.
  setBugSeverity: (id: number, severity: BugSeverity | null, reason?: string) =>
    request<{ ok: true; bug: BugRow }>(`/bugs/${id}/severity`, { severity, reason }),

  // ── ADR-031: per-bucket model + effort registry ─────────────────────────
  getModelConfig: () =>
    request<ModelConfigResponse>('/model-config'),

  updateModelConfig: (update: { bucket: Bucket; model: ModelId; effort: Effort; thinking_mode: ThinkingMode }) =>
    request<{ ok: true; updated: number; buckets: BucketRow[] }>('/model-config', { updates: [update] }),

  // Cypher visibility panel (slice 81b).
  cypherPriors: () => request<CypherPriorsResponse>('/cypher/health/priors'),
  cypherSessions: (limit = 20) => request<CypherSessionsResponse>(`/cypher/health/sessions?limit=${limit}`),
  cypherSession: (id: string) => request<CypherSessionDetail>(`/cypher/health/sessions/${encodeURIComponent(id)}`),
  cypherStale: (ageHours = 2, limit = 100) =>
    request<CypherStaleResponse>(`/cypher/health/sessions/stale?ageHours=${ageHours}&limit=${limit}`),
  cypherSweep: (session_ids: string[], outcome: 'mixed' | 'failed') =>
    request<CypherSweepResult>('/cypher/health/sessions/sweep', { session_ids, outcome }),
  cypherPmRollup: () => request<CypherPmRollupResponse>('/cypher/pm/rollup'),
  cypherPmDrift: () => request<CypherPmDriftResponse>('/cypher/pm/drift'),
  cypherSkillCatalog: () => request<CypherSkillCatalogResponse>('/cypher/skill-catalog'),

  // ADR-034 L1.1 — outcome ledger (thumbs UI + read aggregate).
  cypherOutcomes: (sessionId: string) =>
    request<CypherOutcomesResponse>(`/cypher/outcomes/${encodeURIComponent(sessionId)}`),
  cypherPostThumbs: async (sessionId: string, value: 0.8 | -1.0): Promise<CypherThumbsResponse> => {
    const user = await getBrainUser();
    const res = await fetch(`${BASE}/cypher/outcomes?user=${encodeURIComponent(user)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, signal_kind: 'thumbs', value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { code: res.statusText } }));
      throw new Error((err as { error?: { code?: string } }).error?.code ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<CypherThumbsResponse>;
  },

  // ── ADR-039 AC-14/AC-15: user_verdict capture ─────────────────────────
  // 4-enum signal that lets OPRO learn about prompt clarity rather than
  // only output quality. Writes to prompt_outcomes.user_verdict for the
  // most-recent goal_refinement row matching the session's goal. Returns
  // 404 OUTCOME_ROW_NOT_FOUND when the SCOPE phase hasn't scored this
  // session yet (typical until T8 wires scoreRefinedGoal into the loop).
  cypherPostUserVerdict: async (
    sessionId: string,
    verdict: CypherUserVerdict,
  ): Promise<CypherUserVerdictResponse> => {
    const res = await fetch(`${BASE}/cypher/sessions/${encodeURIComponent(sessionId)}/user-verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { code: res.statusText } }));
      throw new Error((err as { error?: { code?: string } }).error?.code ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<CypherUserVerdictResponse>;
  },

  // ── ADR-040 /board — commit 1 read endpoint ───────────────────────────
  // 404 when OUTCOME_HONEST_KANBAN_ENABLED != '1' on the bridge; the UI
  // treats that as "flag off" and surfaces a "kanban disabled" banner
  // rather than a hard error.
  boardTasks: (p: { column?: KanbanColumn; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (p.column) qs.set('column', p.column);
    if (p.limit != null) qs.set('limit', String(p.limit));
    if (p.offset != null) qs.set('offset', String(p.offset));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ tasks: BoardTask[] }>(`/board/tasks${suffix}`);
  },

  // ── ADR-040 F-UI: PATCH a task (column move + block toggle + reorder) ─
  // Server refuses a move to `done` unless a user_observed evidence row
  // already exists — that's the DoD contract. UI presents that refusal
  // as an actionable message ("verify first via e2e, then 👍").
  updateBoardTask: (
    id: string,
    patch: {
      kanban_column?: KanbanColumn;
      kanban_order?: number;
      blocked?: 0 | 1;
      blocked_reason?: string | null;
    },
  ) => requestPatch<{ task: BoardTask }>(`/board/tasks/${encodeURIComponent(id)}`, patch),

  // ── ADR-040 F-UI: card comment thread ────────────────────────────────
  boardComments: (id: string) =>
    request<{ comments: CardComment[]; needs_answer: 0 | 1 }>(
      `/board/tasks/${encodeURIComponent(id)}/comments`,
    ),
  addBoardComment: (
    id: string,
    body: string,
    kind: CardComment['kind'] = 'answer',
    author: CardComment['author'] = 'user',
  ) =>
    request<{ comment: CardComment }>(`/board/tasks/${encodeURIComponent(id)}/comments`, {
      body,
      kind,
      author,
    }),

  // ADR-040 F-UI: retrigger a stalled card (fresh dispatch)
  retriggerBoardTask: (id: string) =>
    request<{ ok: boolean; id: string; kanban_column: KanbanColumn }>(
      `/board/tasks/${encodeURIComponent(id)}/retrigger`,
      {},
    ),

  // ADR-040 F-UI: worker roster + free/on-duty rollup
  boardWorkers: () =>
    request<{ workers: BoardWorker[]; total: number; on_duty: number; free: number }>(
      `/board/workers`,
    ),

  // ── ADR-040 commit 4.5: outcome-evidence endpoints ────────────────────
  // Two-step user_observed write: (1) mint a token bound to a (task,
  // session) pair; (2) POST the captured hash + verifier session id.
  // The server rejects empty (sha256('')) and stale (hash reused from
  // another task within 24h) captures.
  issueOutcomeToken: (p: { task_id: string; session_id: string }) =>
    request<{ token: string; expires_at: number }>('/outcome-evidence/token', p),

  submitOutcomeEvidence: (p: {
    token: string;
    task_id: string;
    session_id: string;
    verifier_session_id: string;
    verification_output_hash: string;
    non_fixture_identifier: string;
    verdict: 'pass' | 'fail';
    raw_payload?: Record<string, unknown>;
  }) => request<{ id: string; verified_via: 'user_observed' }>('/outcome-evidence', p),
};

// ADR-039 AC-14/AC-15 — user_verdict types.
export type CypherUserVerdict = 'useful' | 'wrong_question' | 'wrong_scope' | 'unrated';
export interface CypherUserVerdictResponse {
  ok: true;
  session_id: string;
  outcome_id: number;
  verdict: CypherUserVerdict;
}

// Phase 82b skill-catalog types.
export type CypherSkillSource = 'wi' | 'global' | 'plugin' | 'builtin';
export interface CypherCatalogRow {
  skill_name: string;
  source: CypherSkillSource;
  source_path: string;
  description: string | null;
  trigger_phrases: string[];
  task_classes: string[];
  registered_at: string;
  last_seen_at: string;
  in_priors: boolean;
}
export interface CypherSkillCatalogResponse {
  total: number;
  by_source: Record<CypherSkillSource, number>;
  in_priors_count: number;
  skills: CypherCatalogRow[];
  generated_at: string;
}

// ADR-034 L1.1 — outcome ledger types.
export type CypherSignalKind = 'verdict' | 'thumbs' | 'rerun' | 'edit_distance' | 'ci';

export interface CypherOutcomeSignal {
  kind: CypherSignalKind;
  value: number;
  weight: number;
  created_at: string;
  created_by: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CypherOutcomesResponse {
  ok: true;
  session_id: string;
  aggregate: number;
  signals: CypherOutcomeSignal[];
}

export interface CypherThumbsResponse {
  ok: true;
  id: number;
  upserted: boolean;
  aggregate: number;
  signals: CypherOutcomeSignal[];
}

// Cypher visibility types (slice 81b).
export interface CypherPriorPoint {
  skill_name: string;
  task_class: string;
  alpha: number;
  beta: number;
  mean: number;
  total_runs: number;
  updated_at: string;
}
export interface CypherPerSkillRate {
  chosen_skill: string;
  successes: number;
  attempts: number;
  rate: number | null;
}
export interface CypherPriorsResponse {
  current: CypherPriorPoint[];
  success_rate: CypherPerSkillRate[];
  generated_at: string;
}
export interface CypherSessionSummary {
  session_id: string;
  goal: string;
  task_class: string | null;
  user: string;
  status: 'pending' | 'done' | 'halted' | 'asked_user';
  /**
   * Full outcome enum matches the cypher_sessions CHECK constraint (post-v100).
   * Before the 2026-07-25 reducer fix the loop collapsed halted/abandoned/
   * rejected_non_interactive → 'mixed', so this field only ever carried a
   * narrow set. Now the honest verdict propagates — UI must handle every
   * enum value. See src/services/cypher/health.ts SessionSummary for the
   * source-of-truth comment.
   */
  outcome:
    | 'success' | 'mixed' | 'failed' | 'halted'
    | 'abandoned' | 'rejected_non_interactive' | 'captured_to_board'
    | null;
  /**
   * Model-emitted rationale from cypher_record_outcome, persisted alongside
   * outcome. Null when the model didn't call the tool. Renders in the
   * session-detail panel so users see WHY the model chose the verdict.
   */
  outcome_note: string | null;
  chosen_skill: string | null;
  skill_actually_invoked: string | null;
  complexity_verdict: 'light' | 'heavy' | 'borderline' | null;
  started_at: string;
  completed_at: string | null;
  step_count: number;
  in_flight: boolean;
  /** True when status='pending' AND started_at older than 2h. Slice 82a-1. */
  stale: boolean;
}
export interface CypherStaleResponse {
  sessions: CypherSessionSummary[];
  total: number;
  threshold_hours: number;
  generated_at: string;
}
export interface CypherSweepResult {
  swept: number;
  swept_ids: string[];
  already_closed: string[];
  not_found: string[];
}
export interface CypherSessionsResponse {
  sessions: CypherSessionSummary[];
  total: number;
}
export interface CypherStepRow {
  stage: string;
  stage_index: number;
  status: string;
  payload: unknown;
  duration_ms: number | null;
  created_at: string;
}
export interface CypherLinkRow {
  work_item_id: string;
  evidence_kind: string;
  evidence_value: string;
  note: string | null;
  created_at: string;
}
export interface CypherAutoActionRow {
  action: string;
  work_item_id: string;
  evidence_kind: string | null;
  evidence_value: string | null;
  reason: string;
  created_at: string;
}
export interface CypherSessionDetail {
  session: CypherSessionSummary;
  steps: CypherStepRow[];
  links: CypherLinkRow[];
  auto_actions: CypherAutoActionRow[];
}
export interface CypherPmRollupRow {
  phase: string;
  wave: string;
  pending: number;
  in_progress: number;
  shipped: number;
  blocked: number;
  deferred: number;
  total: number;
}
export interface CypherPmRollupResponse { rollup: CypherPmRollupRow[] }
export interface CypherDriftItem {
  id: string;
  title: string;
  status: string;
  reason: string;
  detail: string;
  updated_at: string;
}
export interface CypherDriftBucket { count: number; items: CypherDriftItem[] }
export interface CypherPmDriftResponse {
  stale_in_progress: CypherDriftBucket;
  shipped_no_commit: CypherDriftBucket;
  dead_file_path: CypherDriftBucket;
  total: number;
  generated_at: string;
}

// ── ADR-031: per-bucket model + effort types ───────────────────────────────
export type Bucket = 'fetch' | 'digest' | 'chat' | 'analyse' | 'decide' | 'agents' | 'bug-investigator';
export type ModelId = 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6' | 'claude-opus-4-8' | 'claude-opus-latest';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingMode = 'off' | 'adaptive';

export interface BucketRow {
  bucket: Bucket;
  model: ModelId;
  effort: Effort;
  thinking_mode: ThinkingMode;
  recommended: {
    model: ModelId;
    effort: Effort;
    thinking_mode: ThinkingMode;
    reason: string;
    doc_url: string;
  };
  available_efforts_for_model: Effort[];
  supports_adaptive_thinking: boolean;
}

export interface ModelCap {
  supportsAdaptiveThinking: boolean;
  effortsAvailable: Effort[];
  minCacheTokens: number;
  inputPriceMtok: number;
  outputPriceMtok: number;
}

export interface ModelConfigResponse {
  buckets: BucketRow[];
  effortMaxTokens: Record<Effort, number>;
  modelCaps: Record<ModelId, ModelCap>;
  availableModels: ModelId[];
  availableEfforts: Effort[];
  availableThinkingModes: ThinkingMode[];
  availableBuckets: Bucket[];
}

// ── ADR-040 /board ─────────────────────────────────────────────

export type KanbanColumn = 'ready' | 'in_progress' | 'review' | 'e2e' | 'done';

export interface BoardTask {
  id: string;
  title: string;
  posture: string;
  goal_text: string | null;
  acceptance_text: string | null;
  kanban_column: KanbanColumn;
  kanban_order: number;
  assigned_worker_id: number | null;
  blocked: 0 | 1;
  blocked_reason: string | null;
  entered_column_at: number | null;
  depends_on_json: string | null;
  created_at: number;
  last_touched: number;
  // ADR-040 F-UI (2026-07-09): bucket separation surfaces on Board
  project: string;
  parent_task_id: string | null;
  external_ref: string | null;
  // ADR-040 F-UI: short human-readable display number (#N)
  card_number: number | null;
  // ADR-040 F-UI: comment thread + needs-answer state
  needs_answer: 0 | 1;
  comment_count: number;
  // ADR-040 F-UI (2026-07-10): stalled = dead dispatch, needs retrigger
  stalled: 0 | 1;
  stalled_reason: string | null;
}

export interface CardComment {
  id: string;
  task_id: string;
  author: 'worker' | 'cypher' | 'user' | 'system';
  kind: 'progress' | 'question' | 'answer' | 'note';
  body: string;
  created_at: number;
}

export interface BoardWorker {
  number: number;
  profile_hint: string;
  health_status: string;
  on_duty: boolean;
  current_card_number: number | null;
  current_goal: string | null;
  current_task_stalled: boolean;
  heartbeat_age_sec: number;
}
