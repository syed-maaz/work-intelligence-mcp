//
//  DailyBriefHeader.swift
//
//  Top-of-popover card that surfaces /api/morning-brief content:
//
//   - Day header ("Monday, June 22")
//   - Critical alerts (red, up to 2)
//   - Today's calendar (up to 3 events with HH:mm)
//   - Top priorities (up to 3 action items with due labels)
//   - Sprint delta footer
//   - "Open full digest ↗" link → /digest in the web UI
//
//  Empty / loading / error states all handled by per-section gating.
//

import SwiftUI
import AppKit

struct DailyBriefHeader: View {
    let brief: DailyBrief
    /// When true, render the loading placeholder regardless of whether
    /// `brief` already holds prior content. Lets the popover show "still
    /// generating…" during the 30–55s cold-cache call without flashing
    /// stale data.
    var loading: Bool = false

    private let digestURL = URL(string: "http://localhost:5175/digest")!

    @State private var expanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header

            if expanded {
                // Loading / error states first.
                if loading && brief.dayLabel.isEmpty {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.small)
                        Text("Generating today's brief (up to 60s on cold cache)…")
                            .font(.system(size: 10))
                            .foregroundColor(.secondary)
                    }
                } else if brief.error != nil {
                    Text(brief.error ?? "Brief unavailable")
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                } else if brief.dayLabel.isEmpty {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.small)
                        Text("Loading today's brief…")
                            .font(.system(size: 10))
                            .foregroundColor(.secondary)
                    }
                } else {
                    // Critical alerts.
                    if !brief.criticalAlerts.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(brief.criticalAlerts.prefix(2), id: \.self) { alert in
                                HStack(spacing: 4) {
                                    Image(systemName: "exclamationmark.triangle.fill")
                                        .font(.system(size: 9))
                                        .foregroundColor(.red)
                                    Text(alert)
                                        .font(.system(size: 10))
                                        .lineLimit(2)
                                }
                            }
                            if brief.criticalAlerts.count > 2 {
                                Text("+\(brief.criticalAlerts.count - 2) more critical")
                                    .font(.system(size: 9))
                                    .foregroundColor(.secondary)
                            }
                        }
                    }

                    // Calendar — today's events.
                    section(
                        title: "Today",
                        icon: "calendar",
                        rows: brief.calendar.prefix(3).map { e in
                            BriefRow(
                                leading: e.startTime.isEmpty ? "—" : e.startTime,
                                title: e.title,
                                trailing: nil,
                                isHot: false
                            )
                        },
                        emptyText: "No events scheduled."
                    )

                    // Top priorities — overdue first.
                    section(
                        title: "Priorities",
                        icon: "exclamationmark.circle",
                        rows: sortedPriorities.prefix(3).map { p in
                            BriefRow(
                                leading: nil,
                                title: p.title,
                                trailing: p.dueLabel,
                                isHot: p.isOverdue
                            )
                        },
                        emptyText: "Inbox zero today."
                    )

                    // Sprint delta footer.
                    if brief.sprintNet != 0 {
                        HStack(spacing: 4) {
                            Image(systemName: brief.sprintNet > 0 ? "arrow.up.right" : "arrow.down.right")
                                .font(.system(size: 9))
                            Text("Sprint delta: \(brief.sprintNet > 0 ? "+" : "")\(brief.sprintNet)")
                                .font(.system(size: 10))
                        }
                        .foregroundColor(brief.sprintNet > 0 ? .orange : .green)
                        .padding(.top, 1)
                    }

                    // Open-digest CTA.
                    Button(action: { NSWorkspace.shared.open(digestURL) }) {
                        HStack(spacing: 3) {
                            Text("Open full digest")
                                .font(.system(size: 10))
                            Image(systemName: "arrow.up.right.square")
                                .font(.system(size: 9))
                        }
                        .foregroundColor(.accentColor)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.accentColor.opacity(0.07))
        )
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 6) {
            Button(action: { expanded.toggle() }) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)

            Image(systemName: "sun.max.fill")
                .foregroundColor(.yellow)
                .font(.system(size: 12))

            Text("Morning brief")
                .font(.system(size: 13, weight: .semibold))

            if !brief.dayLabel.isEmpty {
                Text("· \(brief.dayLabel)")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            // Freshness indicator: green dot = freshly generated, gray = cached.
            Circle()
                .fill(brief.cached ? Color.secondary.opacity(0.4) : Color.green)
                .frame(width: 5, height: 5)
                .help(brief.cached ? "Cached (refreshes hourly)" : "Freshly generated")
        }
        .contentShape(Rectangle())
        .onTapGesture { expanded.toggle() }
    }

    // MARK: - Section helper

    private struct BriefRow: Identifiable {
        let id = UUID()
        let leading: String?
        let title: String
        let trailing: String?
        let isHot: Bool
    }

    @ViewBuilder
    private func section(title: String, icon: String, rows: [BriefRow], emptyText: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
                Text(title)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.secondary)
            }
            if rows.isEmpty {
                Text(emptyText)
                    .font(.system(size: 10))
                    .foregroundColor(.secondary.opacity(0.7))
                    .padding(.leading, 14)
            } else {
                ForEach(rows) { row in
                    HStack(alignment: .top, spacing: 4) {
                        if let leading = row.leading {
                            Text(leading)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.secondary)
                                .frame(width: 36, alignment: .leading)
                        } else {
                            // Bullet for non-time-anchored rows.
                            Text("•")
                                .font(.system(size: 10))
                                .foregroundColor(row.isHot ? .red : .secondary)
                                .frame(width: 12, alignment: .leading)
                        }
                        Text(row.title)
                            .font(.system(size: 10))
                            .lineLimit(2)
                        Spacer(minLength: 2)
                        if let trailing = row.trailing, !trailing.isEmpty {
                            Text(trailing)
                                .font(.system(size: 9))
                                .foregroundColor(row.isHot ? .red : .secondary)
                        }
                    }
                }
            }
        }
        .padding(.top, 2)
    }

    private var sortedPriorities: [BriefPriority] {
        brief.priorities.sorted { lhs, rhs in
            if lhs.isOverdue != rhs.isOverdue { return lhs.isOverdue && !rhs.isOverdue }
            return false
        }
    }
}
