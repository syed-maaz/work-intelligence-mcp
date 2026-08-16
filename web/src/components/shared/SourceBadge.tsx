import { cn } from '@/lib/utils';

const SOURCE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  jira:   { bg: '#1e3a5f', color: '#60a5fa', label: 'Jira' },
  teams:  { bg: '#2e1a5e', color: '#a78bfa', label: 'Teams' },
  email:  { bg: '#422006', color: '#fbbf24', label: 'Email' },
  github: { bg: '#1e293b', color: '#94a3b8', label: 'GitHub' },
};

const LIGHT_SOURCE_STYLES: Record<string, { bg: string; color: string }> = {
  jira:   { bg: '#dbeafe', color: '#1d4ed8' },
  teams:  { bg: '#ede9fe', color: '#7c3aed' },
  email:  { bg: '#fef3c7', color: '#b45309' },
  github: { bg: '#f1f5f9', color: '#475569' },
};

interface SourceBadgeProps {
  source: string;
  className?: string;
  size?: 'sm' | 'md';
}

export function SourceBadge({ source, className, size = 'sm' }: SourceBadgeProps) {
  const key = source.toLowerCase();
  const style = SOURCE_STYLES[key] ?? { bg: 'var(--bg-3)', color: 'var(--muted)', label: source };
  const label = style.label ?? source;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded font-mono font-medium',
        size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1',
        className
      )}
      style={{ background: style.bg, color: style.color }}
    >
      {label}
    </span>
  );
}

export { LIGHT_SOURCE_STYLES };
