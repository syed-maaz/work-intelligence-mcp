//
//  StatusPoller.swift
//
//  Periodically probes each service's HTTP health endpoint and reports
//  observed status back to the coordinator. Pure observation: it does not
//  start, stop, or own any processes.
//
//  Cadence:
//   * Steady-state interval: 5 seconds
//   * Fast interval:         1.5 seconds, used when ANY service is in
//                            `.starting` — flips back to steady on first
//                            success or after the 30s starting window expires
//
//  Why a single timer instead of one per service:
//   * Avoids three independent timer drifts and three async juggling stories.
//   * URLSession runs the probes concurrently anyway, so latency is fine.
//   * One observable cadence is easier to reason about when debugging.
//

import Foundation

final class StatusPoller {

    typealias ProbeResult = (status: ServiceStatus, latencyMs: Int?, error: String?)

    /// Called for every probe result on the main queue. The coordinator
    /// merges this into the published ServiceState.
    var onProbe: ((_ serviceID: String, _ result: ProbeResult) -> Void)?

    /// Called whenever the poller decides to switch cadence. UI doesn't need
    /// this today; useful for logging.
    var onCadenceChange: ((TimeInterval) -> Void)?

    private let services: [ServiceController]
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "wi.menubar.poller", qos: .utility)
    private let session: URLSession

    /// Service IDs the coordinator has marked as `.starting`. While this set
    /// is non-empty, we poll on the fast cadence.
    private var startingIDs: Set<String> = []

    /// Steady & fast intervals. Stored so they can be tweaked later (settings).
    private let steadyInterval: TimeInterval = 5.0
    private let fastInterval: TimeInterval = 1.5

    init(services: [ServiceController]) {
        self.services = services
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.5
        config.timeoutIntervalForResource = 2.5
        config.waitsForConnectivity = false
        self.session = URLSession(configuration: config)
    }

    // MARK: - Control surface

    func start() {
        stop()  // Defensive: never two timers in flight.
        scheduleTimer(interval: steadyInterval)
        // Fire an immediate probe so the popover doesn't show "unknown" for
        // 5 seconds on first open.
        queue.async { [weak self] in self?.probeAll() }
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    /// Coordinator tells us a service has been asked to start. We bump cadence
    /// and auto-expire after 90s so a service that never comes up doesn't keep
    /// us hammering forever. (Docusaurus first-compile can take 30-60s; Vite
    /// is faster but still wants headroom.)
    func noteStarting(_ serviceID: String) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.startingIDs.insert(serviceID)
            self.applyCadence()
            // Auto-expire fast cadence for this service after 90s.
            self.queue.asyncAfter(deadline: .now() + 90) { [weak self] in
                self?.noteStarted(serviceID)
            }
        }
    }

    /// Coordinator tells us a service is no longer in starting state (either
    /// it became running, or we gave up).
    func noteStarted(_ serviceID: String) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.startingIDs.remove(serviceID)
            self.applyCadence()
        }
    }

    // MARK: - Internals

    private func applyCadence() {
        let target = startingIDs.isEmpty ? steadyInterval : fastInterval
        scheduleTimer(interval: target)
        DispatchQueue.main.async { [weak self] in
            self?.onCadenceChange?(target)
        }
    }

    private func scheduleTimer(interval: TimeInterval) {
        timer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(200))
        t.setEventHandler { [weak self] in self?.probeAll() }
        t.resume()
        timer = t
    }

    private func probeAll() {
        for svc in services {
            probe(svc)
        }
    }

    private func probe(_ svc: ServiceController) {
        let def = svc.definition
        // Use `localhost` (not 127.0.0.1) so the OS resolver tries IPv6 ::1
        // first and falls back to IPv4. Vite and Docusaurus bind to [::1]
        // only by default — an IPv4-only probe would never connect.
        let urlString = "http://localhost:\(def.port)\(def.healthPath)"
        guard let url = URL(string: urlString) else { return }

        var req = URLRequest(url: url)
        req.httpMethod = def.probeWithGET ? "GET" : "HEAD"
        req.timeoutInterval = 2.0

        let started = Date()
        let serviceID = def.id
        let ownedRunning = svc.isRunning

        let task = session.dataTask(with: req) { [weak self] _, response, error in
            guard let self = self else { return }
            let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)

            let result: ProbeResult
            if let error = error {
                // No reply. If we spawned a child and it's still alive, we're
                // probably still starting. Otherwise stopped.
                let status: ServiceStatus = ownedRunning ? .starting : .stopped
                result = (status, nil, error.localizedDescription)
            } else if let http = response as? HTTPURLResponse {
                // Treat any 2xx/3xx/4xx as "the server is up". 5xx counts as
                // running too — it's responding, just unhappy. Only network
                // errors mean "down".
                if http.statusCode >= 200 && http.statusCode < 600 {
                    // If we didn't spawn this, mark as external so the UI can
                    // disable the Connect button.
                    let status: ServiceStatus = ownedRunning ? .running : .external
                    result = (status, elapsedMs, nil)
                } else {
                    result = (.stopped, elapsedMs, "HTTP \(http.statusCode)")
                }
            } else {
                result = (.stopped, nil, "no response")
            }

            DispatchQueue.main.async {
                self.onProbe?(serviceID, result)
            }
        }
        task.resume()
    }
}
