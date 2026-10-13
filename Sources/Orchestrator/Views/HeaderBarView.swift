import SwiftUI

/// The chip bar above the chat — mirrors the Codex app header:
/// [Local] [project] [worktree] [branch] … [$cost] [engine] [access] [review toggle]
struct HeaderBarView: View {
    @EnvironmentObject var store: AppStore
    @Binding var session: Session
    let worktree: Worktree?
    @Binding var showReview: Bool
    @State private var liveBranch: String? = nil
    @State private var confirmDelete = false

    var body: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Chip(icon: "laptopcomputer", text: "Local", help: "Runs on this Mac — no remote sessions.")

                    if let worktree, let project = store.project(for: worktree) {
                        Chip(icon: "folder", text: project.name, help: project.path)
                        Chip(
                            icon: worktree.isMain ? "house" : "square.on.square.dashed",
                            text: worktree.name,
                            help: worktree.isMain
                                ? "Main checkout: \(worktree.path)"
                                : "Worktree: \(worktree.path)\nBase: \(worktree.baseBranch ?? "?")\nNever recycled automatically.")
                    }

                    if let branch = liveBranch {
                        Chip(icon: "arrow.triangle.branch", text: branch,
                             help: "Current branch (live — agents may switch it)")
                    }
                }
            }

            Spacer(minLength: 4)

            // Steer/Queue: what happens to messages sent while the agent is mid-turn.
            // One click flips it; always visible.
            Button {
                session.steeringMode = session.steeringMode == .steer ? .queue : .steer
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: session.steeringMode == .steer ? "bolt.fill" : "clock")
                        .foregroundStyle(session.steeringMode == .steer ? Color.yellow : Color.secondary)
                    Text(session.steeringMode.displayName)
                        .lineLimit(1)
                    if let queued = store.queuedMessages[session.id], !queued.isEmpty {
                        Text("\(queued.count)")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.orange.opacity(0.3)))
                    }
                }
            }
            .buttonStyle(.plain)
            .fixedSize()
            .chipStyle()
            .help("Messages sent while the agent is running: \(session.steeringMode.help)\nClick to toggle.")

            if store.runningSessions.contains(session.id) {
                HStack(spacing: 6) {
                    RunningDot()
                    Text("Working…")
                        .foregroundStyle(.green)
                }
                .chipStyle()
                .help("\(session.engine.displayName) is running a turn in this session")
            }

            if session.totalCostUSD > 0 || session.outputTokens > 0 {
                Chip(
                    icon: "dollarsign.circle",
                    text: String(format: "$%.3f", session.totalCostUSD),
                    help: "API-equivalent cost this session\n"
                        + "in: \(session.inputTokens)  cache: \(session.cachedInputTokens)  out: \(session.outputTokens) tokens")
            }

            // Engine switcher — works mid-conversation; the new engine gets a context bridge.
            Menu {
                ForEach(EngineKind.allCases) { kind in
                    Button {
                        store.switchEngine(sessionID: session.id, to: kind)
                    } label: {
                        HStack {
                            Label(kind.displayName, systemImage: kind.symbol)
                            if kind == session.engine { Image(systemName: "checkmark") }
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: session.engine.symbol)
                        .foregroundStyle(session.engine == .claude ? Color.orange : Color.teal)
                    Text(session.engine.displayName)
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .chipStyle()
            .help("Switch engine mid-session — conversation context is carried over.")

            // Model picker (per session, applies from the next turn).
            Menu {
                ForEach(EngineOptions.models(for: session.engine), id: \.label) { option in
                    Button {
                        session.model = option.id
                    } label: {
                        HStack {
                            Text(option.label)
                            if option.id == session.model { Image(systemName: "checkmark") }
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "cpu")
                        .foregroundStyle(.secondary)
                    Text(currentModelLabel)
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .chipStyle()
            .help("Model for this session (Default = the engine's own configured model). Applies from the next message.")

            // Reasoning effort picker.
            Menu {
                ForEach(EngineOptions.efforts(for: session.engine), id: \.self) { effort in
                    Button {
                        session.effort = effort
                    } label: {
                        HStack {
                            Text(effort?.capitalized ?? "Default")
                            if effort == session.effort { Image(systemName: "checkmark") }
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "brain")
                        .foregroundStyle(.secondary)
                    Text(session.effort?.capitalized ?? "Effort")
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .chipStyle()
            .help("Reasoning effort (claude --effort / codex model_reasoning_effort). Default = engine's own setting. Applies from the next message.")

            Menu {
                ForEach(AccessMode.allCases) { mode in
                    Button {
                        session.accessMode = mode
                    } label: {
                        HStack {
                            Label(mode.displayName, systemImage: mode.symbol)
                            if mode == session.accessMode { Image(systemName: "checkmark") }
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: session.accessMode.symbol)
                        .foregroundStyle(session.accessMode == .full ? Color.red : Color.secondary)
                    Text(session.accessMode.displayName)
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .chipStyle()
            .help(session.accessMode.help)

            Button {
                withAnimation { showReview.toggle() }
            } label: {
                Image(systemName: "sidebar.trailing")
                    .symbolVariant(showReview ? .fill : .none)
            }
            .buttonStyle(.borderless)
            .help(showReview ? "Hide review panel (⌘⇧R)" : "Show review panel (⌘⇧R)")

            Menu {
                Button(session.isPinned ? "Unpin Session" : "Pin Session to Top") {
                    store.togglePin(sessionID: session.id)
                }
                Button("Archive Session") { store.setArchived(sessionID: session.id, true) }
                if let worktree {
                    Divider()
                    Button("Open Worktree Page") { store.selectedWorktreeID = worktree.id }
                }
                Divider()
                Button("Delete Session", role: .destructive) { confirmDelete = true }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Pin, archive or delete this session")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .confirmationDialog("Delete “\(session.title)”?", isPresented: $confirmDelete) {
            Button("Delete Session", role: .destructive) {
                if let full = store.sessions.first(where: { $0.id == session.id }) {
                    store.deleteSession(full)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only the chat is deleted. The worktree is untouched.")
        }
        .onAppear(perform: refreshBranch)
        .onChange(of: store.reviewGeneration) { refreshBranch() }
    }

    private var currentModelLabel: String {
        if let model = session.model {
            return EngineOptions.models(for: session.engine)
                .first { $0.id == model }?.label ?? model
        }
        return "Model"
    }

    private func refreshBranch() {
        guard let path = worktree?.path else { return }
        DispatchQueue.global(qos: .utility).async {
            let branch = GitService.currentBranch(path)
            DispatchQueue.main.async { liveBranch = branch }
        }
    }
}

struct Chip: View {
    var icon: String
    var text: String
    var help: String = ""

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
            Text(text)
                .lineLimit(1)
        }
        .chipStyle()
        .help(help)
    }
}

extension View {
    func chipStyle() -> some View {
        self
            .font(.callout)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            )
    }
}
