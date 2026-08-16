/**
 * Substrate fix #3 — GET /api/skills + GET /api/skills/<name>
 *
 * Closes the asymmetric-prompt-scaffolding gap from the Hermes Agent decline.
 * Today only Claude Code reads the 26 wi-* skills' SKILL.md bodies via
 * ~/.claude/skills/work-intelligence/<name>/ symlinks. Other consumers
 * future consumer see only wire tools (TOOL_MANIFEST). This endpoint serves
 * the SKILL.md body so consumers can fetch and inject prompt scaffolding
 * when invoking the matching wi_* tool.
 *
 * Endpoints:
 *   GET /api/skills                     — index: [{name, description, tool_called}]
 *   GET /api/skills/<name>              — full body: {name, body, frontmatter}
 *   GET /api/skills/<name>?refresh=1    — invalidate cache for this entry
 *
 * Strict path validation — no '..' allowed. 60-min cache. 404 on miss.
 *
 * Refs: .planning/ADR-REVIEW.md graphify+Hermes decline → substrate fix #3.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { json } from './_util.js';
import type { RouteHandler } from './_types.js';

const CACHE_TTL_MS = 60 * 60 * 1000;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface SkillFrontmatter {
  name?: string;
  description?: string;
  'argument-hint'?: string;
  'allowed-tools'?: string[] | string;
  [key: string]: unknown;
}

interface SkillIndexEntry {
  name: string;
  description: string;
  tool_called: string | null;
}

interface SkillBody {
  name: string;
  frontmatter: SkillFrontmatter;
  body: string;
}

interface CacheEntry<T> {
  result: T;
  expiresAt: number;
}

const indexCache = new Map<string, CacheEntry<SkillIndexEntry[]>>();
const bodyCache = new Map<string, CacheEntry<SkillBody>>();

/**
 * Locate the project's skills/ directory. The bridge runs from the project
 * root, so this is just `<cwd>/skills`. Falls back to scanning relative to
 * this file's location when cwd looks wrong (e.g. running under `npx`).
 */
function locateSkillsDir(): string | null {
  const fromCwd = resolve(process.cwd(), 'skills');
  if (existsSync(fromCwd) && statSync(fromCwd).isDirectory()) return fromCwd;

  // Fallback: relative to this file (dist/routes/skills.js → ../../skills)
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const fromHere = resolve(here, '..', '..', 'skills');
    if (existsSync(fromHere) && statSync(fromHere).isDirectory()) return fromHere;
  } catch { /* ignore */ }

  return null;
}

/**
 * Parse a SKILL.md file's YAML frontmatter (between leading `---` markers)
 * and the rest as the body. Frontmatter parsing is intentionally minimal —
 * key: value, with `,`-separated lists for allowed-tools. Avoids pulling in
 * a full YAML dep for what is by convention very simple frontmatter.
 */
function parseSkillFile(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: {}, body: raw };
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }
  const fmRaw = raw.slice(4, end);
  const body = raw.slice(end + 5);

  const frontmatter: SkillFrontmatter = {};
  for (const line of fmRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key === 'allowed-tools' && value) {
      frontmatter[key] = value.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body };
}

/**
 * Cheap heuristic — pull the first wi_* or mcp__work-intelligence__* tool
 * name from frontmatter.allowed-tools so the index can show "this skill
 * primarily wraps wi_search". Not authoritative.
 */
function inferToolCalled(fm: SkillFrontmatter): string | null {
  const tools = fm['allowed-tools'];
  if (!tools) return null;
  const list = Array.isArray(tools) ? tools : [tools];
  for (const t of list) {
    const m = /(wi_[a-z_]+|mcp__work-intelligence__[a-z_]+)/.exec(String(t));
    if (m) return m[1];
  }
  return null;
}

function loadIndex(skillsDir: string): SkillIndexEntry[] {
  const entries = readdirSync(skillsDir);
  const result: SkillIndexEntry[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('wi-')) continue;
    const skillFile = join(skillsDir, entry, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const raw = readFileSync(skillFile, 'utf8');
      const { frontmatter } = parseSkillFile(raw);
      result.push({
        name: entry,
        description: String(frontmatter.description ?? '').slice(0, 280),
        tool_called: inferToolCalled(frontmatter),
      });
    } catch {
      // Skip unreadable; don't fail the whole index.
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function loadSkillBody(skillsDir: string, name: string): SkillBody | null {
  const skillFile = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(skillFile)) return null;
  const raw = readFileSync(skillFile, 'utf8');
  const { frontmatter, body } = parseSkillFile(raw);
  return { name, frontmatter, body };
}

const skillsIndexRoute: RouteHandler = {
  method: 'GET',
  path: '/api/skills',
  handle(_req, res, _ctx, url) {
    try {
      const refresh = url.searchParams.get('refresh') === '1';
      const cacheKey = 'index';
      if (!refresh) {
        const hit = indexCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now()) {
          json(res, 200, { skills: hit.result, cached: true });
          return;
        }
      }
      const skillsDir = locateSkillsDir();
      if (!skillsDir) {
        json(res, 200, { skills: [], cached: false, warning: 'skills directory not found' });
        return;
      }
      const skills = loadIndex(skillsDir);
      indexCache.set(cacheKey, { result: skills, expiresAt: Date.now() + CACHE_TTL_MS });
      json(res, 200, { skills, cached: false });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[skills/index] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

const skillsBodyRoute: RouteHandler = {
  method: 'GET',
  path: '/api/skills/:name',
  handle(_req, res, _ctx, url) {
    try {
      // Path is /api/skills/<name> — extract last segment.
      const parts = url.pathname.split('/').filter(Boolean);
      const name = parts[parts.length - 1] ?? '';

      // Strict validation — no traversal, only known skill-name shape.
      if (!SKILL_NAME_RE.test(name)) {
        json(res, 400, { error: 'invalid_skill_name', message: 'skill name must match [a-z0-9-]{1,64}' });
        return;
      }

      const refresh = url.searchParams.get('refresh') === '1';
      if (!refresh) {
        const hit = bodyCache.get(name);
        if (hit && hit.expiresAt > Date.now()) {
          json(res, 200, { ...hit.result, cached: true });
          return;
        }
      }
      const skillsDir = locateSkillsDir();
      if (!skillsDir) {
        json(res, 404, { error: 'not_found', message: 'skills directory not configured' });
        return;
      }
      const body = loadSkillBody(skillsDir, name);
      if (!body) {
        json(res, 404, { error: 'not_found', message: `skill not found: ${name}` });
        return;
      }
      bodyCache.set(name, { result: body, expiresAt: Date.now() + CACHE_TTL_MS });
      json(res, 200, { ...body, cached: false });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[skills/body] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

export const skillsRoutes: RouteHandler[] = [skillsIndexRoute, skillsBodyRoute];
