//
//  DataCoordinator.swift
//
//  Owns the four card datasets (tokens, bugs, attention, signals). Polls
//  the bridge on a 60s cadence + once immediately on init.
//
//  Phase 3 additions:
//   * Owns the SignalEngine + Notifier
//   * Posts banners for new signals on every refresh
//   * Bridge crash detection: ServicesCoordinator wires up its onStateChange
//     to call us → we synthesize a service.<id> signal on the fly.
//

import Foundation
import SwiftUI

@MainActor
final class DataCoordinator: ObservableObject {

    @Published private(set) var tokens: TokenUsage = .empty
    @Published private(set) var bugs: BugsSummary = .empty
    @Published private(set) var attention: AttentionSummary = .empty
    @Published private(set) var signals: [AttentionSignal] = []
    @Published private(set) var dailyBrief: DailyBrief = .empty

    /// True while a morning-brief fetch is in flight. Lets the header card
    /// render a "still generating…" placeholder instead of showing an empty
    /// shell, which on a cold-cache first call can take 30–55s (Anthropic).
    @Published private(set) var briefLoading: Bool = false

    @Published private(set) var inFlight: Bool = false

    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "wi.menubar.dataPoller", qos: .utility)
    private let interval: TimeInterval = 60.0

    private let signalEngine = SignalEngine()
    private let notifier = Notifier()

    /// Service-state signals layered on top of bridge-sourced signals. Keyed
    /// by service id so a single service can produce/clear its own signal.
    private var serviceSignals: [String: AttentionSignal] = [:]

    init(autoStart: Bool = true) {
        signalEngine.onSnapshot = { [weak self] snapshot in
            guard let self = self else { return }
            // Merge in service-derived signals (bridge/web/docs crash).
            var combined = snapshot
            combined.append(contentsOf: self.serviceSignals.values)
            combined.sort { a, b in
                if a.severity != b.severity { return a.severity > b.severity }
                return a.title < b.title
            }
            self.signals = combined
            self.notifier.processSnapshot(combined)
        }
        notifier.requestAuthorizationIfNeeded()
        if autoStart { start() }
    }

    deinit {
        timer?.cancel()
    }

    func start() {
        stop()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .seconds(2))
        t.setEventHandler { [weak self] in
            Task { @MainActor in self?.refreshAll() }
        }
        t.resume()
        timer = t
        refreshAll()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    /// User-driven refresh (e.g. popover open).
    func refreshAll() {
        inFlight = true

        BridgeAPI.fetchTokenUsage { [weak self] result in
            Task { @MainActor in
                guard let self = self else { return }
                switch result {
                case .success(let usage): self.tokens = usage
                case .failure(let err):
                    var u = self.tokens; u.error = err.localizedDescription; self.tokens = u
                }
                self.checkSettled()
            }
        }

        BridgeAPI.fetchBugsSummary { [weak self] result in
            Task { @MainActor in
                guard let self = self else { return }
                switch result {
                case .success(let s): self.bugs = s
                case .failure(let err):
                    var b = self.bugs; b.error = err.localizedDescription; self.bugs = b
                }
                self.checkSettled()
            }
        }

        BridgeAPI.fetchAttention { [weak self] result in
            Task { @MainActor in
                guard let self = self else { return }
                switch result {
                case .success(let a): self.attention = a
                case .failure(let err):
                    var a = self.attention; a.error = err.localizedDescription; self.attention = a
                }
                self.checkSettled()
            }
        }

        // Signals refresh fans out four bridge calls itself; the SignalEngine
        // delivers the merged result via the onSnapshot callback.
        signalEngine.refresh()

        BridgeAPI.fetchDailyBrief { [weak self] result in
            Task { @MainActor in
                guard let self = self else { return }
                self.briefLoading = false
                switch result {
                case .success(let brief):
                    WILog.app.info("dailyBrief loaded: events=\(brief.calendar.count) priorities=\(brief.priorities.count) cached=\(brief.cached)")
                    self.dailyBrief = brief
                case .failure(let err):
                    WILog.app.warn("dailyBrief fetch failed: \(err.localizedDescription)")
                    var b = self.dailyBrief
                    b.error = err.localizedDescription
                    self.dailyBrief = b
                }
                self.checkSettled()
            }
        }
        // Flip loading flag AFTER the call is scheduled — Task closures land on
        // MainActor so UI sees the flag flip atomically with the fetch start.
        briefLoading = true
    }

    /// Called by ServicesCoordinator when a service we own transitions to
    /// `.crashed`. We synthesize a critical signal and surface it. The next
    /// signal refresh will merge it with the bridge-sourced signals.
    func reportServiceCrash(serviceID: String, displayName: String, lastError: String?) {
        let body = lastError ?? "process exited unexpectedly"
        serviceSignals[serviceID] = AttentionSignal(
            stableID: "service.\(serviceID).crash",
            fingerprint: body,
            category: .service,
            severity: .critical,
            title: "\(displayName) crashed",
            body: body,
            actionHint: "Click Connect on the row above to restart.",
            openURL: nil,
            observedAt: Date()
        )
        signalEngine.refresh()
    }

    /// Called when a previously-crashed service comes back up.
    func clearServiceCrash(serviceID: String) {
        if serviceSignals.removeValue(forKey: serviceID) != nil {
            signalEngine.refresh()
        }
    }

    private func checkSettled() {
        inFlight = false
    }
}
