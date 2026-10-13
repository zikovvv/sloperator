import SwiftUI

/// Usage dashboard: live 5-hour Claude usage block (quota window + when it resets),
/// block history, and per-session API-equivalent costs from this app.
struct UsageView: View {
    @EnvironmentObject var store: AppStore
    @State private var blocks: [UsageBlock] = []
    @State private var loading = false
    @State private var now = Date()

    private let timer = Timer.publish(every: 120, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                currentBlockCard
                sessionCostsCard
                historyCard
            }
            .padding(20)
            .frame(maxWidth: 900, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .onAppear(perform: refresh)
        .onReceive(timer) { _ in
            now = Date()
            refresh()
        }
    }

    private var activeBlock: UsageBlock? {
        blocks.last.flatMap { $0.isActive ? $0 : nil }
    }

    private var currentBlockCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Claude usage — current 5h block", systemImage: "gauge.with.needle")
                    .font(.headline)
                Spacer()
                if loading { ProgressView().controlSize(.small) }
                Button {
                    refresh()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }

            if let block = activeBlock {
                let elapsed = now.timeIntervalSince(block.start)
                let fraction = min(1, elapsed / (5 * 3600))
                ProgressView(value: fraction)
                    .tint(fraction > 0.85 ? .red : fraction > 0.6 ? .orange : .accentColor)
                HStack {
                    Text("Started \(block.start.formatted(date: .omitted, time: .shortened))")
                    Spacer()
                    Text("Resets \(block.end.formatted(date: .omitted, time: .shortened)) — in \(remaining(block))")
                        .fontWeight(.semibold)
                }
                .font(.callout)
                .foregroundStyle(.secondary)

                HStack(spacing: 24) {
                    stat("Messages", "\(block.messages)")
                    stat("Input", format(block.inputTokens))
                    stat("Cache", format(block.cachedTokens))
                    stat("Output", format(block.outputTokens))
                }
                if !block.tokensByModel.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(block.tokensByModel.sorted { $0.value > $1.value }, id: \.key) { model, tokens in
                            Text("\(model): \(format(tokens))")
                                .font(.caption)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(Color.primary.opacity(0.07)))
                        }
                    }
                }
            } else {
                Text("No active block — the next message starts a fresh 5-hour window.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
    }

    private var sessionCostsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Session costs (API-equivalent)", systemImage: "dollarsign.circle")
                .font(.headline)
            let sessions = store.sessions
                .filter { $0.totalCostUSD > 0 || $0.outputTokens > 0 }
                .sorted { $0.totalCostUSD > $1.totalCostUSD }
            if sessions.isEmpty {
                Text("No usage recorded yet in this app.")
                    .foregroundStyle(.secondary)
            } else {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 5) {
                    GridRow {
                        Text("Session").fontWeight(.semibold)
                        Text("Engine").fontWeight(.semibold)
                        Text("In / Cache / Out").fontWeight(.semibold)
                        Text("Cost").fontWeight(.semibold)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    ForEach(sessions) { session in
                        GridRow {
                            Text(session.title).lineLimit(1)
                            Text(session.engine.displayName)
                                .foregroundStyle(session.engine == .claude ? .orange : .teal)
                            Text("\(format(session.inputTokens)) / \(format(session.cachedInputTokens)) / \(format(session.outputTokens))")
                                .font(.callout.monospacedDigit())
                            Text(String(format: "$%.3f", session.totalCostUSD))
                                .font(.callout.monospacedDigit())
                                .fontWeight(.medium)
                        }
                    }
                    Divider()
                    GridRow {
                        Text("Total").fontWeight(.bold)
                        Text("")
                        Text("")
                        Text(String(format: "$%.3f", sessions.reduce(0) { $0 + $1.totalCostUSD }))
                            .fontWeight(.bold)
                            .font(.callout.monospacedDigit())
                    }
                }
                Text("Claude cost comes from the CLI itself; Codex cost is computed from the per-Mtok rates in Settings.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
    }

    private var historyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Recent blocks (last ~30h)", systemImage: "clock.arrow.circlepath")
                .font(.headline)
            if blocks.isEmpty {
                Text("No recent Claude activity found in ~/.claude/projects.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(blocks.reversed().enumerated()), id: \.offset) { _, block in
                    HStack {
                        Circle()
                            .fill(block.isActive ? Color.green : Color.secondary.opacity(0.4))
                            .frame(width: 8, height: 8)
                        Text("\(block.start.formatted(date: .abbreviated, time: .shortened)) → \(block.end.formatted(date: .omitted, time: .shortened))")
                            .font(.callout.monospacedDigit())
                        Spacer()
                        Text("\(block.messages) msgs")
                            .foregroundStyle(.secondary)
                        Text("\(format(block.inputTokens + block.outputTokens)) tok (+\(format(block.cachedTokens)) cache)")
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .font(.callout)
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.monospacedDigit().weight(.semibold))
        }
    }

    private func remaining(_ block: UsageBlock) -> String {
        let seconds = max(0, Int(block.end.timeIntervalSince(now)))
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }

    private func format(_ tokens: Int) -> String {
        if tokens >= 1_000_000 { return String(format: "%.1fM", Double(tokens) / 1e6) }
        if tokens >= 1_000 { return String(format: "%.1fk", Double(tokens) / 1e3) }
        return "\(tokens)"
    }

    private func refresh() {
        guard !loading else { return }
        loading = true
        DispatchQueue.global(qos: .userInitiated).async {
            let scanned = UsageService.scanBlocks()
            DispatchQueue.main.async {
                blocks = scanned
                loading = false
            }
        }
    }
}
