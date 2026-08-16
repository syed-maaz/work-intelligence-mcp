# WIMenuBar — Troubleshooting

Every failure mode we've actually hit, indexed by what you'd grep for. If
something breaks and isn't covered here, add it — that's the contract.

First step always: `tail -F ~/Library/Logs/wi-menubar/menubar.log`.

---

## Node 24/26 ABI mismatch

### Symptoms

- Bridge row goes green for ~3s then back to crashed.
- `bridge.log` shows:
  ```
  Error: The module '/.../node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  was compiled against a different Node.js version using NODE_MODULE_VERSION 137.
  This version of Node.js requires NODE_MODULE_VERSION 147.
  ```
- `===== exited code=1 =====` shortly after each spawn.
- `menubar.log` shows `NvmResolver: chose /usr/local/bin/node` or
  `/opt/homebrew/bin/node` instead of an nvm path.

### Cause

`/bin/zsh -lc` loads `.zprofile` (Homebrew shellenv) **before** `.zshrc`
(nvm), so `node` resolves to Homebrew's Node 26 (ABI 147). But this repo's
`node_modules/better-sqlite3` was built for Node 24 (ABI 137). Calling
`require('better-sqlite3')` triggers `ERR_DLOPEN_FAILED` and the bridge
exits with code 1.

### Fix (already in place)

`Sources/WIMenuBar/Services/NvmResolver.swift` walks
`~/.nvm/alias/default` → `~/.nvm/versions/node/v<X.Y.Z>/bin/node` at boot
and the path is used directly in `Process.executableURL`. No shell, no
PATH lookup, no surprises.

`ServiceController` runs in two modes:

- **Mode A** (default): `definition.executable` set → invoke that binary
  directly with `definition.arguments`. PATH built from the chosen node's
  bin dir + system dirs (Homebrew's bin **excluded** on purpose).
- **Mode B** (fallback): `/bin/zsh -lc <shellCommand>`. Logged as a
  `[services] WARN  ... falling back to /bin/zsh -lc` line.

### When this regresses

If you see Mode B in the log, NvmResolver returned nil. Check:

```bash
ls -la ~/.nvm/alias/default        # must exist, content like "24" or "v24.7.0"
ls ~/.nvm/versions/node/           # must contain v* dirs
```

If both exist and resolution still fails, the resolver's step-2 enumeration
or step-2a matcher needs work. See `NvmResolver.swift` lines 65–95.

### Permanent fix (out of scope here)

Bump `better-sqlite3` to `^12.10.0` (Node 26-compatible). Tracked in
`memory/bug_better_sqlite3_node26_abi.md`. The NvmResolver workaround is
load-bearing until then.

---

## Hung bridge (port bound, no HTTP response)

### Symptoms

- Bridge row is green or `external`, but the popover panes show no data.
- `curl http://localhost:3132/api/status` times out.
- `lsof -nP -iTCP:3132 -sTCP:LISTEN` shows a node pid.
- `bridge.log` ends in a V8 stack trace + `===== exited code=6 =====`.
- `menubar.log` shows `connect(bridge) — port 3132 owned by pid X and healthy;
  adopting as external` from a much earlier click.

### Cause

Bridge crashed with SIGABRT mid-HTTP-request. The listening socket is still
in the kernel's accept queue (process not fully torn down or replaced by a
zombie), but no userspace code is reading from it. From outside, the port
"looks" up.

### Fix (already in place)

`ServicesCoordinator.connect()` now performs an HTTP health probe before
adopting:

```
[services] connect(bridge) requested
[services] healthyExternal(bridge) — http://localhost:3132/api/status → no-response (ok=false)
[services] connect(bridge) — port 3132 bound by pid X but not healthy; reclaiming
```

It SIGTERMs the dead process, waits 200ms for the kernel to release the
bind, then spawns fresh via NvmResolver.

### Manual recovery

If the auto-reclaim ever fails (e.g. EPERM on kill because the bridge
runs under a different uid):

```bash
lsof -ti :3132 | xargs kill -9
sleep 2
SKIP_SYNC=1 node --env-file=.env web-server.js   # from repo root
```

Or just click **Connect** in the menubar — the new code path handles it.

---

## Morning brief never appears

### Symptoms

- Popover opens, brief card is collapsed/empty or shows just the day label.
- `menubar.log` has either
  ```
  [network] WARN  GET /api/morning-brief → err 12001ms: The request timed out.
  ```
  (pre-fix) or
  ```
  [app] WARN  dailyBrief fetch failed: The request timed out.
  ```
  (post-fix on really slow days).

### Cause

The first call of the day misses the bridge's 1h server-side cache and ends
up hitting Anthropic. Observed 25–55s wall time on `claude-sonnet-4-6`. The
old client-side timeout (12s) was below the cold-call floor.

### Fix (already in place)

`BridgeAPI.fetchDailyBrief`:

- `req.timeoutInterval = 60.0`
- Ephemeral session with matching 60s `timeoutIntervalForRequest` and
  `timeoutIntervalForResource`
- Explicit `WILog.network.info("GET /api/morning-brief → start (timeout 60s)")`
  so you can see the call in flight

`DataCoordinator.briefLoading` flips true while the call is outstanding;
`DailyBriefHeader` renders:

> Generating today's brief (up to 60s on cold cache)…

…with a `ProgressView` instead of empty rows.

### To warm the cache manually

```bash
curl -sS --max-time 90 http://localhost:3132/api/morning-brief > /dev/null
```

Then reopen the popover — it'll paint in <500ms from the now-warm cache.

---

## Menubar process disappears

### Symptoms

- WI icon is gone from the menu bar.
- `pgrep -lf WIMenuBar` is empty.
- No `.ips` file in `~/Library/Logs/DiagnosticReports/`.
- `menubar.log` ends mid-session without an `atexit` clean-exit marker.

### Cause categories

1. **SIGKILL** — Activity Monitor force-quit, user typed `kill -9`, or
   macOS reaped the process during sleep/low-memory. Crash interceptors
   don't fire on SIGKILL by design.
2. **SwiftUI render fatal** — a `let` inside a view-builder closure
   evaluating to a precondition failure. Historically caused by the
   `crashedCount`/`runningCount` declarations inside a `Button` label;
   fixed by hoisting those to the parent body.
3. **Out-of-memory** — never observed in practice (footprint stays under
   60 MB) but theoretically possible.

### What the log will show

- For (1) — no special markers, just the last normal log line before kill.
- For (2) — usually an `[ui]` line referencing the offending view + a
  `===== signal SIGABRT =====` from the swift runtime trapping the fatal.
  Re-launch reproduces it.
- For (3) — `[crash] uncaught` from the macOS Jetsam handler if it lands
  before the process is force-terminated.

### Recovery

Just `open WIMenuBar.app` again (or `npm run menubar:run`). Telemetry will
restart from the boot banner.

---

## Bridge logs say `database is locked`

### Symptoms

```
[Bugs] uncaughtException: database is locked
[CodeGraphIndexer] example-service incremental failed: database is locked
```

### Cause

Two writers hit `~/.work-intelligence-mcp/data.db` at once. Almost always
because two bridge processes are running — usually one manually started
in a terminal and one spawned by the menubar.

### Fix

```bash
pgrep -lf web-server.js                       # there should be ONE
lsof -ti :3132 | xargs kill -9
# wait, then start exactly one bridge (menubar Connect button, OR terminal,
# never both)
```

If the menubar adopted an external listener that you forgot about, the
**Stop** action on the bridge row will SIGTERM it cleanly.

---

## Auto-sync errors in bridge.log (cosmetic but noisy)

These are **bridge-side, not menubar bugs** — listed here so you don't
spend time chasing them when reading `bridge.log`:

| Log line | What it really is | Severity |
|----------|-------------------|----------|
| `[Teams] timed out after 300s` | Playwright couldn't drive Teams web (auth lapsed / Chrome busy) | warn |
| `[palace-enricher] query error: no such column: name` | MemPalace schema drift; harmless, retries next cycle | warn |
| `[AutoSync] checkEndedMeetings error: table data_quality has no column named source` | Schema migration drift; non-fatal | warn |
| `[Calendar] Email extract failed: 502 Network error: you are offline` | Outlook web blip; falls back to native calendar | warn |

None of these will appear in `menubar.log` — they're bridge-internal.

---

## Quick reference

### Log paths

```
~/Library/Logs/wi-menubar/menubar.log    # menubar app
~/Library/Logs/wi-menubar/bridge.log     # bridge (when spawned by us)
~/Library/Logs/wi-menubar/web.log        # web UI (when spawned by us)
~/Library/Logs/wi-menubar/docs.log       # docs (when spawned by us)
~/Library/Logs/DiagnosticReports/WIMenuBar*.ips  # macOS crash reports
```

### Sanity checklist when nothing seems to work

```bash
# 1. menubar alive?
pgrep -lf WIMenuBar

# 2. node version it picked?
grep "NvmResolver: chose" ~/Library/Logs/wi-menubar/menubar.log | tail -1
# expected: /Users/<you>/.nvm/versions/node/v24.7.0/bin/node

# 3. bridge alive and responding?
curl -sS --max-time 5 http://localhost:3132/api/status | head -c 200

# 4. any unhandled crashes since last boot?
grep -E "\[crash\]|===== signal" ~/Library/Logs/wi-menubar/menubar.log | tail

# 5. any failed network calls in last 100 lines?
grep "WARN  GET" ~/Library/Logs/wi-menubar/menubar.log | tail -10
```

### Clean rebuild from scratch

```bash
cd tools/wi-menubar
npm run menubar:clean
npm run menubar:build
pkill -x WIMenuBar 2>/dev/null
open WIMenuBar.app
tail -F ~/Library/Logs/wi-menubar/menubar.log
```

---

## Menubar item disappears silently (no crash dialog, no `.ips`)

### Symptoms

- Menubar icon is gone. No "WIMenuBar quit unexpectedly" dialog.
- `~/Library/Logs/DiagnosticReports/` has no `WIMenuBar*.ips` file.
- `menubar.log` stops mid-stream — last line is a successful `GET ... → 200`,
  then nothing. **No `===== signal SIG... =====` banner. No `===== clean
  exit =====` banner.**
- Usually happens when the Mac has been under memory pressure for a while
  (Activity Monitor → Memory tab shows red/yellow Memory Pressure).

### Cause

macOS **jetsam** — the kernel-level memory-pressure killer — sent SIGKILL
to free pages. WIMenuBar is `LSUIElement=true` and runs in the background,
so jetsam prefers it over foreground apps when it has to pick a victim.

SIGKILL is the only POSIX signal that **cannot be intercepted**. Our
`WILog.installSignalHandlers` (`Services/WILog.swift:280`) catches SIGSEGV,
SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGPIPE, SIGTERM and leaves a banner. SIGKILL
bypasses every handler — the kernel reaps the process directly. That's why
the log just stops with no banner and no crash report.

This is not a bug in the Swift app. Inspected on 2026-06-23 — `DataCoordinator`,
`SignalEngine`, `Notifier`, `BridgeAPI`, `StatusPoller` all bound their state;
no leaks. Working set is tens of MB. Jetsam kills it because it can, not
because it has to.

### Fix

User LaunchAgent with `KeepAlive=true` so launchd resurrects the process
within ~10 s of any kill:

```bash
npm run menubar:autostart:on
```

Once installed:

```bash
# Status
npm run menubar:autostart:status

# Remove
npm run menubar:autostart:off
```

The plist lives at `~/Library/LaunchAgents/com.work-intelligence.menubar.plist`.
Template source: `tools/wi-menubar/scripts/com.work-intelligence.menubar.plist.template`.
launchd captures pre-WILog stderr at `~/Library/Logs/wi-menubar/launchagent.err`
— check there first if the menubar item never appears after install.

### Verify it works

```bash
PID=$(pgrep -x WIMenuBar | head -1)
kill -9 "$PID"            # simulate jetsam SIGKILL
sleep 12                  # ThrottleInterval=10
pgrep -lf WIMenuBar       # should print a NEW pid
grep "===== boot" ~/Library/Logs/wi-menubar/menubar.log | tail -2
```

### Confirming jetsam was the cause (optional)

Requires Full Disk Access for Terminal (System Settings → Privacy & Security
→ Full Disk Access):

```bash
log show --predicate 'eventMessage CONTAINS "WIMenuBar" OR eventMessage CONTAINS "jetsam"' --last 30m
```

A jetsam kill leaves a line like:

```
kernel: jetsam: killing pid=NNNNN [WIMenuBar] ...
```

Without FDA, the silent-stop fingerprint in `menubar.log` plus a missing
`.ips` is sufficient evidence — jetsam is the only mechanism that produces
both.

### Full investigation memo

See `~/.claude/projects/.../memory/project_wimenubar_jetsam_sigkill.md` (or
the equivalent in your auto-memory dir) for the full evidence trail, the
exit-class fingerprint table, and the rationale for each LaunchAgent plist
key.
