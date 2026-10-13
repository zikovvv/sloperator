import SwiftUI
import AppKit

/// The page you get by clicking a worktree: what it is, where it lives, and everything
/// running inside it.
struct WorktreeDetailView: View {
    @EnvironmentObject var store: AppStore
    let worktree: Worktree

    @State private var name = ""
    @State private var liveBranch: String? = nil
    @State private var changedCount = 0
    @State private var confirmDiskDelete = false
    @FocusState private var nameFocused: Bool

    private var project: Project? { store.project(for: worktree) }
    private var sessions: [Session] { store.sessions(in: worktree) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                details
                sessionsCard
                if !worktree.isMain { dangerZone }
            }
            .padding(20)
            .frame(maxWidth: 820, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .onAppear(perform: load)
        .onChange(of: worktree.id) { load() }
        .onChange(of: store.reviewGeneration) { refreshGit() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: worktree.isMain ? "house.fill" : "square.on.square.dashed")
                .font(.system(size: 28))
                .foregroundStyle(worktree.isMain ? Color.secondary : Color.purple)
            VStack(alignment: .leading, spacing: 4) {
                TextField("Worktree name", text: $name)
                    .textFieldStyle(.plain)
                    .font(.title2.weight(.semibold))
                    .focused($nameFocused)
                    .onSubmit(commitName)
                    .onChange(of: nameFocused) { _, focused in
                        if !focused { commitName() }
                    }
                Text(worktree.isMain
                     ? "The project's own checkout"
                     : "Isolated worktree — never deleted automatically")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                store.createSessionQuick(worktree: worktree)
            } label: {
                Label("New Session", systemImage: "plus.bubble")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 0) {
            row("Project", value: project?.name ?? "—")
            Divider()
            row("Path", value: worktree.path, mono: true) {
                Button("Reveal") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: worktree.path)])
                }
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(worktree.path, forType: .string)
                }
                Button("Terminal") { openInTerminal() }
            }
            Divider()
            row("Branch", value: liveBranch ?? worktree.branch ?? "—", mono: true) {
                if liveBranch != nil, let created = worktree.branch, liveBranch != created {
                    Text("created on \(created)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Divider()
            baseBranchRow
            Divider()
            row("Changes", value: changedCount == 0 ? "clean" : "\(changedCount) file(s) vs base")
            Divider()
            row("Created", value: worktree.createdAt.formatted(date: .abbreviated, time: .shortened))
        }
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
    }

    /// The diff in the review panel is computed against this.
    private var baseBranchRow: some View {
        HStack {
            Text("Base")
                .frame(width: 90, alignment: .leading)
                .foregroundStyle(.secondary)
            BranchPicker(
                branches: availableBranches,
                selection: Binding(
                    get: { worktree.baseBranch ?? "" },
                    set: { newValue in
                        var updated = worktree
                        updated.baseBranch = newValue.isEmpty ? nil : newValue
                        store.updateWorktree(updated)
                        store.reviewGeneration += 1
                    }
                ),
                noneLabel: "HEAD (no base)",
                placeholder: "Search \(availableBranches.count) branches…",
                isLoading: branchesLoading)
                .frame(maxWidth: 300)
            Text("what the review diff compares against")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }

    @State private var availableBranches: [String] = []
    @State private var branchesLoading = false

    private func row(
        _ label: String, value: String, mono: Bool = false,
        @ViewBuilder trailing: () -> some View = { EmptyView() }
    ) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .frame(width: 90, alignment: .leading)
                .foregroundStyle(.secondary)
            Text(value)
                .font(mono ? .system(.callout, design: .monospaced) : .callout)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            trailing()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }

    private var sessionsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sessions in this worktree")
                .font(.headline)
            if sessions.isEmpty {
                Text("No sessions yet — “New Session” starts one here.")
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            } else {
                ForEach(sessions) { session in
                    Button {
                        store.selectedSessionID = session.id
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: session.engine.symbol)
                                .foregroundStyle(session.engine == .claude ? Color.orange : Color.teal)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(session.title).lineLimit(1)
                                Text(session.lastActivityAt.formatted(
                                    .relative(presentation: .numeric)))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            if store.runningSessions.contains(session.id) {
                                RunningDot()
                            } else if store.needsAttention.contains(session.id) {
                                Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                            }
                            if session.totalCostUSD > 0 {
                                Text(String(format: "$%.3f", session.totalCostUSD))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(HoverRowButtonStyle())
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
    }

    private var dangerZone: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Manage")
                .font(.headline)
            HStack {
                Button(worktree.isPinned ? "Unpin" : "Pin to Top") {
                    store.togglePin(worktreeID: worktree.id)
                }
                Button("Archive") {
                    store.setArchived(worktreeID: worktree.id, true)
                }
                .help("Hides it from the sidebar; nothing on disk changes")
                Button("Remove from Sidebar") {
                    store.removeWorktreeFromList(worktree)
                }
                .help("Forgets it here; keeps the worktree and branch on disk")
                Spacer()
                Button(role: .destructive) {
                    confirmDiskDelete = true
                } label: {
                    Label("Delete Worktree", systemImage: "trash")
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .help("Deletes the folder and this app's records. The branch is kept.")
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
        .confirmationDialog(
            "Do you really want to delete “\(worktree.name)”?",
            isPresented: $confirmDiskDelete, titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                store.deleteWorktreeFromDisk(worktree)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deletes the folder \(worktree.path), any uncommitted changes in it, and "
                 + "\(sessions.count) session\(sessions.count == 1 ? "" : "s") with their "
                 + "transcripts.\n\nThe branch \(worktree.branch ?? "it is on") is NOT deleted — "
                 + "your commits stay in the repository.")
        }
    }

    private func commitName() {
        store.rename(worktreeID: worktree.id, to: name)
    }

    private func openInTerminal() {
        // POSIX-quote the path: worktrees under directories with spaces failed to cd, and a
        // path containing shell metacharacters would otherwise be executed.
        let quoted = "'" + worktree.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let script = """
        tell application "Terminal"
            activate
            do script "cd \(quoted)"
        end tell
        """
        Shell.run("/usr/bin/osascript", ["-e", script])
    }

    private func load() {
        name = worktree.name
        refreshGit()
    }

    private func refreshGit() {
        branchesLoading = availableBranches.isEmpty
        let path = worktree.path
        let base = worktree.isMain ? nil : worktree.baseBranch
        let projectPath = project?.path ?? path
        DispatchQueue.global(qos: .userInitiated).async {
            let branch = GitService.currentBranch(path)
            let changes = GitService.changedFiles(path, base: base).count
            let branches = GitService.branches(projectPath)
            DispatchQueue.main.async {
                liveBranch = branch
                changedCount = changes
                availableBranches = branches
                branchesLoading = false
            }
        }
    }
}

/// Row that actually reacts to the pointer.
///
/// The hover state lives in a nested View, not in the style itself: `ButtonStyle` is not a
/// `View`, so a `@State` declared on it has no storage attached to any view identity. SwiftUI
/// then renders it undefined — in practice buttons intermittently drew filled/black.
struct HoverRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverRow(configuration: configuration)
    }

    private struct HoverRow: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(configuration.isPressed
                              ? Color.accentColor.opacity(0.25)
                              : hovering ? Color.primary.opacity(0.07) : Color.clear)
                )
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
                .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
        }
    }
}

/// Small icon button with real hover and press feedback (the sidebar + buttons).
struct SidebarIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        IconButton(configuration: configuration)
    }

    private struct IconButton: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .foregroundStyle(hovering ? Color.primary : Color.secondary)
                .padding(3)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(configuration.isPressed
                              ? Color.accentColor.opacity(0.35)
                              : hovering ? Color.primary.opacity(0.12) : Color.clear)
                )
                .scaleEffect(configuration.isPressed ? 0.88 : 1)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
                .animation(.spring(response: 0.2, dampingFraction: 0.6),
                           value: configuration.isPressed)
        }
    }
}
