#!/usr/bin/env bash
#
# scripts/smoke-doc-embeddings.sh — ADR-042 Gap 2 (doc_embeddings) smoke.
#
# Hermetic: runs the v101 migration + embedDocs + searchDocs against a
# throwaway temp DB via the compiled dist/, over the REAL docs/docs corpus.
# No bridge needed. Ollama-gated checks SKIP cleanly when Ollama is down.
#
# Usage:
#   npm run build           # dist/ must reflect current TS
#   npm run smoke:doc-embeddings
#
# Exit 0 on all-green (SKIPs count as pass); exit 1 on any hard failure.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"

pass_count=0
fail_count=0
skip_count=0
pass() { echo "  ✓ PASS: $1"; pass_count=$((pass_count+1)); }
fail() { echo "  ✗ FAIL: $1"; fail_count=$((fail_count+1)); }
skip() { echo "  ○ SKIP: $1"; skip_count=$((skip_count+1)); }

require() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not on PATH"; exit 2; }; }
require node
require sqlite3

echo "═══════════════════════════════════════════════════"
echo "ADR-042 Gap 2 — doc_embeddings smoke (hermetic)"
echo "═══════════════════════════════════════════════════"

# ── § 0 preflight — dist present, corpus present ────────────────────────────
echo ""
echo "── § 0. Preflight ──"
if [ ! -f "$REPO/dist/services/embedder.js" ] || [ ! -f "$REPO/dist/db/migrations/v101_doc_embeddings.js" ]; then
  fail "§ 0.1 — dist not built (run: npm run build)"
  echo "════════ Smoke aborted ═══════"; exit 1
fi
pass "§ 0.1 — dist artifacts present"
adr_count=$(ls "$REPO"/docs/docs/adr/*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$adr_count" -lt 1 ]; then fail "§ 0.2 — no ADR corpus at docs/docs/adr"; exit 1; fi
pass "§ 0.2 — ADR corpus present ($adr_count files)"

# ── § 1 ollama availability (gates the live checks) ─────────────────────────
echo ""
echo "── § 1. Ollama availability ──"
OLLAMA_UP=0
if node --input-type=module -e "
import { checkOllamaAvailable } from '$REPO/dist/services/embedder.js';
process.exit((await checkOllamaAvailable()) ? 0 : 3);
" 2>/dev/null; then OLLAMA_UP=1; pass "§ 1.1 — Ollama + nomic-embed-text reachable"; else skip "§ 1.1 — Ollama down → live checks skipped"; fi

# ── § 2 migration + schema shape (no Ollama needed) ─────────────────────────
echo ""
echo "── § 2. Migration v101 ──"
TMPDB="/tmp/wi-docembed-smoke-$$.db"
rm -f "$TMPDB" "$TMPDB-wal" "$TMPDB-shm"
node --input-type=module -e "
import Database from 'better-sqlite3';
import migrateV101 from '$REPO/dist/db/migrations/v101_doc_embeddings.js';
const db = new Database('$TMPDB');
db.exec('CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
migrateV101(db); migrateV101(db); // idempotent
const cols = db.prepare('PRAGMA table_info(doc_embeddings)').all().map(c=>c.name).sort().join(',');
const want = 'content_hash,doc_kind,embedded_at,embedding,model,path,title';
if (cols !== want) { console.error('COLS_MISMATCH:'+cols); process.exit(1); }
db.close();
" 2>/tmp/docembed-s2.err && pass "§ 2.1 — v101 applies, idempotent, correct columns" || { fail "§ 2.1 — $(cat /tmp/docembed-s2.err | head -1)"; }

# ── § 3 embedDocs backfill + change-hash (live) ─────────────────────────────
echo ""
echo "── § 3. embedDocs backfill ──"
if [ "$OLLAMA_UP" = "1" ]; then
  RES=$(node --input-type=module -e "
import Database from 'better-sqlite3';
import migrateV101 from '$REPO/dist/db/migrations/v101_doc_embeddings.js';
import { embedDocs, searchDocs } from '$REPO/dist/services/embedder.js';
const db = new Database('$TMPDB');
const r1 = await embedDocs(db, '$REPO');
const r2 = await embedDocs(db, '$REPO'); // re-run: all unchanged
const total = db.prepare('SELECT COUNT(*) n FROM doc_embeddings').get().n;
const hits = await searchDocs('search-provider proxy returns 401 authentication', db, 5);
const topKind = hits[0] ? hits[0].doc_kind : 'none';
console.log(JSON.stringify({ indexed:r1.indexed, skipped:r1.skipped, rerunUnchanged:r2.unchanged, rerunIndexed:r2.indexed, total, hitCount:hits.length, topKind }));
db.close();
" 2>/tmp/docembed-s3.err)
  if [ -z "$RES" ]; then fail "§ 3 — embedDocs threw: $(head -1 /tmp/docembed-s3.err)";
  else
    indexed=$(echo "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).indexed))")
    skipped=$(echo "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).skipped))")
    total=$(echo "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).total))")
    rerunIdx=$(echo "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).rerunIndexed))")
    hitCount=$(echo "$RES" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).hitCount))")
    [ "$indexed" -ge 1 ] 2>/dev/null && pass "§ 3.1 — backfill indexed $indexed docs (total $total)" || fail "§ 3.1 — indexed 0"
    [ "$skipped" -eq 0 ] 2>/dev/null && pass "§ 3.2 — 0 files skipped (truncation-cap holds for the whole corpus)" || fail "§ 3.2 — $skipped files skipped (embed failures — check char cap)"
    [ "$rerunIdx" -eq 0 ] 2>/dev/null && pass "§ 3.3 — change-hash: re-run re-embeds 0 (all unchanged)" || fail "§ 3.3 — re-run re-embedded $rerunIdx (change-detection broken)"
    [ "$hitCount" -ge 1 ] 2>/dev/null && pass "§ 3.4 — searchDocs returns hits for a doc-shaped query ($hitCount)" || fail "§ 3.4 — searchDocs returned 0"
  fi
else
  skip "§ 3 — embedDocs/searchDocs (Ollama down)"
fi

rm -f "$TMPDB" "$TMPDB-wal" "$TMPDB-shm" /tmp/docembed-s2.err /tmp/docembed-s3.err

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "doc_embeddings smoke: $pass_count passed, $fail_count failed, $skip_count skipped"
echo "═══════════════════════════════════════════════════"
[ "$fail_count" -gt 0 ] && exit 1
exit 0
