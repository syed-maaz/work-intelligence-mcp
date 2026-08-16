import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, description, className }: EmptyStateProps) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center py-16 text-center rounded-xl border', className)}
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
        style={{ background: 'var(--bg-3)' }}
      >
        <Icon size={22} style={{ color: 'var(--muted)' }} />
      </div>
      <p className="font-medium text-sm mb-1" style={{ color: 'var(--fg)' }}>{title}</p>
      {description && (
        <p className="text-xs max-w-xs" style={{ color: 'var(--muted)' }}>{description}</p>
      )}
    </div>
  );
}
