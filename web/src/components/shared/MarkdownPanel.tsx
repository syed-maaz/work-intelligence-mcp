import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MD_COMPONENTS } from '@/lib/linkify'; // U-10 phase 1.5
import { Copy, Check, AlignLeft, Code2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MarkdownPanelProps {
  content: string;
  isLoading?: boolean;
  error?: string | null;
  title?: string;
  className?: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <button
      onClick={copy}
      title="Copy to clipboard"
      className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors hover:bg-[var(--bg-3)]"
      style={{ color: 'var(--muted)' }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export function MarkdownPanel({ content, isLoading, error, title, className }: MarkdownPanelProps) {
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');

  if (isLoading) {
    return (
      <div
        className={cn('rounded-xl border p-5 space-y-3', className)}
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <div className="skeleton h-4 w-2/5" />
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-4/5" />
        <div className="skeleton h-3 w-3/5" />
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-2/3" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn('rounded-xl border p-5 text-sm', className)}
        style={{ background: 'var(--bg-2)', borderColor: 'var(--danger)', color: 'var(--danger)' }}
      >
        <strong className="block mb-1">Error</strong>
        <span style={{ color: 'var(--fg-2)' }}>{error}</span>
      </div>
    );
  }

  if (!content) return null;

  return (
    <div
      className={cn('rounded-xl border overflow-hidden', className)}
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        {title ? (
          <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{title}</span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          <CopyButton text={content} />
          <div
            className="flex items-center rounded-lg overflow-hidden border"
            style={{ borderColor: 'var(--border)' }}
          >
            <button
              onClick={() => setView('rendered')}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 text-xs transition-colors',
                view === 'rendered' ? 'bg-accent text-white' : 'hover:bg-[var(--bg-3)]'
              )}
              style={{ color: view === 'rendered' ? 'white' : 'var(--muted)' }}
            >
              <AlignLeft size={11} />
              <span>Rendered</span>
            </button>
            <button
              onClick={() => setView('raw')}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 text-xs transition-colors',
                view === 'raw' ? 'bg-accent text-white' : 'hover:bg-[var(--bg-3)]'
              )}
              style={{ color: view === 'raw' ? 'white' : 'var(--muted)' }}
            >
              <Code2 size={11} />
              <span>Raw</span>
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3 overflow-x-auto">
        {view === 'rendered' ? (
          <div className="prose-wi">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</ReactMarkdown>
          </div>
        ) : (
          <pre
            className="text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap font-mono"
            style={{ color: 'var(--fg)', fontFamily: 'DM Mono, monospace' }}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
