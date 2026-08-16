/**
 * EP-34: Relevance-ranked context injection.
 * Ranks ContextItems by BM25-like position score + recency decay,
 * then truncates to maxItems. Replaces naïve .slice(0, N) throughout the codebase.
 */

import type { ContextItem } from '../services/analyzer.js';

export interface ScoredItem {
  item: ContextItem;
  bm25Score: number;     // position-based proxy, normalized 0–1
  recencyScore: number;  // exponential decay: e^(-0.1 × days_old), 0–1
  combinedScore: number; // semanticWeight × bm25 + (1-semanticWeight) × recency
}

/**
 * Rank and trim context items.
 *
 * @param items           Raw context items (assumed already in FTS rank order)
 * @param opts.maxItems   How many items to keep (default: 20)
 * @param opts.semanticWeight  Weight given to BM25 position score vs recency (default: 0.7)
 */
export function rankContextItems(
  items: ContextItem[],
  opts: { maxItems?: number; semanticWeight?: number } = {}
): ContextItem[] {
  const { maxItems = 20, semanticWeight = 0.7 } = opts;
  const recencyWeight = 1 - semanticWeight;
  const now = Date.now();

  if (items.length === 0) return [];

  const scored: ScoredItem[] = items.map((item, i) => {
    // BM25 proxy: position in FTS result list (earlier = better rank)
    const bm25Score = 1 / (1 + i);

    // Recency: exponential decay based on item.timestamp if present
    let recencyScore = 0.5; // neutral default
    if (item.timestamp) {
      const daysOld = (now - new Date(item.timestamp).getTime()) / 86_400_000;
      recencyScore = Math.exp(-0.1 * Math.max(0, daysOld));
    }

    const combinedScore = semanticWeight * bm25Score + recencyWeight * recencyScore;
    return { item, bm25Score, recencyScore, combinedScore };
  });

  return scored
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, maxItems)
    .map(s => s.item);
}

/**
 * Normalize a raw FTS5 rank value (negative float) to a 0–1 score.
 * Lower (more negative) rank = better match = higher score.
 */
export function normalizeFtsRank(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}
