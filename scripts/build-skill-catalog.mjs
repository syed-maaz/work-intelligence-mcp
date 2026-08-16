#!/usr/bin/env node
// scripts/build-skill-catalog.mjs
// Parse every skills/<name>/SKILL.md frontmatter -> skills/_catalog.json.
// Malformed YAML per-file is logged into "errors" and skipped; other skills continue.
//
// Usage: node scripts/build-skill-catalog.mjs

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(REPO, 'skills');
const OUT = join(SKILLS_DIR, '_catalog.json');

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { ok: false, error: 'no frontmatter' };
  try {
    return { ok: true, data: yaml.load(m[1]) };
  } catch (e) {
    return { ok: false, error: `yaml parse: ${e.message}` };
  }
}

const skills = [];
const errors = [];

for (const name of readdirSync(SKILLS_DIR)) {
  // Skip _catalog.json and other _-prefixed entries EXCEPT _TEMPLATE.
  if (name.startsWith('_') && name !== '_TEMPLATE') continue;
  if (name === '_TEMPLATE') continue;
  const dir = join(SKILLS_DIR, name);
  if (!statSync(dir).isDirectory()) continue;
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) continue;

  const fm = parseFrontmatter(readFileSync(skillMd, 'utf8'));
  if (!fm.ok) {
    errors.push({ skill: name, error: fm.error });
    continue;
  }
  const data = fm.data || {};
  const meta = data.metadata || {};
  skills.push({
    name: data.name || name,
    description: data.description || '',
    argument_hint: data['argument-hint'] || '',
    bucket: meta.bucket || null,
    invocation: meta.invocation || null,
    run_script: meta.run_script || null,
    endpoints: meta.endpoints || [],
    reads_tables: meta.reads_tables || [],
    writes_tables: meta.writes_tables || [],
    writes_mutating: !!meta.writes_mutating,
    related_skills: meta.related_skills || [],
    triggers: meta.triggers || [],
    model: meta.model || null,
    born: meta.born || null,
    last_verified: meta.last_verified || null,
    subcommands: meta.subcommands || null,
    _skill_dir: `skills/${name}`,
  });
}

const output = {
  generated_at: new Date().toISOString(),
  generator: 'scripts/build-skill-catalog.mjs v1',
  count: skills.length,
  errors,
  skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
};

writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');
console.log(`wrote ${OUT} — ${skills.length} skills, ${errors.length} errors`);
// Exit 0 even with per-file errors: they are logged in the JSON for the
// caller to inspect. A non-zero exit here would STOP the whole runbook on
// one malformed pre-existing skill, which is not the intent.
process.exit(0);
