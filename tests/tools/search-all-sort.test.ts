import { describe, it, expect } from 'vitest';
import { ftsOrderBy } from '../../src/tools/search-all.js';

describe('search-all sortBy (U-15)', () => {
  it('defaults to BM25 rank for relevance', () => {
    expect(ftsOrderBy('relevance', 'messages')).toBe('rank');
    expect(ftsOrderBy('relevance', 'meetings')).toBe('rank');
  });

  it('uses timestamp columns for recency', () => {
    expect(ftsOrderBy('recency', 'messages')).toBe('m.timestamp DESC');
    expect(ftsOrderBy('recency', 'meetings')).toBe('mt.date DESC');
  });
});
