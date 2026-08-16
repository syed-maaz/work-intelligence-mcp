import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  GitPullRequest, RefreshCw, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle, Info, Bell, BellOff,
  GitCommit, FileCode, AlertCircle, ExternalLink, BookOpen,
} from 'lucide-react';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import { MD_COMPONENTS } from '@/lib/linkify'; // U-10 phase 1.5
import { api } from '@/lib/api';
import type { GithubPR, PRReview, PRCommitsResponse, PRFileImpact, PRWorkContextSummary } from '@/lib/api';

const REPOS = ['example-service', 'example-service'];

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function riskBadge(level: 'low' | 'medium' | 'high') {
  const map = {
    low:    { label: 'Low Risk',    color: '#10b981', bg: '#10b98118', Icon: CheckCircle },
    medium: { label: 'Medium Risk', color: '#f59e0b', bg: '#f59e0b18', Icon: AlertTriangle },
    high:   { label: 'High Risk',   color: 'var(--danger)', bg: '#ef444418', Icon: AlertTriangle },
  };
  const { label, color, bg, Icon } = map[level] ?? map.low;
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded font-medium"
      style={{ background: bg, color }}>
      <Icon size={10} /> {label}
    </span>
  );
}

function changeTypeDot(t: string) {
  const map: Record<string, string> = { ADDED: '#10b981', MODIFIED: '#f59e0b', DELETED: 'var(--danger)', RENAMED: '#8b5cf6' };
  return <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 inline-block" style={{ background: map[t] ?? 'var(--muted)' }} />;
}

// ── Impact Panel ────────────────────────────────────────────────────────────

function ImpactPanel({ data }: { data: PRCommitsResponse }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="rounded-xl border" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      {/* Header */}
      <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
        <FileCode size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Code Impact</span>
        <span className="text-xs px-1.5 py-0.5 rounded ml-1"
          style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>
          {data.files.length} files changed
        </span>
        {data.totalImpactedFiles > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: data.crossRepoImpact ? '#ef444418' : '#f59e0b18',
                     color: data.crossRepoImpact ? 'var(--danger)' : '#f59e0b' }}>
            {data.totalImpactedFiles} downstream {data.crossRepoImpact ? '⚠ cross-repo' : ''}
          </span>
        )}
      </div>

      {/* Commits */}
      <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--fg-2)' }}>
          <GitCommit size={10} className="inline mr-1" />Commits ({data.commits.length})
        </p>
        <div className="space-y-1">
          {data.commits.map(c => (
            <div key={c.oid} className="flex items-start gap-2">
              <span className="text-xs font-mono mt-0.5 flex-shrink-0"
                style={{ color: 'var(--accent)' }}>{c.oid.slice(0, 7)}</span>
              <div className="min-w-0">
                <p className="text-xs truncate" style={{ color: 'var(--fg)' }}>{c.messageHeadline}</p>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  {c.authors[0]?.login ?? ''} · {relativeTime(c.authoredDate)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Files + blast radius */}
      <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
        {data.files.map((f: PRFileImpact) => (
          <div key={f.path}>
            <div
              className="px-3 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-[var(--bg-3)]"
              onClick={() => setExpanded(expanded === f.path ? null : f.path)}
            >
              {changeTypeDot(f.changeType)}
              <span className="text-xs font-mono truncate flex-1" style={{ color: 'var(--fg)' }}>
                {f.path.split('/').slice(-1)[0]}
              </span>
              <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)' }}>
                +{f.additions}/−{f.deletions}
              </span>
              {f.blastRadius.length > 0 && (
                <span className="text-xs px-1 rounded flex-shrink-0"
                  style={{ background: '#f59e0b18', color: '#f59e0b' }}>
                  {f.blastRadius.length} deps
                </span>
              )}
              {expanded === f.path
                ? <ChevronDown size={10} style={{ color: 'var(--muted)' }} />
                : <ChevronRight size={10} style={{ color: 'var(--muted)' }} />}
            </div>

            {expanded === f.path && (
              <div className="px-4 pb-2">
                <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>
                  {f.path}
                </p>
                {f.blastRadius.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>No downstream dependencies found.</p>
                ) : (
                  <div className="space-y-0.5">
                    {f.blastRadius.map((n, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="w-1 h-1 rounded-full flex-shrink-0"
                          style={{ background: n.ref_type === 'test_covers' ? '#10b981' : 'var(--accent)' }} />
                        <span className="font-mono truncate" style={{ color: 'var(--fg-2)' }}>
                          {n.repo !== data.repo && (
                            <span className="mr-1 px-1 rounded text-xs"
                              style={{ background: '#ef444418', color: 'var(--danger)' }}>
                              {n.repo}
                            </span>
                          )}
                          {n.file_path.split('/').slice(-1)[0]}
                        </span>
                        <span className="flex-shrink-0" style={{ color: 'var(--muted)' }}>
                          {n.ref_type} · d{n.depth}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Review Card ──────────────────────────────────────────────────────────────

function ReviewCard({ review, prNum, repo }: { review: PRReview; prNum: number; repo: string }) {
  const [tab, setTab] = useState<'summary' | 'body'>('summary');
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [postedUrl, setPostedUrl] = useState('');
  const [postError, setPostError] = useState('');

  const handlePost = async () => {
    // OP-2 / U-5: confirmation gate before posting a real GitHub review
    const ok = window.confirm(
      `Post AI review to ${repo} PR #${prNum}? This will publish a comment on the real GitHub PR.`,
    );
    if (!ok) return;
    setPosting(true);
    setPostError('');
    try {
      const result = await api.postPRReview({ repo, pr: prNum, body: review.markdownBody, execute: true });
      setPostedUrl(result.url ?? '');
      setPosted(true);
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Failed to post review');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="rounded-xl border" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 flex items-center gap-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>AI Review — #{prNum}</span>
        {riskBadge(review.riskLevel)}
        <span className="text-xs ml-auto" style={{ color: 'var(--muted)' }}>{repo}</span>
      </div>
      <div className="flex gap-1 px-3 pt-2">
        {(['summary', 'body'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="text-xs px-2 py-1 rounded"
            style={{ background: tab === t ? 'var(--accent)' : 'transparent', color: tab === t ? '#fff' : 'var(--fg-2)' }}>
            {t === 'summary' ? 'Summary' : 'Full Review'}
          </button>
        ))}
      </div>
      {tab === 'summary' ? (
        <div className="px-3 py-2 space-y-3 text-xs" style={{ color: 'var(--fg)' }}>
          <div><p className="font-semibold mb-0.5" style={{ color: 'var(--fg-2)' }}>Risk Reason</p><p>{review.riskReason}</p></div>
          <div><p className="font-semibold mb-0.5" style={{ color: 'var(--fg-2)' }}>Work Context</p><p>{review.workContextSummary}</p></div>
          <div><p className="font-semibold mb-0.5" style={{ color: 'var(--fg-2)' }}>Test Coverage</p><p>{review.testCoverageSummary}</p></div>
          {review.crossRepoImpact.length > 0 && (
            <div>
              <p className="font-semibold mb-0.5" style={{ color: 'var(--fg-2)' }}>Cross-Repo Impact</p>
              <ul className="list-disc ml-4">{review.crossRepoImpact.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
          {review.missingTests.length > 0 && (
            <div>
              <p className="font-semibold mb-0.5" style={{ color: 'var(--danger)' }}>Missing Tests</p>
              <ul className="list-disc ml-4">{review.missingTests.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}
          {review.suggestedReviewers.length > 0 && (
            <div>
              <p className="font-semibold mb-0.5" style={{ color: 'var(--fg-2)' }}>Suggested Reviewers</p>
              <p>{review.suggestedReviewers.join(', ')}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-2 prose prose-sm max-w-none text-xs" style={{ color: 'var(--fg)' }}>
          <ReactMarkdown components={MD_COMPONENTS}>{review.markdownBody}</ReactMarkdown>
        </div>
      )}
      <div className="px-3 py-2 border-t flex items-center gap-3" style={{ borderColor: 'var(--border)' }}>
        <button
          onClick={handlePost}
          disabled={posting || posted}
          className="text-xs px-3 py-1.5 rounded font-medium"
          style={{ background: posted ? 'var(--bg-3)' : 'var(--accent)', color: posted ? 'var(--muted)' : '#fff', opacity: posting ? 0.7 : 1 }}
        >
          {posting ? 'Posting…' : posted ? '✓ Posted to GitHub' : 'Post to GitHub'}
        </button>
        {posted && postedUrl && (
          <a href={postedUrl} target="_blank" rel="noreferrer" className="text-xs" style={{ color: 'var(--accent)' }}>
            View on GitHub →
          </a>
        )}
        {postError && <span className="text-xs" style={{ color: 'var(--danger)' }}>{postError}</span>}
      </div>
    </div>
  );
}

function EnrichCard({ description }: { description: string }) {
  return (
    <div className="rounded-xl border" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}>
        <Info size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>AI-Generated PR Description</span>
        <button className="ml-auto text-xs px-2 py-0.5 rounded"
          style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}
          onClick={() => { navigator.clipboard.writeText(description); toast.success('Copied!'); }}>
          Copy
        </button>
      </div>
      <div className="px-3 py-2 prose prose-sm max-w-none text-xs" style={{ color: 'var(--fg)' }}>
        <ReactMarkdown components={MD_COMPONENTS}>{description}</ReactMarkdown>
      </div>
    </div>
  );
}

// ── Work Context Card ────────────────────────────────────────────────────────

function WorkContextCard({ ctx }: { ctx: PRWorkContextSummary }) {
  const [open, setOpen] = useState(false);
  const hasData = ctx.relatedMeetings.length > 0 || ctx.openActionItems.length > 0 || ctx.ticketLearnings.length > 0 || ctx.teamsCount > 0;

  return (
    <div className="rounded-xl border" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
      <div className="px-3 py-2 flex items-center gap-2 cursor-pointer" onClick={() => setOpen(v => !v)}>
        <BookOpen size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>Work Context Used</span>
        <div className="flex gap-1 ml-2 flex-wrap">
          {ctx.teamsCount > 0 && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>{ctx.teamsCount} msgs</span>}
          {ctx.relatedMeetings.length > 0 && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>{ctx.relatedMeetings.length} meetings</span>}
          {ctx.openActionItems.length > 0 && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#f59e0b18', color: '#f59e0b' }}>{ctx.openActionItems.length} open tasks</span>}
          {ctx.ticketLearnings.length > 0 && <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#10b98118', color: '#10b981' }}>{ctx.ticketLearnings.length} learnings</span>}
          {!hasData && <span className="text-xs" style={{ color: 'var(--muted)' }}>No context found in DB</span>}
        </div>
        <span className="ml-auto" style={{ color: 'var(--muted)' }}>{open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t" style={{ borderColor: 'var(--border)' }}>
          {ctx.relatedMeetings.length > 0 && (
            <div className="pt-2">
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--fg-2)' }}>Related Meetings</p>
              {ctx.relatedMeetings.map((m, i) => (
                <div key={i} className="text-xs mb-1 pl-2 border-l-2" style={{ borderColor: 'var(--accent)', color: 'var(--fg)' }}>
                  <span className="font-medium">{m.title}</span> <span style={{ color: 'var(--muted)' }}>{m.date}</span>
                  {m.summary && <p style={{ color: 'var(--fg-2)' }}>{m.summary.slice(0, 120)}</p>}
                  {m.decisions && <p style={{ color: '#f59e0b' }}>Decision: {m.decisions.slice(0, 100)}</p>}
                </div>
              ))}
            </div>
          )}
          {ctx.openActionItems.length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--fg-2)' }}>Open Action Items</p>
              {ctx.openActionItems.map((a, i) => (
                <div key={i} className="text-xs flex gap-2 mb-0.5">
                  <span style={{ color: '#f59e0b' }}>●</span>
                  <span style={{ color: 'var(--fg)' }}>{a.content.slice(0, 100)}</span>
                  {a.assignee && <span style={{ color: 'var(--muted)' }}>({a.assignee})</span>}
                </div>
              ))}
            </div>
          )}
          {ctx.ticketLearnings.length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--fg-2)' }}>Ticket Learnings</p>
              {ctx.ticketLearnings.map((l, i) => (
                <div key={i} className="text-xs mb-1 pl-2 border-l-2" style={{ borderColor: '#10b981', color: 'var(--fg)' }}>
                  <p>{l.solution.slice(0, 150)}</p>
                  {l.traps && <p style={{ color: 'var(--danger)' }}>Watch: {l.traps.slice(0, 100)}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export function PRReviewPage() {
  const [repo, setRepo] = useState('example-service');
  const [stateFilter, setStateFilter] = useState<'open' | 'closed' | 'merged'>('open');
  const [search, setSearch] = useState('');
  const [prNumJump, setPrNumJump] = useState('');
  const [selectedPR, setSelectedPR] = useState<GithubPR | null>(null);
  const [reviewData, setReviewData] = useState<{ review: PRReview; blastRadius: unknown[]; workContext: PRWorkContextSummary | null; cached: boolean; cachedAt?: string } | null>(null);
  const [enrichDesc, setEnrichDesc] = useState<string | null>(null);
  const [followed, setFollowed] = useState<Record<string, number[]>>({});
  const [followLoaded, setFollowLoaded] = useState(false);
  // tracks last-known commit count per "repo:prNum" key for change detection
  const commitCountRef = useRef<Record<string, number>>({});

  // On mount: load DB state for all repos, then migrate any localStorage entries
  useEffect(() => {
    const LEGACY_KEY = 'pr-followed';
    async function loadAndMigrate() {
      const results = await Promise.all(
        REPOS.map(r => api.getWatchedPRs(r).then(d => ({ [r]: d.prs })).catch(() => ({ [r]: [] as number[] })))
      );
      const dbState = Object.assign({}, ...results) as Record<string, number[]>;
      try {
        const raw = localStorage.getItem(LEGACY_KEY);
        if (raw) {
          const local = JSON.parse(raw) as Record<string, number[]>;
          for (const [r, nums] of Object.entries(local)) {
            for (const n of nums) {
              await api.watchPR(r, n).catch(() => {});
              if (!dbState[r]) dbState[r] = [];
              if (!dbState[r].includes(n)) dbState[r].push(n);
            }
          }
          localStorage.removeItem(LEGACY_KEY);
        }
      } catch { /* ignore */ }
      setFollowed(dbState);
      setFollowLoaded(true);
    }
    loadAndMigrate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const followedForRepo = followed[repo] ?? [];

  // ── Queries ──────────────────────────────────────────────────────────────

  const prsQuery = useQuery({
    queryKey: ['pr-list', repo, stateFilter],
    queryFn: () => api.listPRs(repo, stateFilter),
  });

  // Poll commits for all followed PRs every 60s while page is open
  const followedCommitsQuery = useQuery({
    queryKey: ['pr-followed-commits', repo, followedForRepo.join(',')],
    queryFn: async () => {
      if (followedForRepo.length === 0) return {};
      const results = await Promise.all(
        followedForRepo.map(n => api.prCommits(repo, n).then(d => ({ [n]: d })).catch(() => ({ [n]: null })))
      );
      return Object.assign({}, ...results) as Record<number, PRCommitsResponse | null>;
    },
    refetchInterval: 60_000,
    enabled: followedForRepo.length > 0,
  });

  // Detect new commits on followed PRs and toast
  useEffect(() => {
    const data = followedCommitsQuery.data;
    if (!data) return;
    for (const [numStr, commits] of Object.entries(data)) {
      if (!commits) continue;
      const key = `${repo}:${numStr}`;
      const prev = commitCountRef.current[key];
      const curr = commits.commits.length;
      if (prev !== undefined && curr > prev) {
        toast.info(`PR #${numStr} — ${curr - prev} new commit${curr - prev > 1 ? 's' : ''}`, { duration: 6000 });
      }
      commitCountRef.current[key] = curr;
    }
  }, [followedCommitsQuery.data, repo]);

  // Per-selected-PR impact query (only when following or explicitly triggered)
  const [showImpact, setShowImpact] = useState(false);
  const impactQuery = useQuery({
    queryKey: ['pr-commits', repo, selectedPR?.number],
    queryFn: () => api.prCommits(repo, selectedPR!.number),
    enabled: !!selectedPR && showImpact,
  });

  const reviewMutation = useMutation({
    mutationFn: ({ prNum, force }: { prNum: number; force?: boolean }) => api.reviewPR(repo, prNum, force),
    onSuccess: (data) => setReviewData(data),
    onError: (e: Error) => toast.error(e.message),
  });

  const enrichMutation = useMutation({
    mutationFn: (prNum: number) => api.enrichPR(repo, prNum),
    onSuccess: (data) => setEnrichDesc(data.description),
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const toggleFollow = async (pr: GithubPR) => {
    const cur = followed[repo] ?? [];
    const isFollowed = cur.includes(pr.number);
    if (isFollowed) {
      await api.unwatchPR(repo, pr.number).catch(() => {});
      setFollowed(prev => ({ ...prev, [repo]: (prev[repo] ?? []).filter(n => n !== pr.number) }));
      toast.success(`Unfollowed PR #${pr.number}`);
    } else {
      await api.watchPR(repo, pr.number).catch(() => {});
      setFollowed(prev => ({ ...prev, [repo]: [...(prev[repo] ?? []), pr.number] }));
      toast.success(`Following PR #${pr.number}`);
    }
  };

  const handleSelectPR = (pr: GithubPR) => {
    setSelectedPR(pr);
    setReviewData(null);
    setEnrichDesc(null);
    setShowImpact(false);
  };

  const handleRepoChange = (r: string) => {
    setRepo(r);
    setSelectedPR(null);
    setReviewData(null);
    setEnrichDesc(null);
    setShowImpact(false);
    setSearch('');
    setPrNumJump('');
  };

  // ── Filtering ────────────────────────────────────────────────────────────

  const allPRs: GithubPR[] = prsQuery.data?.prs ?? [];

  const filteredPRs = allPRs.filter(pr => {
    if (prNumJump.trim()) return String(pr.number).includes(prNumJump.trim());
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      pr.title.toLowerCase().includes(q) ||
      (pr.author?.login ?? '').toLowerCase().includes(q) ||
      String(pr.number).includes(q)
    );
  });

  const isFollowed = selectedPR ? followedForRepo.includes(selectedPR.number) : false;
  const followedImpact = selectedPR ? followedCommitsQuery.data?.[selectedPR.number] : null;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--border)' }}>
        <GitPullRequest size={12} style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>PR Intelligence</span>

        {/* Repo tabs */}
        <div className="flex items-center gap-1 ml-3">
          {REPOS.map(r => (
            <button key={r} onClick={() => handleRepoChange(r)}
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: repo === r ? 'var(--accent)' : 'var(--bg-3)', color: repo === r ? '#fff' : 'var(--fg-2)' }}>
              {r}
            </button>
          ))}
        </div>

        {/* State filter */}
        <div className="flex items-center gap-0.5 ml-2">
          {(['open', 'closed', 'merged'] as const).map(s => (
            <button key={s} onClick={() => setStateFilter(s)}
              className="text-xs px-2 py-0.5 rounded capitalize"
              style={{ background: stateFilter === s ? 'var(--bg-3)' : 'transparent',
                       color: stateFilter === s ? 'var(--fg)' : 'var(--muted)',
                       fontWeight: stateFilter === s ? 600 : 400 }}>
              {s}
            </button>
          ))}
        </div>

        {followedForRepo.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded ml-1"
            style={{ background: 'var(--accent)', color: '#fff' }}>
            {followedForRepo.length} followed
          </span>
        )}

        <button onClick={() => prsQuery.refetch()} className="ml-auto p-1 rounded" style={{ color: 'var(--muted)' }}>
          <RefreshCw size={12} className={prsQuery.isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* PR list sidebar */}
        <div className="w-72 flex-shrink-0 border-r flex flex-col overflow-hidden"
          style={{ borderColor: 'var(--border)' }}>

          {/* Search + PR# jump */}
          <div className="px-2 py-2 space-y-1.5 border-b flex-shrink-0" style={{ borderColor: 'var(--border)' }}>
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPrNumJump(''); }}
              placeholder="Search by title or author…"
              className="w-full px-2.5 py-1.5 text-xs rounded-lg border"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            />
            <input
              value={prNumJump}
              onChange={e => { setPrNumJump(e.target.value); setSearch(''); }}
              placeholder="Jump to PR #…"
              type="number"
              className="w-full px-2.5 py-1.5 text-xs rounded-lg border"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            />
          </div>

          {/* Followed section */}
          {followedForRepo.length > 0 && (
            <div className="flex-shrink-0 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="px-3 py-1.5 flex items-center gap-1.5">
                <Bell size={10} style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--fg-2)' }}>Followed</span>
              </div>
              {followedForRepo.map(num => {
                const pr = allPRs.find(p => p.number === num);
                const impact = followedCommitsQuery.data?.[num];
                return (
                  <div key={num}
                    className="px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-3)] border-b"
                    style={{ borderColor: 'var(--border)', background: selectedPR?.number === num ? 'var(--bg-3)' : undefined }}
                    onClick={() => pr && handleSelectPR(pr)}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono" style={{ color: 'var(--accent)' }}>#{num}</span>
                      <span className="text-xs truncate flex-1" style={{ color: 'var(--fg)' }}>
                        {pr?.title ?? '…'}
                      </span>
                      {impact && (
                        <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)' }}>
                          {impact.commits.length}c · {impact.files.length}f
                        </span>
                      )}
                      {impact?.crossRepoImpact && (
                        <AlertCircle size={10} style={{ color: 'var(--danger)' }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* All PRs list */}
          <div className="flex-1 overflow-y-auto">
            {prsQuery.isLoading && (
              <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--muted)' }}>Loading…</div>
            )}
            {filteredPRs.map(pr => (
              <div key={pr.number}
                className="px-3 py-2 cursor-pointer hover:bg-[var(--bg-3)] border-b"
                style={{ borderColor: 'var(--border)', background: selectedPR?.number === pr.number ? 'var(--bg-3)' : undefined }}
                onClick={() => handleSelectPR(pr)}>
                <div className="flex items-start gap-2">
                  <ChevronRight size={12} className="mt-0.5 flex-shrink-0"
                    style={{ color: selectedPR?.number === pr.number ? 'var(--accent)' : 'var(--muted)' }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium truncate" style={{ color: 'var(--fg)' }}>
                        #{pr.number} {pr.title}
                      </p>
                      {followedForRepo.includes(pr.number) && (
                        <Bell size={9} className="flex-shrink-0" style={{ color: 'var(--accent)' }} />
                      )}
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                      {pr.author?.login ?? ''} · +{pr.additions ?? 0}/−{pr.deletions ?? 0} · {relativeTime(pr.updatedAt)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
            {!prsQuery.isLoading && filteredPRs.length === 0 && (
              <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--muted)' }}>
                {search || prNumJump ? 'No PRs match filter' : 'No PRs'}
              </div>
            )}
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {!selectedPR && (
            <div className="flex items-center justify-center h-40">
              <p className="text-xs" style={{ color: 'var(--muted)' }}>Select a PR to review</p>
            </div>
          )}

          {selectedPR && (
            <>
              {/* PR header card */}
              <div className="rounded-xl border px-3 py-2"
                style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
                    #{selectedPR.number} {selectedPR.title}
                  </p>
                  <button
                    onClick={() => toggleFollow(selectedPR)}
                    disabled={!followLoaded}
                    className="flex-shrink-0 flex items-center gap-1 text-xs px-2 py-0.5 rounded"
                    style={{
                      background: isFollowed ? 'var(--accent)' : 'var(--bg-3)',
                      color: isFollowed ? '#fff' : 'var(--fg-2)',
                      opacity: followLoaded ? 1 : 0.5,
                    }}>
                    {isFollowed ? <Bell size={10} /> : <BellOff size={10} />}
                    {isFollowed ? 'Following' : 'Follow'}
                  </button>
                </div>
                {selectedPR.body && (
                  <p className="text-xs mt-1 line-clamp-3" style={{ color: 'var(--muted)' }}>
                    {selectedPR.body}
                  </p>
                )}
                <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  {selectedPR.headRefName} → {selectedPR.baseRefName} · {relativeTime(selectedPR.updatedAt)}
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button
                    className="text-xs px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5"
                    style={{ background: 'var(--accent)', color: '#fff' }}
                    onClick={() => { reviewMutation.mutate({ prNum: selectedPR.number }); setEnrichDesc(null); }}
                    disabled={reviewMutation.isPending}>
                    {reviewMutation.isPending
                      ? <RefreshCw size={10} className="animate-spin" />
                      : <GitPullRequest size={10} />}
                    AI Review
                  </button>
                  <button
                    className="text-xs px-2.5 py-1 rounded-lg font-medium"
                    style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}
                    onClick={() => { enrichMutation.mutate(selectedPR.number); setReviewData(null); }}
                    disabled={enrichMutation.isPending}>
                    {enrichMutation.isPending ? 'Generating…' : 'Generate Description'}
                  </button>
                  <button
                    className="text-xs px-2.5 py-1 rounded-lg font-medium flex items-center gap-1.5"
                    style={{ background: showImpact ? 'var(--bg-3)' : 'var(--bg-3)', color: 'var(--fg-2)' }}
                    onClick={() => setShowImpact(v => !v)}>
                    <FileCode size={10} />
                    {showImpact ? 'Hide Impact' : 'Code Impact'}
                  </button>
                  <a href={selectedPR.url} target="_blank" rel="noopener noreferrer"
                    className="text-xs px-2.5 py-1 rounded-lg font-medium ml-auto flex items-center gap-1"
                    style={{ background: 'var(--bg-3)', color: 'var(--fg-2)' }}>
                    <ExternalLink size={10} /> Open PR
                  </a>
                </div>
              </div>

              {/* Followed impact — always shown if followed + data available */}
              {isFollowed && followedImpact && !showImpact && (
                <ImpactPanel data={followedImpact} />
              )}

              {/* Explicit impact panel (Code Impact button) */}
              {showImpact && (
                impactQuery.isLoading
                  ? <div className="text-xs px-3 py-4 text-center" style={{ color: 'var(--muted)' }}>Loading impact…</div>
                  : impactQuery.data
                    ? <ImpactPanel data={impactQuery.data} />
                    : impactQuery.isError
                      ? <div className="text-xs px-3 py-2 rounded-xl border"
                          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--danger)' }}>
                          Failed to load impact data
                        </div>
                      : null
              )}

              {reviewData && reviewData.workContext && (
                <WorkContextCard ctx={reviewData.workContext} />
              )}

              {reviewData && (
                <div>
                  {reviewData.cached && (
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-3)', color: 'var(--muted)' }}>
                        Cached · {reviewData.cachedAt ? relativeTime(reviewData.cachedAt) : ''}
                      </span>
                      <button
                        className="text-xs px-2 py-0.5 rounded"
                        style={{ color: 'var(--accent)', background: 'transparent' }}
                        onClick={() => { reviewMutation.mutate({ prNum: selectedPR.number, force: true }); }}
                        disabled={reviewMutation.isPending}>
                        Re-analyze
                      </button>
                    </div>
                  )}
                  <ReviewCard review={reviewData.review} prNum={selectedPR.number} repo={repo} />
                </div>
              )}
              {enrichDesc && <EnrichCard description={enrichDesc} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
