/**
 * EP-15-2: Alert Feed
 * Pinned strip at top of Dashboard showing what matters right now.
 * Refreshes every 5 minutes. Hidden when no alerts.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { api, type Alert } from '../../lib/api';
import { useUIStore } from '@/store/ui';

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
};

function AlertRow({ alert }: { alert: Alert }) {
  const navigate = useNavigate();
  const sendToChat = useUIStore(s => s.sendToChat);
  const queryClient = useQueryClient();
  const dot = SEVERITY_COLOR[alert.severity] ?? '#6b7280';

  async function handleBrainFeedback(outcome: 'success' | 'failed') {
    if (!alert.decision_id) return;
    try {
      await api.brainLearn({ decision_id: String(alert.decision_id), outcome });
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    } catch {
      // silently ignore — the card stays visible for retry
    }
  }

  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2 hover:bg-[var(--bg-3)] transition-colors border-b last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
    >
      <span
        className="mt-0.5 shrink-0 rounded-full"
        style={{ width: 7, height: 7, background: dot, marginTop: 4 }}
      />
      <div
        className="min-w-0 flex-1 cursor-pointer"
        onClick={() => alert.link && navigate(alert.link)}
      >
        <span className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
          {alert.title}
        </span>
        {alert.body && (
          <span className="text-xs ml-2" style={{ color: 'var(--muted)' }}>
            — {alert.body}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {alert.type === 'brain_decision' && alert.decision_id && (
          <>
            <button
              onClick={() => handleBrainFeedback('success')}
              className="text-[10px] px-1.5 py-0.5 rounded border transition-colors hover:bg-[var(--bg-3)]"
              style={{ color: 'var(--accent)', borderColor: 'var(--border)' }}
              title="This decision was correct"
            >
              👍
            </button>
            <button
              onClick={() => handleBrainFeedback('failed')}
              className="text-[10px] px-1.5 py-0.5 rounded border transition-colors hover:bg-[var(--bg-3)]"
              style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}
              title="This decision was wrong"
            >
              👎
            </button>
          </>
        )}
        {alert.cta && (
          <button
            onClick={() => sendToChat(alert.cta!)}
            className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border transition-colors hover:bg-[var(--bg-3)]"
            style={{ color: 'var(--accent)', borderColor: 'var(--border)' }}
            title="Ask AI about this"
          >
            <Sparkles size={9} />
            Ask AI
          </button>
        )}
        {alert.link && (
          <span className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer" style={{ background: 'var(--bg-3)', color: 'var(--muted)' }}
            onClick={() => navigate(alert.link!)}>
            View →
          </span>
        )}
      </div>
    </div>
  );
}

export function AlertFeed() {
  const { data } = useQuery({
    queryKey: ['alerts'],
    queryFn: () => api.alerts(),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });

  const alerts = data?.alerts ?? [];
  if (alerts.length === 0) return null;

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {alerts.map(alert => (
        <AlertRow key={alert.id} alert={alert} />
      ))}
    </div>
  );
}
