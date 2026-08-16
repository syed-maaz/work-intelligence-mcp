/**
 * Convert BrainContext (Pillar 2) into analyzer ContextItems for POST /api/chat.
 */

import type { ContextItem } from '../analyzer.js';
import type { BrainContext } from './context-builder.js';

export function formatBrainContextForPrompt(ctx: BrainContext): string {
  const lines: string[] = [];

  if (ctx.sprint?.name) {
    const fresh = ctx.sprint.fresh ? '' : ' (stale)';
    lines.push(`Sprint: ${ctx.sprint.name}${ctx.sprint.ends ? ` — ends ${ctx.sprint.ends}` : ''}${fresh}`);
  }

  if (ctx.stuck_jiras.length > 0) {
    lines.push(
      `Stuck Jiras (${ctx.stuck_jiras.length}): ${ctx.stuck_jiras
        .slice(0, 8)
        .map((j) => `${j.key} (${j.days_stuck}d)`)
        .join(', ')}`,
    );
  }

  if (ctx.noise_clusters.length > 0) {
    for (const c of ctx.noise_clusters.slice(0, 5)) {
      lines.push(
        `Noise cluster: ${c.signature} (×${c.count})${c.actionable_root ? ` → ${c.actionable_root}` : ''}`,
      );
    }
  }

  if (ctx.calendar_today.length > 0) {
    for (const e of ctx.calendar_today.slice(0, 6)) {
      lines.push(`Calendar: ${e.time} ${e.title}${e.with ? ` with ${e.with}` : ''}`);
    }
  }

  if (ctx.open_investigations.length > 0) {
    lines.push(
      `Open investigations: ${ctx.open_investigations.map((i) => `${i.key} (${i.status})`).join(', ')}`,
    );
  }

  if (ctx.memory_relevant.length > 0) {
    lines.push('Recalled memory:');
    for (const m of ctx.memory_relevant) {
      lines.push(`  - ${m}`);
    }
  }

  if (ctx.stale_warnings.length > 0) {
    lines.push(`Stale warnings: ${ctx.stale_warnings.join('; ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'No operational brain context available.';
}

/** Prepends unified brain snapshot so general chat sees the same memory as decide/context. */
export function brainContextToContextItems(ctx: BrainContext): ContextItem[] {
  const now = new Date().toISOString();
  const items: ContextItem[] = [
    {
      source: 'brain',
      title: 'Unified Brain — operational context',
      content: formatBrainContextForPrompt(ctx),
      author: '',
      timestamp: now,
    },
  ];

  if (ctx.memory_relevant.length > 0) {
    items.push({
      source: 'brain-memory',
      title: `Recalled memory (${ctx.memory_relevant.length} hits)`,
      content: ctx.memory_relevant.join('\n'),
      author: '',
      timestamp: now,
    });
  }

  return items;
}
