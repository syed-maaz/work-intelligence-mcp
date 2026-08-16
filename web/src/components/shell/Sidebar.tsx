import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Brain, ClipboardList, FileText,
  Search, CheckSquare, BookOpen, Settings, BarChart2,
  ChevronLeft, ChevronRight, Zap, MessageSquare, X, Activity, Users, GitPullRequest,
  BookMarked, Wrench, Bug, Sliders, LayoutGrid, Moon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/store/ui';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// OP-3 / U-1: grouped IA — 4 sections (Daily / Search / Work / System).
// Goal: cut top-level cognitive load from 12 siblings to 4 groups of 2–4.
type NavItem = { to: string; icon: typeof LayoutDashboard; label: string; exact?: boolean };
type NavGroup = { label: string; items: NavItem[] };

function isChatPrimaryRoute(pathname: string): boolean {
  return pathname === '/' || pathname === '/chat';
}

const NAV: NavGroup[] = [
  {
    label: 'Daily',
    items: [
      { to: '/', icon: MessageSquare, label: 'Chat', exact: true },
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/action-items', icon: CheckSquare, label: 'Action Items' },
      { to: '/digest', icon: BookOpen, label: 'Daily Digest' },
    ],
  },
  {
    label: 'Search',
    items: [
      { to: '/topic-expert', icon: Brain, label: 'Topic Expert' },
      { to: '/search-all', icon: Search, label: 'Search All' },
      { to: '/teams-updates', icon: ClipboardList, label: 'Teams Updates' },
    ],
  },
  {
    label: 'Work',
    items: [
      { to: '/jira-report', icon: FileText, label: 'Jira Report' },
      { to: '/pr-review', icon: GitPullRequest, label: 'PR Review' },
      { to: '/teammates', icon: Users, label: 'Teammates' },
      { to: '/topics', icon: Settings, label: 'Topics' },
    ],
  },
  {
    label: 'Cypher',
    items: [
      { to: '/cypher', icon: Brain, label: 'Cypher' },
      { to: '/cypher/cost', icon: Brain, label: 'Cost compare' },
      { to: '/board', icon: LayoutGrid, label: 'Board' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/weekly-report', icon: BarChart2, label: 'Weekly Report' },
      { to: '/system-health', icon: Activity, label: 'System Health' },
      { to: '/bugs', icon: Bug, label: 'Bugs' },
      { to: '/dream', icon: Moon, label: 'Dream' },
      { to: '/setup', icon: Wrench, label: 'Setup', exact: true },
      { to: '/setup/models', icon: Sliders, label: 'Models' },
      { to: '/glossary', icon: BookMarked, label: 'Glossary' },
    ],
  },
];

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-block w-1.5 h-1.5 rounded-full flex-shrink-0',
        ok ? 'bg-emerald-400' : 'bg-rose-400'
      )}
    />
  );
}

interface SidebarProps {
  onNavClick?: () => void;
}

export function Sidebar({ onNavClick }: SidebarProps) {
  const { sidebarCollapsed, toggleSidebar, chatOpen, toggleChat, setMobileMenuOpen } = useUIStore();
  const location = useLocation();
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 30_000,
  });

  return (
    <aside
      className={cn(
        'flex flex-col border-r transition-all duration-200 shrink-0 h-full',
        // On mobile always full-width expanded; on md+ use collapsed state
        'w-52 md:w-auto',
        sidebarCollapsed ? 'md:w-14' : 'md:w-52'
      )}
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {/* Logo + mobile close */}
      <div
        className={cn(
          'flex items-center gap-2.5 px-4 py-4 border-b',
          sidebarCollapsed && 'md:justify-center md:px-0'
        )}
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center shrink-0">
          <Zap size={14} className="text-white" />
        </div>
        <span
          className={cn(
            'font-display font-700 text-sm tracking-tight flex-1',
            sidebarCollapsed && 'md:hidden'
          )}
          style={{ color: 'var(--fg)' }}
        >
          Work Intel
        </span>
        {/* Close button — mobile only */}
        <button
          onClick={() => setMobileMenuOpen(false)}
          className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--bg-3)] md:hidden"
          style={{ color: 'var(--muted)' }}
          aria-label="Close menu"
        >
          <X size={14} />
        </button>
      </div>

      {/* Nav — grouped by activity (Daily / Search / Work / System) */}
      <nav className="flex-1 py-3 px-2 overflow-y-auto">
        {NAV.map(group => (
          <div key={group.label} className="mb-3 last:mb-0">
            {!sidebarCollapsed && (
              <div
                className="px-2.5 mb-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--muted)' }}
              >
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map(({ to, icon: Icon, label, exact }) => {
                const active = exact
                  ? location.pathname === to
                  : location.pathname === to || location.pathname.startsWith(to + '/');
                return (
                  <NavLink
                    key={to}
                    to={to}
                    title={sidebarCollapsed ? label : undefined}
                    onClick={onNavClick}
                    className={cn(
                      'flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors',
                      sidebarCollapsed && 'md:justify-center md:px-0 md:w-10 md:mx-auto',
                      active ? 'bg-accent text-white' : 'hover:bg-[var(--bg-3)]'
                    )}
                    style={{ color: active ? 'white' : 'var(--fg-2)' }}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span className={cn(sidebarCollapsed && 'md:hidden')}>{label}</span>
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Connection status */}
      {!sidebarCollapsed && status && (
        <div
          className="px-4 py-3 border-t text-xs space-y-1.5"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        >
          <div className="flex items-center gap-2">
            <StatusDot ok={status.anthropicConnected} />
            <span>Anthropic</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot ok={status.browserConnected} />
            <span>Browser</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot ok={status.githubConnected} />
            <span>GitHub</span>
          </div>
        </div>
      )}

      {/* Chat toggle — hidden on chat-primary routes (U-6) */}
      {!isChatPrimaryRoute(location.pathname) && (
      <button
        onClick={toggleChat}
        className={cn(
          'flex items-center justify-center py-2.5 border-t w-full transition-colors hover:bg-[var(--bg-3)]',
          chatOpen && 'bg-accent/10'
        )}
        style={{
          borderColor: 'var(--border)',
          color: chatOpen ? 'var(--accent)' : 'var(--muted)',
        }}
        title={chatOpen ? 'Close assistant' : 'Open assistant'}
      >
        <MessageSquare size={15} fill={chatOpen ? 'var(--accent)' : 'none'} />
      </button>
      )}

      {/* Collapse toggle — desktop only */}
      <button
        onClick={toggleSidebar}
        className="hidden md:flex items-center justify-center py-3 border-t w-full transition-colors hover:bg-[var(--bg-3)]"
        style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>
    </aside>
  );
}
