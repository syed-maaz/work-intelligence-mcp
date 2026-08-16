import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { useUIStore } from '@/store/ui';
import {
  LayoutDashboard, Brain, FileText, ClipboardList, MessageSquare,
  Search, CheckSquare, BookOpen, Settings, BarChart2, Activity,
} from 'lucide-react';

const PAGES = [
  { to: '/', icon: MessageSquare, label: 'Chat', desc: 'Primary assistant — ask about your work' },
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', desc: 'Stats, recent messages, action items' },
  { to: '/topic-expert', icon: Brain, label: 'Topic Expert', desc: 'Ask a natural language question' },
  { to: '/jira-report', icon: FileText, label: 'Jira Report', desc: 'Live Jira board report with AI analysis' },
  { to: '/teams-updates', icon: ClipboardList, label: 'Teams Updates', desc: 'Search Teams messages and transcripts' },
  { to: '/search-all', icon: Search, label: 'Search All', desc: 'Cross-source search: Outlook + Jira + Teams' },
  { to: '/action-items', icon: CheckSquare, label: 'Action Items', desc: 'Track and filter action items' },
  { to: '/digest', icon: BookOpen, label: 'Daily Digest', desc: 'AI-generated daily summary' },
  { to: '/weekly-report', icon: BarChart2, label: 'Weekly Report', desc: 'AI-generated weekly pattern analysis' },
  { to: '/system-health', icon: Activity, label: 'System Health', desc: 'Data quality, ingestion log, relationships, embeddings' },
  { to: '/topics', icon: Settings, label: 'Topics', desc: 'Configure monitored projects' },
  { to: '/setup', icon: Settings, label: 'Setup', desc: 'First-run checklist: API key, browser, GitHub' },
  { to: '/glossary', icon: BookOpen, label: 'Glossary', desc: 'Topic vs project vs board vocabulary' },
];

const SHORTCUTS = [
  { keys: '⌘K', label: 'Open command palette' },
  { keys: 'ESC', label: 'Close palette' },
];

export function CommandPalette() {
  const { cmdOpen, setCmdOpen } = useUIStore();
  const navigate = useNavigate();

  // ⌘K / Ctrl+K
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setCmdOpen(true);
    }
    if (e.key === 'Escape') {
      setCmdOpen(false);
    }
  }, [setCmdOpen]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  function go(to: string) {
    navigate(to);
    setCmdOpen(false);
  }

  if (!cmdOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={() => setCmdOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-xl border overflow-hidden shadow-2xl"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border-2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <Command>
          <div
            className="flex items-center gap-2 px-4 py-3 border-b"
            style={{ borderColor: 'var(--border)' }}
          >
            <Search size={14} style={{ color: 'var(--muted)' }} />
            <Command.Input
              placeholder="Jump to page…"
              className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-[var(--muted)]"
              style={{ color: 'var(--fg)' }}
              autoFocus
            />
            <kbd
              className="text-[10px] px-1.5 py-0.5 rounded font-mono"
              style={{ background: 'var(--bg-3)', color: 'var(--muted)', border: '1px solid var(--border)' }}
            >
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-72 overflow-y-auto py-2">
            <Command.Empty
              className="py-8 text-center text-sm"
              style={{ color: 'var(--muted)' }}
            >
              No results
            </Command.Empty>

            <Command.Group
              heading={
                <span className="px-4 py-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                  Pages
                </span>
              }
            >
              {PAGES.map(({ to, icon: Icon, label, desc }) => (
                <Command.Item
                  key={to}
                  value={label}
                  onSelect={() => go(to)}
                  className="flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors aria-selected:bg-[var(--bg-3)]"
                  style={{ color: 'var(--fg)' }}
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: 'var(--bg-3)' }}
                  >
                    <Icon size={13} style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs" style={{ color: 'var(--muted)' }}>{desc}</p>
                  </div>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group
              heading={
                <span className="px-4 py-1 text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                  Shortcuts
                </span>
              }
            >
              {SHORTCUTS.map(({ keys, label }) => (
                <div
                  key={keys}
                  className="flex items-center justify-between px-4 py-2 text-xs"
                  style={{ color: 'var(--fg-2)' }}
                >
                  <span>{label}</span>
                  <kbd
                    className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                    style={{ background: 'var(--bg-3)', color: 'var(--muted)', border: '1px solid var(--border)' }}
                  >
                    {keys}
                  </kbd>
                </div>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
