---
sidebar_position: 1
title: ADR-001 Browser Extraction
---

# ADR-001: Browser Extraction over Microsoft Graph API

| Field | Value |
|-------|-------|
| **Date** | 2026-04-13 |
| **Status** | ✅ Accepted |
| **Deciders** | Project owner |

## Context

The user works in a corporate Microsoft 365 environment. IT policy blocks third-party Azure AD app registrations and denies OAuth delegated permissions to the Microsoft Graph API. The original `TeamsConnector`, `EmailConnector`, and `GraphAuthManager` files were built for Graph API and are non-functional in this environment.

## Decision

Use **Playwright browser automation** to scrape `teams.microsoft.com` and `outlook.office.com` using the user's existing browser SSO session.

## Options Considered

| Option | Verdict | Reason |
|--------|---------|--------|
| Microsoft Graph API + Azure OAuth | ❌ Rejected | Blocked by corporate IT policy |
| Playwright browser scraper | ✅ **Accepted** | Uses existing SSO — no IT approval needed |
| `@playwright/mcp` (Claude-driven live browser) | ⏳ Deferred | Useful for ad-hoc queries; not suitable for background sync |

## Consequences

### Positive
- No IT approval or Azure app registration needed
- Works immediately with existing corporate SSO
- User data never leaves the machine via new auth flows

### Negative
- DOM selectors can break when Microsoft updates web UI
  - **Mitigation**: Use `data-*` attributes and ARIA roles (more stable than class names)
- Browser must be accessible (profile path configured)
  - **Mitigation**: Env var `BROWSER_PROFILE_PATH` with headless mode

## Implementation

- [EP-1: Browser Session Manager](../epics/ep1-browser-session) — shared Playwright instance
- [EP-2: Teams Browser Connector](../epics/ep2-teams-scraper) — Teams scraper
- [EP-3: Outlook Browser Connector](../epics/ep3-outlook-scraper) — Outlook scraper
- [EP-9: Dead Code Cleanup](../epics/ep9-cleanup) — delete Graph API files
