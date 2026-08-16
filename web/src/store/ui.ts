import { create } from 'zustand';

export type Theme = 'system' | 'dark' | 'light';

interface UIStore {
  sidebarCollapsed: boolean;
  mobileMenuOpen: boolean;
  theme: Theme;
  cmdOpen: boolean;
  chatOpen: boolean;
  pendingChatMessage: string | null;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  setMobileMenuOpen: (v: boolean) => void;
  setTheme: (t: Theme) => void;
  setCmdOpen: (v: boolean) => void;
  toggleCmd: () => void;
  toggleChat: () => void;
  setChatOpen: (v: boolean) => void;
  sendToChat: (msg: string) => void;
  clearPendingChatMessage: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarCollapsed: false,
  mobileMenuOpen: false,
  theme: (localStorage.getItem('wi-theme') as Theme) ?? 'system',
  cmdOpen: false,
  chatOpen: false,
  pendingChatMessage: null,

  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setMobileMenuOpen: (v) => set({ mobileMenuOpen: v }),

  setTheme: (t) => {
    localStorage.setItem('wi-theme', t);
    applyTheme(t);
    set({ theme: t });
  },

  setCmdOpen: (v) => set({ cmdOpen: v }),
  toggleCmd: () => set((s) => ({ cmdOpen: !s.cmdOpen })),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  setChatOpen: (v) => set({ chatOpen: v }),
  sendToChat: (msg) => set({ chatOpen: true, pendingChatMessage: msg }),
  clearPendingChatMessage: () => set({ pendingChatMessage: null }),
}));

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);

  root.classList.toggle('dark', isDark);

  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}
