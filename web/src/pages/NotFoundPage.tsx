/**
 * U-7 fix: real 404 page instead of a silent redirect to "/".
 *
 * Before: `<Route path="*" element={<Navigate to="/" replace />} />` —
 * any stale bookmark or renamed route silently went home, hiding the breakage.
 *
 * Now we tell the user what happened and offer concrete jumps. The 12 nav items
 * are not re-listed (Sidebar covers that); we surface the ones a typo would
 * realistically land on.
 */

import { Link, useLocation } from 'react-router-dom';
import { Compass, ArrowLeft } from 'lucide-react';

interface SuggestedDestination {
  path: string;
  label: string;
  hint?: string;
}

// Common bookmark drift candidates — keep this small so it stays scannable.
const SUGGESTIONS: SuggestedDestination[] = [
  { path: '/', label: 'Dashboard', hint: 'today\'s activity + alerts' },
  { path: '/topic-expert', label: 'Topic Expert', hint: 'ask across all sources' },
  { path: '/jira-report', label: 'Jira Report', hint: 'sprint board + analysis' },
  { path: '/action-items', label: 'Action Items', hint: 'what you owe' },
  { path: '/system-health', label: 'System Health', hint: 'verify everything\'s OK' },
];

export default function NotFoundPage() {
  const location = useLocation();
  const attempted = `${location.pathname}${location.search}`;

  return (
    <div
      className="max-w-2xl mx-auto px-6 py-12 space-y-6"
      style={{ color: 'var(--fg)' }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--bg-3)' }}
        >
          <Compass size={20} style={{ color: 'var(--muted)' }} />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
            404 — Not Found
          </div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)' }}>
            That page isn't here.
          </h1>
        </div>
      </div>

      <div
        className="px-3 py-2 rounded-lg text-xs font-mono"
        style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg-2)' }}
      >
        Requested: <span style={{ color: 'var(--fg)' }}>{attempted}</span>
      </div>

      <p className="text-sm" style={{ color: 'var(--fg-2)' }}>
        The route may have been renamed, or your bookmark is from an older version of the UI. The
        sidebar on the left has the full navigation; here are a few places it might be:
      </p>

      <ul className="space-y-1.5">
        {SUGGESTIONS.map((s) => (
          <li key={s.path}>
            <Link
              to={s.path}
              className="inline-flex items-baseline gap-2 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-[var(--bg-3)]"
              style={{ color: 'var(--accent)' }}
            >
              <span className="font-medium">{s.label}</span>
              {s.hint && (
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  — {s.hint}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>

      <div className="pt-2">
        <button
          onClick={() => window.history.length > 1 ? window.history.back() : (window.location.href = '/')}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors hover:bg-[var(--bg-3)]"
          style={{ color: 'var(--fg-2)', background: 'var(--bg-2)', border: '1px solid var(--border)' }}
        >
          <ArrowLeft size={13} />
          Go back
        </button>
      </div>
    </div>
  );
}
