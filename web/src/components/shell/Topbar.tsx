import { useLocation } from 'react-router-dom';
import { Sun, Moon, Monitor, Command, Menu, RefreshCw } from 'lucide-react';
import { useUIStore, type Theme } from '@/store/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { SyncAllButton } from '@/components/shared/SyncAllButton';
import { formatRelative } from '@/lib/utils';

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/topic-expert': 'Topic Expert',
  '/jira-report': 'Jira Report',
  '/teams-updates': 'Teams Updates',
  '/search-all': 'Search All',
  '/action-items': 'Action Items',
  '/digest': 'Daily Digest',
  '/weekly-report': 'Weekly Report',
  '/system-health': 'System Health',
  '/topics': 'Topics & Settings',
};

const THEME_ICONS: Record<Theme, React.ReactNode> = {
  system: <Monitor size={14} />,
  light: <Sun size={14} />,
  dark: <Moon size={14} />,
};

const THEME_CYCLE: Theme[] = ['system', 'light', 'dark'];

export function Topbar() {
  const location = useLocation();
  const { theme, setTheme, setCmdOpen, setMobileMenuOpen } = useUIStore();
  const title = PAGE_TITLES[location.pathname] ?? 'Work Intelligence';
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 30_000 });

  // A-10: palace uptime — surface a banner when the recall layer is offline so
  // users know answers may be less complete instead of mysteriously degraded.
  const { data: palace } = useQuery({
    queryKey: ['palace-status'],
    queryFn: async () => {
      const res = await fetch('/api/palace/status');
      if (!res.ok) return null;
      return res.json() as Promise<{ connected: boolean; uptime?: number; lastError?: string | null; drawerCount?: number }>;
    },
    refetchInterval: 60_000, // poll once a minute
    retry: false,
  });
  const palaceOffline = palace !== undefined && palace !== null && !palace.connected;

  // U-9: AI budget widget — surface today's spend so users know what they have left.
  const { data: budget } = useQuery({
    queryKey: ['brain-budget'],
    queryFn: async () => {
      const res = await fetch('/api/brain/budget?user=anon:ui');
      if (!res.ok) return null;
      return res.json() as Promise<{
        calls: number; max_calls: number;
        tokens: number; max_tokens: number;
        reset_in_ms: number;
      }>;
    },
    refetchInterval: 60_000,
    retry: false,
  });

  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(theme);
    setTheme(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]);
  }

  return (
    <header
      className="flex flex-col shrink-0 border-b"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {/* A-10: palace offline banner — sits above the topbar row when applicable */}
      {palaceOffline && (
        <div
          className="px-3 sm:px-4 py-1.5 text-[11px] flex items-center gap-2"
          style={{
            background: 'color-mix(in srgb, #f59e0b 18%, transparent)',
            color: '#92400e',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#f59e0b' }} />
          <span><strong>Recall layer offline</strong> — answers may be less complete. {palace?.lastError ? `(${palace.lastError})` : 'Check MEMPALACE_PATH.'}</span>
        </div>
      )}

      <div className="flex items-center justify-between px-3 sm:px-4 py-2 gap-3">
      {/* Left: hamburger + title */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => setMobileMenuOpen(true)}
          className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--bg-3)] md:hidden shrink-0"
          style={{ color: 'var(--fg-2)' }}
          aria-label="Open menu"
        >
          <Menu size={15} />
        </button>
        <h1 className="font-display font-600 text-sm tracking-tight truncate" style={{ color: 'var(--fg)' }}>
          {title}
        </h1>
      </div>

      {/* Center: sync status — hidden on mobile */}
      <div className="hidden sm:flex items-center gap-3 text-xs flex-1 justify-center" style={{ color: 'var(--muted)' }}>
        {status?.lastSync && (
          <span className="flex items-center gap-1">
            <RefreshCw size={10} />
            {formatRelative(status.lastSync)}
          </span>
        )}
        {status && (
          <div className="flex items-center gap-2">
            {[
              { label: 'AI', ok: status.anthropicConnected },
              { label: 'Browser', ok: status.browserConnected },
            ].map(p => (
              <span key={p.label} className="flex items-center gap-1" style={{ color: p.ok ? '#10b981' : '#ef4444' }}>
                <span className={`w-1.5 h-1.5 rounded-full ${p.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                {p.label}
              </span>
            ))}
          </div>
        )}
        {budget && (() => {
          const callsPct = budget.max_calls > 0 ? budget.calls / budget.max_calls : 0;
          const tokensPct = budget.max_tokens > 0 ? budget.tokens / budget.max_tokens : 0;
          const worst = Math.max(callsPct, tokensPct);
          const tone = worst >= 0.95 ? '#ef4444' : worst >= 0.8 ? '#f59e0b' : 'var(--muted)';
          const hours = Math.floor(budget.reset_in_ms / 3_600_000);
          const minutes = Math.floor((budget.reset_in_ms % 3_600_000) / 60_000);
          return (
            <span
              className="flex items-center gap-1 text-[11px]"
              style={{ color: tone }}
              title={`Brain calls: ${budget.calls}/${budget.max_calls}\nTokens: ${budget.tokens.toLocaleString()}/${budget.max_tokens.toLocaleString()}\nResets in ${hours}h ${minutes}m (UTC midnight)`}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: tone }} />
              {budget.calls}/{budget.max_calls} · {Math.round(budget.tokens / 1000)}k/{Math.round(budget.max_tokens / 1000)}k
            </span>
          );
        })()}
        <SyncAllButton />
      </div>

      {/* Right: ⌘K + theme */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => setCmdOpen(true)}
          className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-[var(--bg-3)]"
          style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
        >
          <Command size={10} /><span>K</span>
        </button>
        <button
          onClick={cycleTheme}
          title={`Theme: ${theme}`}
          className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--bg-3)]"
          style={{ color: 'var(--fg-2)' }}
        >
          {THEME_ICONS[theme]}
        </button>
      </div>
      </div>
    </header>
  );
}
