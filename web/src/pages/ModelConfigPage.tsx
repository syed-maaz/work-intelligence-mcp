/**
 * ADR-031 — /setup/models admin UI.
 *
 * One row per bucket (fetch / digest / chat / analyse / decide / agents /
 * bug-investigator). Each row exposes the model + effort + thinking-mode
 * knobs, surfaces the system-recommended defaults with rationale, and
 * shows a live cost-per-day estimate so the user can see the cost impact
 * of each bucket-level choice before saving.
 *
 * The 60s registry cache invalidates immediately on POST so changes take
 * effect on the next call site.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import {
  api,
  type Bucket,
  type ModelId,
  type Effort,
  type ThinkingMode,
  type BucketRow,
  type ModelCap,
} from '@/lib/api';
import { Button, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';

// Coarse per-bucket call volume estimates used to drive the live cost
// preview. These are not enforced anywhere in the backend — they exist
// so the user can see "if I move chat to opus/max, that's roughly $X/day
// extra" before clicking save. Values reflect the rough cadence implied
// by ADR-031's bucket descriptions; tweak when telemetry catches up.
const BUCKET_VOLUME_PER_DAY: Record<Bucket, number> = {
  fetch: 200,
  digest: 5,
  chat: 30,
  analyse: 10,
  decide: 10,
  agents: 100,
  'bug-investigator': 5,
};

const BUCKET_DESCRIPTIONS: Record<Bucket, string> = {
  fetch: 'Bulk extraction during sync — action items, summaries, calendar parse.',
  digest: 'Daily / weekly synthesis — digests, notebooks, member profiles, briefs.',
  chat: 'UI chat panel reply — every chatWithContext / answerQuestion turn.',
  analyse: 'Jira analyse + PR review — user-clicks-button reasoning.',
  decide: 'Brain decide — agentic recall + cluster + verify loop.',
  agents: 'Background agents — correlation, orchestrator, score_severity.',
  'bug-investigator': 'Self-healing bug loop — root-cause + patch synthesis.',
};

const EFFORT_LABEL: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

const MODEL_LABEL: Record<ModelId, string> = {
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-latest': 'Opus (latest, proxy alias)',
};

function modelLabelWithPrice(model: ModelId, cap?: ModelCap): string {
  if (!cap) return MODEL_LABEL[model] ?? model;
  return `${MODEL_LABEL[model]} ($${cap.inputPriceMtok}/$${cap.outputPriceMtok}/Mtok)`;
}

function isRecommended(row: { model: ModelId; effort: Effort; thinking_mode: ThinkingMode },
                       rec:  { model: ModelId; effort: Effort; thinking_mode: ThinkingMode }): boolean {
  return row.model === rec.model && row.effort === rec.effort && row.thinking_mode === rec.thinking_mode;
}

/**
 * Estimate USD/day for one bucket at a given (model, effort).
 *
 * Crude model: assume each call uses `effortMaxTokens[effort]` output
 * tokens and ~4× that for input (system + user message + context).
 * Real costs will deviate (cache reads, tool_use loop turn counts), but
 * the relative ordering between buckets and models is what matters for
 * making the dropdown choice.
 */
function estimateCostPerDay(
  bucket: Bucket,
  model: ModelId,
  effort: Effort,
  effortMaxTokens: Record<Effort, number>,
  modelCaps: Record<ModelId, ModelCap>,
): number {
  const cap = modelCaps[model];
  if (!cap) return 0;
  const out = effortMaxTokens[effort];
  const inTokens = out * 4;
  const callsPerDay = BUCKET_VOLUME_PER_DAY[bucket] ?? 0;
  const usdPerCall =
    (inTokens * cap.inputPriceMtok + out * cap.outputPriceMtok) / 1_000_000;
  return usdPerCall * callsPerDay;
}

interface BucketRowProps {
  row: BucketRow;
  modelCaps: Record<ModelId, ModelCap>;
  availableModels: ModelId[];
  effortMaxTokens: Record<Effort, number>;
  onSave: (update: { bucket: Bucket; model: ModelId; effort: Effort; thinking_mode: ThinkingMode }) => Promise<void>;
}

function BucketRowEditor({ row, modelCaps, availableModels, effortMaxTokens, onSave }: BucketRowProps) {
  const [model, setModel] = useState<ModelId>(row.model);
  const [effort, setEffort] = useState<Effort>(row.effort);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>(row.thinking_mode);
  const [saving, setSaving] = useState(false);

  // Reset local state when the upstream row changes (e.g. after a refetch).
  useEffect(() => {
    setModel(row.model);
    setEffort(row.effort);
    setThinkingMode(row.thinking_mode);
  }, [row.model, row.effort, row.thinking_mode]);

  // Effort dropdown options follow the live model selection — when the user
  // switches model, snap effort to a value the new model actually supports.
  const efforts = modelCaps[model]?.effortsAvailable ?? row.available_efforts_for_model;
  useEffect(() => {
    if (!efforts.includes(effort)) {
      setEffort(efforts[0] ?? 'low');
    }
  }, [model, efforts, effort]);

  // Thinking adaptive mode is haiku-incompatible. Force off when user picks haiku.
  const supportsAdaptive = modelCaps[model]?.supportsAdaptiveThinking ?? false;
  useEffect(() => {
    if (!supportsAdaptive && thinkingMode === 'adaptive') {
      setThinkingMode('off');
    }
  }, [supportsAdaptive, thinkingMode]);

  const isDirty =
    model !== row.model || effort !== row.effort || thinkingMode !== row.thinking_mode;

  const recommended = isRecommended({ model, effort, thinking_mode: thinkingMode }, row.recommended);
  const costPerDay = estimateCostPerDay(row.bucket, model, effort, effortMaxTokens, modelCaps);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ bucket: row.bucket, model, effort, thinking_mode: thinkingMode });
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
      <td className="px-3 py-2 align-top">
        <div className="font-medium" style={{ color: 'var(--fg)' }}>{row.bucket}</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
          {BUCKET_DESCRIPTIONS[row.bucket]}
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <select
          className="w-full text-xs px-2 py-1 rounded border"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          value={model}
          onChange={(e) => setModel(e.target.value as ModelId)}
          disabled={saving}
        >
          {availableModels.map((m) => (
            <option key={m} value={m}>{modelLabelWithPrice(m, modelCaps[m])}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 align-top">
        <select
          className="w-full text-xs px-2 py-1 rounded border"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          value={effort}
          onChange={(e) => setEffort(e.target.value as Effort)}
          disabled={saving}
        >
          {efforts.map((eff) => (
            <option key={eff} value={eff}>
              {EFFORT_LABEL[eff]} ({effortMaxTokens[eff]} tok)
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 align-top">
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--fg)' }}>
          <input
            type="checkbox"
            checked={thinkingMode === 'adaptive'}
            onChange={(e) => setThinkingMode(e.target.checked ? 'adaptive' : 'off')}
            disabled={!supportsAdaptive || saving}
          />
          adaptive
        </label>
        {!supportsAdaptive && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            (haiku: not supported)
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {recommended ? (
          <Badge variant="success" className="inline-flex items-center gap-1">
            <CheckCircle2 size={10} /> Recommended
          </Badge>
        ) : (
          <div className="space-y-1">
            <Badge variant="warning" className="inline-flex items-center gap-1">
              <AlertTriangle size={10} /> Off-default
            </Badge>
            <div className="text-xs" style={{ color: 'var(--muted)' }} title={row.recommended.reason}>
              Recommended: {MODEL_LABEL[row.recommended.model]} / {row.recommended.effort} / {row.recommended.thinking_mode}.{' '}
              <a
                href={row.recommended.doc_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5"
                style={{ color: 'var(--accent)' }}
              >
                why <ExternalLink size={9} />
              </a>
            </div>
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs whitespace-nowrap" style={{ color: 'var(--fg-2)' }}>
        ${costPerDay.toFixed(2)}/day
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          ({BUCKET_VOLUME_PER_DAY[row.bucket]} calls/day)
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={!isDirty || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </td>
    </tr>
  );
}

export default function ModelConfigPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['model-config'],
    queryFn: api.getModelConfig,
  });

  const updateMutation = useMutation({
    mutationFn: api.updateModelConfig,
    onSuccess: (_, variables) => {
      toast.success(`Saved ${variables.bucket} → ${MODEL_LABEL[variables.model]} / ${variables.effort}; takes effect within 60s.`);
      queryClient.invalidateQueries({ queryKey: ['model-config'] });
    },
    onError: (err) => toast.error(`Save failed: ${(err as Error).message}`),
  });

  const handleSave = async (update: { bucket: Bucket; model: ModelId; effort: Effort; thinking_mode: ThinkingMode }) => {
    await updateMutation.mutateAsync(update);
  };

  // Total daily-cost rollup at current saved values.
  const totalCostPerDay = useMemo(() => {
    if (!data) return 0;
    return data.buckets.reduce(
      (sum, b) => sum + estimateCostPerDay(b.bucket, b.model, b.effort, data.effortMaxTokens, data.modelCaps),
      0,
    );
  }, [data]);

  if (isLoading) {
    return (
      <div className="px-3 py-2">
        <div className="text-xs" style={{ color: 'var(--muted)' }}>Loading model configuration…</div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="px-3 py-2">
        <div className="text-xs" style={{ color: 'var(--danger)' }}>
          Failed to load model configuration: {error ? (error as Error).message : 'no data'}
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 max-w-6xl animate-fade-in">
      <div className="mb-3">
        <h1 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Model Configuration</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
          Each bucket controls Anthropic API calls for one functional area. Defaults are evidence-backed —
          see{' '}
          <a
            href="/docs/adr/adr-031-per-bucket-model-effort-config"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            ADR-031
          </a>{' '}
          for sources. Changes take effect within 60s (registry cache TTL); writes invalidate immediately.
          Estimated daily cost at current settings:{' '}
          <span style={{ color: 'var(--fg)' }}>${totalCostPerDay.toFixed(2)}/day</span>.
        </p>
      </div>

      <div
        className="rounded border overflow-x-auto"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left" style={{ color: 'var(--muted)' }}>
              <th className="px-3 py-1.5 font-semibold">Bucket</th>
              <th className="px-3 py-1.5 font-semibold">Model</th>
              <th className="px-3 py-1.5 font-semibold">Effort</th>
              <th className="px-3 py-1.5 font-semibold">Thinking</th>
              <th className="px-3 py-1.5 font-semibold">Status</th>
              <th className="px-3 py-1.5 font-semibold">Est. cost</th>
              <th className="px-3 py-1.5 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {data.buckets.map((row) => (
              <BucketRowEditor
                key={row.bucket}
                row={row}
                modelCaps={data.modelCaps}
                availableModels={data.availableModels}
                effortMaxTokens={data.effortMaxTokens}
                onSave={handleSave}
              />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs mt-3" style={{ color: 'var(--muted)' }}>
        Cost estimates assume ~4× input-to-output ratio and the bucket-volume guesses listed in the row.
        Actual billing reflects cache hits, tool-use turn counts, and real call rates — see{' '}
        <a href="/system-health" style={{ color: 'var(--accent)' }}>System Health → Tokens</a> for measured cost.
      </p>
    </div>
  );

  // touch unused-import warnings if any (keep cn import for future styling)
  void cn;
}
