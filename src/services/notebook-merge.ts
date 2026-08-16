/**
 * notebook-merge — pure helpers for Option 3 of the updateNotebook cost-reduction
 * plan (see .planning/updatenotebook-cost-reduction/01-cost-analysis-and-impact-map.md).
 *
 * The patch_notebook tool returns ONLY what changed (8 fields, see NotebookPatch
 * below) instead of the entire 7-section notebook. Server-side we apply the patch
 * deterministically to the structured state (NotebookState), then re-render the
 * same 7-section markdown that downstream consumers already expect. This module
 * is intentionally dependency-free (no DB, no Anthropic, no I/O) so it can be
 * unit-tested in isolation and trivially understood.
 *
 * Invariants preserved (these are also the test names in notebook-merge.test.ts):
 *   1. keyPeople dedup with name-form variations — canonical form wins, the
 *      Jaccard relationship detector at relationship-detector.ts:90 never sees
 *      duplicates of the same human under different aliases.
 *   2. decisions are append-only — applyPatch has no removal field for them.
 *      (Blockers DO have a removal field via `resolvedBlockers`; decisions don't.)
 *   3. timeline ordering — entries stay in insertion order, callers can sort.
 *   4. idempotency — applying the same patch twice should NOT duplicate entries.
 *      This defends against the double-fire from the two trigger sites in
 *      web-server.js (runFullSync + runTargetedTeamsSync) for the same message
 *      delta — see § 5.3 of the cost-reduction doc.
 *   5. backfill correctness — parseMarkdownToState turns the legacy 7-section
 *      markdown back into NotebookState. Used on first read after the v67→v68
 *      migration so existing notebooks (largest 13.8 KB at investigation time)
 *      keep working. On parse failure, callers should fall back to "rebuild
 *      from cold" rather than ship a corrupt row.
 *
 * The render function MUST emit identical bytes to the existing analyzer.ts:1500-1513
 * renderer — that's how three regex-based consumers (obsidian-export.ts:575,
 * relationship-detector.ts:32, web-server.js graph endpoint) keep working with
 * no change. The `renderMarkdown` function below is a literal port of that block.
 */

/** Structured state of a topic notebook — what we store in topic_notebooks.state_json. */
export interface NotebookState {
  overview: string;
  keyPeople: string[];           // canonicalized; see canonicalizePersonName
  currentStatus: string;
  timeline: string[];            // newest-last by convention; chronological if callers sort
  decisionsMade: string[];       // append-only
  openQuestionsAndBlockers: string[];
  keyThreads: string[];
}

/**
 * What the model returns from the patch_notebook tool — ONLY the deltas.
 * Mirrors the JSON schema in analyzer.ts (see § 7 Option 3 of the doc).
 */
export interface NotebookPatch {
  newTimelineEntries?: string[];   // append
  newDecisions?: string[];         // append (de-duped against existing)
  newPeople?: string[];            // canonicalize + dedupe-merge
  newBlockers?: string[];          // append (de-duped)
  resolvedBlockers?: string[];     // remove from openQuestionsAndBlockers
  newThreads?: string[];           // append (de-duped)
  updatedStatus?: string;          // replaces currentStatus if present
  updatedOverview?: string;        // replaces overview if present (rare)
  noChanges?: boolean;             // explicit no-op marker
}

/** Empty state — used when a notebook doesn't exist yet. */
export function emptyState(): NotebookState {
  return {
    overview: '',
    keyPeople: [],
    currentStatus: '',
    timeline: [],
    decisionsMade: [],
    openQuestionsAndBlockers: [],
    keyThreads: [],
  };
}

/**
 * Canonicalize a person's display name so the Jaccard relationship detector
 * doesn't see ["M. Syed", "Syed, M", "Maaz Syed", "Maaz"] as four distinct people.
 *
 * Strategy: lowercase, strip punctuation, normalize whitespace, expand "Last, First"
 * → "First Last", drop bare single-initial prefixes when a full first name appears
 * elsewhere on the same input. This is intentionally conservative — false unifications
 * (treating two different humans as one) are worse than false splits, so when in doubt
 * the function keeps tokens separate.
 *
 * NOT designed to be language-aware. Sufficient for the English/transliterated-Latin
 * names we see in Teams/Email/Jira. Edge cases:
 *   - Single token ("Alex"):     returns "alex"
 *   - "Lastname, Firstname":     returns "firstname lastname"
 *   - "Firstname Lastname":      returns "firstname lastname"
 *   - "F. Lastname":             returns "f lastname"  (initial preserved; merge step
 *                                                       can fold it into "firstname lastname"
 *                                                       if seen alongside)
 */
export function canonicalizePersonName(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  // "Lastname, Firstname [Middle...]" → "Firstname [Middle...] Lastname"
  // Only flip if there's exactly one comma and the part after it is non-empty.
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0 && s.indexOf(',', commaIdx + 1) < 0) {
    const last = s.slice(0, commaIdx).trim();
    const rest = s.slice(commaIdx + 1).trim();
    if (last && rest) s = `${rest} ${last}`;
  }

  // Strip the punctuation that's purely cosmetic on initials and titles.
  // Keep apostrophes for names like "O'Brien". Keep hyphens for double-barrelled.
  s = s.replace(/[.·]/g, ' ');     // dots and middots → space
  s = s.replace(/\s+/g, ' ').trim();    // collapse internal whitespace
  s = s.toLowerCase();

  return s;
}

/**
 * Merge a list of newly-mentioned people into an existing canonical list,
 * de-duping by canonical form. Returns the new list in insertion order
 * (existing first, then newly-seen entries in the order they appeared).
 *
 * Folding rule: when a new entry's canonical form matches an existing entry's
 * canonical form, the EXISTING form wins (we don't churn the display name).
 * When an initial-only form ("m syed") matches a fuller form ("maaz syed")
 * already in the list, the fuller form wins.
 */
export function mergePeople(existing: string[], incoming: string[]): string[] {
  const out: string[] = [];
  const canonSeen = new Map<string, string>();  // canonical → display form chosen

  for (const p of existing) {
    const c = canonicalizePersonName(p);
    if (!c) continue;
    if (!canonSeen.has(c)) {
      canonSeen.set(c, p);
      out.push(p);
    }
  }

  for (const p of incoming) {
    const c = canonicalizePersonName(p);
    if (!c) continue;

    // Direct match — already have this person, skip.
    if (canonSeen.has(c)) continue;

    // Initial-fold: if the incoming is "x lastname" and we already have
    // "<longer> lastname" where <longer> starts with x, treat as same person.
    const tokens = c.split(' ');
    if (tokens.length === 2 && tokens[0].length === 1) {
      const initial = tokens[0];
      const last = tokens[1];
      let foldedTo: string | null = null;
      for (const seenCanon of canonSeen.keys()) {
        const st = seenCanon.split(' ');
        if (st.length >= 2 && st[st.length - 1] === last && st[0].length > 1 && st[0].startsWith(initial)) {
          foldedTo = seenCanon;
          break;
        }
      }
      if (foldedTo) continue;  // existing fuller form wins
    }

    canonSeen.set(c, p);
    out.push(p);
  }

  return out;
}

/**
 * Append `incoming` to `existing`, skipping items whose trimmed lowercase
 * form is already present. Used for decisions, blockers, threads, timeline.
 * Preserves order: existing entries first, new entries in input order.
 *
 * This is the idempotency guard (Invariant 4): applying the same patch twice
 * does not duplicate entries.
 */
export function appendDeduped(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map(s => s.trim().toLowerCase()));
  const out = existing.slice();
  for (const item of incoming) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Remove items from `existing` whose trimmed lowercase form matches any
 * entry in `toRemove`. Used for `resolvedBlockers`. Order of remaining
 * entries is preserved.
 */
export function removeDeduped(existing: string[], toRemove: string[]): string[] {
  if (toRemove.length === 0) return existing.slice();
  const remove = new Set(toRemove.map(s => s.trim().toLowerCase()));
  return existing.filter(s => !remove.has(s.trim().toLowerCase()));
}

/**
 * Apply a NotebookPatch to a NotebookState and return the new state.
 * Pure: does not mutate `state`.
 *
 * If `patch.noChanges === true`, the state is returned unchanged (we still
 * clone it so callers don't accidentally share references).
 */
export function applyPatch(state: NotebookState, patch: NotebookPatch): NotebookState {
  // Defensive: clone the input so applyPatch is a pure function.
  const next: NotebookState = {
    overview: state.overview,
    keyPeople: state.keyPeople.slice(),
    currentStatus: state.currentStatus,
    timeline: state.timeline.slice(),
    decisionsMade: state.decisionsMade.slice(),
    openQuestionsAndBlockers: state.openQuestionsAndBlockers.slice(),
    keyThreads: state.keyThreads.slice(),
  };

  if (patch.noChanges) return next;

  if (patch.newPeople && patch.newPeople.length > 0) {
    next.keyPeople = mergePeople(next.keyPeople, patch.newPeople);
  }
  if (patch.newTimelineEntries && patch.newTimelineEntries.length > 0) {
    next.timeline = appendDeduped(next.timeline, patch.newTimelineEntries);
  }
  if (patch.newDecisions && patch.newDecisions.length > 0) {
    // Invariant 2: decisions are append-only. No "removed decisions" field exists.
    next.decisionsMade = appendDeduped(next.decisionsMade, patch.newDecisions);
  }
  if (patch.newBlockers && patch.newBlockers.length > 0) {
    next.openQuestionsAndBlockers = appendDeduped(next.openQuestionsAndBlockers, patch.newBlockers);
  }
  if (patch.resolvedBlockers && patch.resolvedBlockers.length > 0) {
    next.openQuestionsAndBlockers = removeDeduped(next.openQuestionsAndBlockers, patch.resolvedBlockers);
  }
  if (patch.newThreads && patch.newThreads.length > 0) {
    next.keyThreads = appendDeduped(next.keyThreads, patch.newThreads);
  }
  if (patch.updatedStatus !== undefined && patch.updatedStatus !== '') {
    next.currentStatus = patch.updatedStatus;
  }
  if (patch.updatedOverview !== undefined && patch.updatedOverview !== '') {
    next.overview = patch.updatedOverview;
  }

  return next;
}

/**
 * Render a NotebookState as the canonical 7-section markdown.
 *
 * MUST emit byte-for-byte the same shape as analyzer.ts:1500-1513's existing
 * renderer — three downstream consumers regex-match the section headers and
 * line formats: obsidian-export.ts:575, relationship-detector.ts:32, and the
 * web-server.js graph endpoint via extractPeopleNames. The unit test
 * `render: matches legacy analyzer renderer byte-for-byte` enforces this.
 */
export function renderMarkdown(topicName: string, state: NotebookState): string {
  return [
    `# ${topicName}`,
    '',
    '## Overview',
    state.overview,
    '',
    '## Key People',
    state.keyPeople.map(p => `- ${p}`).join('\n'),
    '',
    '## Current Status',
    state.currentStatus,
    '',
    '## Timeline',
    state.timeline.map(t => `- ${t}`).join('\n'),
    '',
    '## Decisions Made',
    state.decisionsMade.map(d => `- ${d}`).join('\n'),
    '',
    '## Open Questions & Blockers',
    state.openQuestionsAndBlockers.map(q => `- ${q}`).join('\n'),
    '',
    '## Key Threads',
    state.keyThreads.map(k => `- ${k}`).join('\n'),
  ].join('\n');
}

/**
 * Parse a legacy 7-section markdown notebook back into structured state.
 * Used for backfill on first read after the v67→v68 migration (Invariant 5).
 *
 * Returns `null` if the markdown can't be parsed confidently — callers are
 * expected to treat a null return as "rebuild this notebook from cold rather
 * than write a corrupt state_json". Better to pay one extra buildNotebook
 * call than to ship a structured state that's missing sections.
 *
 * Parsing rules:
 *   - The first `# <name>` line is treated as the title (the topic name is
 *     also passed in by the caller, but we don't use this for matching since
 *     the title can drift).
 *   - Sections are delimited by `## <heading>` lines. We look for the EXACT
 *     headings the renderer produces.
 *   - Inside each list section we accept lines that start with `- ` (or `* `,
 *     defensively). Other lines are joined as prose (for overview / status).
 *   - If ANY of the 7 sections are missing, parsing fails (returns null).
 */
export function parseMarkdownToState(markdown: string): NotebookState | null {
  if (!markdown || typeof markdown !== 'string') return null;

  const SECTION_HEADINGS = [
    'Overview',
    'Key People',
    'Current Status',
    'Timeline',
    'Decisions Made',
    'Open Questions & Blockers',
    'Key Threads',
  ];

  // Map heading → captured lines
  const sections = new Map<string, string[]>();
  let currentHeading: string | null = null;
  const lines = markdown.split('\n');

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      const h = headingMatch[1].trim();
      if (SECTION_HEADINGS.includes(h)) {
        currentHeading = h;
        sections.set(h, []);
        continue;
      } else {
        // Unknown ## heading — stop capturing into the previous section
        // but don't fail (the renderer only emits the known 7).
        currentHeading = null;
        continue;
      }
    }
    if (currentHeading) {
      sections.get(currentHeading)!.push(line);
    }
  }

  // All 7 sections must be present.
  for (const h of SECTION_HEADINGS) {
    if (!sections.has(h)) return null;
  }

  // Helpers to extract prose vs list-items from a section body.
  const toProse = (arr: string[]): string => arr.join('\n').trim();
  const toList = (arr: string[]): string[] => {
    return arr
      .map(l => l.match(/^[-*]\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => m[1].trim())
      .filter(s => s.length > 0);
  };

  return {
    overview: toProse(sections.get('Overview')!),
    keyPeople: toList(sections.get('Key People')!),
    currentStatus: toProse(sections.get('Current Status')!),
    timeline: toList(sections.get('Timeline')!),
    decisionsMade: toList(sections.get('Decisions Made')!),
    openQuestionsAndBlockers: toList(sections.get('Open Questions & Blockers')!),
    keyThreads: toList(sections.get('Key Threads')!),
  };
}
