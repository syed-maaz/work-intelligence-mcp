//
//  ServicesCoordinator.swift
//
//  The single SwiftUI-observable that the popover binds to. Owns the three
//  controllers + the poller, and merges probe results into the @Published
//  state array that the UI renders.
//
//  Threading rules:
//   * All mutation of `states` happens on the main actor.
//   * Spawn / kill calls go to ServiceController, which dispatches its own
//     timeout work to a background queue.
//   * The poller calls back on main via DispatchQueue.main.async — no extra
//     hopping needed here.
//

import Foundation
import SwiftUI

@MainActor
final class ServicesCoordinator: ObservableObject {

    @Published private(set) var states: [ServiceState] = []
    @Published private(set) var pollIntervalSeconds: Double = 5.0

    /// Optional bridge to the data layer so we can report crash transitions
    /// as AttentionSignals. Wired by WIMenuBarApp at construction.
    weak var dataCoordinator: DataCoordinator?

    private let controllers: [ServiceController]
    private let poller: StatusPoller

    init(repoRoot: String, logDirectory: String) {
        WILog.services.info("ServicesCoordinator init — repoRoot=\(repoRoot)")
        let ctrls = ServiceController.defaultControllers(
            repoRoot: repoRoot,
            logDirectory: logDirectory
        )
        self.controllers = ctrls
        self.poller = StatusPoller(services: ctrls)
        self.states = ctrls.map {
            ServiceState.initial(
                id: $0.definition.id,
                displayName: $0.definition.displayName,
                port: $0.definition.port
            )
        }
        let names = ctrls.map { $0.definition.id }.joined(separator: ", ")
        WILog.services.info("registered \(ctrls.count) controllers: \(names)")

        // Wire poller -> coordinator.
        poller.onProbe = { [weak self] serviceID, result in
            self?.applyProbe(serviceID: serviceID, result: result)
        }
        poller.onCadenceChange = { [weak self] interval in
            self?.pollIntervalSeconds = interval
        }

        // Wire each controller's termination notice back into status flips.
        for ctrl in controllers {
            ctrl.onTermination = { [weak self] terminated in
                Task { @MainActor in
                    self?.handleTermination(serviceID: ctrl.definition.id, process: terminated)
                }
            }
        }

        poller.start()
        WILog.services.info("poller started")
    }

    deinit {
        WILog.services.warn("ServicesCoordinator deinit — stopping all children")
        poller.stop()
        // Stop any children we spawned. We don't wait — app is going away.
        for c in controllers { c.stop() }
    }

    // MARK: - User-facing actions

    func connect(_ serviceID: String) {
        WILog.services.info("connect(\(serviceID)) requested")
        guard let ctrl = controller(for: serviceID),
              let idx = states.firstIndex(where: { $0.id == serviceID }) else {
            WILog.services.warn("connect(\(serviceID)) — no such service")
            return
        }

        // If we already spawned the child and it's still alive, this click
        // is a no-op. Log and bail.
        if ctrl.isRunning {
            WILog.services.info("connect(\(serviceID)) — already owned by us pid=\(ctrl.ownedPID ?? -1); nothing to do")
            return
        }

        // Check whether someone external is already serving the port AND
        // actually responding to HTTP. A process bound to the port but not
        // answering (zombie, crashed mid-boot, killed connection state) is
        // worse than no listener — the row would go green but no requests
        // would land. So we adopt only when both conditions hold.
        let port = ctrl.definition.port
        let externalPID = PortUtils.listenerPID(forPort: port)

        if let pid = externalPID, healthyExternal(serviceID: serviceID, port: port, ctrl: ctrl) {
            WILog.services.info("connect(\(serviceID)) — port \(port) owned by pid \(pid) and healthy; adopting as external")
            states[idx].status = .external
            states[idx].lastError = nil
            poller.noteStarted(serviceID)
            return
        }

        if let pid = externalPID {
            // Port held by a dead-or-half-dead process. Best effort: terminate it
            // so our spawn doesn't immediately EADDRINUSE-die. If kill fails
            // (different uid, gone already), proceed and let spawn fail loudly.
            WILog.services.warn("connect(\(serviceID)) — port \(port) bound by pid \(pid) but not healthy; reclaiming")
            PortUtils.terminate(pid: pid)
            // Brief settle so the kernel releases the bind before we try to
            // listen ourselves. 200ms is enough for the typical TIME_WAIT-free
            // SIGTERM path; if not, the spawn will retry next click.
            Thread.sleep(forTimeInterval: 0.2)
        }

        do {
            let pid = try ctrl.start()
            WILog.services.info("connect(\(serviceID)) — spawned pid \(pid)")
            states[idx].status = .starting
            states[idx].ownedPID = pid
            states[idx].lastError = nil
            poller.noteStarting(serviceID)
        } catch {
            WILog.services.error("connect(\(serviceID)) — spawn failed: \(error.localizedDescription)")
            states[idx].status = .crashed
            states[idx].lastError = error.localizedDescription
        }
    }

    /// Synchronous best-effort HTTP probe against the controller's health
    /// path. Returns true only on an actual 200/2xx response inside 800ms.
    /// Used by `connect()` to decide whether an external listener is a
    /// "real bridge already up" vs. "stale bind we should reclaim".
    private func healthyExternal(serviceID: String, port: Int, ctrl: ServiceController) -> Bool {
        let urlString = "http://localhost:\(port)\(ctrl.definition.healthPath)"
        guard let url = URL(string: urlString) else {
            WILog.services.warn("healthyExternal(\(serviceID)) — bad URL \(urlString)")
            return false
        }
        var request = URLRequest(url: url, timeoutInterval: 0.8)
        request.httpMethod = ctrl.definition.probeWithGET ? "GET" : "HEAD"

        // Block briefly with a semaphore. We're on @MainActor here, so 800ms
        // is the absolute ceiling; the actual call is usually <50ms locally.
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        var observed = "no-response"
        let task = URLSession.shared.dataTask(with: request) { _, response, error in
            if let http = response as? HTTPURLResponse {
                observed = "HTTP \(http.statusCode)"
                ok = (200..<300).contains(http.statusCode)
            } else if let err = error {
                observed = "err: \(err.localizedDescription)"
            }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + 0.8)
        WILog.services.info("healthyExternal(\(serviceID)) — \(urlString) → \(observed) (ok=\(ok))")
        return ok
    }

    func stop(_ serviceID: String) {
        guard let ctrl = controller(for: serviceID),
              let idx = states.firstIndex(where: { $0.id == serviceID }) else { return }

        // Case 1: we own the child process — polite SIGTERM via Process API.
        if ctrl.isRunning {
            ctrl.stop()
            states[idx].lastError = nil
            return
        }

        // Case 2: external process (running but not spawned by us). Look up
        // the listener PID by port and SIGTERM it. The next probe cycle will
        // observe it gone and flip the row to stopped.
        let port = ctrl.definition.port
        DispatchQueue.global(qos: .userInitiated).async {
            if let pid = PortUtils.listenerPID(forPort: port) {
                PortUtils.terminate(pid: pid)
                Task { @MainActor in
                    if let i = self.states.firstIndex(where: { $0.id == serviceID }) {
                        // Optimistic UI hint — actual transition happens when
                        // the next probe fails to connect.
                        self.states[i].lastError = "stopping (pid \(pid))"
                    }
                }
            } else {
                Task { @MainActor in
                    if let i = self.states.firstIndex(where: { $0.id == serviceID }) {
                        self.states[i].lastError = "no listener found on :\(port)"
                    }
                }
            }
        }
    }

    func stopAll() {
        for c in controllers { c.stop() }
    }

    // MARK: - Reducers

    private func applyProbe(serviceID: String, result: StatusPoller.ProbeResult) {
        guard let idx = states.firstIndex(where: { $0.id == serviceID }) else { return }
        var s = states[idx]

        // If the controller owns a live PID, prefer that signal over the
        // probe's view of who's running. (Probe can't tell apart "our child"
        // from "someone else's process on the port".)
        let owned = controller(for: serviceID)?.ownedPID
        let weOwnAlivePID = (owned != nil)
        s.ownedPID = owned

        // Translate probe result into UI status, with our PID knowledge mixed in.
        switch result.status {
        case .running:
            // Probe healthy. If we own the PID it's ours; otherwise external.
            // Either way, we're no longer "starting".
            s.status = weOwnAlivePID ? .running : .external
            poller.noteStarted(serviceID)
        case .external:
            s.status = .external
            poller.noteStarted(serviceID)
        case .starting:
            // The probe told us "you have a live PID but no HTTP yet". Honor it
            // only if we DO actually own a PID — otherwise this is stale.
            s.status = weOwnAlivePID ? .starting : .stopped
        case .stopped:
            // No HTTP reply. Decide based on what we know about ownership:
            //  * We own a live PID → still booting (or hung). Stay yellow.
            //    The 90s noteStarting() auto-expire is the safety net.
            //  * We previously showed running and PID is gone → it crashed.
            //  * Otherwise → just stopped.
            if weOwnAlivePID {
                s.status = .starting
            } else if s.status == .running {
                s.status = .crashed
            } else {
                s.status = .stopped
            }
        case .crashed:
            s.status = .crashed
        }

        s.latencyMs = result.latencyMs
        s.lastChecked = Date()
        s.lastError = result.error

        // Crash-edge detection: if we just transitioned from running → crashed,
        // tell the data coordinator so it can fire a banner. Going from
        // crashed back to running clears the signal.
        let before = states[idx].status
        states[idx] = s
        if before != .crashed && s.status == .crashed {
            dataCoordinator?.reportServiceCrash(
                serviceID: serviceID,
                displayName: s.displayName,
                lastError: s.lastError
            )
        } else if before == .crashed && (s.status == .running || s.status == .external) {
            dataCoordinator?.clearServiceCrash(serviceID: serviceID)
        }
    }

    private func handleTermination(serviceID: String, process: Process) {
        guard let idx = states.firstIndex(where: { $0.id == serviceID }) else { return }
        var s = states[idx]
        s.ownedPID = nil
        let before = s.status
        // Exit code 0 from a user-initiated Stop -> .stopped. Anything else
        // (signal, non-zero exit) -> .crashed for visibility.
        if process.terminationReason == .uncaughtSignal || process.terminationStatus != 0 {
            s.status = .crashed
            s.lastError = "exit code \(process.terminationStatus)"
        } else {
            s.status = .stopped
            s.lastError = nil
        }
        states[idx] = s
        poller.noteStarted(serviceID)

        if before != .crashed && s.status == .crashed {
            dataCoordinator?.reportServiceCrash(
                serviceID: serviceID,
                displayName: s.displayName,
                lastError: s.lastError
            )
        }
    }

    // MARK: - Helpers

    private func controller(for id: String) -> ServiceController? {
        controllers.first { $0.definition.id == id }
    }
}
