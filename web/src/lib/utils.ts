import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow, format } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelative(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return ts;
  }
}

export function formatDate(ts: string | null | undefined, fmt = 'MMM d, yyyy'): string {
  if (!ts) return '—';
  try {
    return format(new Date(ts), fmt);
  } catch {
    return ts;
  }
}

export function truncate(s: string, n = 120): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    jira: 'Jira',
    teams: 'Teams',
    email: 'Email',
    github: 'GitHub',
  };
  return map[source] ?? source;
}
