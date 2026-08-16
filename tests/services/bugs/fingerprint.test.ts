import { describe, it, expect } from 'vitest';
import {
  computeFingerprint,
  normalizeMessage,
  extractTopFrame,
} from '../../../src/services/bugs/fingerprint.js';
import type { BugSource } from '../../../src/types/bugs.js';

describe('normalizeMessage — 5 fixtures from PLAN.md', () => {
  it('digit runs ≥ 3 → <N>', () => {
    expect(normalizeMessage("Cannot read property 'x' of undefined at line 1234"))
      .toBe("cannot read property 'x' of undefined at line <N>");
  });

  it('UUIDs → <HASH>', () => {
    expect(normalizeMessage('Connection failed for request 9f3e1d2c-8a4b-4e5f-9c1d-3a2b4c5d6e7f'))
      .toBe('connection failed for request <HASH>');
  });

  it("absolute /Users/ paths → ~", () => {
    expect(normalizeMessage("ENOENT: no such file or directory, open '/home/testuser/Desktop/x.ts'"))
      .toBe("enoent: no such file or directory, open '~/desktop/x.ts'");
  });

  it('digit runs in messages get tagged', () => {
    expect(normalizeMessage('Listening on port 3132'))
      .toBe('listening on port <N>');
  });

  it('whitespace trim + lowercase', () => {
    expect(normalizeMessage('   Already Lowercase  '))
      .toBe('already lowercase');
  });

  it('SHA-shaped hex runs ≥ 8 → <HASH>', () => {
    expect(normalizeMessage('build failed at commit ab12cd34ef56'))
      .toBe('build failed at commit <HASH>');
  });

  it('paths before digits — /home/testuser keeps no <N>', () => {
    expect(normalizeMessage("ENOENT: '/home/testuser/Desktop/123.ts'"))
      .toBe("enoent: '~/desktop/<N>.ts'");
  });
});

describe('extractTopFrame — 4 fixtures from PLAN.md', () => {
  it('skips node_modules/express, picks first non-library frame', () => {
    const stack = [
      'Error: x',
      '    at Function.errorHandler (/node_modules/express/lib/router/route.js:144:13)',
      '    at handler (/src/routes/pr.ts:89:7)',
    ].join('\n');
    expect(extractTopFrame(stack)).toBe('/src/routes/pr.ts:89');
  });

  it('skips withAgentTick wrapper', () => {
    const stack = [
      'TypeError: x',
      '    at withAgentTick (web-server.js:1820:5)',
      '    at OutlookWatcher (src/connectors/outlook-browser.ts:42:9)',
    ].join('\n');
    expect(extractTopFrame(stack)).toBe('src/connectors/outlook-browser.ts:42');
  });

  it('skips ErrorBoundary.componentDidCatch', () => {
    const stack = [
      'Error: render',
      '    at componentDidCatch (web/src/components/shell/ErrorBoundary.tsx:32:5)',
      '    at TopicsPage (web/src/pages/TopicsPage.tsx:88:11)',
    ].join('\n');
    expect(extractTopFrame(stack)).toBe('web/src/pages/TopicsPage.tsx:88');
  });

  it('returns null when stack only contains node_modules frames', () => {
    const stack = [
      'Error: x',
      '    at lib (/node_modules/some-lib/index.js:10:5)',
      '    at other (/node_modules/another/index.js:20:3)',
    ].join('\n');
    expect(extractTopFrame(stack)).toBeNull();
  });

  it('null stack returns null top frame', () => {
    expect(extractTopFrame(null)).toBeNull();
  });
});

describe('computeFingerprint', () => {
  const baseline = {
    source: 'bridge' as BugSource,
    errorName: 'TypeError',
    message: "Cannot read property 'x' of undefined at line 1234",
    stack: '    at handler (/src/routes/pr.ts:89:7)',
  };

  it('returns 16-char hex fingerprint', () => {
    const result = computeFingerprint(baseline);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('determinism — 1000 calls produce identical output', () => {
    const first = computeFingerprint(baseline).fingerprint;
    for (let i = 0; i < 1000; i++) {
      expect(computeFingerprint(baseline).fingerprint).toBe(first);
    }
  });

  it('different source → different fingerprint (even when name+msg+frame match)', () => {
    const a = computeFingerprint({ ...baseline, source: 'bridge' });
    const b = computeFingerprint({ ...baseline, source: 'agent' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('different errorName → different fingerprint', () => {
    const a = computeFingerprint({ ...baseline, errorName: 'TypeError' });
    const b = computeFingerprint({ ...baseline, errorName: 'RangeError' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('messages that normalize to the same string → same fingerprint', () => {
    const a = computeFingerprint({ ...baseline, message: 'Listening on port 3132' });
    const b = computeFingerprint({ ...baseline, message: 'Listening on port 5175' });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('exposes normalizedMessage and topFrame on the result', () => {
    const r = computeFingerprint(baseline);
    expect(r.normalizedMessage).toBe("cannot read property 'x' of undefined at line <N>");
    expect(r.topFrame).toBe('/src/routes/pr.ts:89');
  });

  it('null stack → topFrame null, fingerprint still stable', () => {
    const r = computeFingerprint({ ...baseline, stack: null });
    expect(r.topFrame).toBeNull();
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
