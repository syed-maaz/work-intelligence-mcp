import { describe, it, expect } from 'vitest';
import { detectMode } from '../../../src/services/chat/mode-detect.js';

describe('detectMode', () => {
  it('routes "/wi-investigate DEMO-15702" to WORK with high confidence', () => {
    const r = detectMode({ message: '/wi-investigate DEMO-15702' });
    expect(r.mode).toBe('work');
    expect(r.signals).toContain('slash:/wi-investigate');
    expect(r.signals).toContain('jira:DEMO-15702');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.modeSource).toBe('auto');
    expect(r.clarifyingPrompt).toBeUndefined();
  });

  it('routes "I\'m stressed about tonight\'s on-call" to LIFE on mood signal', () => {
    const r = detectMode({ message: "I'm stressed about tonight's on-call" });
    expect(r.mode).toBe('life');
    expect(r.signals.some((s) => s.startsWith('mood:'))).toBe(true);
    expect(r.clarifyingPrompt).toBeUndefined();
  });

  it('routes empty-signals "hey" to AMBIGUOUS with clarifying prompt', () => {
    const r = detectMode({ message: 'hey' });
    expect(r.mode).toBe('ambiguous');
    expect(r.signals).toEqual([]);
    expect(r.clarifyingPrompt).toBeTruthy();
    expect(r.confidence).toBe(0);
  });

  it('honors manualMode override over heuristic (CHAT-06)', () => {
    const r = detectMode({ message: "I'm stressed", manualMode: 'work' });
    expect(r.mode).toBe('work');
    expect(r.modeSource).toBe('manual');
    expect(r.confidence).toBe(1.0);
    expect(r.signals).toContain('manual:work');
  });

  it('routes "I\'m exhausted, investigate DEMO-15702" to WORK (imperative-verb canary)', () => {
    const r = detectMode({ message: "I'm exhausted, investigate DEMO-15702" });
    expect(r.mode).toBe('work');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.signals).toContain('imperative:investigate');
    expect(r.signals).toContain('jira:DEMO-15702');
    expect(r.signals).toContain('mood:exhausted');
    expect(r.clarifyingPrompt).toBeUndefined();
  });

  it('AMBIGUOUS gate guarded by explicit referent (CHAT-05 / adversarial fix #3)', () => {
    // No referent → close-call / mood-only-question gate fires.
    const noRef = detectMode({ message: "I'm exhausted and stressed, can we talk?" });
    expect(noRef.mode).toBe('ambiguous');
    expect(noRef.clarifyingPrompt).toBeTruthy();

    // Referent present → gate cannot fire; routes WORK.
    const withRef = detectMode({ message: "I'm exhausted, fix DEMO-15702" });
    expect(withRef.mode).toBe('work');
    expect(withRef.clarifyingPrompt).toBeUndefined();
  });

  it('persistence boost gated by prior turn confidence ≥ 0.7 (adversarial fix #2)', () => {
    const strong = detectMode({
      message: 'thanks',
      history: [{ mode: 'work', confidence: 0.9 }],
    });
    expect(strong.mode).toBe('work');
    expect(strong.signals).toContain('persistence:work');

    const weak = detectMode({
      message: 'thanks',
      history: [{ mode: 'work', confidence: 0.5 }],
    });
    expect(weak.mode).toBe('ambiguous');
    expect(weak.signals).toEqual([]);
  });

  it('routes family-keyword message to LIFE', () => {
    const r = detectMode({ message: 'taking my daughter to the doctor' });
    expect(r.mode).toBe('life');
    expect(r.signals).toContain('family:daughter');
    expect(r.signals).toContain('family:doctor');
    expect(r.clarifyingPrompt).toBeUndefined();
  });

  it('returns modeSource="auto" when manualMode is undefined', () => {
    const r = detectMode({ message: '/wi-investigate', manualMode: undefined });
    expect(r.modeSource).toBe('auto');
    expect(r.mode).toBe('work');
  });

  it('clarifyingPrompt is undefined for all non-ambiguous outcomes', () => {
    const cases = [
      detectMode({ message: '/wi-investigate DEMO-15702' }),
      detectMode({ message: "I'm stressed about tonight's on-call" }),
      detectMode({ message: "I'm stressed", manualMode: 'work' }),
      detectMode({ message: 'taking my daughter to the doctor' }),
      detectMode({ message: "I'm exhausted, investigate DEMO-15702" }),
    ];
    for (const c of cases) {
      expect(c.mode).not.toBe('ambiguous');
      expect(c.clarifyingPrompt).toBeUndefined();
    }
  });
});
