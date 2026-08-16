/**
 * Common types and interfaces for all connectors
 */

/**
 * Date range for filtering messages/issues
 */
export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  pageSize?: number;
  nextPageToken?: string;
}

/**
 * Pagination result
 */
export interface PaginationResult<T> {
  items: T[];
  nextPageToken?: string;
  hasMore: boolean;
}

/**
 * Message source type
 */
export enum MessageSource {
  Teams = 'teams',
  Email = 'email',
  Jira = 'jira',
  GitHub = 'github',
  Slack = 'slack',
  Linear = 'linear',
}

/**
 * Unified message interface that normalizes data from different sources
 */
export interface UnifiedMessage {
  /** Unique identifier */
  id: string;

  /** Source of the message */
  source: MessageSource;

  /** Message subject/title */
  subject: string;

  /** Message content/body (may be HTML or plain text) */
  content: string;

  /** Sender information */
  sender: {
    id: string;
    name: string;
    email?: string;
  };

  /** Recipients (for email) or participants (for Teams/Jira) */
  recipients?: Array<{
    id: string;
    name: string;
    email?: string;
  }>;

  /** Creation timestamp */
  createdAt: Date;

  /** Last modification timestamp */
  modifiedAt?: Date;

  /** Thread/conversation identifier */
  conversationId?: string;

  /** Parent message ID (for replies) */
  parentId?: string;

  /** Whether this is a reply */
  isReply: boolean;

  /** Channel the message came from (Slack/Teams style sources) */
  channel?: string;

  /** Team/workspace the message came from */
  team?: string;

  /** Source-specific metadata */
  metadata: {
    /** Teams-specific data */
    teams?: {
      teamId: string;
      teamName?: string;
      channelId: string;
      channelName?: string;
      messageType?: string;
    };

    /** Email-specific data */
    email?: {
      importance?: 'low' | 'normal' | 'high';
      hasAttachments?: boolean;
      internetMessageId?: string;
      categories?: string[];
    };

    /** Jira-specific data */
    jira?: {
      issueKey: string;
      projectKey: string;
      issueType?: string;
      status?: string;
      priority?: string;
      assignee?: {
        id: string;
        name: string;
        email?: string;
      };
      epicKey?: string;
      epicName?: string;
      labels?: string[];
      /** Linked pull requests — populated by MCP path only */
      pullRequests?: Array<{
        id: string;
        title: string;
        url: string;
        status: string;   // 'OPEN' | 'MERGED' | 'DECLINED'
        author: string;
        repository: string;
      }>;
      /** Status transition history — populated by MCP path only */
      transitions?: Array<{
        fromStatus: string;
        toStatus: string;
        transitionedAt: string; // ISO string
      }>;
    };

    /** GitHub-specific data */
    github?: {
      number: number;
      state: 'open' | 'closed' | 'merged';
      isPR: boolean;
      url: string;
      labels?: string[];
      repository?: string;
    };

    /** Slack-specific data */
    slack?: {
      channelId: string;
      channelName?: string;
      /** Parent thread timestamp — set on replies in a thread */
      threadTs?: string;
    };

    /** Linear-specific data */
    linear?: {
      /** Issue identifier, e.g. ENG-123 */
      identifier: string;
      state?: string;
      team?: string;
    };
  };

  /** Raw data from source (for debugging/advanced use) */
  raw?: unknown;
}

/**
 * Authentication configuration base
 */
export interface AuthConfig {
  /** Service name for keychain storage */
  serviceName: string;
}

/**
 * Microsoft Graph authentication configuration
 */
export interface GraphAuthConfig extends AuthConfig {
  /** Azure AD tenant ID */
  tenantId: string;

  /** Azure AD client/application ID */
  clientId: string;

  /** Required permission scopes */
  scopes: string[];
}

/**
 * Jira authentication configuration
 */
export interface JiraAuthConfig extends AuthConfig {
  /** Jira instance URL (e.g., https://company.atlassian.net) */
  baseUrl: string;

  /** User email address */
  email: string;

  /** API token (stored in keychain) */
  apiToken?: string;
}

/**
 * Authentication status
 */
export interface AuthStatus {
  /** Whether the user is authenticated */
  isAuthenticated: boolean;

  /** User information (if authenticated) */
  user?: {
    id: string;
    name: string;
    email?: string;
  };

  /** Token expiration time (if applicable) */
  expiresAt?: Date;
}

/**
 * Connector error types
 */
export enum ConnectorErrorType {
  Authentication = 'authentication',
  Network = 'network',
  RateLimit = 'rate_limit',
  InvalidInput = 'invalid_input',
  NotFound = 'not_found',
  Unknown = 'unknown',
}

/**
 * Connector error class
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public type: ConnectorErrorType,
    public statusCode?: number,
    public cause?: Error
  ) {
    super(message);
    this.name = 'ConnectorError';
    Object.setPrototypeOf(this, ConnectorError.prototype);
  }
}

/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  /** Maximum number of requests per time window */
  maxRequests: number;

  /** Time window in milliseconds */
  windowMs: number;

  /** Maximum number of retries */
  maxRetries: number;

  /** Base delay for exponential backoff (in ms) */
  baseDelayMs: number;
}

/**
 * Default rate limit configurations for different services
 */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  teams: {
    maxRequests: 100,
    windowMs: 60000, // 1 minute
    maxRetries: 3,
    baseDelayMs: 1000,
  },
  email: {
    maxRequests: 100,
    windowMs: 60000, // 1 minute
    maxRetries: 3,
    baseDelayMs: 1000,
  },
  jira: {
    maxRequests: 200,
    windowMs: 60000, // 1 minute
    maxRetries: 3,
    baseDelayMs: 500,
  },
};
