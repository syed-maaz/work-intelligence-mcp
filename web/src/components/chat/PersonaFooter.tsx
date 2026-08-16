/**
 * Phase 78a-05 — PersonaFooter
 *
 * Small dimmed strip rendered below the chat input. Becomes visible for
 * exactly 5 seconds after the *effective* mode changes (chip click OR a new
 * assistant turn whose `detectedMode` differs from the previous one), then
 * auto-dismisses. Returns null when not visible — no DOM artifact.
 *
 * Format strings (literal, per spec):
 *   WORK:      `Mode: 🛠 Work — knows your stack.`
 *   LIFE:      `Mode: 🤝 Life — knows your family + values.`
 *   AMBIGUOUS: `Mode: 🤔 Ambiguous — asking for clarification.`
 */

import { useEffect, useRef, useState } from 'react';
import { useChatStore, type ChatMode, type DetectedMode } from '@/store/chat';

const VISIBLE_MS = 5000;

const COPY: Record<'work' | 'life' | 'ambiguous', string> = {
  work: 'Mode: 🛠 Work — knows your stack.',
  life: 'Mode: 🤝 Life — knows your family + values.',
  ambiguous: 'Mode: 🤔 Ambiguous — asking for clarification.',
};

/**
 * Pick the "effective" mode the same way ConversationHeader does — last
 * server-resolved detectedMode wins; otherwise fall back to the chip
 * (with chip='auto' surfacing as 'ambiguous' so the emoji matches).
 */
function effectiveMode(
  chip: ChatMode,
  lastDetected: DetectedMode | undefined,
): 'work' | 'life' | 'ambiguous' {
  if (lastDetected) return lastDetected;
  if (chip === 'auto') return 'ambiguous';
  return chip;
}

export function PersonaFooter(): JSX.Element | null {
  const activeSession = useChatStore(s => s.activeSession());
  const messages = useChatStore(s => s.messages());

  let lastDetected: DetectedMode | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].detectedMode) {
      lastDetected = messages[i].detectedMode;
      break;
    }
  }

  const chip: ChatMode = activeSession?.mode ?? 'auto';
  const eff = effectiveMode(chip, lastDetected);

  const lastAnnouncedRef = useRef<'work' | 'life' | 'ambiguous' | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // First render seeds the announced mode without firing the footer (we
    // only announce *transitions*, not the initial state).
    if (lastAnnouncedRef.current === null) {
      lastAnnouncedRef.current = eff;
      return;
    }
    if (lastAnnouncedRef.current === eff) return;
    lastAnnouncedRef.current = eff;
    setVisible(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setVisible(false), VISIBLE_MS);
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [eff]);

  // Final unmount cleanup
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  if (!visible) return null;

  return (
    <p
      className="text-[10px] text-center px-3 py-1"
      style={{ color: 'var(--muted)' }}
      role="status"
      aria-live="polite"
    >
      {COPY[eff]}
    </p>
  );
}
