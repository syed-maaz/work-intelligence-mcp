//
//  TokenUsageCard.swift
//
//  Compact 7-day token-usage card with a tiny inline sparkline.
//
//  Layout:
//    Tokens (7d)                       12,345 in · 6,789 out
//    ▁▂▅▆▇▆▂                           $0.07 · 12 calls
//

import SwiftUI

struct TokenUsageCard: View {
    let usage: TokenUsage

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Tokens (7d)")
                    .font(.system(size: 11, weight: .medium))
                Spacer()
                if let err = usage.error {
                    Text(err)
                        .font(.system(size: 9))
                        .foregroundStyle(.red)
                        .lineLimit(1)
                } else {
                    Text("\(formatThousands(usage.totalInputTokens))  in  ·  \(formatThousands(usage.totalOutputTokens)) out")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            HStack(spacing: 6) {
                SparklineView(values: usage.dailyTotals)
                    .frame(height: 16)
                Spacer()
                Text("$\(String(format: "%.2f", usage.estCostUsd))  ·  \(usage.totalCalls) calls")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    private func formatThousands(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }
}

/// Tiny inline sparkline. Renders one bar per data point, height proportional
/// to value / max. Min bar height is 1px so empty days are still visible as a
/// baseline. SwiftUI `Path` would be smoother but bars read better at 16px.
struct SparklineView: View {
    let values: [Int]

    var body: some View {
        GeometryReader { geo in
            let count = max(values.count, 1)
            let maxVal = max(values.max() ?? 1, 1)
            let barWidth = (geo.size.width - CGFloat(count - 1) * 1.5) / CGFloat(count)
            HStack(alignment: .bottom, spacing: 1.5) {
                ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                    let h = max(1.0, geo.size.height * (CGFloat(v) / CGFloat(maxVal)))
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color.accentColor.opacity(0.7))
                        .frame(width: max(2, barWidth), height: h)
                }
            }
        }
    }
}
