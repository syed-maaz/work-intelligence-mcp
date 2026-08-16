---
sidebar_position: 2
title: ADR-002 Single Server First
---

# ADR-002: Single Server Now, Extractable Later

| Field | Value |
|-------|-------|
| **Date** | 2026-04-13 |
| **Status** | ✅ Accepted |

## Context

The long-term vision is a [multi-MCP federated architecture](../architecture#multi-mcp-vision) where each data source has its own specialized MCP server. However, building multiple servers from day one adds coordination overhead before the core functionality is even working.

## Decision

Build all connectors inside `work-intelligence-mcp` for Phase 1. The `DataSource` interface is the extraction boundary — any connector can become its own MCP server later without modifying the DB or tools layer.

**Rule**: No connector may directly query SQLite. Connectors return `UnifiedMessage[]`. The sync pipeline writes to DB.

## The Extraction Boundary

```typescript
// src/services/sync.ts
interface DataSource {
  fetchMessages(config: Record<string, unknown>, since?: Date): Promise<UnifiedMessage[]>;
}
```

To extract a connector to its own server in Phase 2:
1. Move connector file to `../teams-mcp/src/`
2. Wrap `fetchMessages()` as an MCP tool
3. In this server: replace local connector with an MCP client call
4. DB layer and MCP tools: **unchanged**

## Future Monorepo Structure

```
work-intelligence/
├── packages/
│   ├── core/                 ← shared types: UnifiedMessage, DataSource
│   ├── work-intelligence-mcp/ ← this project (cortex)
│   ├── teams-mcp/             ← future
│   ├── outlook-mcp/           ← future
│   └── jira-mcp/              ← future
└── package.json               ← npm workspaces
```

> For now, `src/connectors/types.ts` is the `core` package in disguise. Always import from there — never duplicate types.
