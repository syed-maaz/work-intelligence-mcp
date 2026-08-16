import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MD_COMPONENTS } from '@/lib/linkify'; // U-10 phase 1.5
import { StaleBanner } from './StaleBanner'; // U-14
import { ChevronDown, ChevronRight, RefreshCw, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

function AccordionSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b last:border-b-0" style={{ borderColor: 'var(--border)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full px-4 py-2 text-xs font-semibold text-left hover:bg-[var(--bg-3)] transition-colors"
        style={{ color: 'var(--fg)' }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && (
        <div className="px-4 pb-3 text-xs prose-wi" style={{ color: 'var(--fg-2)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function SkeletonSummary() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="skeleton h-2.5 w-1/3" />
      <div className="skeleton h-2.5 w-full" />
      <div className="skeleton h-2.5 w-4/5" />
    </div>
  );
}

function GeneratingIndicator() {
  return (
    <div className="flex items-center gap-2 p-4 text-xs" style={{ color: 'var(--muted)' }}>
      <RefreshCw size={12} className="animate-spin" />
      <span>Generating your daily summary…</span>
    </div>
  );
}

export function DailySummarySection() {
  const [refresh, setRefresh] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['daily-summary'],
    queryFn: () => api.dailySummary({ refresh }),
    staleTime: 3_600_000, // 1 hour — don't re-fetch on navigation
    refetchOnWindowFocus: false,
  });

  async function handleRefresh() {
    setIsRefreshing(true);
    setRefresh(true);
    await refetch();
    setRefresh(false);
    setIsRefreshing(false);
  }

  const generatedAt = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
    >
      {/* Header */}
      <div
        className="px-4 py-2 border-b flex items-center justify-between"
        style={{ borderColor: 'var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            Daily Summary
          </h2>
          {generatedAt && (
            <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--muted)' }}>
              <Clock size={9} />
              {data?.cached ? 'cached' : 'generated'} {generatedAt}
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing || isFetching}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors',
            'hover:bg-[var(--bg-3)] disabled:opacity-50 disabled:cursor-not-allowed'
          )}
          style={{ color: 'var(--muted)' }}
          title="Regenerate summary"
        >
          <RefreshCw size={12} className={cn(isRefreshing && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Content */}
      {isLoading && !data ? (
        <SkeletonSummary />
      ) : isFetching && isRefreshing ? (
        <GeneratingIndicator />
      ) : error ? (
        <div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>
          Failed to generate daily summary: {(error as Error).message}
        </div>
      ) : data?.markdown ? (
        <div>
          {/* U-14: surface staleness if backend marked it cached/stale */}
          <div className="px-4 pt-3">
            <StaleBanner
              stale={(data as { stale?: boolean }).stale}
              reason={(data as { stale_reason?: string }).stale_reason}
              cachedAt={(data as { cached_at?: string | number }).cached_at}
            />
          </div>
          <DailySummaryContent markdown={data.markdown} />
        </div>
      ) : (
        <div className="p-4 text-xs" style={{ color: 'var(--muted)' }}>
          No summary available yet.
        </div>
      )}
    </div>
  );
}

function DailySummaryContent({ markdown }: { markdown: string }) {
  // Split the markdown into sections by ## headings to render in accordions
  const sections = parseSections(markdown);

  if (sections.items.length === 0 && !sections.preamble) {
    return (
      <div className="p-4 text-xs prose-wi" style={{ color: 'var(--fg-2)' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{markdown}</ReactMarkdown>
      </div>
    );
  }

  // Render the header (everything before the first ##) and then sections
  const { preamble, items } = sections;

  return (
    <div>
      {preamble && (
        <div className="px-4 py-3 border-b text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{preamble}</ReactMarkdown>
        </div>
      )}
      {items.map((sec, i) => (
        <AccordionSection key={i} title={sec.title} defaultOpen={true}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{sec.body}</ReactMarkdown>
        </AccordionSection>
      ))}
    </div>
  );
}

interface ParsedSection { title: string; body: string; }
interface ParseResult { preamble: string; items: ParsedSection[]; }

function parseSections(md: string): ParseResult {
  const lines = md.split('\n');
  const items: ParsedSection[] = [];
  let preamble = '';
  let current: ParsedSection | null = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      if (current) items.push(current);
      current = { title: heading[1].trim(), body: '' };
    } else if (current) {
      current.body += line + '\n';
    } else {
      preamble += line + '\n';
    }
  }
  if (current) items.push(current);

  return { preamble: preamble.trim(), items };
}
