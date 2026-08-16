---
name: wi-disk-audit
description: "Audit macOS dev-machine disk usage and recover from runaway claude-mem bloat. Systematic walk (df → per-dir → find rogue big files) plus a proven three-stage claude-mem recovery (kill concurrent prunes → clean JSONL → VACUUM + wal_checkpoint(TRUNCATE) + FTS rebuild). Use when disk is full, claude-mem.db is multi-GB, or the daily prune cron is misbehaving."
trigger_phrases:
  - "what's taking up my disk"
  - "free disk space"
  - "recover from claude-mem bloat"
  - "disk full"
  - "macos disk audit"
argument-hint: "[mode: audit | recover | verify]"
allowed-tools:
  - Bash
---

<objective>
Answer "what's eating my disk?" on a macOS dev box, and — when the answer is claude-mem — surgically reclaim space without losing observations. Optimised for the specific failure profile of a WI/Claude Code power user: unbounded `claude-mem.db` growth (upstream issue thedotmack/claude-mem#2793), runaway `~/.claude/projects/*-observer-sessions/` JSONL, and concurrent-cron double-fault regressions.

**Cardinal rules:**
- `du` on macOS home MUST use `-x` (never `-L`). Sandboxed apps in `~/Library/Containers/` symlink back to `~` — plain `du` double-counts silently.
- Never `sqlite3 .backup` a live claude-mem DB. It livelocks against ~20 worker connections. Use `cp -c` (APFS clone, instant, 0 real bytes).
- Never DELETE from `observations` — that's the durable knowledge. The bloat lives in `user_prompts`, `sdk_sessions.user_prompt`, `user_prompts_fts_data`, and the JSONL dir.
</objective>

<process>

## Mode: audit — figure out what's eating the disk

1. Establish baseline:
   ```bash
   df -h /System/Volumes/Data | tail -1
   diskutil info / | grep -E "Free Space|Capacity"
   sysctl vm.swapusage
   ```
   Under ~20 GB free is critical (macOS needs ~10 GB headroom for swap + APFS snapshots).

2. Top-level home sweep (background it — 2-3 min on a 200+ GB home):
   ```bash
   du -shx /Users/$USER/*/ 2>/dev/null | sort -hr
   du -shx /Users/$USER/.??*/ 2>/dev/null | sort -hr | head -20   # hidden dirs too
   ```

3. Score the three usual suspects on a WI machine:
   ```bash
   du -shx ~/.claude ~/.claude-mem ~/Library/Application\ Support/Claude 2>/dev/null
   du -shx ~/.work-intelligence-mcp ~/.hermes 2>/dev/null
   ```

4. Find any single mega-file > 500 MB (catches unbounded-log-file bugs invisible to summary scans):
   ```bash
   find /Users/$USER -xdev -type f -size +500M 2>/dev/null
   ```

5. If `~/.claude-mem/claude-mem.db` is > 5 GB **or** the JSONL dir at
   `~/.claude/projects/-Users-$USER--claude-mem-observer-sessions/` is > 5 GB → jump to `mode: recover`.

6. Report top-10 by size with recoverable-space ranking. **Stop and ask** before deleting anything.

## Mode: recover — reclaim space from runaway claude-mem

**Preconditions to check first (skip nothing — the 2026-07-09 double-fault came from skipping step 1):**

1. Kill every concurrent prune-in-flight AND its sqlite3 child:
   ```bash
   pkill -f claude-mem-prune.sh 2>/dev/null; true
   pkill -f 'sqlite3.*claude-mem' 2>/dev/null; true
   sleep 2
   pgrep -fla "claude-mem-prune|sqlite3.*claude-mem" || echo "all stopped"
   ```

2. Delete any diverged APFS clone backups (they lose rollback value the moment their source's DELETEs commit):
   ```bash
   rm -v ~/.claude-mem/claude-mem.db.cron-backup-* 2>/dev/null
   ```

3. Move JSONL aside FIRST (no scratch cost; self-provisions VACUUM headroom):
   ```bash
   JSONL=$HOME/.claude/projects/-Users-$USER--claude-mem-observer-sessions
   if [ -d "$JSONL" ]; then
     mv "$JSONL" "$JSONL.trash-$(date +%Y%m%d-%H%M%S)"
     ( nohup rm -rf "$JSONL.trash-"* >/dev/null 2>&1 & )
   fi
   ```

4. Capture pre-state (`observations` count is the number you MUST preserve):
   ```bash
   DB=$HOME/.claude-mem/claude-mem.db
   sqlite3 "$DB" "PRAGMA busy_timeout=30000;
     SELECT 'observations' t, COUNT(*) c FROM observations
     UNION ALL SELECT 'user_prompts', COUNT(*) FROM user_prompts
     UNION ALL SELECT 'sdk_sessions', COUNT(*) FROM sdk_sessions;"
   ```

5. APFS clone insurance (instant, 0 real bytes):
   ```bash
   cp -c "$DB" "$DB.backup-$(date +%Y%m%d-%H%M%S)"
   ```

**The three-stage shrink (all steps required — proven 2026-07-09):**

6. Stage A — DELETE + FTS rebuild in a transaction (drops raw prompt bloat):
   ```bash
   sqlite3 "$DB" <<'SQL'
   PRAGMA busy_timeout = 60000;
   BEGIN IMMEDIATE TRANSACTION;
   DROP TRIGGER IF EXISTS user_prompts_ai;
   DROP TRIGGER IF EXISTS user_prompts_ad;
   DROP TRIGGER IF EXISTS user_prompts_au;
   DELETE FROM user_prompts;
   UPDATE sdk_sessions SET user_prompt = NULL;
   DELETE FROM pending_messages WHERE status='failed';
   CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
     INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
   END;
   CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
     INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
     VALUES('delete', old.id, old.prompt_text);
   END;
   CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
     INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
     VALUES('delete', old.id, old.prompt_text);
     INSERT INTO user_prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
   END;
   COMMIT;
   INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild');
   SQL
   ```

7. Stage B — VACUUM to rebuild the DB into compact form (30 s – 5 min):
   ```bash
   sqlite3 "$DB" "PRAGMA busy_timeout=180000; VACUUM;"
   ```

8. Stage C — **wal_checkpoint(TRUNCATE) — mandatory, do not skip**:
   VACUUM alone can leave the main file oversized while WAL holds the compact copy. Explicit truncate collapses them (took 113 GB → 15 GB in < 1 s on 2026-07-09).
   ```bash
   sqlite3 "$DB" "PRAGMA busy_timeout=60000; PRAGMA wal_checkpoint(TRUNCATE);"
   ls -lh "$DB"
   ```

9. If the DB is still > 100 MB, the `user_prompts_fts_data` shadow still has stale rows — rebuild + VACUUM once more (took 15 GB → 78 MB in 1.2 s):
   ```bash
   sqlite3 "$DB" "PRAGMA busy_timeout=60000;
     INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild');"
   sqlite3 "$DB" "PRAGMA busy_timeout=60000; VACUUM;"
   ```

## Mode: verify — integrity check + observation-count preservation

10. Confirm nothing corrupted and no memory was lost:
    ```bash
    DB=$HOME/.claude-mem/claude-mem.db
    sqlite3 -readonly "$DB" "PRAGMA integrity_check;"    # must say 'ok'
    sqlite3 "$DB" "PRAGMA busy_timeout=30000;
      SELECT project, COUNT(*) FROM observations
      GROUP BY project ORDER BY 2 DESC LIMIT 10;"
    df -h /System/Volumes/Data | tail -1
    ```

11. Sanity-check WI can still see the observations it depends on:
    ```bash
    sqlite3 "$DB" "SELECT COUNT(*) FROM observations
      WHERE      project IN ('work-intelligence-mcp', 'your-repo-name');"
    ```
    Count should be > 0 and match pre-cleanup value from step 4. If it dropped to zero, restore from the APFS backup made in step 5.

## Prevention (do this once, not per-incident)

12. Daily prune cron via Hermes (silent watchdog pattern):
    - Script: `~/.hermes/scripts/claude-mem-prune.sh` (hardened v2 — flock lock, 15 GB free-space precheck, mandatory `wal_checkpoint(TRUNCATE)` after VACUUM, JSONL-first ordering)
    - Cron: `0 4 * * *`, `no_agent=true`, `deliver=origin`
    - Threshold: 2 GB per side (DB / JSONL); under threshold = silent exit
    - **Daily, not weekly** — observed regrowth is ~14 GB/day of raw prompts on a heavy user; a 7-day gap is enough to refill a fresh cleanup.

## Failure modes and their fixes (2026-06 → 2026-07 field notes)

| Symptom | Root cause | Fix |
|---|---|---|
| VACUUM exits 0 but file still huge | Compact form lives in WAL; main file unchanged | `PRAGMA wal_checkpoint(TRUNCATE)` |
| Two `cron-backup-*` files near the DB size same minute | Concurrent prune runs, each APFS clone diverged | Kill both, delete both clones, add `flock` to script |
| VACUUM hangs or fails when disk near-full | VACUUM needs scratch ≈ DB size; ran below floor | Precheck `df` ≥ 15 GB free; clean JSONL first to self-provision |
| DB shrinks to ~15 GB but not further | `user_prompts_fts_data` holds stale rows | FTS rebuild + second VACUUM (1.2 s) |
| DB grew from 88 MB → 113 GB in 10 days | Weekly cron too slow for real regrowth cadence | Change cron to daily `0 4 * * *` |
| `du -h ~/Library` reports 90+ GB in an app container | Symlinks back into `~` inflate count | Always use `du -x`; `ls -la` the dir to spot `lrwxr-xr-x` |
| `sqlite3 .backup` livelocks | Online-backup API restarts on every modified page under worker load | Use `cp -c` (APFS clone) instead |
| `claude-mem stop` doesn't stop workers | Session-init hooks in every open Claude Code window respawn workers within seconds | CMD+Q the Claude Code app first (not just close window), then `claude-mem stop` — OR operate online with `busy_timeout=60000` on your connection |

## Interlock with WI

Both `~/.work-intelligence-mcp/data.db` (WI store — usually 1-2 GB, healthy) and `~/.claude-mem/claude-mem.db` (claude-mem store — the offender) are queried by the WI bridge. This skill only touches the claude-mem file. It never reads, writes, or migrates the WI DB. If the WI DB itself is huge, that's a different investigation — check bridge `SKIP_SYNC=1` state and see the WI health skill.

</process>
