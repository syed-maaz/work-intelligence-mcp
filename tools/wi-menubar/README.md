# WIMenuBar

Native macOS menubar app for Work Intelligence. Swift + SwiftUI, built via SPM
(no Xcode). Tabbed popover surfacing:

- **Today** — morning brief (calendar, priorities, sprint delta)
- **Health** — bridge / web / docs service rows, agent + MCP health, signals,
  attention items, bugs, token usage
- **Activity** — recent events, awaiting-user sessions

The popover is the only UI surface — there is no main window.

---

## Quickstart

```bash
npm run menubar:build   # swift build -c release + bundle
npm run menubar:run     # open WIMenuBar.app
npm run menubar:clean   # rm .build/ + WIMenuBar.app
```

Logs land in `~/Library/Logs/wi-menubar/`:

- `menubar.log` — app activity (boot, services, network, UI, signals, crash)
- `bridge.log` — bridge stdout/stderr when the menubar spawned it
- `web.log`    — web UI server when spawned by the menubar
- `docs.log`   — docs server when spawned by the menubar

`tail -F ~/Library/Logs/wi-menubar/menubar.log` is the first thing to do when
anything looks wrong.

---

## Architecture (one paragraph)

`WIMenuBarApp` owns a `ServicesCoordinator` (spawns/monitors bridge/web/docs)
and a `DataCoordinator` (polls `/api/*` every 60s for cards). All `node`
spawning routes through `NvmResolver.nodePath` so the right ABI is picked
deterministically — see [TROUBLESHOOTING.md § Node ABI](docs/TROUBLESHOOTING.md#node-2426-abi-mismatch).
The popover (`PopoverView`) is the only visible surface; it lives in the
status bar and is rebuilt on every reopen.

Full layout:

```
Sources/WIMenuBar/
  WIMenuBarApp.swift            # entry, boot logger, coordinator wiring
  Views/
    PopoverView.swift           # Today / Health / Activity tabs
  Features/
    DailyBrief/DailyBriefHeader.swift
    Signals/SignalsCard.swift
    Attention/AttentionCard.swift
    Bugs/BugsCard.swift
    Tokens/TokenUsageCard.swift
    Services/ServiceRowView.swift
  Services/
    BridgeAPI.swift             # URLSession wrapper, logs every call
    DataCoordinator.swift       # @MainActor data store, 60s poll
    ServicesCoordinator.swift   # spawn / adopt-external / kill services
    ServiceController.swift     # per-service Process + log handle
    NvmResolver.swift           # picks the right node binary
    WILog.swift                 # file + os_log + crash interceptors
    StatusPoller.swift          # http probe loop for service rows
    SignalEngine.swift          # signal aggregation across endpoints
    Notifier.swift              # banner + sound for new critical signals
  Models/
    *.swift                     # plain structs, no Codable
docs/
  TROUBLESHOOTING.md            # ← read this when something breaks
```

---

## Logging

Six categories, all written to `~/Library/Logs/wi-menubar/menubar.log` and
mirrored to `os_log` (subsystem `com.work-intelligence.menubar`):

| Category    | What it covers |
|-------------|----------------|
| `app`       | App boot, coordinator wiring, top-level lifecycle |
| `services`  | Spawn / kill / adopt-external / NvmResolver decisions |
| `ui`        | Popover open/close, tab switches |
| `network`   | Every BridgeAPI call: `GET <path> → <status> <ms>ms` |
| `signals`   | Notifier output (banner posted, deduped, suppressed) |
| `crash`     | Uncaught NSException + POSIX signal handlers |

Per-line format:

```
YYYY-MM-DD HH:MM:SS.mmm [<category>] <LEVEL>  <file>:<line> (<thread>) <message>
```

Boot banner is recognisable at a glance:

```
===== boot 2026-06-23 08:37:27.445 pid=60549 =====
  bundle: /Users/.../WIMenuBar.app
  log:    /Users/.../menubar.log
  host:   <hostname>
  os:     Version <macOS version>
```

Crash markers when applicable:

```
[crash] uncaught: NSInternalInconsistencyException: <reason>
<stack>
===== signal SIGSEGV =====
```

---

## When things break

→ [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) covers every failure
mode we've actually hit, with grep-able log signatures and exact fixes.

The three most common:

1. **Bridge spawns then dies (`NODE_MODULE_VERSION 147`)** — Homebrew node 26
   vs better-sqlite3 ABI 137. Fixed by `NvmResolver` resolving to nvm's
   Node 24 binary at boot; if it regresses, see § Node ABI Mismatch.
2. **Port :3132 bound but no HTTP response** — bridge crashed mid-request.
   The menubar's `healthyExternal` probe now detects this on Connect and
   reclaims the port; see § Hung Bridge.
3. **Morning brief never appears** — cold-cache call to Anthropic takes
   30–55s, was timing out at 12s. Now 60s with explicit "Generating…"
   placeholder; see § Morning Brief.
