import { cn } from '@/lib/utils';
import { forwardRef } from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, children, disabled, ...props }, ref) => {
    const base = 'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 ring-offset-1';

    const variants = {
      primary: 'bg-accent text-white hover:bg-[var(--accent-2)]',
      secondary: 'border hover:bg-[var(--bg-3)]',
      ghost: 'hover:bg-[var(--bg-3)]',
      danger: 'bg-red-600 text-white hover:bg-red-700',
    };

    const sizes = {
      sm: 'text-xs px-2.5 py-1.5 h-7',
      md: 'text-sm px-3.5 py-2 h-9',
      lg: 'text-sm px-4 py-2.5 h-11',
    };

    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        disabled={disabled || loading}
        style={variant === 'secondary' || variant === 'ghost'
          ? { borderColor: 'var(--border)', color: 'var(--fg)' }
          : undefined}
        {...props}
      >
        {loading && (
          <svg className="animate-spin -ml-1" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { label?: string }>(
  ({ className, label, id, ...props }, ref) => (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-xs font-medium" style={{ color: 'var(--fg-2)' }}>
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={id}
        className={cn(
          'w-full rounded-lg px-3 py-2 text-sm border transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 placeholder:text-[var(--muted)]',
          className
        )}
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        {...props}
      />
    </div>
  )
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }>(
  ({ className, label, id, ...props }, ref) => (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-xs font-medium" style={{ color: 'var(--fg-2)' }}>
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={id}
        className={cn(
          'w-full rounded-lg px-3 py-2 text-sm border transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 placeholder:text-[var(--muted)] resize-y',
          className
        )}
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        {...props}
      />
    </div>
  )
);
Textarea.displayName = 'Textarea';

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn('rounded-xl border', className)}
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {children}
    </div>
  );
}

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}

const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  default: { bg: 'var(--bg-3)', color: 'var(--muted)' },
  success: { bg: '#064e3b', color: '#34d399' },
  warning: { bg: '#451a03', color: '#fbbf24' },
  danger:  { bg: '#450a0a', color: '#f87171' },
  info:    { bg: '#1e3a5f', color: '#60a5fa' },
};

export function Badge({ children, variant = 'default', className }: BadgeProps) {
  const s = BADGE_STYLES[variant];
  return (
    <span
      className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium font-mono', className)}
      style={{ background: s.bg, color: s.color }}
    >
      {children}
    </span>
  );
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: { value: string; label: string }[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, id, options, className, ...props }, ref) => (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-xs font-medium" style={{ color: 'var(--fg-2)' }}>
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={id}
        className={cn(
          'w-full rounded-lg px-3 py-2 text-sm border transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40 cursor-pointer',
          className
        )}
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
);
Select.displayName = 'Select';

interface TabsProps {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div
      className={cn('flex items-center gap-1 p-1 rounded-lg', className)}
      style={{ background: 'var(--bg-3)' }}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'flex-1 text-xs font-medium px-3 py-1.5 rounded-md transition-colors',
            active === t.key ? 'bg-accent text-white shadow-sm' : 'hover:bg-[var(--bg-2)]'
          )}
          style={{ color: active === t.key ? 'white' : 'var(--fg-2)' }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
