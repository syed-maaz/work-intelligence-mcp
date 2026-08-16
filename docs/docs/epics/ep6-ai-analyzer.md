---
title: "EP-6: AI Analyzer Upgrade"
sidebar_label: "EP-6: AI Analyzer"
---

# EP-6: AI Analyzer Upgrade

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | Medium |
| **Agent Role** | AI / Prompt Engineer |
| **Depends On** | [EP-0](./ep0-foundation) |
| **Blocks** | — |
| **File Scope** | `src/services/analyzer.ts` (modify only) |

## Goal

The existing `AIAnalyzer` works but has several technical debt issues: it uses brittle regex to parse JSON from LLM responses, uses an outdated model, and has no prompt caching. This epic upgrades it to use Claude's structured tool use API for reliable JSON extraction, adds prompt caching, and updates model names to current Claude 4.x versions.

This epic can run **in parallel** with EP-1 through EP-4.

## Known Issues to Fix

| Issue | Location in File |
|-------|-----------------|
| JSON extraction via `match(/\{[\s\S]*\}/)` — breaks on nested braces | Lines 367, 406, 440, 470 |
| No prompt caching (`cache_control`) | All four methods |
| Hardcoded outdated model `claude-3-5-sonnet-20241022` | Line 88 |
| No structured tool use — responses parsed by regex | All four methods |

## Acceptance Criteria

- [x] All 4 methods use Claude tool use (structured output) — no regex JSON parsing anywhere
- [x] System prompt on the main API call uses `cache_control: { type: "ephemeral" }` for prompt caching
- [x] Fast extraction tasks (`detectActionItems`, `extractQuestions`, `summarizeContent`) use `claude-haiku-4-5-20251001`
- [x] Quality generation (`generateDigest`) uses `claude-sonnet-4-6`
- [x] Batch processing: chunk messages into groups of ≤50 before sending to API
- [x] All `match(/\{[\s\S]*\}/)` regex patterns removed
- [x] `npm run typecheck` passes
- [x] Existing behavior preserved — method signatures unchanged

## Model Reference

| Task | Model | Why |
|------|-------|-----|
| `detectActionItems` | `claude-haiku-4-5-20251001` | Fast, cheap, structured extraction |
| `extractQuestions` | `claude-haiku-4-5-20251001` | Fast, cheap, structured extraction |
| `summarizeContent` | `claude-haiku-4-5-20251001` | Fast, cheap, structured extraction |
| `generateDigest` | `claude-sonnet-4-6` | Quality narrative generation |

## Tool Use Pattern

Replace regex parsing with a tool definition + `tool_choice: { type: "tool" }`:

```typescript
const response = await anthropic.messages.create({
  model: EXTRACTION_MODEL,
  max_tokens: 1024,
  system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
  tools: [{
    name: 'extract_action_items',
    description: 'Extract action items from messages',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { task: { type: 'string' }, assignee: { type: 'string' }, due_date: { type: 'string' } } }
        }
      },
      required: ['items']
    }
  }],
  tool_choice: { type: 'tool', name: 'extract_action_items' },
  messages: [{ role: 'user', content: userPrompt }]
});
// result is always tool_use block — no regex needed
const toolUse = response.content.find(b => b.type === 'tool_use');
const result = toolUse.input as { items: ActionItem[] };
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-6-1 | Refactor `detectActionItems` to use tool use | ✅ Done |
| EP-6-2 | Refactor `extractQuestions` to use tool use | ✅ Done |
| EP-6-3 | Refactor `summarizeContent` to use tool use | ✅ Done |
| EP-6-4 | Refactor `generateDigest` to use tool use | ✅ Done |
| EP-6-5 | Add prompt caching via `cache_control: { type: "ephemeral" }` | ✅ Done |
| EP-6-6 | Update model constants to current Claude 4.x versions | ✅ Done |
| EP-6-7 | Message chunking: process ≤50 messages per API call | ✅ Done |

---

## Agent Prompt

:::tip Start This Epic
Only EP-0 (Foundation) is needed. This epic can run in parallel with EP-1/EP-2/EP-3/EP-4.
:::

```
You are implementing EP-6: AI Analyzer Upgrade for the Work Intelligence MCP project.


CONTEXT:
The AIAnalyzer in src/services/analyzer.ts is working but has technical debt:
- JSON parsed via regex match(/\{[\s\S]*\}/) — brittle and breaks on edge cases
- Outdated model (claude-3-5-sonnet-20241022)
- No prompt caching

Your job: upgrade to structured tool use (reliable JSON), add prompt caching, update models.
Method signatures must NOT change — only internals.

YOUR SCOPE: ONE file — src/services/analyzer.ts (modify it).
Do NOT modify any other files.

READ FIRST:
- src/services/analyzer.ts (all of it — understand all 4 methods before touching anything)
- package.json (confirm @anthropic-ai/sdk version)

WHAT TO CHANGE:

1. Model constants (update these):
   - EXTRACTION_MODEL = 'claude-haiku-4-5-20251001'  (for detectActionItems, extractQuestions, summarizeContent)
   - DIGEST_MODEL = 'claude-sonnet-4-6'               (for generateDigest)

2. For each of the 4 methods, replace regex JSON extraction with tool use:
   - Define a tool with input_schema matching the expected output shape
   - Use tool_choice: { type: 'tool', name: '...' } to force structured output
   - Read result from content.find(b => b.type === 'tool_use').input
   - Remove ALL match(/\{[\s\S]*\}/) patterns

3. Add prompt caching:
   - Wrap the system prompt string in: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
   - Change system: string → system: ContentBlockParam[]

4. Add message chunking:
   - If messages.length > 50, split into chunks of 50 and process each chunk
   - Merge results across chunks

ACCEPTANCE CRITERIA:
- All 4 methods use tool use — zero regex JSON parsing
- npm run typecheck passes with zero errors
- Method signatures unchanged (callers don't break)
- No untyped any without a comment
```
