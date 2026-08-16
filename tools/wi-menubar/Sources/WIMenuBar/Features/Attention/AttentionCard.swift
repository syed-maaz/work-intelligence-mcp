//
//  AttentionCard.swift
//
//  Shows the pending-phase queue count. Click to expand to the top 3 items.
//
//  Layout (collapsed):
//    Attention                         8 pending
//
//  Layout (expanded):
//    Attention                         8 pending
//      • PHASE-86-02  Investigate stage: stop being a stub
//      • PHASE-86-05  Complexity scorer NL-structure signals
//      • PHASE-86-07  Argument-availability filter in skill ranker
//

import SwiftUI

struct AttentionCard: View {
    let attention: AttentionSummary

    @State private var expanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: { expanded.toggle() }) {
                HStack {
                    Text("Attention")
                        .font(.system(size: 11, weight: .medium))
                    Spacer()
                    if let err = attention.error {
                        Text(err)
                            .font(.system(size: 9))
                            .foregroundStyle(.red)
                            .lineLimit(1)
                    } else {
                        Text("\(attention.pendingCount) pending")
                            .font(.system(size: 10))
                            .foregroundStyle(attention.pendingCount > 0 ? .orange : .secondary)
                            .monospacedDigit()
                    }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded && !attention.preview.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(attention.preview, id: \.id) { item in
                        HStack(alignment: .top, spacing: 4) {
                            Text(item.id)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .frame(minWidth: 70, alignment: .leading)
                            Text(item.title)
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                }
                .padding(.top, 2)
            }
        }
    }
}
