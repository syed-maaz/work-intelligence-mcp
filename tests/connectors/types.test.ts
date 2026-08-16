/**
 * Tests for connector types and utilities
 */

import { describe, it, expect } from 'vitest';
import {
  ConnectorError,
  ConnectorErrorType,
  MessageSource,
  DEFAULT_RATE_LIMITS,
} from '../../src/fetcher/sources/types.js';

describe('ConnectorError', () => {
  it('should create error with type and message', () => {
    const error = new ConnectorError(
      'Test error',
      ConnectorErrorType.Authentication
    );

    expect(error.message).toBe('Test error');
    expect(error.type).toBe(ConnectorErrorType.Authentication);
    expect(error.name).toBe('ConnectorError');
  });

  it('should include status code if provided', () => {
    const error = new ConnectorError(
      'Not found',
      ConnectorErrorType.NotFound,
      404
    );

    expect(error.statusCode).toBe(404);
  });

  it('should include cause if provided', () => {
    const cause = new Error('Original error');
    const error = new ConnectorError(
      'Wrapped error',
      ConnectorErrorType.Unknown,
      undefined,
      cause
    );

    expect(error.cause).toBe(cause);
  });

  it('should be instance of Error', () => {
    const error = new ConnectorError(
      'Test',
      ConnectorErrorType.Unknown
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConnectorError);
  });
});

describe('MessageSource', () => {
  it('should have correct enum values', () => {
    expect(MessageSource.Teams).toBe('teams');
    expect(MessageSource.Email).toBe('email');
    expect(MessageSource.Jira).toBe('jira');
  });
});

describe('ConnectorErrorType', () => {
  it('should have all error types', () => {
    expect(ConnectorErrorType.Authentication).toBe('authentication');
    expect(ConnectorErrorType.Network).toBe('network');
    expect(ConnectorErrorType.RateLimit).toBe('rate_limit');
    expect(ConnectorErrorType.InvalidInput).toBe('invalid_input');
    expect(ConnectorErrorType.NotFound).toBe('not_found');
    expect(ConnectorErrorType.Unknown).toBe('unknown');
  });
});

describe('DEFAULT_RATE_LIMITS', () => {
  it('should have rate limits for all services', () => {
    expect(DEFAULT_RATE_LIMITS.teams).toBeDefined();
    expect(DEFAULT_RATE_LIMITS.email).toBeDefined();
    expect(DEFAULT_RATE_LIMITS.jira).toBeDefined();
  });

  it('should have valid rate limit configurations', () => {
    const { teams, email, jira } = DEFAULT_RATE_LIMITS;

    // Teams
    expect(teams.maxRequests).toBeGreaterThan(0);
    expect(teams.windowMs).toBeGreaterThan(0);
    expect(teams.maxRetries).toBeGreaterThan(0);
    expect(teams.baseDelayMs).toBeGreaterThan(0);

    // Email
    expect(email.maxRequests).toBeGreaterThan(0);
    expect(email.windowMs).toBeGreaterThan(0);
    expect(email.maxRetries).toBeGreaterThan(0);
    expect(email.baseDelayMs).toBeGreaterThan(0);

    // Jira
    expect(jira.maxRequests).toBeGreaterThan(0);
    expect(jira.windowMs).toBeGreaterThan(0);
    expect(jira.maxRetries).toBeGreaterThan(0);
    expect(jira.baseDelayMs).toBeGreaterThan(0);
  });

  it('should have valid Jira limits', () => {
    const { jira } = DEFAULT_RATE_LIMITS;

    // Browser-based scraping — higher limits than REST API (no server-side throttle)
    expect(jira.maxRequests).toBeGreaterThan(0);
    expect(jira.baseDelayMs).toBeGreaterThan(0);
    expect(jira.windowMs).toBeGreaterThan(0);
  });
});
