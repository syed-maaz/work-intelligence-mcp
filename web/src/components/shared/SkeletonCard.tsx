import { cn } from '@/lib/utils';

interface SkeletonCardProps {
  lines?: number;
  className?: string;
}

export function SkeletonCard({ lines = 4, className }: SkeletonCardProps) {
  return (
    <div
      className={cn('rounded-xl border p-5 space-y-3', className)}
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      <div className="skeleton h-4 w-2/5" />
      {Array.from({ length: lines - 1 }).map((_, i) => (
        <div key={i} className={cn('skeleton h-3', i % 3 === 0 ? 'w-full' : i % 3 === 1 ? 'w-4/5' : 'w-3/5')} />
      ))}
    </div>
  );
}

export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-3 py-3', className)}>
      <div className="skeleton h-3 w-16 shrink-0" />
      <div className="skeleton h-3 flex-1" />
      <div className="skeleton h-3 w-24 shrink-0" />
    </div>
  );
}
