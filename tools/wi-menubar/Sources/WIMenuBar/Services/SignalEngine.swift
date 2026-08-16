//
//  SignalEngine.swift
//
//  Polls the four signal source endpoints, translates each into one or more
//  AttentionSignal objects, de-dupes, and hands the result to whoever wants
//  it (DataCoordinator for UI, Notifier for banners).
//
//  Translation rules (kept explicit & local — easier to tune than a rule DSL):
//
//   * Stale cypher session: 1 signal PER session. warning severity.
//     stableID = "cypher.session.<session_id>"
//     fingerprint = goal hash (so updating the goal re-fires)
//
//   * Expired MCP token: 1 signal per server. critical severity.
//   * Expiring < 24h: 1 signal per server. warning severity.
//     stableID = "mcp.<server_name>"
//     action_hint = the exact `npm run mcp-setup -- --name <X> --url <Y>` line
//
//   * Stale in-progress work item: 1 signal per item. warning severity.
//     stableID = "drift.<work_item_id>"
//
//   * Critical alert: 1 signal per alert. critical severity.
//     stableID = "alert.<alert_id>"
//

import Foundation

/// Aggregate connectivity color. Computed by DataCoordinator from the
/// full signal snapshot — `red` if any critical signal is present,
/// `yellow` if any warning, `green` otherwise. Surfaced to the menubar
/// glyph so the user can tell "everything reachable" from "app hung" at
/// a glance: a healthy menubar is now a green dot, not an empty label.
enum AggregateStatus: String {
    case green
    case yellow
    case red

    static func from(signals: [AttentionSignal]) -> AggregateStatus {
        if signals.contains(where: { $0.severity == .critical }) { return .red }
        if signals.contains(where: { $0.severity == .warning }) { return .yellow }
        return .green
    }
}

/// Drives all signal-source fetches, then hands the merged result to the
/// callback on the main queue.
final class SignalEngine {

    /// Called every time we have a fresh complete snapshot. Always on main.
    var onSnapshot: (([AttentionSignal]) -> Void)?

    /// Becomes true the first time the webui probe succeeds this run. Until
    /// then, a probe failure is treated as "not started" (silent) rather
    /// than "crashed" (yellow signal). Without this, a fresh boot where the
    /// user just hasn't started Vite yet would flash yellow on every refresh
    /// — annoying and not actionable. After the first success, transitioning
    /// back to unreachable IS interesting and gets a signal.
    private var webUISeenUpOnce = false

    /// One-shot refresh of every source. Fans out five bridge calls in
    /// parallel and waits for all of them before delivering.
    func refresh() {
        // Step 1: bridge connectivity probe. If the bridge is down, every
        // downstream fetch will fail identically — the menubar should NOT
        // pretend everything else is healthy just because we got empty
        // results. We short-circuit to a single critical signal and emit.
        BridgeAPI.fetchBridgeReachable { [weak self] bridgeUp in
            guard let self = self else { return }
            if !bridgeUp {
                let bridgeDown = AttentionSignal(
                    stableID: "service.bridge.down",
                    fingerprint: "down",
                    category: .service,
                    severity: .critical,
                    title: "WI bridge unreachable",
                    body: "Cannot reach localhost:3132. All MCP/agent/signal data is stale.",
                    actionHint: "npm run web:bridge",
                    openURL: nil,
                    observedAt: Date()
                )
                DispatchQueue.main.async {
                    WILog.app.info("snapshot: agg=red total=1 crit=1 warn=0 (bridge down — short-circuit)")
                    self.onSnapshot?([bridgeDown])
                }
                return
            }
            // Bridge is up — proceed with the full fan-out.
            self.refreshAllWithBridgeUp()
        }
    }

    /// The original fan-out, gated behind a successful bridge probe so we
    /// don't waste 7 timeouts every poll when the bridge is wedged.
    private func refreshAllWithBridgeUp() {
        let group = DispatchGroup()
        var sessions: [[String: Any]] = []
        var awaitingUser: [[String: Any]] = []
        var tokens: [[String: Any]] = []
        var drift: [[String: Any]] = []
        var alerts: [[String: Any]] = []
        var agents: [[String: Any]] = []
        var mcpServers: [[String: Any]] = []
        // Web UI reachability — probed directly, NOT through the bridge,
        // so a healthy bridge with a stopped Vite shows the right thing.
        var webUIReachable = false

        group.enter()
        BridgeAPI.fetchWebUIReachable { reachable in
            webUIReachable = reachable
            group.leave()
        }

        group.enter()
        BridgeAPI.fetchStaleCypherSessions { r in
            if case .success(let s) = r { sessions = s }
            group.leave()
        }

        // Awaiting-user is a separate, higher-priority signal: a session
        // explicitly asked the user a question and they haven't answered for
        // >= 1 minute. Distinct from the stale-pending signal above.
        group.enter()
        BridgeAPI.fetchAwaitingUserSessions(minMinutes: 1) { r in
            if case .success(let s) = r { awaitingUser = s }
            group.leave()
        }

        group.enter()
        BridgeAPI.fetchMCPTokens { r in
            if case .success(let s) = r { tokens = s }
            group.leave()
        }

        group.enter()
        BridgeAPI.fetchWorkItemDrift { r in
            if case .success(let s) = r { drift = s }
            group.leave()
        }

        group.enter()
        BridgeAPI.fetchAlerts { r in
            if case .success(let s) = r { alerts = s }
            group.leave()
        }

        // Internal-component health: agents in the bridge process and
        // reachability of every registered MCP server. These two fan-outs
        // are what surface "something inside WI is broken" — without them
        // the menubar can't tell the user that, say, BugInvestigatorAgent
        // crashed or the Jira MCP server is unreachable.
        group.enter()
        BridgeAPI.fetchAgentHealth { r in
            if case .success(let s) = r { agents = s }
            group.leave()
        }

        group.enter()
        BridgeAPI.fetchMCPHealth { r in
            if case .success(let s) = r { mcpServers = s }
            group.leave()
        }

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            // Update web-UI seen-up-once latch BEFORE translating: a single
            // first-success unlocks the warning-on-loss behavior for the
            // rest of the session.
            if webUIReachable { self.webUISeenUpOnce = true }

            var all: [AttentionSignal] = []
            all.append(contentsOf: self.translateAwaitingUser(awaitingUser))
            all.append(contentsOf: self.translateCypherSessions(sessions))
            all.append(contentsOf: self.translateMCPTokens(tokens))
            all.append(contentsOf: self.translateDrift(drift))
            all.append(contentsOf: self.translateAlerts(alerts))
            all.append(contentsOf: self.translateAgentHealth(agents))
            all.append(contentsOf: self.translateMCPHealth(mcpServers))
            all.append(contentsOf: self.translateWebUI(reachable: webUIReachable))
            // Sort: critical first, then warning, then info. Stable secondary
            // sort by title so order is deterministic across refreshes.
            all.sort { a, b in
                if a.severity != b.severity { return a.severity > b.severity }
                return a.title < b.title
            }
            // Log a one-line snapshot summary so the menubar's color is
            // grep-able post-hoc. Without this, the dot color is invisible
            // to anything but the user's eyeballs — and "yellow right now
            // because the Jira MCP token expires in 13min" is the kind of state
            // we want to be able to confirm from `tail menubar.log`.
            let agg = AggregateStatus.from(signals: all)
            let crit = all.filter { $0.severity == .critical }.count
            let warn = all.filter { $0.severity == .warning }.count
            WILog.app.info("snapshot: agg=\(agg.rawValue) total=\(all.count) crit=\(crit) warn=\(warn)")
            self.onSnapshot?(all)
        }
    }

    // MARK: - Translators

    /// Base URL of the web UI. We deep-link signals here so clicking a row
    /// in the popover opens the relevant page.
    private let webBase = "http://localhost:5175"

    /// Awaiting-user sessions = a Cypher run paused on `status='asked_user'`
    /// for >= 1 min. ALWAYS critical — the loop is literally blocked on a
    /// human reply. Distinct stableID prefix (`cypher.asked.<id>`) so it
    /// never collides with a stale-pending signal for the same session.
    private func translateAwaitingUser(_ rows: [[String: Any]]) -> [AttentionSignal] {
        rows.compactMap { row -> AttentionSignal? in
            guard let id = row["session_id"] as? String else { return nil }
            let goal = (row["goal"] as? String) ?? "(no goal)"
            let mins = (row["asked_minutes_ago"] as? Int) ?? 0
            let preview = row["question_preview"] as? String
            // Body shows the actual question if we have one; otherwise falls
            // back to the goal so the user has context.
            let body: String
            if let p = preview, !p.isEmpty {
                body = "\(p) — waiting \(mins)m"
            } else {
                body = "\(goal) — waiting \(mins)m"
            }
            // Fingerprint is intentionally STABLE across the lifetime of an
            // unresolved session: re-firing a banner every 5 minutes was the
            // dominant source of menubar notification spam (Defect A in
            // .planning/wi-menubar-notifications/01-UX-ANALYSIS-AND-PLAN.md).
            // Escalation reminders happen via Notifier's single 30-min
            // re-fire path, not via fingerprint churn. The signal itself
            // stays visible in the popover + dot color the entire time.
            return AttentionSignal(
                stableID: "cypher.asked.\(id)",
                fingerprint: "asked",
                category: .cypherSession,
                severity: .critical,
                title: "Cypher session needs your reply",
                body: body,
                actionHint: "Resume in /cypher to answer",
                openURL: URL(string: "\(webBase)/cypher"),
                observedAt: Date()
            )
        }
    }

    private func translateCypherSessions(_ rows: [[String: Any]]) -> [AttentionSignal] {
        rows.compactMap { row -> AttentionSignal? in
            guard let id = row["session_id"] as? String else { return nil }
            let goal = (row["goal"] as? String) ?? "(no goal)"
            let user = (row["user"] as? String) ?? "?"
            let started = (row["started_at"] as? String) ?? "?"
            return AttentionSignal(
                stableID: "cypher.session.\(id)",
                fingerprint: shortHash(goal),
                category: .cypherSession,
                severity: .warning,
                title: "Stale Cypher session",
                body: "\(goal) (user: \(user), started \(started))",
                actionHint: "wi-record-outcome \(id) to close, or resume",
                openURL: URL(string: "\(webBase)/cypher"),
                observedAt: Date()
            )
        }
    }

    private func translateMCPTokens(_ rows: [[String: Any]]) -> [AttentionSignal] {
        rows.compactMap { row -> AttentionSignal? in
            guard let name = row["server_name"] as? String else { return nil }
            let url = (row["server_url"] as? String) ?? "?"
            let expired = (row["expired"] as? Bool) ?? false
            let minsToExpiry = (row["expires_in_minutes"] as? Int) ?? 0

            // No deep link for MCP tokens — fix is a terminal command, not a page.
            if expired {
                let minsAgo = abs(minsToExpiry)
                let ago = formatMinutes(minsAgo)
                // Stable fingerprint — see comment in translateAwaitingUser
                // above. Hourly re-fire used to spam notifications for
                // long-expired tokens that the user has already seen.
                return AttentionSignal(
                    stableID: "mcp.\(name)",
                    fingerprint: "expired",
                    category: .mcpToken,
                    severity: .critical,
                    title: "MCP server '\(name)' token expired",
                    body: "Expired \(ago) ago. Tool calls to \(name) will fail.",
                    actionHint: "npm run mcp-setup -- --name \(name) --url \(url)",
                    openURL: nil,
                    observedAt: Date()
                )
            } else if minsToExpiry < 60 * 24 {
                // Stable fingerprint — see comment in translateAwaitingUser.
                return AttentionSignal(
                    stableID: "mcp.\(name)",
                    fingerprint: "expiring",
                    category: .mcpToken,
                    severity: .warning,
                    title: "MCP server '\(name)' token expiring soon",
                    body: "Expires in \(formatMinutes(minsToExpiry)).",
                    actionHint: "npm run mcp-setup -- --name \(name) --url \(url)",
                    openURL: nil,
                    observedAt: Date()
                )
            }
            return nil
        }
    }

    private func translateDrift(_ rows: [[String: Any]]) -> [AttentionSignal] {
        rows.compactMap { row -> AttentionSignal? in
            guard let id = row["id"] as? String else { return nil }
            let title = (row["title"] as? String) ?? "(no title)"
            let reason = (row["reason"] as? String) ?? "drift"
            let detail = (row["detail"] as? String) ?? ""
            return AttentionSignal(
                stableID: "drift.\(id)",
                fingerprint: shortHash("\(reason)-\(detail)"),
                category: .workItemDrift,
                severity: .warning,
                title: "Work item drift: \(id)",
                body: "\(title) — \(detail)",
                actionHint: nil,
                openURL: URL(string: "\(webBase)/cypher"),
                observedAt: Date()
            )
        }
    }

    /// Agent crashed inside the bridge process. The bridge tracks per-agent
    /// status — 'healthy', 'ready', 'crashed', 'disabled'. We surface ONLY
    /// 'crashed' as a critical signal: 'disabled' means the user turned it
    /// off explicitly, 'ready' means it hasn't ticked yet (boot phase). The
    /// signal points at /system-health which renders the agent table with
    /// the stack traces the bridge captured.
    private func translateAgentHealth(_ rows: [[String: Any]]) -> [AttentionSignal] {
        rows.compactMap { row -> AttentionSignal? in
            guard let name = row["name"] as? String else { return nil }
            let status = (row["status"] as? String) ?? ""
            guard status == "crashed" else { return nil }
            let errMsg = (row["error"] as? String) ?? "(no error captured)"
            let trimmed = errMsg.count > 100 ? String(errMsg.prefix(97)) + "…" : errMsg
            // Bucket by error text so a repeating "same crash" doesn't re-fire
            // every minute, but a NEW crash on the same agent (different
            // error) does.
            return AttentionSignal(
                stableID: "agent.\(name)",
                fingerprint: shortHash(errMsg),
                category: .service,
                severity: .critical,
                title: "Agent crashed: \(name)",
                body: trimmed,
                actionHint: "Restart the bridge to reinit the agent",
                openURL: URL(string: "\(webBase)/system-health"),
                observedAt: Date()
            )
        }
    }

    /// MCP server unreachable. /api/mcp/health pings every registered server
    /// every poll tick (60s). reachable=false → critical signal. The body
    /// contains the underlying error (auth expired, network, server 5xx) so
    /// the user can decide whether it's a token-refresh fix or a wait-for-
    /// upstream fix. distinct from translateMCPTokens — a server can be
    /// unreachable with a still-valid token (network issue) or have an
    /// expired token but be otherwise alive.
    private func translateMCPHealth(_ rows: [[String: Any]]) -> [AttentionSignal] {
        rows.compactMap { row -> AttentionSignal? in
            guard let name = row["server_name"] as? String else { return nil }
            let reachable = (row["reachable"] as? Bool) ?? true
            guard !reachable else { return nil }
            let errMsg = (row["error"] as? String) ?? "no response"
            let trimmed = errMsg.count > 100 ? String(errMsg.prefix(97)) + "…" : errMsg
            let url = (row["server_url"] as? String) ?? "?"
            return AttentionSignal(
                stableID: "mcp.unreachable.\(name)",
                fingerprint: shortHash(errMsg),
                category: .service,
                severity: .critical,
                title: "MCP server unreachable: \(name)",
                body: trimmed,
                actionHint: "npm run mcp-setup -- --name \(name) --url \(url)",
                openURL: URL(string: "\(webBase)/system-health"),
                observedAt: Date()
            )
        }
    }

    private func translateAlerts(_ rows: [[String: Any]]) -> [AttentionSignal] {
        rows.compactMap { row -> AttentionSignal? in
            guard let id = row["id"] as? String,
                  let sev = row["severity"] as? String else { return nil }
            guard sev == "critical" else { return nil }
            let title = (row["title"] as? String) ?? "Alert"
            let body = (row["body"] as? String) ?? ""
            let trimmed = body.count > 120 ? String(body.prefix(117)) + "…" : body
            // Alerts typically link to /action-items but some use a `link`
            // field on the alert payload itself. Prefer that when present.
            let linkPath = (row["link"] as? String) ?? "/action-items"
            return AttentionSignal(
                stableID: "alert.\(id)",
                fingerprint: shortHash(body),
                category: .alertOverdue,
                severity: .critical,
                title: title,
                body: trimmed,
                actionHint: nil,
                openURL: URL(string: "\(webBase)\(linkPath)"),
                observedAt: Date()
            )
        }
    }

    /// Web UI (Vite dev server on :5175) reachability. Asymmetric rules:
    ///   * Reachable → no signal (the green state).
    ///   * Unreachable BUT never seen up this run → no signal (user hasn't
    ///     started Vite yet; "missing" is the default, not an outage).
    ///   * Unreachable AFTER we've seen it up at least once → warning signal
    ///     (it came up then went away; could be intentional Cmd-C or a
    ///     crash; either way the user wants to know it's now missing).
    ///
    /// Warning not critical because the menubar app doesn't depend on the
    /// web UI being up — the popover keeps working. The signal is purely
    /// informational, but it's the only place the missing-UI state is
    /// visible after the user closes the browser tab.
    private func translateWebUI(reachable: Bool) -> [AttentionSignal] {
        if reachable { return [] }
        if !webUISeenUpOnce { return [] }
        return [
            AttentionSignal(
                stableID: "service.webui.down",
                fingerprint: "down",
                category: .service,
                severity: .warning,
                title: "Web UI unreachable",
                body: "localhost:5175 was up earlier this session, now not responding.",
                actionHint: "npm run web:dev",
                openURL: nil,
                observedAt: Date()
            )
        ]
    }

    // MARK: - Helpers

    /// 8-char hex of a string — good enough for fingerprinting, not a security
    /// primitive. Uses Foundation's hash so behavior is stable within a run.
    private func shortHash(_ s: String) -> String {
        let h = s.hashValue
        return String(format: "%016x", UInt64(bitPattern: Int64(h))).prefix(8).description
    }

    private func formatMinutes(_ mins: Int) -> String {
        let m = abs(mins)
        if m < 60 { return "\(m)m" }
        if m < 60 * 24 { return "\(m / 60)h \(m % 60)m" }
        return "\(m / (60 * 24))d \((m % (60 * 24)) / 60)h"
    }
}
