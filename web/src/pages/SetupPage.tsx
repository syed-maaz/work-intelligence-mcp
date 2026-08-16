/**
 * First-run setup wizard.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { CheckCircle2, Circle, XCircle, AlertCircle, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui';

interface SetupStep {
  id: string;
  title: string;
  description: string;
  ok: boolean;
  action?: string;
  href?: string;
}

export default function SetupPage() {
  const { data: status, isLoading } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
  });

  const { data: connectorsData, isLoading: connectorsLoading, error: connectorsError } = useQuery({
    queryKey: ['connectors'],
    queryFn: api.connectors,
    retry: 1,
  });

  const configuredMap = connectorsData?.configured ?? {};
  const connectors = Object.entries(configuredMap).map(([name, c]) => ({ ...c, name }));
  const connectorsReachable = !connectorsError;
  const connectorsReady =
    connectorsReachable && connectors.length > 0 && connectors.some((c) => c.enabled && c.hasRequiredEnv);

  const steps: SetupStep[] = [
    {
      id: 'anthropic',
      title: 'Anthropic API key',
      description: 'Required in .env as ANTHROPIC_API_KEY for brain, digest, and analysis.',
      ok: !!status?.anthropicConnected,
      action: 'Add to .env and restart the bridge',
    },
    {
      id: 'browser',
      title: 'Browser profile (Teams / Outlook / Jira browser mode)',
      description: 'Set BROWSER_PROFILE_PATH from chrome://version → Profile Path. macOS recommended for calendar + Outlook watchers.',
      ok: !!status?.browserConnected,
      action: 'Copy Profile Path into .env',
    },
    {
      id: 'github',
      title: 'GitHub token',
      description: 'GITHUB_TOKEN for PR review and wi_pr_* tools.',
      ok: !!status?.githubConnected,
      action: 'Add GITHUB_TOKEN to .env',
    },
    {
      id: 'connectors',
      title: 'Connectors',
      description: 'Fetch sources (Jira, GitHub, Slack, Linear, Teams, Outlook…) sync raw data into SQLite. All disabled by default.',
      ok: connectorsReady,
      action: 'Edit wi.config.json → connectors.<name>.enabled: true and set the env vars listed in CONNECTORS.md',
    },
    {
      id: 'jira-mcp',
      title: 'Jira MCP OAuth',
      description:
        'One-time: npm run mcp-setup -- --name jira --url https://jira.example.com/mcp — your Jira MCP endpoint (see CONNECTORS.md).',
      ok: false,
      action: 'Run mcp-setup in terminal (tokens stored in SQLite)',
    },
    {
      id: 'data',
      title: 'Initial sync',
      description: 'Run teams-sync and open Jira Report once to populate SQLite.',
      ok: (status?.messages ?? 0) > 0,
      action: 'npm run teams-sync · open Jira Report',
      href: '/jira-report',
    },
  ];

  const doneCount = steps.filter((s) => s.ok).length;
  const allCore = steps.slice(0, 3).every((s) => s.ok);

  return (
    <div className="max-w-lg space-y-5 animate-fade-in">
      <div>
        <h1 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Setup</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
          {isLoading ? 'Checking configuration…' : `${doneCount} / ${steps.length} steps complete`}
        </p>
      </div>

      <div className="space-y-2">
        {steps.map((step) => (
          <div
            key={step.id}
            className="rounded-xl border px-4 py-3 flex gap-3"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
          >
            {step.ok ? (
              <CheckCircle2 size={18} className="shrink-0 text-emerald-500 mt-0.5" />
            ) : (
              <Circle size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--muted)' }} />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{step.title}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--fg-2)' }}>{step.description}</p>

              {step.id === 'connectors' && (
                connectorsLoading ? (
                  <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>Checking connector registry…</p>
                ) : !connectorsReachable ? (
                  <p className="text-[11px] mt-2 flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                    <AlertCircle size={12} className="shrink-0" />
                    connector registry not reachable (GET /api/connectors unavailable)
                  </p>
                ) : connectors.length === 0 ? (
                  <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>No connectors registered.</p>
                ) : (
                  <>
                    <div className="mt-2 space-y-1">
                      {connectors.map((c) => (
                        <div key={c.name} className="flex items-center gap-2 text-[11px]">
                          <span className="min-w-0 flex-1 font-medium truncate" style={{ color: 'var(--fg)' }}>{c.name}</span>
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px]"
                            style={{ border: '1px solid var(--border)', color: 'var(--fg-2)' }}
                          >
                            {c.mode}
                          </span>
                          <span className="flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
                            {c.enabled
                              ? <CheckCircle2 size={12} className="text-emerald-500" />
                              : <XCircle size={12} style={{ color: 'var(--muted)' }} />}
                            enabled
                          </span>
                          <span className="flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
                            {c.hasRequiredEnv
                              ? <CheckCircle2 size={12} className="text-emerald-500" />
                              : <XCircle size={12} className="text-amber-500" />}
                            env
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] mt-2" style={{ color: 'var(--muted)' }}>
                      Edit wi.config.json → connectors.&lt;name&gt;.enabled: true and set the env vars listed in CONNECTORS.md.
                    </p>
                  </>
                )
              )}

              {!step.ok && step.action && (
                <p className="text-[11px] mt-2 font-medium" style={{ color: 'var(--accent)' }}>{step.action}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {!allCore && (
        <div
          className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'color-mix(in srgb, #f59e0b 12%, transparent)', color: '#92400e' }}
        >
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          Core steps (API key + browser + GitHub) must be green before live fetch tools work reliably.
        </div>
      )}

      <div className="flex gap-2">
        <Link to="/">
          <Button size="sm">
            Open chat
            <ArrowRight size={12} className="ml-1" />
          </Button>
        </Link>
        <Link to="/system-health">
          <Button variant="ghost" size="sm">System health</Button>
        </Link>
      </div>

      <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
        Full guide: GETTING-STARTED.md in the repo root. Calendar and Outlook watchers require macOS.
      </p>
    </div>
  );
}
