import { describe, it, expect } from 'vitest';
import { GLOSSARY } from '../../web/src/lib/glossary.js';

describe('GLOSSARY (U-19)', () => {
  it('defines core disambiguated terms', () => {
    const terms = GLOSSARY.map((e) => e.term);
    expect(terms).toContain('Topic');
    expect(terms).toContain('Brain decision');
    expect(terms).toContain('Investigation');
  });

  it('every entry has term and meaning', () => {
    for (const entry of GLOSSARY) {
      expect(entry.term.length).toBeGreaterThan(0);
      expect(entry.meaning.length).toBeGreaterThan(10);
    }
  });
});
