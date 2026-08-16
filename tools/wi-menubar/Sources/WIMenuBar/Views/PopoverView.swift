//
//  PopoverView.swift
//
//  Composition root for the menubar popover. Tabbed layout — three sections
//  user can switch between with a segmented control at the top. Without this
//  split the original "seven stacked cards in a 320pt column" felt cramped:
//  everything shouted at once and the eye had nowhere to rest.
//
//  Tabs:
//    - Today     (Daily Brief — what's on the plate today)
//    - Health    (Signals + Services + at-a-glance status grid)
//    - Activity  (Token usage, bugs, work-queue attention)
//
//  The "Health" tab title carries a red dot when any critical signal is
//  live, so the user knows to click it without opening every tab. Same trick
//  for "Activity" if there's an open bug. This keeps the at-a-glance role
//  the popover used to play (everything visible) while giving each section
//  enough room to breathe when opened.
//

import SwiftUI

private enum PopoverTab: String, CaseIterable, Identifiable {
    case today
    case health
    case activity
    var id: String { rawValue }
    var title: String {
        switch self {
        case .today:    return "Today"
        case .health:   return "Health"
        case .activity: return "Activity"
        }
    }
}

struct PopoverView: View {
    @EnvironmentObject private var coordinator: ServicesCoordinator
    @EnvironmentObject private var data: DataCoordinator

    @State private var servicesExpanded: Bool = false

    /// Default to whichever tab is "loudest". If something is critical the
    /// user almost certainly wants Health first; otherwise Today is the
    /// natural landing page.
    @State private var activeTab: PopoverTab = .today
    @State private var initialised: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            tabBar
            Divider().padding(.vertical, 1)

            Group {
                switch activeTab {
                case .today:    todayPane
                case .health:   healthPane
                case .activity: activityPane
                }
            }

            Divider().padding(.vertical, 2)

            footer
        }
        .padding(14)
        .frame(width: 360)
        .onAppear {
            data.refreshAll()
            if !initialised {
                initialised = true
                if criticalCount > 0 { activeTab = .health }
            }
        }
    }

    // MARK: - Tab bar

    @ViewBuilder
    private var tabBar: some View {
        HStack(spacing: 6) {
            ForEach(PopoverTab.allCases) { tab in
                tabButton(tab)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func tabButton(_ tab: PopoverTab) -> some View {
        let isActive = activeTab == tab
        let dotColor = tabAlertColor(tab)
        Button(action: { activeTab = tab }) {
            HStack(spacing: 4) {
                Text(tab.title)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .foregroundColor(isActive ? .primary : .secondary)
                if let c = dotColor {
                    // Small severity dot acts as a "you have unread in this tab"
                    // marker so the user knows where to click. Doesn't appear
                    // when state is clean — clean menubar is a calm menubar.
                    Circle().fill(c).frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isActive ? Color.secondary.opacity(0.18) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Severity-tinted dot color shown next to a tab title when that tab has
    /// urgent content. nil = no dot.
    private func tabAlertColor(_ tab: PopoverTab) -> Color? {
        switch tab {
        case .today:
            // Today's brief doesn't currently carry severity; could later
            // light up for "critical alert in today's brief".
            return nil
        case .health:
            let critical = data.signals.contains { $0.severity == .critical }
            let warning  = data.signals.contains { $0.severity == .warning  }
            if critical { return .red }
            if warning  { return .orange }
            // Service down counts as critical Health concern too.
            if coordinator.states.contains(where: { $0.status == .crashed }) { return .red }
            return nil
        case .activity:
            // Light up activity if there's an open bug worth resolving.
            let openBugs = data.bugs.proposedCount + data.bugs.investigatingCount
            if openBugs > 0 { return .orange }
            return nil
        }
    }

    private var criticalCount: Int {
        data.signals.filter { $0.severity == .critical }.count
    }

    // MARK: - Today pane

    @ViewBuilder
    private var todayPane: some View {
        // Daily brief stays the headline. It's the densest, most useful
        // single card and benefits from extra width.
        DailyBriefHeader(brief: data.dailyBrief, loading: data.briefLoading)
    }

    // MARK: - Health pane

    @ViewBuilder
    private var healthPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Signals card: structured per-row breakdown of what's actually
            // alerting. Critical-first sort means the loudest thing is
            // always at the top.
            SignalsCard(signals: data.signals)

            // Service controls: connect/stop buttons. Collapsed by default —
            // user opens when they want to act on a service.
            VStack(alignment: .leading, spacing: 4) {
                Button(action: { servicesExpanded.toggle() }) {
                    HStack(spacing: 4) {
                        Image(systemName: servicesExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                        Text("Services")
                            .font(.system(size: 11, weight: .semibold))
                        Spacer(minLength: 4)
                        // Tiny summary: "3 · 1 crashed" when collapsed.
                        let crashedCount = coordinator.states.filter { $0.status == .crashed }.count
                        let runningCount = coordinator.states.filter { $0.status == .running || $0.status == .external }.count
                        Text("\(runningCount)/\(coordinator.states.count) up")
                            .font(.system(size: 10))
                            .foregroundColor(.secondary)
                            .monospacedDigit()
                        if crashedCount > 0 {
                            Text("· \(crashedCount) down")
                                .font(.system(size: 10))
                                .foregroundColor(.red)
                                .monospacedDigit()
                        }
                    }
                    .foregroundColor(.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if servicesExpanded {
                    ForEach(coordinator.states) { state in
                        ServiceRowView(
                            state: state,
                            onConnect: { coordinator.connect(state.id) },
                            onStop:    { coordinator.stop(state.id) }
                        )
                    }
                }
            }
        }
    }

    // MARK: - Activity pane

    @ViewBuilder
    private var activityPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            TokenUsageCard(usage: data.tokens)
            BugsCard(bugs: data.bugs)
            AttentionCard(attention: data.attention)
        }
    }

    // MARK: - Footer

    @ViewBuilder
    private var footer: some View {
        HStack {
            Text("Probing every \(String(format: "%.1f", coordinator.pollIntervalSeconds))s")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Spacer()
            Button(action: { data.refreshAll() }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10))
            }
            .buttonStyle(.plain)
            .help("Refresh now")

            Button("Quit") {
                coordinator.stopAll()
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
            .controlSize(.small)
        }
    }
}
