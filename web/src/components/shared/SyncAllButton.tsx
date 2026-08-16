import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';

export function SyncAllButton() {
  const [polling, setPolling] = useState(false);
  const [currentTopic, setCurrentTopic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const handleSync = async () => {
    if (polling) return;
    setError(null);
    try {
      await api.syncAll();
      setPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    }
  };

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      try {
        const progress = await api.syncStatus();
        setCurrentTopic(progress.currentTopic);
        if (!progress.running) {
          clearInterval(id);
          setPolling(false);
          setCurrentTopic(null);
          qc.invalidateQueries();
          if (progress.error) {
            setError(progress.error);
          }
        }
      } catch {
        clearInterval(id);
        setPolling(false);
      }
    }, 2000);
    return () => clearInterval(id);
  }, [polling, qc]);

  return (
    <div className="flex items-center gap-3">
      {polling && (
        <span className="text-xs animate-pulse" style={{ color: 'var(--muted)' }}>
          Syncing{currentTopic ? ` ${currentTopic}` : ''}…
        </span>
      )}
      {error && (
        <span className="text-xs" style={{ color: '#f87171' }}>
          {error}
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={handleSync}
        disabled={polling}
        loading={polling}
      >
        <RefreshCw size={13} />
        Sync All
      </Button>
    </div>
  );
}
