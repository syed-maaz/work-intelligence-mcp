/**
 * Phase 78a-05 — ConversationHeader
 *
 * Thin horizontal strip rendered at the top of the message list. Shows:
 *   - Mode emoji on the left (🛠 / 🤝 / 🤔).
 *   - Subtitle: "Auto → Work" when chip='auto' AND server resolved to work,
 *     "Manual: 🛠 Work" when chip='work' or 'life' (override).
 *   - One-line persona summary on the right (first ~80 chars of the
 *     /api/persona response systemPrompt for the resolved mode).
 *
 * Reactivity: re-renders when chip changes (mode in store) or when last
 * assistant turn updates (detectedMode change).
 */

import { useEffect, useState } from 'react';
import { useChatStore, type DetectedMode, type ChatMode } from '@/store/chat';

const EMOJI: Record<'work' | 'life' | 'ambiguous', string> = {
  work: '🛠',
  life: '🤝',
  ambiguous: '🤔',
};

const MODE_LABEL: Record<'work' | 'life' | 'ambiguous', string> = {
  work: 'Work',
  life: 'Life',
  ambiguous: 'Ambiguous',
};

/**
 * Pick the "effective" mode for header rendering: prefer the last assistant
 * message's `detectedMode` (server-resolved) when available, otherwise fall
 * back to the chip selection. For chip='auto' with no assistant turns yet,
 * defaults to 'ambiguous' (the 🤔 emoji) to mirror the chip emoji.
 */
function effectiveMode(
  chip: ChatMode,
  lastDetected: DetectedMode | undefined,
): 'work' | 'life' | 'ambiguous' {
  if (lastDetected) return lastDetected;
  if (chip === 'auto') return 'ambiguous';
  return chip; // 'work' | 'life'
}

interface PersonaSummary {
  text: string;
  cached: boolean;
}

const personaCache = new Map<string, PersonaSummary>();

async function fetchPersonaSummary(mode: 'work' | 'life' | 'mixed'): Promise<PersonaSummary> {
  const key = mode;
  const hit = personaCache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/persona?mode=${mode}`);
    if (!res.ok) {
      const fallback = { text: '', cached: false };
      personaCache.set(key, fallback);
      return fallback;
    }
    const json = await res.json() as { systemPrompt?: string; cached?: boolean };
    const raw = (json.systemPrompt ?? '').trim();
    // First non-empty line, or first 80 chars — whichever is shorter.
    const firstLine = raw.split('\n').find(l => l.trim().length > 0)?.trim() ?? '';
    const text = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
    const summary: PersonaSummary = { text, cached: !!json.cached };
    personaCache.set(key, summary);
    return summary;
  } catch {
    const fallback = { text: '', cached: false };
    return fallback;
  }
}

export function ConversationHeader(): JSX.Element | null {
  const activeSession = useChatStore(s => s.activeSession());
  const messages = useChatStore(s => s.messages());

  // Pick last assistant message's detectedMode if present.
  let lastDetected: DetectedMode | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].detectedMode) {
      lastDetected = messages[i].detectedMode;
      break;
    }
  }

  const chip: ChatMode = activeSession?.mode ?? 'auto';
  const eff = effectiveMode(chip, lastDetected);
  // Persona endpoint accepts 'work' | 'life' | 'mixed' — map ambiguous → work
  // for the summary fetch (matches D-78a-09 backward-compat default).
  const personaMode: 'work' | 'life' | 'mixed' = eff === 'ambiguous' ? 'work' : eff;

  const [summary, setSummary] = useState<PersonaSummary>({ text: '', cached: false });

  useEffect(() => {
    let cancelled = false;
    fetchPersonaSummary(personaMode).then(s => {
      if (!cancelled) setSummary(s);
    });
    return () => { cancelled = true; };
  }, [personaMode]);

  if (!activeSession) return null;

  // Subtitle copy: "Auto → Work" only when chip='auto' AND a detection has
  // happened; "Manual: 🛠 Work" when chip is a manual override; nothing
  // before the first turn.
  let subtitle: string | null = null;
  if (chip === 'auto' && lastDetected) {
    subtitle = `Auto → ${MODE_LABEL[lastDetected]}`;
  } else if (chip === 'work') {
    subtitle = 'Manual: 🛠 Work';
  } else if (chip === 'life') {
    subtitle = 'Manual: 🤝 Life';
  }

  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-xs"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-base leading-none" aria-hidden="true">{EMOJI[eff]}</span>
        {subtitle && (
          <span className="text-[11px] font-medium" style={{ color: 'var(--fg-2)' }}>
            {subtitle}
          </span>
        )}
      </div>
      {summary.text && (
        <span
          className="truncate text-[11px]"
          style={{ color: 'var(--muted)' }}
          title={summary.text}
        >
          {summary.text}
        </span>
      )}
    </div>
  );
}
