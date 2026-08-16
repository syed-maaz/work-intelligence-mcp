//
//  AttentionSignal.swift
//
//  Unified "something needs the user's attention" envelope. Every data source
//  (stale cypher sessions, expired MCP tokens, drifted work items, overdue
//  alerts, bridge crashes) is normalized into this shape so the UI doesn't
//  care where it came from and the notifier can fire on any of them.
//
//  De-dup strategy:
//   * `stableID` is the hash key. Same signal with the same ID fires once.
//   * `fingerprint` is a content hash. If the body changes (e.g. count went
//     from 4 stale sessions to 5) we want a fresh notification. The Notifier
//     records (stableID, fingerprint) tuples in UserDefaults and only posts
//     when a tuple is new OR older than 6 hours.
//

import Foundation

enum SignalSeverity: String, Comparable {
    case info       // gray, silent
    case warning    // yellow, banner only
    case critical   // red, banner + sound

    static func < (lhs: SignalSeverity, rhs: SignalSeverity) -> Bool {
        let order: [SignalSeverity] = [.info, .warning, .critical]
        return order.firstIndex(of: lhs)! < order.firstIndex(of: rhs)!
    }
}

enum SignalCategory: String {
    case cypherSession   // stale or pending cypher session
    case mcpToken        // MCP OAuth token expired / expiring
    case workItemDrift   // stale in-progress work item
    case alertOverdue    // overdue action items from /api/alerts
    case service         // bridge / web / docs crashed
}

extension SignalCategory {
    /// Human-readable subsystem label, used as the notification subtitle
    /// so stacked banners are distinguishable at a glance. Prior implementation
    /// used a hard-coded "WI Menubar" subtitle for every category — when 3+
    /// banners stacked in Notification Center the user couldn't tell which
    /// subsystem fired. Plan: `.planning/wi-menubar-notifications/01-UX-…`.
    var subsystemLabel: String {
        switch self {
        case .cypherSession:  return "WI · Cypher"
        case .mcpToken:       return "WI · MCP Tokens"
        case .service:        return "WI · Service Health"
        case .workItemDrift:  return "WI · Work Drift"
        case .alertOverdue:   return "WI · Alerts"
        }
    }
}

struct AttentionSignal: Identifiable, Equatable {
    /// Stable identity for de-dup across polls. e.g. "mcp.my-jira" — the
    /// same expired-token signal should keep this ID across refreshes.
    let stableID: String

    /// Content fingerprint. Changes when the underlying details change
    /// materially enough to warrant a fresh banner.
    let fingerprint: String

    let category: SignalCategory
    let severity: SignalSeverity

    let title: String
    /// One-line elaboration, capped to ~80 chars in the UI.
    let body: String

    /// Optional one-line "how to fix it" — the menubar shows this dim, the
    /// notification puts it in the body.
    let actionHint: String?

    /// Optional URL to open when the user clicks the signal row. Typically
    /// points to a page in the web UI (e.g. /bugs, /cypher, /action-items).
    let openURL: URL?

    /// When the signal was first observed in this run.
    let observedAt: Date

    /// SwiftUI identity = stableID. Two signals with the same stableID are
    /// considered the same row (the UI will replace, not duplicate).
    var id: String { stableID }
}
