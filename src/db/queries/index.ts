/**
 * src/db/queries/index.ts — barrel re-export for all domain query modules.
 *
 * All callers import from 'src/db/queries.js' — Node resolves queries/index.js
 * automatically, so zero import changes are needed across the codebase.
 */

// Topics
export {
  InsertTopicSchema,
  createTopic,
  getTopic,
  getTopicByName,
  listTopics,
  deleteTopic,
  getTopicHealthScores,
} from './topics.js';
export type { InsertTopic, TopicHealth } from './topics.js';

// Messages
export {
  InsertMessageSchema,
  insertMessage,
  upsertMessage,
  searchMessages,
  getMessagesByTopic,
  getMessage,
} from './messages.js';
export type { InsertMessage, MessageFilters } from './messages.js';

// Action items
export {
  InsertActionItemSchema,
  insertActionItem,
  updateActionItem,
  getActionItems,
  getActionItem,
  deleteActionItem,
  getPendingReviewItems,
  confirmActionItem,
  dismissActionItem,
  autoPromotePendingItems,
} from './action-items.js';
export type { InsertActionItem, ActionItemUpdate, ActionItemFilters } from './action-items.js';

// Meetings
export {
  InsertMeetingSchema,
  insertMeeting,
  getMeeting,
  getMeetingsByTopic,
  deleteMeeting,
} from './meetings.js';
export type { InsertMeeting } from './meetings.js';

// Decisions
export {
  InsertDecisionSchema,
  insertDecision,
  getDecision,
  getDecisionsByTopic,
  getDecisionsByMeeting,
  deleteDecision,
} from './decisions.js';
export type { InsertDecision } from './decisions.js';

// Questions
export {
  InsertQuestionSchema,
  insertQuestion,
  updateQuestion,
  getQuestion,
  getQuestions,
  deleteQuestion,
} from './questions.js';
export type { InsertQuestion, QuestionUpdate, QuestionFilters } from './questions.js';

// Digests
export {
  saveDigest,
  getCachedDigest,
  listDigests,
  deleteDigest,
} from './digests.js';
export type { DigestRecord } from './digests.js';

// Calendar
export {
  upsertCalendarEvent,
  getUpcomingEvents,
  getEventsForDate,
  getLatestCalendarScrapeTime,
} from './calendar.js';
export type { CalendarEvent, InsertCalendarEvent } from './calendar.js';

// Notebooks
export {
  getNotebook,
  saveNotebook,
  listNotebooks,
  deleteNotebook,
  saveAnnotation,
  getAnnotation,
  getCorrections,
  appendCorrection,
  saveNotebookChatEntry,
  getNotebookChatHistory,
} from './notebooks.js';
export type { TopicNotebook, NotebookChatEntry } from './notebooks.js';

// Jira (issues, analysis, fav keywords)
export {
  saveJiraIssues,
  loadJiraIssues,
  getJiraIssuesCachedAt,
  saveBoardIssues,
  loadBoardIssues,
  saveJiraAnalysis,
  loadJiraAnalysis,
  listJiraAnalyses,
  saveJiraNotes,
  listFavKeywords,
  saveFavKeyword,
  deleteFavKeyword,
} from './jira.js';
export type { JiraIssueRow, BoardIssueRow, JiraAnalysisRow, TeamsFavKeyword } from './jira.js';

// Jira transitions & ticket learnings
export {
  getLastTransition,
  recordTransition,
  getCycleTime,
  getWeeklyVelocity,
  getCycleTimesForSimilarTickets,
  saveLearning,
  getLearning,
  findSimilarLearnings,
} from './transitions.js';
export type {
  JiraTransition,
  VelocityStats,
  CycleTimeBaseline,
  TicketLearning,
} from './transitions.js';

// System (sync state, error logs, token usage, data quality, ingestion log)
export {
  getSyncState,
  updateSyncState,
  insertErrorLog,
  listErrorLogs,
  markErrorResolved,
  updateErrorAnalysis,
  recordTokenUsage,
  getTokenStats,
  insertDataQualityIssue,
  listDataQualityIssues,
  resolveDataQualityIssue,
  startIngestionLog,
  finishIngestionLog,
} from './system.js';
export type {
  SyncState,
  ErrorLog,
  InsertErrorLog,
  TokenUsageRow,
  TokenStatsSummary,
  DataQualityIssue,
} from './system.js';

// Code Graph (EP-43)
export { getBlastRadius, getTestCoverage, getFileOwners } from './code-graph.js';
export type { BlastRadiusNode } from './code-graph.js';

// Teammates (EP-45)
export {
  addTeamMember,
  markMember,
  softDeleteMember,
  getTeamMember,
  getMarkedMembers,
  getAllMembers,
  addMemberAlias,
  resolveMemberByAlias,
  getMemberAliases,
  getMemberProfile,
  saveMemberProfile,
  countNewMessages,
  countNewCommits,
  getMemberActivity,
  getTeamAverages,
  getExpertCandidates,
} from './teammates.js';
export type {
  TeamMember,
  MemberAlias,
  MemberProfile,
  MemberWithStats,
  MemberActivity,
  TeamAverages,
  ExpertCandidate,
} from './teammates.js';

// Investigation — Phase 55 foundation + Phase 56 self-learning brain
export {
  getSession,
  createSession,
  updateSession,
  recordPatternFeedback,
  getPatternWithFeedback,
  upsertToolEffectiveness,
  getTopToolsForRootCauseType,
  createHypothesisAccuracy,
  resolveHypothesisAccuracy,
  getStaleKnowledgeIds,
  getBrainStats,
  KNOWLEDGE_TTL_DAYS,
} from './investigation.js';
export type { InvestigationSession } from './investigation.js';
