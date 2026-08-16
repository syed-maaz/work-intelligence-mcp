/**
 * Phase 79-08 — Obsidian vault indexer.
 *
 * Responsibilities:
 *  1. Boot scan: reads all .md files under OBSIDIAN_VAULT_PATH, parses
 *     frontmatter and splits on SEPARATOR, UPSERTs into obsidian_notes.
 *  2. File watcher: fs.watch on the vault directory (recursive) with a
 *     2-second debounce. On file change, re-indexes that single file.
 *  3. syncSingleFile(filePath): exported for tests and explicit triggers.
 *
 * Reuses SEPARATOR and extractPeopleNames from obsidian-export.ts.
 * Does NOT duplicate frontmatter parsing — uses a minimal inline parser
 * because gray-matter is not installed (and the full YAML is stored as
 * JSON for later use; no heavy parsing needed at index time).
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { SEPARATOR } from '../../tools/obsidian-export.js';

const DEBOUNCE_MS = 2000;
const WIKILINK_RE = /\[\[([^\]|#]+?)(?:\|[^\]]+)?\]\]/g;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

// ── Frontmatter + body split ────────────────────────────────────────────────

interface ParsedNote {
  fileName: string;
  topicName: string;
  frontmatterJson: string;
  wiBody: string;
  userAnnotations: string;
  wikilinksJson: string;
  tagsJson: string;
  fileMtimeEpoch: number;
}

function parseVaultFile(filePath: string): ParsedNote | null {
  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fileName = path.basename(filePath);
    const baseName = fileName.replace(/\.md$/, '');

    // Frontmatter
    let bodyStart = 0;
    let frontmatterJson = '{}';
    const fmMatch = FRONTMATTER_RE.exec(raw);
    if (fmMatch) {
      bodyStart = fmMatch[0].length;
      // Minimal YAML-line-to-JSON: store raw YAML lines as a JSON object
      // by splitting on colon. Good enough for tags/aliases lookups.
      const obj: Record<string, string> = {};
      for (const line of fmMatch[1].split('\n')) {
        const sep = line.indexOf(':');
        if (sep > 0) {
          const k = line.slice(0, sep).trim();
          const v = line.slice(sep + 1).trim();
          if (k && v) obj[k] = v;
        }
      }
      frontmatterJson = JSON.stringify(obj);
    }

    const body = raw.slice(bodyStart);

    // Split on SEPARATOR
    const sepIdx = body.indexOf(SEPARATOR);
    let wiBody: string;
    let userAnnotations: string;
    if (sepIdx >= 0) {
      wiBody = body.slice(0, sepIdx).trim();
      userAnnotations = body.slice(sepIdx + SEPARATOR.length).trimStart();
    } else {
      wiBody = body.trim();
      userAnnotations = '';
    }

    // Wikilinks: extract from full content
    const allWikilinks: string[] = [];
    let m: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(raw)) !== null) {
      allWikilinks.push(m[1].trim());
    }
    const wikilinksJson = JSON.stringify([...new Set(allWikilinks)]);

    // Tags: from frontmatter JSON or inline #tag scan
    let tags: string[] = [];
    if (frontmatterJson !== '{}') {
      const parsed = JSON.parse(frontmatterJson) as Record<string, string>;
      if (parsed.tags) {
        tags = parsed.tags
          .replace(/[\[\]]/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }
    const tagsJson = JSON.stringify(tags);

    // Topic name: from frontmatter "topic_name" or file basename
    let topicName = baseName;
    if (frontmatterJson !== '{}') {
      const parsed = JSON.parse(frontmatterJson) as Record<string, string>;
      if (parsed.topic_name) topicName = parsed.topic_name;
    }

    return {
      fileName,
      topicName,
      frontmatterJson,
      wiBody,
      userAnnotations,
      wikilinksJson,
      tagsJson,
      fileMtimeEpoch: Math.floor(stat.mtimeMs),
    };
  } catch (err) {
    process.stderr.write(`[vault-indexer] parse failed ${filePath}: ${(err as Error).message}\n`);
    return null;
  }
}

// ── UPSERT helper ────────────────────────────────────────────────────────────

function upsertNote(db: Database.Database, filePath: string, note: ParsedNote): void {
  db.prepare(`
    INSERT INTO obsidian_notes
      (file_path, file_name, topic_name, frontmatter_json, wi_body, user_annotations,
       wikilinks_json, tags_json, file_mtime_epoch, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      file_name        = excluded.file_name,
      topic_name       = excluded.topic_name,
      frontmatter_json = excluded.frontmatter_json,
      wi_body          = excluded.wi_body,
      user_annotations = excluded.user_annotations,
      wikilinks_json   = excluded.wikilinks_json,
      tags_json        = excluded.tags_json,
      file_mtime_epoch = excluded.file_mtime_epoch,
      indexed_at       = excluded.indexed_at
  `).run(
    filePath,
    note.fileName,
    note.topicName,
    note.frontmatterJson,
    note.wiBody,
    note.userAnnotations,
    note.wikilinksJson,
    note.tagsJson,
    note.fileMtimeEpoch,
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Re-index a single vault file. Exported so tests can trigger explicit re-index
 * and so vault write-back (topic-expert) can call it after writing.
 */
export function syncSingleFile(db: Database.Database, filePath: string): void {
  if (!filePath.endsWith('.md')) return;
  const note = parseVaultFile(filePath);
  if (note) upsertNote(db, filePath, note);
}

/**
 * Scan the vault directory and UPSERT all .md files into obsidian_notes.
 * Skips files whose mtime hasn't changed since last index (fast re-runs).
 */
export function indexVault(db: Database.Database, vaultPath: string): void {
  if (!fs.existsSync(vaultPath)) {
    process.stderr.write(`[vault-indexer] vault path not found: ${vaultPath}\n`);
    return;
  }

  // Build a map of known mtimes for cheap dirty-check
  const known = new Map<string, number>();
  const rows = db
    .prepare(`SELECT file_path, file_mtime_epoch FROM obsidian_notes`)
    .all() as Array<{ file_path: string; file_mtime_epoch: number }>;
  for (const r of rows) known.set(r.file_path, r.file_mtime_epoch);

  let indexed = 0;
  let skipped = 0;

  function scanDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // skip hidden dirs (e.g. .obsidian)
        if (!entry.name.startsWith('.')) scanDir(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const mtime = Math.floor(fs.statSync(full).mtimeMs);
          if (known.get(full) === mtime) {
            skipped++;
            continue;
          }
        } catch {
          // file might have disappeared — skip
          continue;
        }
        const note = parseVaultFile(full);
        if (note) {
          upsertNote(db, full, note);
          indexed++;
        }
      }
    }
  }

  scanDir(vaultPath);
  process.stderr.write(`[vault-indexer] boot scan done: indexed=${indexed} skipped=${skipped}\n`);
}

/**
 * Start a file watcher on vaultPath. Re-indexes changed .md files with a
 * 2-second debounce. Returns a cleanup function (call on server shutdown).
 */
export function watchVault(db: Database.Database, vaultPath: string): () => void {
  if (!fs.existsSync(vaultPath)) {
    process.stderr.write(`[vault-indexer] watch skipped — path not found: ${vaultPath}\n`);
    return () => {};
  }

  const debounce = new Map<string, ReturnType<typeof setTimeout>>();

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(vaultPath, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      const full = path.join(vaultPath, filename);
      const existing = debounce.get(full);
      if (existing) clearTimeout(existing);
      debounce.set(
        full,
        setTimeout(() => {
          debounce.delete(full);
          if (fs.existsSync(full)) {
            syncSingleFile(db, full);
            process.stderr.write(`[vault-indexer] re-indexed: ${filename}\n`);
          }
        }, DEBOUNCE_MS),
      );
    });
    watcher.on('error', (err) => {
      process.stderr.write(`[vault-indexer] watcher error: ${(err as Error).message}\n`);
    });
    process.stderr.write(`[vault-indexer] watching: ${vaultPath}\n`);
  } catch (err) {
    process.stderr.write(`[vault-indexer] failed to start watcher: ${(err as Error).message}\n`);
  }

  return () => {
    for (const t of debounce.values()) clearTimeout(t);
    debounce.clear();
    watcher?.close();
  };
}
