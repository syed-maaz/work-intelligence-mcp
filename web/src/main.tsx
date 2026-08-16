import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './globals.css';
import { applyTheme } from './store/ui';

// Apply persisted theme before first paint
const saved = localStorage.getItem('wi-theme') as 'system' | 'dark' | 'light' | null;
applyTheme(saved ?? 'system');

// ── ADR-030 Phase A: global error capture (dev/preview only) ────────────────
// Vite minifies production builds and breaks topFrame extraction without
// source maps. Phase B will revisit production capture once source maps are
// resolved server-side. For now, dev/preview only — caught errors in
// production silently log to the console.
if (import.meta.env.MODE !== 'production') {
  window.addEventListener('error', (event) => {
    void fetch('/api/bugs/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'web-ui',
        errorName: (event.error as Error | undefined)?.name ?? 'WindowError',
        message: event.message,
        stack: (event.error as Error | undefined)?.stack ?? null,
        file: event.filename,
        line: event.lineno,
        build: import.meta.env.MODE,
      }),
    }).catch(() => { /* swallow */ });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    void fetch('/api/bugs/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'web-ui',
        errorName: err.name,
        message: err.message,
        stack: err.stack ?? null,
        context: { kind: 'unhandledrejection' },
        build: import.meta.env.MODE,
      }),
    }).catch(() => { /* swallow */ });
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10 * 60 * 1000,   // 10 min — show cached data on tab switch
      gcTime: 30 * 60 * 1000,      // keep unused cache for 30 min
      refetchOnWindowFocus: false,
      refetchOnMount: false,        // don't re-fetch just because a component mounts
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
