//
//  SignalsCard.swift
//
//  Top-of-popover "Needs attention" card. Renders signals from the
//  SignalEngine, sorted critical-first. Features:
//
//   - Collapsible header with a count badge per severity
//   - "Open all in browser" link → /system-health page in the web UI
//   - Click any row to open its deep link (where applicable)
//
//  Header reads like:
//
//      ▼ Needs attention · 5 (2 critical)            Open in browser ↗
//
//  Collapsed body is just the header. Expanded shows up to 5 rows + a
//  "+N more — open in browser" link if there are more.
//

import SwiftUI
import AppKit

struct SignalsCard: View {

    let signals: [AttentionSignal]

    /// Cards start collapsed by default per user preference 2026-06-22.
    /// The header still shows the count badge so the user can see the
    /// signal count without opening the panel.
    @State private var expanded: Bool = false
    @State private var initialised: Bool = false

    private let maxVisibleRows = 5
    private let webBase = "http://localhost:5175"

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if expanded {
                if signals.isEmpty {
                    Text("All clear — nothing needs your attention.")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                } else {
                    body(for: sorted)
                }
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.secondary.opacity(0.08))
        )
    }

    // MARK: - Sub-views

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 6) {
            // Chevron toggles expanded state.
            Button(action: { expanded.toggle() }) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)

            Text("Needs attention")
                .font(.system(size: 12, weight: .semibold))

            // Count badges: total · N critical
            countBadges

            Spacer(minLength: 4)

            // Right-side: open-in-browser link, always visible (collapsed or not).
            Button(action: openAllInBrowser) {
                HStack(spacing: 3) {
                    Text("Open in browser")
                        .font(.system(size: 10))
                    Image(systemName: "arrow.up.right.square")
                        .font(.system(size: 9))
                }
                .foregroundColor(.accentColor)
            }
            .buttonStyle(.plain)
            .help("Open all signals in the Work Intelligence web UI")
        }
        .contentShape(Rectangle())
        .onTapGesture { expanded.toggle() }
    }

    @ViewBuilder
    private var countBadges: some View {
        let critical = signals.filter { $0.severity == .critical }.count
        let warning  = signals.filter { $0.severity == .warning  }.count
        let total = signals.count

        if total == 0 {
            Text("0")
                .font(.system(size: 10, weight: .medium))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Capsule().fill(Color.green.opacity(0.18)))
                .foregroundColor(.green)
        } else {
            Text("\(total)")
                .font(.system(size: 10, weight: .medium))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Capsule().fill(Color.secondary.opacity(0.18)))
            if critical > 0 {
                Text("\(critical) critical")
                    .font(.system(size: 10, weight: .medium))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.red.opacity(0.18)))
                    .foregroundColor(.red)
            }
            if warning > 0 && critical == 0 {
                Text("\(warning) warn")
                    .font(.system(size: 10, weight: .medium))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.orange.opacity(0.18)))
                    .foregroundColor(.orange)
            }
        }
    }

    @ViewBuilder
    private func body(for list: [AttentionSignal]) -> some View {
        let visible = Array(list.prefix(maxVisibleRows))
        let remaining = list.count - visible.count

        VStack(alignment: .leading, spacing: 4) {
            ForEach(visible) { signal in
                signalRow(signal)
            }
            if remaining > 0 {
                Button(action: openAllInBrowser) {
                    Text("+\(remaining) more — open in browser ↗")
                        .font(.system(size: 10))
                        .foregroundColor(.accentColor)
                }
                .buttonStyle(.plain)
                .padding(.top, 2)
            }
        }
    }

    @ViewBuilder
    private func signalRow(_ signal: AttentionSignal) -> some View {
        Button(action: { open(signal) }) {
            HStack(alignment: .top, spacing: 6) {
                // Severity dot.
                Circle()
                    .fill(color(for: signal.severity))
                    .frame(width: 6, height: 6)
                    .padding(.top, 4)

                VStack(alignment: .leading, spacing: 1) {
                    Text(signal.title)
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)
                    Text(signal.body)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                    if let hint = signal.actionHint {
                        Text(hint)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundColor(.secondary.opacity(0.8))
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 2)

                // Arrow only when there's somewhere to go.
                if signal.openURL != nil {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 8))
                        .foregroundColor(.secondary)
                        .padding(.top, 3)
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Disable hover-as-link when there's no URL.
        .disabled(signal.openURL == nil)
        .help(signal.openURL?.absoluteString ?? "")
    }

    // MARK: - Helpers

    private var sorted: [AttentionSignal] {
        signals.sorted { lhs, rhs in
            if lhs.severity != rhs.severity {
                return lhs.severity > rhs.severity
            }
            return lhs.observedAt > rhs.observedAt
        }
    }

    private func color(for severity: SignalSeverity) -> Color {
        switch severity {
        case .critical: return .red
        case .warning:  return .orange
        case .info:     return .blue
        }
    }

    private func open(_ signal: AttentionSignal) {
        guard let url = signal.openURL else { return }
        NSWorkspace.shared.open(url)
    }

    private func openAllInBrowser() {
        // /system-health is the closest existing route to a "signals overview"
        // page. Change this when there's a dedicated /signals page.
        if let url = URL(string: "\(webBase)/system-health") {
            NSWorkspace.shared.open(url)
        }
    }
}
