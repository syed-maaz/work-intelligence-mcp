//
//  ServiceState.swift
//
//  Plain data describing what we know about a single service (bridge / web /
//  docs). Deliberately a value type (struct) so SwiftUI diffing is cheap.
//
//  Status semantics:
//   * stopped   — health probe failed, and we haven't spawned a child for it
//   * starting  — we spawned a child, but the health probe hasn't passed yet
//   * running   — health probe passes (regardless of who started the process)
//   * crashed   — we spawned a child, child exited unexpectedly OR was running
//                 and then went unhealthy
//   * external  — health probe passes but the PID on the port isn't ours.
//                 (This is the common case during dev: bridge already running
//                 from a separate terminal.) Connect button is disabled; Stop
//                 button replaced by a "not ours" hint.
//

import Foundation

enum ServiceStatus: String {
    case stopped
    case starting
    case running
    case crashed
    case external
}

struct ServiceState: Identifiable, Equatable {
    let id: String                  // "bridge" | "web" | "docs"
    let displayName: String         // "Bridge" | "Web UI" | "Docs"
    let port: Int

    var status: ServiceStatus
    var lastChecked: Date?
    var latencyMs: Int?
    var ownedPID: Int32?            // PID of the child we spawned (if any)
    var lastError: String?          // last probe error message (UI tooltip)

    static func initial(id: String, displayName: String, port: Int) -> ServiceState {
        ServiceState(
            id: id,
            displayName: displayName,
            port: port,
            status: .stopped,
            lastChecked: nil,
            latencyMs: nil,
            ownedPID: nil,
            lastError: nil
        )
    }
}
