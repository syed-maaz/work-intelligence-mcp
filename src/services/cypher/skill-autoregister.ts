/**
 * ADR-040 commit 4 (2026-07-06): tool-catalog auto-registration.
 *
 * At bridge boot, scan ~/.claude/skills/work-intelligence/ for skill
 * directories containing SKILL.md and register any not already in
 * TOOL_CATALOG as dynamic ToolDefinitions. Closes the "17 missing
 * skills" gap from GAP-001.
 *
 * Not to be confused with `skill-discovery.ts` (phase 82b, 2026-06-14),
 * which scans the same directory but writes to the `skill_catalog` DB
 * table for the Cypher priors/ranking system. This module is
 * orthogonal: it mutates the in-memory `TOOL_CATALOG` array so the
 * runtime loop can dispatch to skills that weren't hardcoded.
 *
 * # Naming convention
 *
 * Skill dir `wi-<kebab-name>` → tool name `wi_<snake_name>`. The
 * transformation is deterministic — kebab → snake. Skills lacking
 * SKILL.md frontmatter still register with a minimal schema and a
 * generic description sourced from the directory name.
 *
 * # SKILL.md frontmatter
 *
 * We parse the leading YAML block (between --- markers) for `name`,
 * `description`, and optional `input_schema`. All three are optional —
 * missing fields fall back to inferred defaults so we never crash on
 * malformed frontmatter.
 *
 * # Idempotency
 *
 * `autoRegisterMissingSkills` mutates the passed catalog in place.
 * Called once at boot. Duplicate invocation is a no-op — each
 * candidate skill is checked against the existing catalog by
 * normalized name before push.
 *
 * See:
 *   - .planning/adr-040-commit-4-plan.md
 *   - src/services/cypher/skill-dispatch.ts (the invocation)
 *   - src/services/cypher/skill-discovery.ts (the priors-side scanner; different concern)
 *   - ~/.claude/skills/work-intelligence/ (the skill files)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from './tool-catalog.js';
import type { SkillDispatchArgs } from './skill-dispatch.js';

const SKILLS_ROOT =
  process.env.WI_SKILLS_ROOT || join(homedir(), '.claude', 'skills', 'work-intelligence');

interface Frontmatter {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

/**
 * Scan SKILLS_ROOT, register skills not already in `catalog`.
 * Returns the count of newly-registered skills. Best-effort — logs
 * warnings on parse failures; never throws.
 */
export function autoRegisterMissingSkills(catalog: ToolDefinition[]): number {
  if (!existsSync(SKILLS_ROOT)) {
    console.warn(`[skill-autoregister] skills root not found: ${SKILLS_ROOT}`);
    return 0;
  }

  // Build a set of already-registered skill names. Both wi_snake_name
  // and wi-kebab-name shapes are recorded so we don't double-register.
  const existing = new Set<string>();
  for (const t of catalog) {
    existing.add(t.name); // wi_snake_name
    existing.add(t.name.replace(/^wi_/, 'wi-').replace(/_/g, '-')); // wi-kebab-name
  }

  let registered = 0;
  const entries = safeReaddir(SKILLS_ROOT);
  for (const dir of entries) {
    const skillDir = join(SKILLS_ROOT, dir);
    if (!isDirectory(skillDir)) continue;
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    if (!dir.startsWith('wi-')) continue; // scope to wi-* skills only

    const skillName = dir; // wi-<kebab>
    const toolName = 'wi_' + dir.replace(/^wi-/, '').replace(/-/g, '_');
    if (existing.has(toolName) || existing.has(skillName)) continue;

    let fm: Frontmatter = {};
    try {
      fm = parseSkillFrontmatter(readFileSync(skillMd, 'utf8'));
    } catch (e) {
      console.warn(`[skill-autoregister] frontmatter parse failed for ${skillName}: ${(e as Error).message}`);
    }

    catalog.push({
      name: toolName,
      description: fm.description || `Auto-registered from ${skillName}/SKILL.md`,
      category: 'auto',
      posture_eligibility: ['generic'],
      estimated_duration_ms: 30000,
      input_schema:
        (fm.input_schema as { type?: string } | undefined) ?? {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'Free-text goal or query for the skill' },
          },
          additionalProperties: true,
        },
      handler: async (input, ctx) => {
        const { runSkillSubagent } = await import('./skill-dispatch.js');
        return runSkillSubagent(skillName, input as SkillDispatchArgs, {
          db: ctx.db,
          sessionId: ctx.session_id,
        });
      },
    });
    registered++;
  }
  return registered;
}

/**
 * Parse the leading YAML block from a SKILL.md file. Returns an
 * empty object if no frontmatter present or if parsing fails. Uses
 * a minimal line-based parser rather than pulling in js-yaml — the
 * frontmatter is simple (name, description, input_schema) and this
 * keeps the module dep-free.
 */
export function parseSkillFrontmatter(content: string): Frontmatter {
  const lines = content.split('\n');
  if (lines[0] !== '---') return {};
  const endIdx = lines.findIndex((l, i) => i > 0 && l === '---');
  if (endIdx < 0) return {};

  const fm: Frontmatter = {};
  const yaml = lines.slice(1, endIdx);
  let inputSchemaCollecting = false;
  const inputSchemaLines: string[] = [];

  for (const line of yaml) {
    if (inputSchemaCollecting) {
      inputSchemaLines.push(line);
      continue;
    }
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === 'name') fm.name = unquote(value);
    else if (key === 'description') fm.description = unquote(value);
    else if (key === 'input_schema') {
      inputSchemaCollecting = true;
      if (value) inputSchemaLines.push(value);
    }
  }

  if (inputSchemaLines.length > 0) {
    const raw = inputSchemaLines.join('\n').trim();
    try {
      fm.input_schema = JSON.parse(raw);
    } catch {
      // Silent — schema stays undefined, caller uses default.
    }
  }
  return fm;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
