/**
 * EP-59: Graph traversal -> natural language path formatter.
 * Converts KG traversal results into human-readable relationship paths
 * for injection into chat context. Max 15 paths per 59-C5.
 */

export interface TraversalPath {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string;
  validTo?: string;
}

/**
 * Parse raw palace KG JSON into TraversalPath[].
 * Handles both array format and { triples: [] } format.
 */
export function parseTraversalPaths(raw: string): TraversalPath[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed)
      ? parsed
      : (parsed.triples || parsed.results || []);
    return items
      .map((t: Record<string, unknown>) => ({
        subject: String(t.subject || t.s || ''),
        predicate: String(t.predicate || t.p || t.relation || ''),
        object: String(t.object || t.o || ''),
        validFrom: t.valid_from
          ? String(t.valid_from)
          : t.start
            ? String(t.start)
            : undefined,
        validTo: t.valid_to
          ? String(t.valid_to)
          : t.end
            ? String(t.end)
            : undefined,
      }))
      .filter((p: TraversalPath) => p.subject && p.predicate && p.object);
  } catch {
    return [];
  }
}

/**
 * Format traversal paths as natural language text.
 * Example output: "JIRA-15257 -> caused-regression -> FF_RM_11372 (since 2026-04-17)"
 *
 * @param paths     Parsed traversal paths
 * @param maxPaths  Maximum paths to include (default: 15 per 59-C5)
 * @returns Human-readable text block for context injection, or '' if no paths
 */
export function formatTraversalAsText(paths: TraversalPath[], maxPaths = 15): string {
  if (paths.length === 0) return '';

  const lines = paths.slice(0, maxPaths).map((p) => {
    const dateSuffix = p.validFrom
      ? ` (since ${p.validFrom.slice(0, 10)}${p.validTo ? `, ended ${p.validTo.slice(0, 10)}` : ''})`
      : '';
    return `${p.subject} -> ${p.predicate} -> ${p.object}${dateSuffix}`;
  });

  return `Knowledge Graph Relationships:\n${lines.join('\n')}`;
}
