/**
 * U-8 fix: catch render errors inside a route so a single page crash doesn't
 * blank the entire app. The Sidebar + Topbar + ChatPanel stay alive; only the
 * crashed route shows a recovery card.
 *
 * Usage: wrap each <Route element={...}> child, OR wrap once around <Routes>
 * if you want all routes covered by the same boundary. App.tsx does the
 * outer-wrap variant for simplicity.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** Optional label so the recovery UI can hint where it crashed. */
  scope?: string;
}

interface State {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Surface to dev tools so we don't lose the stack
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.scope ?? '(unscoped)', error, errorInfo);
    this.setState({ errorInfo });

    // ADR-030 Phase A: POST to bridge so React render errors get captured
    // the same way bridge/agent throws do. Best-effort — never throw here
    // (this handler runs during a render-error path; throwing would
    // recursively trigger another componentDidCatch).
    try {
      void fetch('/api/bugs/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'web-ui',
          errorName: error.name,
          message: error.message,
          stack: error.stack ?? null,
          context: { scope: this.props.scope ?? null, componentStack: errorInfo.componentStack },
          build: import.meta.env.MODE,
        }),
      }).catch(() => { /* swallow — capture must not crash the recovery card */ });
    } catch { /* same */ }
  }

  handleReset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const { scope } = this.props;
    const message = this.state.error.message || 'Unknown error';
    const stackPreview =
      this.state.error.stack?.split('\n').slice(0, 5).join('\n') ?? '';

    return (
      <div
        className="max-w-2xl mx-auto px-6 py-12 space-y-5"
        style={{ color: 'var(--fg)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--danger, #ef4444) 18%, transparent)' }}
          >
            <AlertTriangle size={20} style={{ color: 'var(--danger, #ef4444)' }} />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
              Page error
            </div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)' }}>
              This page hit a problem{scope ? ` in ${scope}` : ''}.
            </h1>
          </div>
        </div>

        <p className="text-sm" style={{ color: 'var(--fg-2)' }}>
          The rest of the app is still working — sidebar and chat are unaffected. You can try the
          page again, or reload to start fresh.
        </p>

        <div
          className="px-3 py-2 rounded-lg text-xs font-mono whitespace-pre-wrap break-words"
          style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg-2)' }}
        >
          {message}
          {stackPreview && (
            <details className="mt-1">
              <summary className="cursor-pointer" style={{ color: 'var(--muted)' }}>
                Stack (top 5)
              </summary>
              <div className="mt-1" style={{ color: 'var(--muted)' }}>{stackPreview}</div>
            </details>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={this.handleReset}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors hover:bg-[var(--bg-3)]"
            style={{ color: 'var(--fg)', background: 'var(--bg-2)', border: '1px solid var(--border)' }}
          >
            <RotateCcw size={13} />
            Try again
          </button>
          <button
            onClick={this.handleReload}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
            style={{ color: '#fff', background: 'var(--accent)' }}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
