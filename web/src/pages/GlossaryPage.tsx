/**
 * U-19 — Vocabulary glossary.
 */
import { BookMarked } from 'lucide-react';
import { GLOSSARY } from '@/lib/glossary';

export default function GlossaryPage() {
  return (
    <div className="max-w-2xl space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <BookMarked size={16} style={{ color: 'var(--accent)' }} />
        <h1 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Vocabulary</h1>
      </div>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Terms used across the web UI and brain tools — disambiguated so Topics, projects, and boards do not blur together.
      </p>
      <div className="space-y-2">
        {GLOSSARY.map((entry) => (
          <div
            key={entry.term}
            className="rounded-xl border px-4 py-3"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
          >
            <p className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{entry.term}</p>
            <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--fg-2)' }}>{entry.meaning}</p>
            {entry.notTheSameAs && (
              <p className="text-[11px] mt-2 italic" style={{ color: 'var(--muted)' }}>
                Not the same as: {entry.notTheSameAs}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
