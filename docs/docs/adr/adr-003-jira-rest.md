---
sidebar_position: 3
title: ADR-003 Jira REST API
---

# ADR-003: Jira Uses REST API (No Change)

| Field | Value |
|-------|-------|
| **Date** | 2026-04-13 |
| **Status** | ✅ Accepted — superseded for `jira.example.com` by [ADR-006](./adr-006-jira-mcp-fallback) |

> **Note (2026-04-19)**: ADR-003 applies to **Jira Cloud** (Atlassian-hosted instances using
> `atlassian.net`). For the  on-premise instance (`jira.example.com`), the REST API approach
> described here does not apply — that instance rate-limits all API calls at the IP level
> regardless of token validity. The `jira.example.com` instance is now accessed via the
>  Jira MCP server with browser fallback; see [ADR-006](./adr-006-jira-mcp-fallback).

## Decision

The existing `JiraConnector` (`src/connectors/jira.ts`) uses Jira's REST API v3 with a personal API token. This is **not** blocked by corporate IT policy — personal API tokens are separate from Azure AD / OAuth app registrations.

No browser scraping is needed for Jira. The connector is already fully built. The only work needed is wiring it into `SyncService` ([EP-4](../epics/ep4-jira-wiring)).

## Authentication

Jira uses HTTP Basic auth with `email:api_token` base64-encoded:

```
Authorization: Basic base64(email:api_token)
```

Tokens are obtained from [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) — no admin/IT involvement needed.

Credentials are loaded from env vars (`JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`) with optional keytar storage.
