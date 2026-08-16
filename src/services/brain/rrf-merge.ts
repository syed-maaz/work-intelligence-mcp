/**
 * Phase 79-5b — Reciprocal Rank Fusion (Cormack et al 2009, k=60 standard).
 *
 * Merges results from multiple recall lanes with heterogeneous score spaces.
 * Each lane contributes 1/(k + rank_in_lane) for every id that appears.
 * IDs that appear in multiple lanes accumulate boost.
 */
export interface Rankable {
  id: string;
  score: number;
  source: string;
  snippet: string;
}

export function rrfMerge(
  lanes: Rankable[][],
  k = 60,
  limit = 8,
): Rankable[] {
  const scores = new Map<string, { total: number; hit: Rankable }>();
  for (const lane of lanes) {
    lane.forEach((hit, rank) => {
      const contribution = 1 / (k + rank + 1);
      const existing = scores.get(hit.id);
      if (existing) {
        existing.total += contribution;
      } else {
        scores.set(hit.id, { total: contribution, hit: { ...hit, score: 0 } });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ total, hit }) => ({ ...hit, score: total }));
}
