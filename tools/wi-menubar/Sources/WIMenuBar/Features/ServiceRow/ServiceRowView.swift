//
//  ServiceRowView.swift
//
//  One row per service inside the popover. Compact, readable at a glance:
//
//    ●  Bridge          :3132   12 ms     [Stop]
//    ○  Web UI          :5175    —        [Connect]
//    ⚠  Docs            :3000    —        [Connect]   not ours
//
//  The colored dot encodes status. Latency only shown when running. The button
//  on the right is either Connect (when stopped/crashed) or Stop (when running
//  or starting). External processes show a hint and no Stop button — we don't
//  want to nuke a bridge the user started in another terminal.
//

import SwiftUI

struct ServiceRowView: View {
    let state: ServiceState
    let onConnect: () -> Void
    let onStop: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            // Status indicator. A colored circle is faster to parse than text.
            Circle()
                .fill(dotColor)
                .frame(width: 9, height: 9)
                .help(state.lastError ?? state.status.rawValue)

            VStack(alignment: .leading, spacing: 1) {
                Text(state.displayName)
                    .font(.system(size: 12, weight: .medium))
                HStack(spacing: 6) {
                    Text(":\(state.port)")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    if let ms = state.latencyMs, state.status == .running || state.status == .external {
                        Text("· \(ms) ms")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            actionButton
        }
        .padding(.vertical, 2)
    }

    // MARK: - Pieces

    private var dotColor: Color {
        switch state.status {
        // Running and external both mean "healthy on the port" — same color.
        // The Stop button works for both.
        case .running, .external: return .green
        case .starting:           return .yellow
        case .crashed:            return .red
        case .stopped:            return .gray
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch state.status {
        case .stopped, .crashed:
            Button("Connect", action: onConnect)
                .controlSize(.small)
        case .starting, .running:
            Button("Stop", action: onStop)
                .controlSize(.small)
        case .external:
            // Even though we didn't spawn this, the user wants to be able to
            // stop it from one place. The coordinator looks up the listener
            // PID via lsof and SIGTERMs it.
            Button("Stop", action: onStop)
                .controlSize(.small)
        }
    }
}
