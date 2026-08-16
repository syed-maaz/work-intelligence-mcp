//
//  BridgeAPI.swift
//
//  Thin URLSession wrapper around the three Phase-2 bridge endpoints. No
//  retries, no caching, no caching headers — the DataPoller calls these on a
//  60s cadence and that's our caching strategy.
//
//  Design choice: I'm parsing JSON with `JSONSerialization` rather than
//  Codable. The bridge responses have mixed-type fields (numbers that are
//  sometimes ints, sometimes strings) and pragmatic dictionary access is
//  shorter than building a tower of Decodable structs that we'd need to
//  maintain alongside the bridge. If the schemas stabilize we can revisit.
//

import Foundation

enum BridgeAPI {

    /// Base URL for the bridge. Always localhost — see StatusPoller for the
    /// IPv6/IPv4 reasoning.
    static let base = "http://localhost:3132"

    /// Shared session with short timeouts so the menubar never blocks on a
    /// dead bridge. 3s is enough for any of these queries on a healthy DB.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3.0
        config.timeoutIntervalForResource = 3.0
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    // MARK: - Connectivity probes
    //
    // These two probes exist for the status-light feature. Every other fetch
    // below uses the bridge as its data source, so when the bridge is down
    // every fetch fails identically and the menubar can't tell "bridge
    // crashed" from "no signals to report" — both produce an empty snapshot.
    //
    // fetchStatus → does the bridge answer at all? Boolean only.
    // fetchWebUIReachable → can we open localhost:5175? The dev server runs
    //                       outside the bridge process so it has to be probed
    //                       directly; bridge being up tells us nothing about it.

    /// Probe /api/status. Returns true on any 2xx, false otherwise. Never
    /// completes with .failure — connectivity is the result, not an error
    /// condition for the caller. Times out at 2s (tighter than the 3s
    /// default) so a wedged bridge doesn't slow the snapshot.
    static func fetchBridgeReachable(completion: @escaping (Bool) -> Void) {
        let url = URL(string: "\(base)/api/status")!
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 2.0
        let started = Date()
        session.dataTask(with: req) { _, response, error in
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            if let error = error {
                WILog.network.warn("PROBE bridge → err \(ms)ms: \(error.localizedDescription)")
                completion(false); return
            }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let ok = code >= 200 && code < 300
            WILog.network.debug("PROBE bridge → \(code) \(ms)ms ok=\(ok)")
            completion(ok)
        }.resume()
    }

    /// Probe the Vite dev server root at localhost:5175. The dev server runs
    /// as a separate node process so the bridge being up tells us nothing.
    /// Uses HEAD with a 1.5s timeout (Vite is local; if it's not up it fails
    /// instantly, no need to wait).
    static func fetchWebUIReachable(completion: @escaping (Bool) -> Void) {
        // Vite binds to ::1 by default; use `localhost` so the OS resolver
        // tries IPv6 first and falls back to IPv4 (same reasoning as
        // StatusPoller.probe).
        guard let url = URL(string: "http://localhost:5175/") else {
            completion(false); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 1.5
        let started = Date()
        session.dataTask(with: req) { _, response, error in
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            if let error = error {
                // Connection refused is the steady-state when Vite isn't
                // running. Log at debug so we don't spam warnings every 60s.
                WILog.network.debug("PROBE webui → err \(ms)ms: \(error.localizedDescription)")
                completion(false); return
            }
            // Any HTTP response means the server is alive — Vite returns 200
            // on /, but even a 404 would prove the listener exists. Network
            // errors are the only "down" signal we trust.
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            WILog.network.debug("PROBE webui → \(code) \(ms)ms")
            completion(code > 0)
        }.resume()
    }

    // MARK: - Tokens

    static func fetchTokenUsage(windowDays: Int = 7,
                                completion: @escaping (Result<TokenUsage, Error>) -> Void) {
        let url = URL(string: "\(base)/api/system-health/tokens?windowDays=\(windowDays)")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let dict):
                let totals = dict["totals"] as? [String: Any] ?? [:]
                let byDay = dict["byDay"] as? [[String: Any]] ?? []
                let daily = byDay.map { day -> Int in
                    let i = day["input_tokens"] as? Int ?? 0
                    let o = day["output_tokens"] as? Int ?? 0
                    return i + o
                }
                let usage = TokenUsage(
                    totalCalls: totals["calls"] as? Int ?? 0,
                    totalInputTokens: totals["input_tokens"] as? Int ?? 0,
                    totalOutputTokens: totals["output_tokens"] as? Int ?? 0,
                    estCostUsd: (totals["est_cost_usd"] as? Double)
                        ?? Double(totals["est_cost_usd"] as? Int ?? 0),
                    dailyTotals: daily,
                    lastUpdated: Date(),
                    error: nil
                )
                completion(.success(usage))
            }
        }
    }

    // MARK: - Bugs

    /// Fetch counts for the three "open-ish" statuses in parallel and combine.
    /// The bridge has no /api/bugs/summary endpoint, so we fan out 3 list
    /// calls with limit=3 and aggregate. Each call returns {ok, bugs[], total}.
    static func fetchBugsSummary(completion: @escaping (Result<BugsSummary, Error>) -> Void) {
        let statuses = ["new", "investigating", "proposed"]
        let group = DispatchGroup()

        // We collect results into these locked-by-serialization vars (only
        // mutated inside group.notify after all done blocks fired).
        var counts: [String: Int] = [:]
        var preview: [String] = []
        var firstError: Error?

        for status in statuses {
            group.enter()
            let url = URL(string: "\(base)/api/bugs?status=\(status)&limit=3")!
            getJSON(url: url) { result in
                defer { group.leave() }
                switch result {
                case .failure(let err):
                    if firstError == nil { firstError = err }
                case .success(let dict):
                    let total = dict["total"] as? Int ?? 0
                    counts[status] = total
                    if let bugs = dict["bugs"] as? [[String: Any]] {
                        for b in bugs where preview.count < 3 {
                            // Bridge uses `error_name` + `message`, not `title`.
                            // Build a "name — first line of message" preview,
                            // capped so the popover doesn't blow up vertically.
                            let name = (b["error_name"] as? String) ?? "(no name)"
                            let firstMsgLine = ((b["message"] as? String) ?? "")
                                .split(separator: "\n").first.map(String.init) ?? ""
                            let trimmedMsg = firstMsgLine.count > 60
                                ? String(firstMsgLine.prefix(57)) + "…"
                                : firstMsgLine
                            let line = trimmedMsg.isEmpty
                                ? "[\(status)] \(name)"
                                : "[\(status)] \(name) — \(trimmedMsg)"
                            preview.append(line)
                        }
                    }
                }
            }
        }

        group.notify(queue: .main) {
            if let err = firstError, counts.isEmpty {
                completion(.failure(err))
                return
            }
            let s = BugsSummary(
                newCount: counts["new"] ?? 0,
                investigatingCount: counts["investigating"] ?? 0,
                proposedCount: counts["proposed"] ?? 0,
                preview: preview,
                lastUpdated: Date(),
                error: nil
            )
            completion(.success(s))
        }
    }

    // MARK: - Attention (PM next-phase queue)

    static func fetchAttention(completion: @escaping (Result<AttentionSummary, Error>) -> Void) {
        let url = URL(string: "\(base)/api/cypher/pm/next")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err):
                completion(.failure(err))
            case .success(let dict):
                let items = dict["items"] as? [[String: Any]] ?? []
                // Only count items with status "pending" — the API returns
                // mixed statuses and we want a real "to do" count.
                let pending = items.filter { ($0["status"] as? String) == "pending" }
                let preview = pending.prefix(3).map { item -> (id: String, title: String) in
                    (
                        id: item["id"] as? String ?? "?",
                        title: item["title"] as? String ?? "(no title)"
                    )
                }
                let summary = AttentionSummary(
                    pendingCount: pending.count,
                    preview: Array(preview),
                    lastUpdated: Date(),
                    error: nil
                )
                completion(.success(summary))
            }
        }
    }

    // MARK: - Signal sources

    /// Stale cypher sessions (pending, started > N hours ago, never completed).
    static func fetchStaleCypherSessions(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        let url = URL(string: "\(base)/api/cypher/health/sessions/stale")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let dict):
                completion(.success(dict["sessions"] as? [[String: Any]] ?? []))
            }
        }
    }

    /// MCP OAuth token registry — names + expiry only, never the tokens
    /// themselves. The endpoint is new (Phase 3); on older bridges it returns
    /// 404 and we treat that as "no MCP servers configured".
    static func fetchMCPTokens(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        let url = URL(string: "\(base)/api/mcp/tokens")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let dict):
                // Older bridge returns {error: "Not found"} — surface as empty.
                if dict["error"] != nil {
                    completion(.success([]))
                    return
                }
                completion(.success(dict["items"] as? [[String: Any]] ?? []))
            }
        }
    }

    /// Drifted work items — stale in-progress, shipped without commit, etc.
    static func fetchWorkItemDrift(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        let url = URL(string: "\(base)/api/cypher/pm/drift?staleDays=7")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let dict):
                // Shape: { stale_in_progress: {items:[]}, shipped_no_commit: {items:[]}, ... }
                var all: [[String: Any]] = []
                for key in ["stale_in_progress", "shipped_no_commit", "dead_file_path"] {
                    if let block = dict[key] as? [String: Any],
                       let items = block["items"] as? [[String: Any]] {
                        all.append(contentsOf: items)
                    }
                }
                completion(.success(all))
            }
        }
    }

    /// System alerts (overdue items, stale items, etc.) from `/api/alerts`.
    /// Shape: { alerts: [ {severity, title, body, type, id} ] }.
    static func fetchAlerts(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        let url = URL(string: "\(base)/api/alerts")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let dict):
                completion(.success(dict["alerts"] as? [[String: Any]] ?? []))
            }
        }
    }

    // MARK: - Internal health (agents + MCP reachability)

    /// Per-agent health snapshot from /api/agents/health. Returns the raw
    /// agents[] array. Agents with status='crashed' or 'disabled' (when not
    /// explicitly turned off) drive critical signals.
    static func fetchAgentHealth(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        let url = URL(string: "\(base)/api/agents/health")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let dict):
                completion(.success(dict["agents"] as? [[String: Any]] ?? []))
            }
        }
    }

    /// Per-MCP-server reachability ping from /api/mcp/health. Each row carries
    /// {server_name, server_url, reachable, error, latency_ms}. Servers with
    /// reachable=false drive critical signals — the menubar makes the user
    /// notice when MCP tool calls would currently fail. Treats 404 as empty
    /// array so older bridges don't trip the menubar.
    static func fetchMCPHealth(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        let url = URL(string: "\(base)/api/mcp/health")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let dict):
                if (dict["error"] as? String) == "Not found" {
                    completion(.success([])); return
                }
                completion(.success(dict["servers"] as? [[String: Any]] ?? []))
            }
        }
    }

    /// Sessions that are blocked on a user response (status='asked_user')
    /// for longer than `minMinutes`. Returns the `.sessions[]` array from
    /// `/api/cypher/health/sessions/awaiting-user?minMinutes=1`. Returns
    /// empty list on 404 so older bridges gracefully degrade.
    static func fetchAwaitingUserSessions(
        minMinutes: Double = 1,
        completion: @escaping (Result<[[String: Any]], Error>) -> Void
    ) {
        let url = URL(string: "\(base)/api/cypher/health/sessions/awaiting-user?minMinutes=\(minMinutes)")!
        getJSON(url: url) { result in
            switch result {
            case .failure(let err): completion(.failure(err))
            case .success(let dict):
                if (dict["error"] as? String) == "Not found" {
                    completion(.success([])); return
                }
                completion(.success(dict["sessions"] as? [[String: Any]] ?? []))
            }
        }
    }

    // MARK: - Daily brief

    /// Pulls /api/morning-brief and turns it into the slim DailyBrief shape
    /// the popover header card renders. Cached server-side for 1h so calls
    /// here are normally fast even on a fresh boot.
    ///
    /// Cold-cache first-call-of-the-day hits Anthropic and routinely takes
    /// 25–55s. We use a 60s timeout for that path and accept that the popover
    /// will show a "still generating" placeholder for the full duration on
    /// the first open. Subsequent calls hit the bridge's 1h server cache and
    /// return in <500ms.
    ///
    /// Logs at the [network] category — every call logs URL, status, ms,
    /// and (on success) whether the response was server-cached.
    static func fetchDailyBrief(completion: @escaping (Result<DailyBrief, Error>) -> Void) {
        let url = URL(string: "\(base)/api/morning-brief")!
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        // 60s total: matches the empirically-observed worst case of Anthropic
        // call + response materialization. Bumped from 12s in 2026-06-23 after
        // the cold-call always timed out and the popover never painted a brief.
        req.timeoutInterval = 60.0

        let started = Date()
        let label = url.path

        // Use a one-off session for the long timeout — we don't want to bump
        // the shared 3s session globally just for this one slow endpoint.
        let oneOff = URLSession(configuration: {
            let c = URLSessionConfiguration.ephemeral
            c.timeoutIntervalForRequest = 60.0
            c.timeoutIntervalForResource = 60.0
            c.waitsForConnectivity = false
            return c
        }())

        WILog.network.info("GET \(label) → start (timeout 60s)")
        oneOff.dataTask(with: req) { data, response, error in
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            if let error = error {
                WILog.network.warn("GET \(label) → err \(ms)ms: \(error.localizedDescription)")
                completion(.failure(error)); return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data),
                  let dict = json as? [String: Any] else {
                WILog.network.warn("GET \(label) → \(status) \(ms)ms parse-failed")
                completion(.failure(NSError(domain: "BridgeAPI", code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "morning-brief parse failed"])))
                return
            }
            let cached = (dict["cached"] as? Bool) ?? false
            WILog.network.info("GET \(label) → \(status) \(ms)ms (\(data.count)B, cached=\(cached))")
            let brief = parseDailyBrief(dict)
            completion(.success(brief))
        }.resume()
    }

    /// Pure parsing helper for fetchDailyBrief — testable / no I/O.
    private static func parseDailyBrief(_ dict: [String: Any]) -> DailyBrief {
        let sections = dict["sections"] as? [String: Any] ?? [:]
        let dateString = (dict["date"] as? String) ?? ""

        // Day label: convert "2026-06-22" → "Monday, June 22".
        let dayLabel: String = {
            let inFmt = DateFormatter()
            inFmt.dateFormat = "yyyy-MM-dd"
            inFmt.locale = Locale(identifier: "en_US_POSIX")
            guard let date = inFmt.date(from: dateString) else { return dateString }
            let outFmt = DateFormatter()
            outFmt.dateFormat = "EEEE, MMMM d"
            return outFmt.string(from: date)
        }()

        // Critical alerts: only severity=="critical" titles.
        let alertsRaw = sections["alerts"] as? [[String: Any]] ?? []
        let critical = alertsRaw.compactMap { row -> String? in
            guard (row["severity"] as? String) == "critical" else { return nil }
            return row["title"] as? String
        }

        // Today's calendar: take all events, label by HH:mm.
        let calRaw = sections["calendar"] as? [[String: Any]] ?? []
        let events: [BriefEvent] = calRaw.prefix(5).map { row in
            let title = (row["title"] as? String) ?? "(no title)"
            let raw = (row["start_time"] as? String) ?? ""
            let short = String(raw.suffix(11).prefix(5))  // "HH:mm" from "...HH:mm:ssZ"
            return BriefEvent(title: title, startTime: short.isEmpty ? "" : short)
        }

        // Priorities: take top 3, overdue first.
        let prioRaw = sections["priorities"] as? [[String: Any]] ?? []
        let now = Date()
        let priorities: [BriefPriority] = prioRaw.prefix(5).map { row in
            let title = (row["title"] as? String) ?? "(no title)"
            let due = (row["due_date"] as? String) ?? ""
            let parsed: Date? = {
                let f = DateFormatter()
                f.dateFormat = "yyyy-MM-dd"
                return f.date(from: due)
            }()
            let label: String
            let overdue: Bool
            if let d = parsed {
                let cal = Calendar.current
                let days = cal.dateComponents([.day], from: cal.startOfDay(for: d),
                                              to: cal.startOfDay(for: now)).day ?? 0
                if days > 0 { label = "overdue \(days)d"; overdue = true }
                else if days == 0 { label = "today"; overdue = false }
                else { label = "in \(-days)d"; overdue = false }
            } else {
                label = ""; overdue = false
            }
            return BriefPriority(title: title, dueLabel: label, isOverdue: overdue)
        }

        // Sprint delta.
        let sprint = sections["sprintDelta"] as? [String: Any] ?? [:]
        let net = sprint["net"] as? Int ?? 0

        let cached = (dict["cached"] as? Bool) ?? false

        return DailyBrief(
            dayLabel: dayLabel,
            criticalAlerts: critical,
            calendar: events,
            priorities: priorities,
            sprintNet: net,
            lastUpdated: Date(),
            cached: cached,
            error: nil
        )
    }

    // MARK: - Plumbing

    private static func getJSON(url: URL,
                                completion: @escaping (Result<[String: Any], Error>) -> Void) {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 3.0
        let started = Date()
        // Shorten URL for log: just the path + query, no host/port. Avoids
        // /api/system-health/tokens?windowDays=7 becoming a 50-char prefix.
        let label = url.path + (url.query.map { "?\($0)" } ?? "")
        session.dataTask(with: req) { data, response, error in
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            if let error = error {
                WILog.network.warn("GET \(label) → err \(ms)ms: \(error.localizedDescription)")
                completion(.failure(error)); return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard let data = data else {
                WILog.network.warn("GET \(label) → \(status) \(ms)ms empty body")
                completion(.failure(NSError(domain: "BridgeAPI", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "empty response"])))
                return
            }
            do {
                let json = try JSONSerialization.jsonObject(with: data)
                guard let dict = json as? [String: Any] else {
                    WILog.network.warn("GET \(label) → \(status) \(ms)ms not-a-dict (\(data.count)B)")
                    completion(.failure(NSError(domain: "BridgeAPI", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "not a dict"])))
                    return
                }
                WILog.network.debug("GET \(label) → \(status) \(ms)ms (\(data.count)B)")
                completion(.success(dict))
            } catch {
                WILog.network.warn("GET \(label) → \(status) \(ms)ms parse-err: \(error.localizedDescription)")
                completion(.failure(error))
            }
        }.resume()
    }
}
