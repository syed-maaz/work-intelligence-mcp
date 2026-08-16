//
//  CardData.swift
//
//  Plain data structs for the three Phase-2 cards. One struct per card so
//  diffing is local — updating tokens doesn't redraw the bugs row.
//

import Foundation

/// Result of polling `/api/system-health/tokens?windowDays=7`.
struct TokenUsage: Equatable {
    var totalCalls: Int
    var totalInputTokens: Int
    var totalOutputTokens: Int
    var estCostUsd: Double
    /// One bar per day. Length is whatever the API returned (typically 7).
    /// Each value is the day's input+output combined.
    var dailyTotals: [Int]
    var lastUpdated: Date?
    var error: String?

    static let empty = TokenUsage(
        totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0,
        estCostUsd: 0, dailyTotals: [], lastUpdated: nil, error: nil
    )
}

/// Result of polling `/api/bugs` for open-ish statuses combined.
struct BugsSummary: Equatable {
    var newCount: Int
    var investigatingCount: Int
    var proposedCount: Int
    /// Top 3 bug titles for the expanded view.
    var preview: [String]
    var lastUpdated: Date?
    var error: String?

    var openTotal: Int { newCount + investigatingCount + proposedCount }

    static let empty = BugsSummary(
        newCount: 0, investigatingCount: 0, proposedCount: 0,
        preview: [], lastUpdated: nil, error: nil
    )
}

/// Result of polling `/api/cypher/pm/next` for the phase queue.
struct AttentionSummary: Equatable {
    /// Total pending phase items.
    var pendingCount: Int
    /// Top 3 (id, title) tuples for the expanded view.
    var preview: [(id: String, title: String)]
    var lastUpdated: Date?
    var error: String?

    static let empty = AttentionSummary(
        pendingCount: 0, preview: [], lastUpdated: nil, error: nil
    )

    // Equatable manually because tuples aren't Equatable in Swift.
    static func == (lhs: AttentionSummary, rhs: AttentionSummary) -> Bool {
        lhs.pendingCount == rhs.pendingCount
            && lhs.lastUpdated == rhs.lastUpdated
            && lhs.error == rhs.error
            && lhs.preview.count == rhs.preview.count
            && zip(lhs.preview, rhs.preview).allSatisfy { $0.id == $1.id && $0.title == $1.title }
    }
}
