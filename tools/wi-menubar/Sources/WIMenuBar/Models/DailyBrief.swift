//
//  DailyBrief.swift
//
//  Extracted from /api/morning-brief. We pull only the structured slices we
//  display in the popover header — the markdown summary is too long for a
//  300px-wide card and we don't want to host a markdown renderer.
//
//  Shape mapped from the bridge response:
//    {
//      date: "2026-06-22",
//      cached: bool,
//      sections: {
//        alerts:     [ {severity, title} ]            ← we want severity=="critical"
//        calendar:   [ {title, start_time} ]          ← today's events
//        priorities: [ {title, due_date, status} ]    ← top 5 open action items
//        sprintDelta:{ opened, closed, net }
//      }
//    }
//

import Foundation

struct DailyBrief: Equatable {
    /// "Monday, June 22" — derived locally for display.
    var dayLabel: String
    var criticalAlerts: [String]
    /// Items already filtered to "happening today".
    var calendar: [BriefEvent]
    /// Top action items already filtered to overdue or due-today.
    var priorities: [BriefPriority]
    var sprintNet: Int
    var lastUpdated: Date?
    var cached: Bool
    var error: String?

    static let empty = DailyBrief(
        dayLabel: "", criticalAlerts: [],
        calendar: [], priorities: [],
        sprintNet: 0, lastUpdated: nil,
        cached: false, error: nil
    )
}

struct BriefEvent: Equatable {
    var title: String
    /// "10:30" pulled from start_time ISO string.
    var startTime: String
}

struct BriefPriority: Equatable {
    var title: String
    /// "overdue 3d" or "today" or "" if no due_date.
    var dueLabel: String
    var isOverdue: Bool
}
