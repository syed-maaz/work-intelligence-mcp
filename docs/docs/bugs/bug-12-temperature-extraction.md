---
title: "BUG-12: Temperature 0.7 on extraction"
sidebar_label: "BUG-12: Extraction temperature"
---

# BUG-12: Temperature 0.7 on deterministic extraction tasks

| | |
|---|---|
| **Severity** | Accumulating Debt |
| **Status** | ✅ Fixed |
| **File** | `src/services/analyzer.ts:157–158` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

`AIAnalyzer` stored a single `temperature` value applied to **all** API calls:

```typescript
this.temperature = config.temperature || 0.7;
```

The default of `0.7` was used for every method, including the extraction tasks that run with `EXTRACTION_MODEL` (Claude Haiku):

- `detectActionItemsChunk()` — classifies whether a piece of text contains an action item
- `summarizeContentChunk()` — extracts key points, threads, participants
- `extractQuestionsChunk()` — identifies open questions

These are **structured classification tasks** that use `tool_choice: { type: 'tool', name }` (forced tool use) to return JSON. The correct temperature for deterministic structured extraction is `0` — the model should always produce the same output for the same input.

Temperature `0.7` introduces randomness into what should be deterministic classification:
- The same message batch can produce different action items on different sync runs
- A task that was detected on Monday may not be detected on Tuesday
- Two parallel chunks processing the same message may reach different conclusions
- Action item descriptions vary in wording across runs, defeating the content-hash deduplication added in [BUG-08](./bug-08-action-items-duplicated)

## Fix

Extraction method calls now use `temperature: 0`. Synthesis methods (`generateDigestChunk`, `answerQuestion`) retain `this.temperature` since creative prose generation benefits from some variability:

```typescript
// After fix — EXTRACTION_MODEL calls
const response = await this.client.beta.promptCaching.messages.create({
  model: EXTRACTION_MODEL,
  max_tokens: this.maxTokens,
  temperature: 0,           // ← deterministic classification
  ...
});

// Synthesis calls (unchanged)
const response = await this.client.beta.promptCaching.messages.create({
  model: DIGEST_MODEL,
  max_tokens: this.maxTokens,
  temperature: this.temperature,  // ← 0.7, allows prose variation
  ...
});
```

The fix was applied to all three extraction chunks: `detectActionItemsChunk`, `summarizeContentChunk`, `extractQuestionsChunk`.

## Files Changed

- `src/services/analyzer.ts` — `temperature: 0` on all `EXTRACTION_MODEL` API calls (3 sites)
