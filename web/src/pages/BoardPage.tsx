/**
 * /board — Outcome-honest delivery kanban (ADR-040 + F-UI 2026-07-09).
 *
 * 5-column layout: ready → in_progress → review → e2e → done. Every card
 * is a `tasks` row from ADR-038 D2, extended by v90 with
 * goal_text / acceptance_text / kanban_column / assigned_worker_id /
 * blocked / entered_column_at / depends_on_json. Polls /api/board/tasks
 * every 30s.
 *
 * # F-UI (bucket separation + manual moves)
 *
 * 1. **Filter chips at the top** — project + posture + worker + blocked-only.
 * 2. **Swimlanes inside each column** — cards grouped by project.
 * 3. **Chip band on each card** — project + posture + external_ref + aging.
 * 4. **Every card is clickable** — opens a detail modal. On `e2e` the modal
 *    hosts the verify-and-close capture form; on every other column it's
 *    read-only detail + a "Move to column" dropdown.
 * 5. **Drag-and-drop between columns** — native HTML5 drag events; on drop
 *    the client PATCHes `/api/board/tasks/:id { kanban_column }`. Optimistic
 *    UI: the query cache updates immediately; a refetch reconciles.
 *    Move-to-done is refused server-side unless a user_observed evidence
 *    row already exists (DoD contract, ADR §2.4) — the UI presents that
 *    409 as an actionable message.
 *
 * When OUTCOME_HONEST_KANBAN_ENABLED != '1' the endpoint returns 404 and
 * the UI shows a "kanban disabled" banner. Post-F1 the flag defaults ON.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { LayoutGrid, MessageSquare, User, X } from 'lucide-react';
import { useMemo, useState, type ClipboardEvent, type DragEvent } from 'react';
import { api, type BoardTask, type CardComment, type KanbanColumn } from '@/lib/api';
import { useVerificationCapture } from '@/hooks/useVerificationCapture';

const COLUMNS: readonly KanbanColumn[] = ['ready', 'in_progress', 'review', 'e2e', 'done'];
const COLUMN_LABEL: Record<KanbanColumn, string> = {
  ready: 'Ready',
  in_progress: 'In Progress',
  review: 'Review',
  e2e: 'E2E',
  done: 'Done',
};
const COLUMN_TINT: Record<KanbanColumn, string> = {
  ready: 'border-emerald-200 bg-emerald-50/40',
  in_progress: 'border-amber-200 bg-amber-50/40',
  review: 'border-amber-200 bg-amber-50/40',
  e2e: 'border-emerald-200 bg-emerald-50/40',
  done: 'border-gray-200 bg-gray-50/40',
};
const POLL_MS = 30_000;

const PROJECT_PALETTE: Record<string, string> = {
  wi: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  example-service: 'bg-cyan-100 text-cyan-800 border-cyan-300',
  operations: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300',
};
const POSTURE_TINT: Record<string, string> = {
  'bug-investigate': 'bg-red-100 text-red-800 border-red-300',
  'pr-review':       'bg-blue-100 text-blue-800 border-blue-300',
  'pm':              'bg-purple-100 text-purple-800 border-purple-300',
  'generic':         'bg-gray-100 text-gray-700 border-gray-300',
};

function projectChipClass(project: string): string {
  if (PROJECT_PALETTE[project]) return PROJECT_PALETTE[project]!;
  const h = [...project].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
  const hues = ['emerald', 'orange', 'teal', 'rose', 'lime', 'sky'];
  const hue = hues[Math.abs(h) % hues.length];
  return `bg-${hue}-100 text-${hue}-800 border-${hue}-300`;
}

function ageBandClass(enteredAt: number | null): { label: string; ring: string } {
  if (!enteredAt) return { label: '—', ring: '' };
  const days = (Date.now() - enteredAt) / (1000 * 60 * 60 * 24);
  const label = formatDistanceToNow(new Date(enteredAt), { addSuffix: false });
  if (days < 7) return { label, ring: 'ring-emerald-200' };
  if (days < 14) return { label, ring: 'ring-yellow-300' };
  if (days < 30) return { label, ring: 'ring-red-300' };
  return { label, ring: 'ring-purple-400' };
}

// Short human-referenceable label. Prefer the sequential card_number (#42);
// fall back to the last 4 hex of the id when card_number is null (pre-v94 rows
// the migration should have backfilled, but guard anyway).
function cardNumberLabel(task: BoardTask): string {
  if (task.card_number != null) return `#${task.card_number}`;
  const hex = task.id.replace(/^task_/, '').replace(/^cyp_/, '');
  return `#${hex.slice(-4)}`;
}

// ── page ────────────────────────────────────────────────────────────────

export default function BoardPage() {
  const qc = useQueryClient();
  const [openTask, setOpenTask] = useState<BoardTask | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<Set<string>>(new Set());
  const [postureFilter, setPostureFilter] = useState<Set<string>>(new Set());
  const [workerFilter, setWorkerFilter] = useState<Set<string>>(new Set());
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['board', 'tasks'],
    queryFn: () => api.boardTasks({ limit: 500 }),
    refetchInterval: POLL_MS,
    retry: (failureCount, err) => {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('HTTP 404')) return false;
      return failureCount < 2;
    },
  });

  const move = useMutation({
    mutationFn: (v: { id: string; column: KanbanColumn }) =>
      api.updateBoardTask(v.id, { kanban_column: v.column }),
    onMutate: async (v) => {
      // Optimistic update — refetch guard so no stale flash between click and 200.
      await qc.cancelQueries({ queryKey: ['board', 'tasks'] });
      const prev = qc.getQueryData<{ tasks: BoardTask[] }>(['board', 'tasks']);
      if (prev) {
        qc.setQueryData<{ tasks: BoardTask[] }>(['board', 'tasks'], {
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id === v.id ? { ...t, kanban_column: v.column, entered_column_at: Date.now() } : t,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['board', 'tasks'], ctx.prev);
      const msg = err instanceof Error ? err.message : String(err);
      // Server may return "done_requires_user_observed" — surface it plainly.
      if (msg.includes('done_requires_user_observed') || msg.includes('user_observed')) {
        setMoveError('Cards can only reach `done` after a 👍 verify on `e2e`. Move to `e2e` first.');
      } else {
        setMoveError(msg);
      }
      setTimeout(() => setMoveError(null), 5000);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', 'tasks'] }),
  });

  const block = useMutation({
    mutationFn: (v: { id: string; blocked: 0 | 1; reason?: string | null }) =>
      api.updateBoardTask(v.id, { blocked: v.blocked, blocked_reason: v.reason ?? null }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['board', 'tasks'] });
      const prev = qc.getQueryData<{ tasks: BoardTask[] }>(['board', 'tasks']);
      if (prev) {
        qc.setQueryData<{ tasks: BoardTask[] }>(['board', 'tasks'], {
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id === v.id ? { ...t, blocked: v.blocked, blocked_reason: v.reason ?? null } : t,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['board', 'tasks'], ctx.prev);
      setMoveError(err instanceof Error ? err.message : String(err));
      setTimeout(() => setMoveError(null), 5000);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', 'tasks'] }),
  });

  const retrigger = useMutation({
    mutationFn: (id: string) => api.retriggerBoardTask(id),
    onError: (err) => {
      setMoveError(err instanceof Error ? err.message : String(err));
      setTimeout(() => setMoveError(null), 5000);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['board', 'tasks'] }),
  });

  const flagOff = error instanceof Error && error.message.includes('HTTP 404');
  const allTasks = data?.tasks ?? [];

  const projects = useMemo(() => uniqueBy(allTasks, (t) => t.project), [allTasks]);
  const postures = useMemo(() => uniqueBy(allTasks, (t) => t.posture ?? 'generic'), [allTasks]);
  const workers = useMemo(
    () =>
      uniqueBy(
        allTasks,
        (t) => (t.assigned_worker_id == null ? 'unassigned' : `W${t.assigned_worker_id}`),
      ),
    [allTasks],
  );

  const filtered = useMemo(() => {
    return allTasks.filter((t) => {
      if (projectFilter.size > 0 && !projectFilter.has(t.project)) return false;
      const p = t.posture ?? 'generic';
      if (postureFilter.size > 0 && !postureFilter.has(p)) return false;
      const w = t.assigned_worker_id == null ? 'unassigned' : `W${t.assigned_worker_id}`;
      if (workerFilter.size > 0 && !workerFilter.has(w)) return false;
      if (blockedOnly && t.blocked !== 1) return false;
      return true;
    });
  }, [allTasks, projectFilter, postureFilter, workerFilter, blockedOnly]);

  // A blocked card keeps its kanban_column in the DB (ADR-040 §2.8 —
  // blocked is a flag, not a state) but is surfaced in a dedicated
  // "Blocked" lane on the board so it's visually grouped and obvious.
  // Normal columns EXCLUDE blocked cards so a card never shows twice.
  const blockedCards = filtered.filter((t) => t.blocked === 1);
  const byColumn = COLUMNS.reduce(
    (acc, col) => {
      acc[col] = filtered.filter((t) => t.kanban_column === col && t.blocked !== 1);
      return acc;
    },
    {} as Record<KanbanColumn, BoardTask[]>,
  );

  const totalHidden = allTasks.length - filtered.length;
  const activeFilterCount =
    projectFilter.size + postureFilter.size + workerFilter.size + (blockedOnly ? 1 : 0);

  const doMove = (id: string, column: KanbanColumn) => {
    move.mutate({ id, column });
  };
  const doBlock = (id: string, blocked: 0 | 1, reason?: string | null) => {
    block.mutate({ id, blocked, reason });
  };

  return (
    <div className="p-6">
      <header className="mb-4 flex items-center gap-3">
        <LayoutGrid className="h-6 w-6 text-emerald-600" />
        <h1 className="text-2xl font-bold">Board</h1>
        <span className="text-sm text-gray-500">
          Outcome-honest delivery kanban · ADR-040
        </span>
        <span className="ml-auto text-xs text-gray-500">
          {allTasks.length} cards · {filtered.length} visible
          {totalHidden > 0 && (
            <button
              className="ml-2 underline hover:text-gray-800"
              onClick={() => {
                setProjectFilter(new Set());
                setPostureFilter(new Set());
                setWorkerFilter(new Set());
                setBlockedOnly(false);
              }}
            >
              clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
            </button>
          )}
        </span>
      </header>

      {moveError && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {moveError}
        </div>
      )}

      {!flagOff && <WorkerStrip />}

      {!flagOff && !isLoading && allTasks.length > 0 && (
        <div className="mb-4 space-y-2 rounded-lg border bg-white p-3 text-xs">
          <FilterRow
            label="Project"
            options={projects}
            selected={projectFilter}
            onToggle={(v) => setProjectFilter(toggleSet(projectFilter, v))}
            renderChip={(v) => (
              <span className={`rounded border px-2 py-0.5 ${projectChipClass(v)}`}>{v}</span>
            )}
          />
          <FilterRow
            label="Posture"
            options={postures}
            selected={postureFilter}
            onToggle={(v) => setPostureFilter(toggleSet(postureFilter, v))}
            renderChip={(v) => (
              <span className={`rounded border px-2 py-0.5 ${POSTURE_TINT[v] ?? POSTURE_TINT.generic}`}>{v}</span>
            )}
          />
          <FilterRow
            label="Worker"
            options={workers}
            selected={workerFilter}
            onToggle={(v) => setWorkerFilter(toggleSet(workerFilter, v))}
            renderChip={(v) => (
              <span className="inline-flex items-center gap-1 rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-gray-700">
                <User className="h-3 w-3" />
                {v}
              </span>
            )}
          />
          <div className="flex items-center gap-2 pt-1">
            <span className="w-20 text-gray-600">State</span>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={blockedOnly}
                onChange={(e) => setBlockedOnly(e.target.checked)}
                className="h-3 w-3"
              />
              <span className="text-gray-700">blocked only</span>
            </label>
            <span className="ml-4 text-gray-500">
              Tip: drag cards between columns, or click a card for details + column menu.
            </span>
          </div>
        </div>
      )}

      {flagOff && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Kanban disabled.</strong> Set{' '}
          <code className="rounded bg-amber-100 px-1">OUTCOME_HONEST_KANBAN_ENABLED=1</code> in
          your bridge&nbsp;<code>.env</code> and restart to enable this view.
        </div>
      )}

      {error && !flagOff && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <strong>Failed to load tasks:</strong>{' '}
          {error instanceof Error ? error.message : String(error)}
          <button
            onClick={() => refetch()}
            className="ml-3 rounded bg-red-600 px-2 py-1 text-white hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6">
        {COLUMNS.map((col) => (
          <Column
            key={col}
            column={col}
            tasks={byColumn[col]}
            loading={isLoading}
            flagOff={flagOff}
            onCardClick={setOpenTask}
            onDragStart={(id) => setDragTaskId(id)}
            onDragEnd={() => setDragTaskId(null)}
            onDrop={(col) => {
              if (dragTaskId) doMove(dragTaskId, col);
              setDragTaskId(null);
            }}
            dragTaskId={dragTaskId}
          />
        ))}
        {/* Blocked lane — aggregates every blocked=1 card regardless of its
            underlying column. Dropping a card here blocks it; unblock from
            the card detail modal. Per ADR-040 §2.8 blocked is a flag, so the
            card keeps its real kanban_column (shown as a sub-label). */}
        <BlockedLane
          tasks={blockedCards}
          loading={isLoading}
          flagOff={flagOff}
          onCardClick={setOpenTask}
          onDrop={() => {
            if (dragTaskId) doBlock(dragTaskId, 1, 'Blocked from board');
            setDragTaskId(null);
          }}
        />
      </div>

      {openTask && (
        <TaskDetailModal
          task={(data?.tasks ?? []).find((t) => t.id === openTask.id) ?? openTask}
          onClose={() => setOpenTask(null)}
          onEvidenceLanded={() => { setOpenTask(null); refetch(); }}
          onMove={(col) => {
            doMove(openTask.id, col);
            setOpenTask(null);
          }}
          onBlock={(blocked, reason) => {
            doBlock(openTask.id, blocked, reason);
          }}
          onRetrigger={() => {
            retrigger.mutate(openTask.id);
            setOpenTask(null);
          }}
        />
      )}
    </div>
  );
}

// ── worker strip — free / on-duty rollup + per-worker pills ─────────────

function WorkerStrip() {
  const { data } = useQuery({
    queryKey: ['board', 'workers'],
    queryFn: () => api.boardWorkers(),
    refetchInterval: 15_000,
  });
  if (!data) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3 text-xs">
      <span className="inline-flex items-center gap-1 font-semibold text-gray-700">
        <User className="h-4 w-4" /> Workers
      </span>
      <span className="rounded bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
        {data.free} free
      </span>
      <span className="rounded bg-blue-100 px-2 py-0.5 font-semibold text-blue-800">
        {data.on_duty} on duty
      </span>
      <span className="text-gray-400">of {data.total}</span>
      <span className="ml-2 h-4 w-px bg-gray-200" />
      {data.workers.map((w) => (
        <span
          key={w.number}
          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 ${
            w.on_duty
              ? w.current_task_stalled
                ? 'border-orange-300 bg-orange-50 text-orange-800'
                : 'border-blue-300 bg-blue-50 text-blue-800'
              : 'border-gray-200 bg-gray-50 text-gray-500'
          }`}
          title={
            w.on_duty
              ? `Worker ${w.number} → #${w.current_card_number ?? '?'}: ${(w.current_goal ?? '').slice(0, 80)}`
              : `Worker ${w.number} (${w.profile_hint}) — idle`
          }
        >
          {w.on_duty && !w.current_task_stalled && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-600" />
          )}
          W{w.number}
          <span className="opacity-60">·{w.profile_hint}</span>
          {w.on_duty
            ? w.current_task_stalled
              ? ' ⚠️'
              : ` → #${w.current_card_number ?? '?'}`
            : ' · idle'}
        </span>
      ))}
    </div>
  );
}

// ── column with swimlanes-by-project ────────────────────────────────────

function Column({
  column,
  tasks,
  loading,
  flagOff,
  onCardClick,
  onDragStart,
  onDragEnd,
  onDrop,
  dragTaskId,
}: {
  column: KanbanColumn;
  tasks: BoardTask[];
  loading: boolean;
  flagOff: boolean;
  onCardClick: (task: BoardTask) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (col: KanbanColumn) => void;
  dragTaskId: string | null;
}) {
  const byProject = useMemo(() => groupBy(tasks, (t) => t.project), [tasks]);
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOver) setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragOver(false);
    onDrop(column);
  };

  return (
    <section
      className={`rounded-lg border p-3 transition ${COLUMN_TINT[column]} ${
        dragOver ? 'ring-4 ring-emerald-400' : ''
      }`}
      aria-label={`Column ${COLUMN_LABEL[column]}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
          {COLUMN_LABEL[column]}
        </h2>
        <span className="text-xs text-gray-500">{tasks.length}</span>
      </header>

      {loading && !flagOff ? (
        <div className="h-20 animate-pulse rounded bg-gray-200/60" />
      ) : tasks.length === 0 ? (
        <div className="text-xs text-gray-400">{dragOver ? 'Drop to move here' : 'No cards'}</div>
      ) : (
        <div className="flex flex-col gap-3">
          {Array.from(byProject.entries()).map(([project, projectTasks]) => (
            <div key={project} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${projectChipClass(project)}`}>
                  {project}
                </span>
                <span className="text-[10px] text-gray-400">{projectTasks.length}</span>
                <span className="h-px flex-1 bg-gray-200" />
              </div>
              {projectTasks.map((task) => (
                <Card
                  key={task.id}
                  task={task}
                  onClick={onCardClick}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  isDragging={dragTaskId === task.id}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── blocked lane — aggregates every blocked=1 card ──────────────────────

function BlockedLane({
  tasks,
  loading,
  flagOff,
  onCardClick,
  onDrop,
}: {
  tasks: BoardTask[];
  loading: boolean;
  flagOff: boolean;
  onCardClick: (task: BoardTask) => void;
  onDrop: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <section
      className={`rounded-lg border border-red-300 bg-red-50/50 p-3 transition ${
        dragOver ? 'ring-4 ring-red-400' : ''
      }`}
      aria-label="Column Blocked"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDrop();
      }}
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700">
          🚫 Blocked
        </h2>
        <span className="text-xs text-red-500">{tasks.length}</span>
      </header>
      {loading && !flagOff ? (
        <div className="h-20 animate-pulse rounded bg-red-200/60" />
      ) : tasks.length === 0 ? (
        <div className="text-xs text-red-400">{dragOver ? 'Drop to block' : 'Nothing blocked'}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => onCardClick(task)}
              className="w-full rounded border border-red-300 bg-white p-2 text-left shadow-sm hover:ring-2 hover:ring-red-400"
              title={task.blocked_reason ?? 'Blocked — click for details / unblock'}
            >
              <div className="mb-1 flex flex-wrap items-center gap-1">
                <span className="rounded bg-gray-800 px-1 py-[1px] text-[9px] font-semibold leading-tight text-white">
                  {cardNumberLabel(task)}
                </span>
                <span className={`rounded border px-1 py-[1px] text-[9px] uppercase leading-tight ${projectChipClass(task.project)}`}>
                  {task.project}
                </span>
                <span className="rounded border border-gray-300 bg-gray-50 px-1 py-[1px] text-[9px] uppercase leading-tight text-gray-600">
                  in {COLUMN_LABEL[task.kanban_column]}
                </span>
              </div>
              <div className="text-sm font-medium leading-snug text-gray-900 line-clamp-2">
                {task.title}
              </div>
              {task.blocked_reason && (
                <div className="mt-1 truncate text-[10px] text-red-700">🚫 {task.blocked_reason}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── card with drag + click ─────────────────────────────────────────────

function Card({
  task,
  onClick,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  task: BoardTask;
  onClick: (t: BoardTask) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const enteredAt = task.entered_column_at ?? task.created_at;
  const age = ageBandClass(enteredAt);
  const posture = task.posture ?? 'generic';
  const workerLabel = task.assigned_worker_id ? `W${task.assigned_worker_id}` : 'unassigned';
  const isE2E = task.kanban_column === 'e2e';

  const handleDragStart = (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
    onDragStart(task.id);
  };

  return (
    <article
      className={`cursor-pointer select-none rounded border bg-white p-2 shadow-sm ring-1 transition ${
        task.stalled === 1
          ? 'border-orange-500 bg-orange-50 ring-2 ring-orange-500'
          : task.needs_answer === 1
            ? 'border-amber-400 bg-amber-50 ring-2 ring-amber-400'
            : `${age.ring} ${task.blocked ? 'opacity-60 ring-red-300' : ''}`
      } ${isE2E ? 'hover:ring-2 hover:ring-emerald-400' : 'hover:ring-2 hover:ring-gray-400'} ${
        isDragging ? 'opacity-40' : ''
      }`}
      title={
        task.stalled === 1
          ? 'Stalled — dispatch died. Click to Retrigger.'
          : task.needs_answer === 1
            ? 'Needs your answer — click to reply'
            : isE2E
              ? 'Click to verify + close · drag to move'
              : 'Click for details · drag to move'
      }
      onClick={() => onClick(task)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(task);
        }
      }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <span className="rounded bg-gray-800 px-1 py-[1px] text-[9px] font-semibold leading-tight text-white">
          {cardNumberLabel(task)}
        </span>
        {task.stalled === 1 && (
          <span
            title={task.stalled_reason ?? 'The dispatch for this card is no longer running.'}
            className="cursor-help rounded bg-orange-600 px-1 py-[1px] text-[9px] font-semibold uppercase leading-tight text-white"
          >
            ⚠️ Stalled · retrigger
          </span>
        )}
        {task.stalled !== 1 && task.kanban_column === 'in_progress' && task.assigned_worker_id != null && (
          <span className="inline-flex items-center gap-0.5 rounded bg-blue-600 px-1 py-[1px] text-[9px] font-semibold uppercase leading-tight text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            Working
          </span>
        )}
        {task.needs_answer === 1 && (
          <span className="rounded bg-amber-500 px-1 py-[1px] text-[9px] font-semibold uppercase leading-tight text-white">
            ❓ Needs answer
          </span>
        )}
        <span className={`rounded border px-1 py-[1px] text-[9px] uppercase leading-tight ${projectChipClass(task.project)}`}>
          {task.project}
        </span>
        <span className={`rounded border px-1 py-[1px] text-[9px] uppercase leading-tight ${POSTURE_TINT[posture] ?? POSTURE_TINT.generic}`}>
          {posture}
        </span>
        {task.external_ref && (
          <span className="rounded border border-gray-300 bg-gray-50 px-1 py-[1px] text-[9px] leading-tight text-gray-700">
            {task.external_ref}
          </span>
        )}
        {task.comment_count > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded border border-gray-300 bg-gray-50 px-1 py-[1px] text-[9px] leading-tight text-gray-600">
            <MessageSquare className="h-2.5 w-2.5" />
            {task.comment_count}
          </span>
        )}
      </div>

      <div className="text-sm font-medium leading-snug text-gray-900 line-clamp-2">
        {task.title}
      </div>
      {task.goal_text && task.goal_text !== task.title && (
        <div className="mt-1 text-xs text-gray-600 line-clamp-2">{task.goal_text}</div>
      )}
      <footer className="mt-2 flex items-center justify-between text-[10px] text-gray-500">
        <span className="inline-flex items-center gap-1">
          <User className="h-3 w-3" />
          {workerLabel}
        </span>
        <span>{age.label}</span>
      </footer>
      {task.blocked === 1 && task.blocked_reason && (
        <div className="mt-1 truncate text-[10px] text-red-700" title={task.blocked_reason}>
          🚫 {task.blocked_reason}
        </div>
      )}
    </article>
  );
}

// ── filter row ─────────────────────────────────────────────────────────

function FilterRow<T extends string>({
  label,
  options,
  selected,
  onToggle,
  renderChip,
}: {
  label: string;
  options: T[];
  selected: Set<T>;
  onToggle: (v: T) => void;
  renderChip: (v: T) => React.ReactNode;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 shrink-0 text-gray-600">{label}</span>
      {options.map((v) => {
        const active = selected.has(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => onToggle(v)}
            className={`transition ${active ? 'ring-2 ring-emerald-500' : 'opacity-60 hover:opacity-100'}`}
            title={active ? 'click to remove filter' : 'click to filter'}
          >
            {renderChip(v)}
            {active && <X className="ml-0.5 inline h-2.5 w-2.5" />}
          </button>
        );
      })}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

function uniqueBy<T, K>(xs: T[], key: (t: T) => K): K[] {
  const seen = new Set<K>();
  const out: K[] = [];
  for (const x of xs) {
    const k = key(x);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}
function groupBy<T, K>(xs: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k) ?? [];
    arr.push(x);
    m.set(k, arr);
  }
  return m;
}
function toggleSet<T>(s: Set<T>, v: T): Set<T> {
  const next = new Set(s);
  if (next.has(v)) next.delete(v); else next.add(v);
  return next;
}

// ── TaskDetailModal — works for every column ──────────────────────────

function TaskDetailModal({
  task,
  onClose,
  onEvidenceLanded,
  onMove,
  onBlock,
  onRetrigger,
}: {
  task: BoardTask;
  onClose: () => void;
  onEvidenceLanded: () => void;
  onMove: (col: KanbanColumn) => void;
  onBlock: (blocked: 0 | 1, reason?: string | null) => void;
  onRetrigger: () => void;
}) {
  const isE2E = task.kanban_column === 'e2e';
  const derivedSessionId = `cyp_${task.id.replace(/^task_/, '')}`;
  const posture = task.posture ?? 'generic';
  const enteredAt = task.entered_column_at ?? task.created_at;
  const age = ageBandClass(enteredAt);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">
              <span className="mr-2 rounded bg-gray-800 px-1.5 py-0.5 align-middle text-xs font-semibold text-white">
                {cardNumberLabel(task)}
              </span>
              {task.title}
            </h2>
            <p className="mt-1 text-xs text-gray-500 truncate">
              {task.id} · session {derivedSessionId} · project <code>{task.project}</code>
              {task.external_ref && <> · ref <code>{task.external_ref}</code></>}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {/* Chip band + move menu */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className={`rounded border px-2 py-0.5 text-[10px] uppercase ${projectChipClass(task.project)}`}>
            {task.project}
          </span>
          <span className={`rounded border px-2 py-0.5 text-[10px] uppercase ${POSTURE_TINT[posture] ?? POSTURE_TINT.generic}`}>
            {posture}
          </span>
          <span className="rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-[10px] uppercase text-gray-700">
            {COLUMN_LABEL[task.kanban_column]}
          </span>
          <span className="rounded border border-gray-300 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-700">
            <User className="mr-1 inline h-3 w-3" />
            {task.assigned_worker_id ? `W${task.assigned_worker_id}` : 'unassigned'}
          </span>
          <span className={`rounded border px-2 py-0.5 text-[10px] ring-1 ${age.ring}`}>
            aged {age.label}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-xs text-gray-600">Move to:</label>
            <select
              className="rounded border px-2 py-1 text-xs"
              value={task.kanban_column}
              onChange={(e) => {
                const next = e.target.value as KanbanColumn;
                if (next !== task.kanban_column) onMove(next);
              }}
            >
              {COLUMNS.map((c) => (
                <option key={c} value={c}>
                  {COLUMN_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Stalled banner — dead dispatch, offer Retrigger */}
        {task.stalled === 1 && (
          <div className="mb-4 rounded border border-orange-400 bg-orange-50 p-3 text-sm text-orange-900">
            <div className="flex items-start justify-between gap-2">
              <div>
                <strong>⚠️ Stalled — no worker is running this.</strong>
                <div className="mt-1 text-xs">
                  {task.stalled_reason ?? 'The dispatch for this card is no longer running.'}
                </div>
              </div>
              <button
                type="button"
                onClick={onRetrigger}
                className="shrink-0 rounded bg-orange-600 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-700"
              >
                🔄 Retrigger
              </button>
            </div>
          </div>
        )}

        {/* Working indicator — a live worker is on this card */}
        {task.stalled !== 1 && task.kanban_column === 'in_progress' && task.assigned_worker_id != null && (
          <div className="mb-4 flex items-center gap-2 rounded border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900">
            <span className="h-2 w-2 animate-pulse rounded-full bg-blue-600" />
            Worker {task.assigned_worker_id} is actively working this card. Progress appears in the activity thread below.
          </div>
        )}

        {/* Block / unblock control */}
        {task.blocked === 1 ? (
          <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            <div className="flex items-center justify-between gap-2">
              <span>🚫 <strong>Blocked.</strong> {task.blocked_reason ?? 'No reason recorded.'}</span>
              <button
                type="button"
                onClick={() => onBlock(0, null)}
                className="shrink-0 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
              >
                Unblock
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 rounded border border-gray-200 bg-gray-50 p-2 text-xs">
            <span className="text-gray-600">Not blocked.</span>
            <button
              type="button"
              onClick={() => {
                const reason = window.prompt('Reason for blocking this card?', '') ?? '';
                onBlock(1, reason || 'Blocked');
              }}
              className="ml-auto rounded border border-red-300 px-3 py-1 text-red-700 hover:bg-red-50"
            >
              🚫 Block
            </button>
          </div>
        )}

        {task.goal_text && (
          <div className="mb-4 rounded bg-gray-50 p-3 text-sm text-gray-800">
            <div className="mb-1 text-xs font-semibold uppercase text-gray-500">Goal</div>
            {task.goal_text}
          </div>
        )}

        {task.acceptance_text && (
          <div className="mb-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm">
            <div className="mb-1 text-xs font-semibold uppercase text-blue-700">
              Verification instructions
            </div>
            {task.acceptance_text}
          </div>
        )}

        {task.depends_on_json && (
          <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-xs">
            <div className="mb-1 font-semibold uppercase text-gray-500">Dependencies</div>
            <code className="text-gray-700">{task.depends_on_json}</code>
          </div>
        )}

        {/* Activity + Q&A thread — what the worker has done, plus your replies */}
        <CommentThread taskId={task.id} needsAnswer={task.needs_answer === 1} />

        {isE2E ? (
          <E2EVerifyForm
            task={task}
            derivedSessionId={derivedSessionId}
            onEvidenceLanded={onEvidenceLanded}
          />
        ) : (
          <div className="mt-4 rounded border border-gray-200 bg-white p-3 text-xs text-gray-600">
            <p>
              This card is in <strong>{COLUMN_LABEL[task.kanban_column]}</strong>. The
              verify-and-close form only appears in <strong>E2E</strong> — that's the
              outcome-honesty contract (ADR-040 §2.4). To close this card:
            </p>
            <ol className="mt-2 ml-4 list-decimal space-y-1">
              <li>Let the BoardWorkerAgent advance it through <code>in_progress</code> → <code>review</code> → <code>e2e</code>, OR</li>
              <li>Use the "Move to" dropdown above to jump straight to <code>e2e</code> and verify.</li>
            </ol>
            <p className="mt-2">
              A manual move to <code>done</code> is refused by the SQL trigger unless a
              user_observed evidence row already exists.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── comment thread — activity + Q&A per card ────────────────────────────

const COMMENT_STYLE: Record<CardComment['kind'], { label: string; cls: string }> = {
  progress: { label: 'progress', cls: 'border-gray-200 bg-gray-50 text-gray-700' },
  question: { label: 'question', cls: 'border-amber-300 bg-amber-50 text-amber-900' },
  answer:   { label: 'answer',   cls: 'border-emerald-300 bg-emerald-50 text-emerald-900' },
  note:     { label: 'note',     cls: 'border-blue-200 bg-blue-50 text-blue-900' },
};

function CommentThread({ taskId, needsAnswer }: { taskId: string; needsAnswer: boolean }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['board', 'comments', taskId],
    queryFn: () => api.boardComments(taskId),
    refetchInterval: 15_000,
  });
  const post = useMutation({
    mutationFn: (body: string) => api.addBoardComment(taskId, body, 'answer', 'user'),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['board', 'comments', taskId] });
      qc.invalidateQueries({ queryKey: ['board', 'tasks'] });
    },
  });

  const comments = data?.comments ?? [];

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-gray-500" />
        <span className="text-xs font-semibold uppercase text-gray-600">Activity &amp; comments</span>
        {needsAnswer && (
          <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
            ❓ awaiting your answer
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="h-10 animate-pulse rounded bg-gray-100" />
      ) : comments.length === 0 ? (
        <div className="rounded border border-dashed border-gray-200 p-3 text-center text-xs text-gray-400">
          No activity yet. The worker will post progress here as it works the card.
        </div>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => {
            const s = COMMENT_STYLE[c.kind];
            return (
              <li key={c.id} className={`rounded border p-2 text-sm ${s.cls}`}>
                <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide opacity-70">
                  <span className="font-semibold">{c.author}</span>
                  <span>·</span>
                  <span>{s.label}</span>
                  <span className="ml-auto">
                    {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                  </span>
                </div>
                <div className="whitespace-pre-wrap">{c.body}</div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Reply box — post an answer / note back into the ticket */}
      <div className="mt-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder={needsAnswer ? 'Answer the question to unblock this card…' : 'Add a comment / note…'}
          className="w-full rounded border p-2 text-sm"
        />
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            disabled={!draft.trim() || post.isPending}
            onClick={() => post.mutate(draft.trim())}
            className="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {post.isPending ? 'Posting…' : needsAnswer ? 'Answer' : 'Comment'}
          </button>
        </div>
        {post.isError && (
          <div className="mt-1 text-xs text-red-700">
            {post.error instanceof Error ? post.error.message : 'Failed to post'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── E2E verify-and-close form (only rendered when kanban_column='e2e') ──

function E2EVerifyForm({
  task,
  derivedSessionId,
  onEvidenceLanded,
}: {
  task: BoardTask;
  derivedSessionId: string;
  onEvidenceLanded: () => void;
}) {
  const [pasted, setPasted] = useState('');
  const [nonFixtureId, setNonFixtureId] = useState(task.id);
  const cap = useVerificationCapture();

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    setPasted(text);
    await cap.captureFromPaste(text);
  };

  // BUG FIX (2026-07-10): typing (not just pasting) must also feed the
  // capture hook so the hash is computed and the buttons enable. Previously
  // onChange only set local state → cap.status stayed 'idle' → Verify/Reject
  // stayed disabled forever unless a native paste event fired.
  const handleChange = async (text: string) => {
    setPasted(text);
    await cap.captureFromPaste(text);
  };

  // Gate the buttons on captured content, not the async status — the hash is
  // computed synchronously-enough on each change, and status can lag behind
  // React's render in the same tick. A non-empty capture + a posting guard
  // is the honest enable condition.
  const canSubmit = pasted.trim().length > 0 && cap.status !== 'posting';

  const submit = async (verdict: 'pass' | 'fail') => {
    return cap.submit({
      taskId: task.id,
      sessionId: derivedSessionId,
      verdict,
      nonFixtureIdentifier: nonFixtureId,
    });
  };

  if (cap.status === 'succeeded') {
    return (
      <div className="rounded border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">
        ✓ Evidence recorded ({cap.evidenceId}). Card will move to <code>done</code> on next refresh.
        <div className="mt-3">
          <button onClick={onEvidenceLanded} className="rounded bg-emerald-600 px-3 py-1 text-white">
            OK
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-3">
        <label className="mb-1 block text-xs font-semibold uppercase text-gray-600">
          Paste verification output
        </label>
        <textarea
          value={pasted}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={handlePaste}
          rows={6}
          placeholder="Run the verification command, then paste (or type) its output here…"
          className="w-full rounded border p-2 font-mono text-xs"
        />
      </div>

      <div className="mb-3">
        <button
          type="button"
          onClick={() => cap.captureFromClipboard()}
          className="rounded border px-3 py-1 text-sm hover:bg-gray-100"
        >
          Or read from clipboard
        </button>
        {cap.hash && (
          <span className="ml-3 text-xs text-gray-500">
            hash: <code>{cap.hash.slice(0, 12)}…</code>
          </span>
        )}
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs font-semibold uppercase text-gray-600">
          Non-fixture identifier (real ID this evidence attests to)
        </label>
        <input
          value={nonFixtureId}
          onChange={(e) => setNonFixtureId(e.target.value)}
          className="w-full rounded border p-2 text-sm"
        />
      </div>

      {cap.error && (
        <div className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {cap.error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => submit('pass').then((ok) => { if (ok) onEvidenceLanded(); })}
          className="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          {cap.status === 'posting' ? 'Submitting…' : '👍 Verify & close'}
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => submit('fail')}
          className="rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700 disabled:opacity-40"
        >
          👎 Reject
        </button>
      </div>
      {!canSubmit && (
        <p className="mt-2 text-xs text-gray-400">
          Paste or type the verification output above to enable Verify / Reject.
        </p>
      )}
    </>
  );
}
