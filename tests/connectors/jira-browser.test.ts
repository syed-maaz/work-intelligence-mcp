import { describe, it, expect } from 'vitest';
import { convertRapidBoardToNavigatorUrl } from '../../src/fetcher/sources/jira-browser.js';

describe('convertRapidBoardToNavigatorUrl', () => {
  it('converts RapidBoard URL with projectKey to JQL navigator URL', () => {
    const input = 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=1&projectKey=DEMO';
    const result = convertRapidBoardToNavigatorUrl(input);
    expect(result).toBe(
      'https://jira.example.com/issues/?jql=project%20%3D%20DEMO%20ORDER%20BY%20updated%20DESC'
    );
    // Must point to issue navigator
    expect(result).toContain('/issues/?jql=');
    // Must contain the project key
    expect(result).toContain('DEMO');
    // Must NOT contain RapidBoard
    expect(result).not.toContain('RapidBoard');
  });

  it('passes through a non-RapidBoard URL unchanged', () => {
    const input = 'https://jira.example.com/issues/?jql=project%3DDEMO+ORDER+BY+updated+DESC';
    expect(convertRapidBoardToNavigatorUrl(input)).toBe(input);
  });

  it('passes through a browse URL unchanged', () => {
    const input = 'https://jira.example.com/browse/DEMO-123';
    expect(convertRapidBoardToNavigatorUrl(input)).toBe(input);
  });

  it('handles RapidBoard URL without projectKey by using ORDER BY fallback', () => {
    const input = 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=1';
    const result = convertRapidBoardToNavigatorUrl(input);
    expect(result).toContain('/issues/?jql=');
    expect(result).not.toContain('RapidBoard');
  });

  it('returns the original string for a malformed URL', () => {
    const input = 'not-a-url';
    expect(convertRapidBoardToNavigatorUrl(input)).toBe(input);
  });

  it('preserves the host from the input URL', () => {
    const input = 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=1&projectKey=PROJ';
    const result = convertRapidBoardToNavigatorUrl(input);
    expect(result.startsWith('https://jira.example.com/')).toBe(true);
  });
});
