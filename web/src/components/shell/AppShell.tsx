import { useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { StatusBar } from './StatusBar';
import { ChatPanel } from './ChatPanel';
import { useUIStore } from '@/store/ui';

/** U-6: chat is the homepage — no duplicate slide-over panel on / or /chat */
function isChatPrimaryRoute(pathname: string): boolean {
  return pathname === '/' || pathname === '/chat';
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { chatOpen, mobileMenuOpen, setMobileMenuOpen } = useUIStore();
  const { pathname } = useLocation();
  const showSidebarChat = chatOpen && !isChatPrimaryRoute(pathname);

  return (
    <div className="flex h-screen w-screen overflow-hidden" style={{ background: 'var(--bg)' }}>

      {/* Mobile sidebar backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar — hidden on mobile unless mobileMenuOpen, always visible md+ */}
      <div
        className={[
          'fixed inset-y-0 left-0 z-40 md:static md:z-auto md:flex md:shrink-0 transition-transform duration-200',
          mobileMenuOpen ? 'flex translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
      >
        <Sidebar onNavClick={() => setMobileMenuOpen(false)} />
      </div>

      {/* Main column */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar />

        <div className="flex flex-1 min-h-0 relative">
          {/* Page content */}
          <main className="flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5 md:p-6">
            {children}
          </main>

          {/* Chat panel — overlay on mobile, sidebar on desktop */}
          {showSidebarChat && (
            <>
              {/* Mobile: full-screen overlay */}
              <div className="fixed inset-0 z-50 md:hidden flex flex-col">
                <ChatPanel />
              </div>
              {/* Desktop: right sidebar */}
              <div className="hidden md:flex shrink-0">
                <ChatPanel />
              </div>
            </>
          )}
        </div>

        <StatusBar />
      </div>
    </div>
  );
}
