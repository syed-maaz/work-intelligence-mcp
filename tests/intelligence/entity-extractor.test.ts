import { describe, it, expect } from 'vitest';
import { extractEntities, type ExtractedEntities } from '../../src/intelligence/entity-extractor.js';

describe('extractEntities()', () => {
  it('extracts Jira keys from text', () => {
    const result = extractEntities('Check DEMO-15257 status');
    expect(result).toEqual<ExtractedEntities>({
      jiraKeys: ['DEMO-15257'],
      people: [],
      flags: [],
      files: [],
    });
  });

  it('matches people by case-insensitive first/last name substring', () => {
    const result = extractEntities('Ask Alex about the project', [
      'Alex Johnson',
    ]);
    expect(result.people).toEqual(['Alex Johnson']);
    expect(result.jiraKeys).toEqual([]);
    expect(result.flags).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('extracts feature flags with FF_ prefix', () => {
    const result = extractEntities('FF_RM_11372 was promoted');
    expect(result.flags).toEqual(['FF_RM_11372']);
    expect(result.jiraKeys).toEqual([]);
    expect(result.people).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('extracts file paths with at least one slash and extension', () => {
    const result = extractEntities('Check src/services/analyzer.ts for changes');
    expect(result.files).toEqual(['src/services/analyzer.ts']);
    expect(result.jiraKeys).toEqual([]);
    expect(result.people).toEqual([]);
    expect(result.flags).toEqual([]);
  });

  it('returns all empty arrays for empty input', () => {
    const result = extractEntities('');
    expect(result).toEqual<ExtractedEntities>({
      jiraKeys: [],
      people: [],
      flags: [],
      files: [],
    });
  });

  it('deduplicates across types — jiraKey wins over file path', () => {
    // DEMO-15257 appears in the file path but should only be in jiraKeys
    const result = extractEntities('DEMO-15257 mentioned in src/DEMO-15257/fix.ts');
    expect(result.jiraKeys).toEqual(['DEMO-15257']);
    expect(result.files).toEqual(['src/DEMO-15257/fix.ts']);
  });

  it('deduplicates within the same type', () => {
    const result = extractEntities('PROJ-1 and PROJ-2 and PROJ-1 again');
    expect(result.jiraKeys).toEqual(['PROJ-1', 'PROJ-2']);
    expect(result.people).toEqual([]);
    expect(result.flags).toEqual([]);
    expect(result.files).toEqual([]);
  });
});
