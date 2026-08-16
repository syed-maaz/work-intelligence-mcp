// ---------------------------------------------------------------------------
// Entity Extractor — Phase 59 Wave 1
//
// Query-time regex/dictionary NER for structured entity extraction.
// Zero latency, no LLM calls — pure regex + dictionary matching.
// Extracts Jira keys, known people, feature flags, and file paths.
// ---------------------------------------------------------------------------

/**
 * Structured entities extracted from a text query.
 * Used by chat handlers to build targeted FTS and palace searches.
 */
export interface ExtractedEntities {
  jiraKeys: string[]; // /[A-Z][A-Z0-9]+-\d+/g
  people: string[];   // matched against knownPeople list
  flags: string[];    // /FF_[A-Z0-9_]+/g
  files: string[];    // paths with / and .ext
}

// Regex patterns — compiled once at module load
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const FEATURE_FLAG_RE = /\b(FF_[A-Z0-9_]+)\b/g;
// File paths: at least one slash, ends with .ext (1-10 chars).
// Negative lookbehind prevents matching Jira keys embedded in paths.
const FILE_PATH_RE = /(?:[\w@.-]+\/)+[\w.-]+\.\w{1,10}\b/g;

/**
 * Extract structured entities from free-text input using regex and
 * dictionary matching. Pure function — no side effects, no LLM calls.
 *
 * @param text - The user's query or message text
 * @param knownPeople - Optional list of full names to match against
 * @returns Structured entities with deduplication applied
 */
export function extractEntities(
  text: string,
  knownPeople?: string[],
): ExtractedEntities {
  if (!text) {
    return { jiraKeys: [], people: [], flags: [], files: [] };
  }

  // 1. Extract Jira keys
  const jiraKeys = [...new Set(
    Array.from(text.matchAll(JIRA_KEY_RE), (m) => m[1]),
  )];

  // 2. Extract feature flags
  const flags = [...new Set(
    Array.from(text.matchAll(FEATURE_FLAG_RE), (m) => m[1]),
  )];

  // 3. Extract file paths
  const rawFiles = Array.from(text.matchAll(FILE_PATH_RE), (m) => m[0]);

  // 4. Match people — case-insensitive first/last/full name token matching
  const people: string[] = [];
  if (knownPeople && knownPeople.length > 0) {
    const textLower = text.toLowerCase();
    for (const fullName of knownPeople) {
      // Split name into tokens, match any token with length >= 3
      const tokens = fullName
        .split(/\s+/)
        .filter((t) => t.length >= 3)
        .map((t) => t.toLowerCase());

      const matched = tokens.some((token) => textLower.includes(token));
      if (matched && !people.includes(fullName)) {
        people.push(fullName);
      }
    }
  }

  // 5. Dedup across types: Jira keys win over file paths
  const jiraKeySet = new Set(jiraKeys);
  const deduplicatedFiles = [...new Set(
    rawFiles.filter((f) => !jiraKeySet.has(f)),
  )];

  return {
    jiraKeys,
    people,
    flags,
    files: deduplicatedFiles,
  };
}
