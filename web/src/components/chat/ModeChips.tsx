/**
 * Phase 78a-05 — ModeChips
 *
 * Three-chip group rendered in the ChatPanel header. Reads + writes the
 * chip-selected `mode` field directly from the Zustand chat store
 * (D-78a-05: no controlled-component / prop-drilling pattern).
 *
 * Chip semantics:
 *   🤔 Auto — server detects per turn (default).
 *   🛠 Work — manual override; force work persona + work memory.
 *   🤝 Life — manual override; force life persona + life memory (78a stub).
 *
 * Chip selection persists via the existing `persist` middleware on
 * useChatStore (storage=localStorage in this project; CHAT-06 spec calls
 * for sessionStorage but the existing config is localStorage and the plan
 * forbids changing the persist config in this task).
 */

import { useChatStore, type ChatMode } from '@/store/chat';

interface ChipDef {
  mode: ChatMode;
  emoji: string;
  label: string;
  title: string;
}

const CHIPS: readonly ChipDef[] = [
  { mode: 'auto', emoji: '🤔', label: 'Auto', title: 'Auto — server detects per turn' },
  { mode: 'work', emoji: '🛠',  label: 'Work', title: 'Work mode — work memory only' },
  { mode: 'life', emoji: '🤝', label: 'Life', title: 'Life mode — life memory only (78a stub)' },
];

export function ModeChips(): JSX.Element | null {
  const activeSession = useChatStore(s => s.activeSession());
  const setMode = useChatStore(s => s.setMode);

  // No session → render nothing (defensive; the store always seeds one).
  if (!activeSession) return null;
  const active: ChatMode = activeSession.mode ?? 'auto';

  return (
    <div
      role="radiogroup"
      aria-label="Chat mode"
      className="flex items-center gap-1"
    >
      {CHIPS.map(chip => {
        const isActive = active === chip.mode;
        return (
          <button
            key={chip.mode}
            type="button"
            role="radio"
            aria-checked={isActive}
            title={chip.title}
            onClick={() => setMode(activeSession.id, chip.mode)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors"
            style={{
              background: isActive ? 'var(--accent)' : 'transparent',
              color: isActive ? '#fff' : 'var(--fg-2)',
              border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            <span aria-hidden="true">{chip.emoji}</span>
            <span>{chip.label}</span>
          </button>
        );
      })}
    </div>
  );
}
