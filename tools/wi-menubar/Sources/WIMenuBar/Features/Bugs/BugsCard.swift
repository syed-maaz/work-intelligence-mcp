//
//  BugsCard.swift
//
//  Shows total open-ish bug count with breakdown chips. Tappable to expand
//  showing the top 3 bug titles. Click count: 1 click → expand, click again
//  → collapse. No deep links yet; that's a Phase 3 sugar item.
//
//  Layout (collapsed):
//    Bugs                              34 open
//                                      0 new · 0 inv · 34 prop
//
//  Layout (expanded):
//    Bugs                              34 open
//      • [proposed] Cookie not stripped …
//      • [proposed] getSearchToken …
//      • [proposed] constructClientId …
//

import SwiftUI

struct BugsCard: View {
    let bugs: BugsSummary

    // Default expanded so the user actually sees the top bug titles. Toggle
    // closes it. Switching to @AppStorage later would persist user preference.
    @State private var expanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Header row, always visible. Tapping toggles expansion.
            Button(action: { expanded.toggle() }) {
                HStack {
                    Text("Bugs")
                        .font(.system(size: 11, weight: .medium))
                    Spacer()
                    if let err = bugs.error {
                        Text(err)
                            .font(.system(size: 9))
                            .foregroundStyle(.red)
                            .lineLimit(1)
                    } else {
                        Text("\(bugs.openTotal) open")
                            .font(.system(size: 10))
                            .foregroundStyle(bugs.openTotal > 0 ? .orange : .secondary)
                            .monospacedDigit()
                    }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            HStack(spacing: 6) {
                ChipView(label: "new", count: bugs.newCount, color: .red)
                ChipView(label: "inv", count: bugs.investigatingCount, color: .yellow)
                ChipView(label: "prop", count: bugs.proposedCount, color: .blue)
            }

            if expanded && !bugs.preview.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(bugs.preview.enumerated()), id: \.offset) { _, title in
                        Text("• \(title)")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .padding(.top, 2)
            }
        }
    }
}

/// Tiny pill: "5 new". Used by both BugsCard and AttentionCard.
struct ChipView: View {
    let label: String
    let count: Int
    let color: Color

    var body: some View {
        HStack(spacing: 3) {
            Circle().fill(color.opacity(count > 0 ? 0.85 : 0.35)).frame(width: 6, height: 6)
            Text("\(count) \(label)")
                .font(.system(size: 9))
                .foregroundStyle(count > 0 ? .primary : .secondary)
                .monospacedDigit()
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(Color.secondary.opacity(0.08))
        .clipShape(Capsule())
    }
}
