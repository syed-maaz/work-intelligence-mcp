---
title: WIMenuBar — Architecture & Design Decisions
---

# WIMenuBar — Architecture & Design Decisions

A native macOS menubar app for the Work Intelligence bridge, living at
`tools/wi-menubar/` in this repo. This doc focuses on **why** the app is
built the way it is. For build & usage instructions see
`tools/wi-menubar/README.md`.

> **Audience:** future contributors deciding whether to add a new card,
> change the polling cadence, or port any of the patterns here to a new
> menubar app for a sibling project.

---

## Goals

1. **One always-visible entry point to WI.** No browser tab required. Click
   the menubar item → see what needs your attention right now.
2. **Surface "needs attention" proactively.** Don't make the user check.
   Banner notifications for new critical signals; count badge in the
   menubar label.
3. **Control the WI services without a terminal.** Bridge, web UI, docs —
   Connect/Stop from the popover.
4. **Built from npm scripts inside this repo.** No Xcode required, no
   separate repo, no Apple Developer Program membership.
5. **One folder per feature.** New cards drop in as
   `Features/<Name>/<Name>Card.swift` without ceremony.

---

## Stack choices

| Decision                            | Choice                                  | Why                                                                                                     |
|-------------------------------------|-----------------------------------------|---------------------------------------------------------------------------------------------------------|
| Language                            | Swift 5.9+                              | Native menubar API access (`MenuBarExtra`), small binary, no runtime to ship.                            |
| UI framework                        | SwiftUI                                 | Declarative; the popover is essentially a list of cards observing `@Published` state.                    |
| App lifecycle                       | `MenuBarExtra` Scene (macOS 13+)        | No `NSStatusBar` boilerplate. Trailing-closure label gives us a SwiftUI badge view.                      |
| Build system                        | Swift Package Manager                   | Builds with just Command Line Tools — no Xcode, no `.xcodeproj`.                                         |
| Bundle                              | `.app` produced by `scripts/bundle.sh`  | Hand-written `Info.plist` keeps `LSUIElement=true` (no Dock icon) explicit.                              |
| Codesigning                         | Ad-hoc (`codesign --sign -`)            | Zero friction. Trade-off: UNUserNotifications silently drop — solved with an osascript fallback path.    |
| Networking                          | `URLSession` + `JSONSerialization`      | Bridge JSON is mixed-type (numbers sometimes as strings) and small; Codable would be more code, not less. |
| Concurrency                         | `@MainActor` + `DispatchSourceTimer`    | Predictable. Avoided Swift Concurrency `Task` everywhere to keep `deinit` simple and avoid actor hops.   |
| Notifications                       | UN + osascript dual-path                | UN for signed release future-proofing; osascript so ad-hoc dev builds actually deliver.                   |
| State storage (notification dedupe) | `UserDefaults` JSON-encoded dict        | 6h dedupe window of ~20 keys → not worth a database.                                                     |

---

## Component map

```
                    ┌──────────────────────────────┐
                    │       WIMenuBarApp           │
                    │   @main, Scene, MenuBarLabel │
                    └──────────────┬───────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
       ServicesCoordinator   DataCoordinator   PopoverView (root)
       (bridge/web/docs)     (poll 60s, 4 +    composes 7 cards
            │                 1 signal call)
            │                       │
            └────┬──── crash ──────▶│  serviceSignals[id]
                 │  signals          │
                 ▼                   ▼
        ServiceController      SignalEngine + Notifier
        (Process, lsof)        (fan-out → translate → dedupe → banner)
                 │                   │
                 ▼                   ▼
              ports/PIDs        bridge endpoints
```

### Service-side

- **`ServicesCoordinator`** owns three `ServiceController`s (bridge, web,
  docs). Polls each port every 1.5s, transitions states, fires crash
  signals into `DataCoordinator` when a `.running` → `.crashed` edge fires.
- **`ServiceController`** spawns the process (`open` for app-like
  services, `Process` for shell commands), captures stdout/stderr to
  `~/Library/Logs/wi-menubar/<id>.log`, watches for termination.
- **`PortUtils`** is the "adoption" helper — when a service is running but
  not under our PID (you started the bridge in a terminal), `lsof -ti :PORT
  -sTCP:LISTEN` finds the listener PID so the Stop button still works.
- **`StatusPoller`** issues a `HEAD http://localhost:<port>/` to determine
  reachability. **Always** uses `localhost` (not `127.0.0.1`) because Vite
  and Docusaurus bind to IPv6 only.

### Data-side

- **`DataCoordinator`** is `@MainActor` and `ObservableObject`. Owns five
  `@Published` datasets (tokens, bugs, attention, dailyBrief, signals)
  and the SignalEngine + Notifier instances. Single 60s `DispatchSourceTimer`
  drives `refreshAll()`. Popover-open triggers an immediate refresh via
  `.onAppear`.
- **`BridgeAPI`** is a stateless `enum` with one shared `URLSession` (3s
  timeout for fast endpoints, 12s for `/api/morning-brief`). Returns
  `Result<Domain, Error>` via completion handlers — not async/await, to
  keep `DispatchGroup` fan-out simple in `SignalEngine`.
- **`SignalEngine`** runs 4 endpoints concurrently via `DispatchGroup`,
  translates each into `AttentionSignal`s (one translator function per
  source), merges, sorts, calls `onSnapshot`.
- **`Notifier`** receives the snapshot, applies 6h `(stableID,
  fingerprint)` dedupe via `UserDefaults`, fires UN + osascript banners
  for survivors.

---

## The "signal" abstraction

Every "thing that needs the user's attention" — regardless of source —
is normalized to a single envelope:

```swift
struct AttentionSignal {
    let stableID: String        // dedupe identity: "mcp.jira"
    let fingerprint: String     // content hash; change → fresh banner
    let category: SignalCategory
    let severity: SignalSeverity  // critical > warning > info
    let title: String
    let body: String
    let actionHint: String?     // copy-paste-ready command (monospaced in UI)
    let openURL: URL?           // deep link → web UI page
    let observedAt: Date
}
```

This is the **only data type the SignalsCard cares about**, the **only**
data type the Notifier emits banners for, and the **only** data type
counted in the menubar badge. Adding a new source means writing one
translator function — no UI changes, no notifier changes, no badge
changes.

### Why stableID + fingerprint?

- `stableID` = identity. Two refreshes of the same expired-token signal
  produce identical `stableID`s. The UI replaces the row, doesn't
  duplicate.
- `fingerprint` = content hash. When the *meaning* of the same signal
  changes (e.g. expired 1h ago → expired 2h ago), we want a fresh banner.
  When it doesn't change, we suppress.

Combined with a 6h dedupe window: a critical signal you've already seen
silences itself for 6 hours unless its content changes materially. New
signals you've never seen banner immediately.

### Translation rules (current)

| Source endpoint                          | Translator → severity                                              | Cardinality |
|------------------------------------------|--------------------------------------------------------------------|-------------|
| `/api/cypher/health/sessions/stale`      | always `warning`; one signal per stale session                     | 0..N        |
| `/api/mcp/tokens`                        | expired → `critical`; \<24h to expiry → `warning`; healthy → none   | 0..N        |
| `/api/cypher/pm/drift?staleDays=7`       | always `warning`; merges 3 buckets (stale_in_progress, shipped_no_commit, dead_file_path) | 0..N |
| `/api/alerts` (critical only)            | `critical`; we ignore non-critical to avoid double-counting with AttentionCard | 0..N |
| Service crash (in-process detection)     | `critical`; one signal per crashed service                         | 0..3        |

---

## Notifications — the dual-path Notifier

This was the highest-friction part of the project, worth documenting in
detail so nobody re-treads it.

### The problem

`UNUserNotificationCenter.requestAuthorization(...)` succeeds against
ad-hoc-signed bundles. `UNUserNotificationCenter.current().add(request)`
succeeds. Nothing visible appears. `UNUserNotificationCenter.current()
.getDeliveredNotifications` returns the request you just added. macOS just
... doesn't show the banner.

This is not documented anywhere clearly. Empirically it's because the
notification center requires a code signature it can attribute the
notification to. Ad-hoc signatures (`codesign --sign -`) don't have a
Team ID and macOS treats the bundle as untrusted for notification
delivery purposes, even though `authorizationStatus == .authorized`.

### The solution

`Notifier.post()` fires **both** delivery paths for every signal:

1. **UNUserNotificationCenter** — the "official" path. Works invisibly on
   ad-hoc builds, will work properly on a real signed release in the
   future. Zero cost when it fails.
2. **osascript `display notification`** — fallback that always works
   because osascript is system-signed and inherits Notification Center
   permission. Less rich (no actions, no images), but it actually shows
   up.

```
                ┌──────────────────────────────────────┐
                │  Notifier.post(signal)                │
                └──────────────────────────────────────┘
                          │           │
                ┌─────────┘           └─────────┐
                ▼                               ▼
   UNUserNotificationCenter           Process /usr/bin/osascript
   .current().add(req)                -e 'display notification ...'
                │                               │
   silently drops on ad-hoc      always renders if osascript has
   builds; rich on signed        Notification Center permission
   builds                        (first-run prompt for Script Editor)
```

The trade-off: on a signed release, you'd see *both* a UN banner and an
osascript banner. We'll cross that bridge when the project gets a real
signing identity — at which point we'll add a build-time flag to disable
the osascript path.

### Dedupe

`UserDefaults` key `wi.menubar.notifier.shownSignals` stores
`[String: { lastShown: Date }]` keyed by `<stableID>::<fingerprint>`.
Pruned to a 6-hour window on every `processSnapshot` call. New signals
fire immediately; identical signals stop banner-ing for 6h; content
changes (different fingerprint) bypass dedupe.

---

## Polling cadence — why 60s

A bridge tick currently runs ~7 HTTP calls per cycle. At 60s that's 0.1
req/s — negligible load. We considered:

- **30s:** twice the noise, no real responsiveness gain since the bridge's
  upstream syncs run on multi-minute cycles. The popover already
  force-refreshes on open, which is the only place the user actually
  notices freshness.
- **5s:** considered for the badge, but rejected — the badge is a
  glance-target, not a fast-feedback widget. New signals usually surface
  on minute-scale anyway (cypher session goes stale after 10min,
  MCP tokens after hours).
- **Event-driven (SSE/WebSocket):** worthwhile when bridge load matters,
  but bridge doesn't currently expose a push channel. Open question for
  Phase 4+.

The daily brief uses a different cadence: it's pulled on every 60s tick
but the **server-side cache** is 1 hour, so 59 of every 60 calls hit
cache. The 12s client timeout accommodates the one cold-cache call per
hour without making the other endpoints suffer.

---

## Why a separate menubar app instead of a tab/widget?

Alternatives we considered:

1. **Web UI tab** — already exists. Problem: the user has to remember to
   open it. The whole point is proactive attention.
2. **macOS widget** — limited interactivity (no live process control,
   no Connect/Stop buttons, very restrictive update budget).
3. **Hammerspoon / Übersicht** — works, but pulls in Lua / a separate
   tool. Doesn't compose well with the npm-script build flow.
4. **Electron menubar** — overkill (~150MB resident, slow boot). Same
   notifications problem as anything not system-signed.

A native Swift app at \<5MB resident with a 0.3s cold start was the clear
winner. The only meaningful downside (notifications gotcha) was solvable
with the osascript fallback.

---

## Future work (Phase 4+)

Not implemented; listed here so future contributors know the rationale:

| Item                                   | Status        | Notes                                                                     |
|----------------------------------------|---------------|---------------------------------------------------------------------------|
| Server-Sent Events for signals         | not started   | Would replace the 60s poll with push. Worth doing if signal count grows. |
| Notification actions ("Open Cypher")   | blocked       | Requires real signing identity (UN actions don't work via osascript).    |
| 9am scheduled daily-brief notification | not started   | Trivial — `UNCalendarNotificationTrigger`; deferred until we know whether the user wants it. |
| Per-service log viewer                 | not started   | "View logs" button opens `~/Library/Logs/wi-menubar/<id>.log` in Console.app. |
| Custom menubar icon                    | not started   | Currently text-only "WI". An SF Symbol or PDF asset would polish it.     |
| Plugin/extension surface               | rejected      | Not worth the abstraction cost for an in-repo tool. New cards add directly. |

---

## See also

- `tools/wi-menubar/README.md` — build, run, layout, adding new cards
- Skill `swiftui-menubar-app-spm` — captures CLT-only build flow + the
  MenuBarExtra label gotcha + IPv6 probe + accessibility AppleScript
  diagnostic. Should be the first thing a Hermes/Claude session reads
  before touching this code.
- `web-server.js` — search for the endpoints listed in the data-flow
  section to see the bridge side.
