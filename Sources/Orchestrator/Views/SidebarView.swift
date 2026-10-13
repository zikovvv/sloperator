import SwiftUI
import AppKit

/// Sidebar hierarchy: Project → Worktree (the unit of work) → Sessions.
/// All create actions are ONE CLICK; options live in context menus. Buttons are always visible.
struct SidebarView: View {
    @EnvironmentObject var store: AppStore
    @State private var worktreeOptionsProject: Project? = nil

    var body: some View {
        List(selection: store.sidebarSelection) {
            ForEach(store.projects) { project in
                ProjectRow(project: project, worktreeOptionsProject: $worktreeOptionsProject)
                if isExpanded(project) {
                    ForEach(store.worktrees(in: project)) { worktree in
                        WorktreeRows(worktree: worktree)
                    }
                    let archived = store.archivedWorktrees(in: project)
                    if !archived.isEmpty {
                        DisclosureGroup("Archived worktrees (\(archived.count))") {
                            ForEach(archived) { worktree in
                                HStack(spacing: 6) {
                                    Image(systemName: "square.on.square.dashed")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                    Text(worktree.name)
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                    Spacer()
                                    Button("Restore") {
                                        store.setArchived(worktreeID: worktree.id, false)
                                    }
                                    .buttonStyle(.borderless)
                                    .font(.caption2)
                                }
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 14)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack {
                Button {
                    addProject()
                } label: {
                    Label("Add Project", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                Spacer()
            }
            .padding(8)
            .background(.bar)
        }
        .sheet(item: $worktreeOptionsProject) { project in
            NewWorktreeSheet(project: project)
        }
        .onReceive(NotificationCenter.default.publisher(for: .newWorktreeRequested)) { _ in
            if let sessionID = store.selectedSessionID,
               let session = store.sessions.first(where: { $0.id == sessionID }),
               let worktree = store.worktree(for: session),
               let project = store.project(for: worktree) {
                store.createWorktreeQuick(project: project)
            } else if let project = store.projects.first {
                store.createWorktreeQuick(project: project)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .newSessionRequested)) { _ in
            if let sessionID = store.selectedSessionID,
               let session = store.sessions.first(where: { $0.id == sessionID }),
               let worktree = store.worktree(for: session) {
                store.createSessionQuick(worktree: worktree)
            } else if let project = store.projects.first,
                      let worktree = store.worktrees(in: project).first {
                store.createSessionQuick(worktree: worktree)
            }
        }
    }

    private func isExpanded(_ project: Project) -> Bool {
        store.projects.first(where: { $0.id == project.id })?.isExpanded ?? true
    }

    private func addProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add Project"
        panel.message = "Choose one or more project folders (git is initialized automatically if missing)"
        if panel.runModal() == .OK {
            for url in panel.urls {
                store.addProject(path: url.path)
            }
        }
    }
}

/// Small pulsing dot marking a running agent.
struct RunningDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(Color.green)
            .frame(width: 8, height: 8)
            .opacity(pulsing ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: pulsing)
            .onAppear { pulsing = true }
    }
}

private struct ProjectRow: View {
    @EnvironmentObject var store: AppStore
    let project: Project
    @Binding var worktreeOptionsProject: Project?
    @State private var renamingProject = false
    @State private var projectDraftName = ""
    @FocusState private var projectNameFocused: Bool

    private var runningCount: Int {
        store.worktrees(in: project)
            .flatMap { store.sessions(in: $0) }
            .filter { store.runningSessions.contains($0.id) }
            .count
    }

    private var attentionCount: Int {
        store.worktrees(in: project)
            .flatMap { store.sessions(in: $0) }
            .filter { store.needsAttention.contains($0.id) }
            .count
    }

    var body: some View {
        HStack(spacing: 6) {
            Button {
                toggleExpanded()
            } label: {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption2.weight(.bold))
                    .frame(width: 12)
            }
            .buttonStyle(SidebarIconButtonStyle())
            Image(systemName: "folder.fill")
                .foregroundStyle(.secondary)
            if renamingProject {
                TextField("", text: $projectDraftName)
                    .textFieldStyle(.roundedBorder)
                    .font(.callout)
                    .focused($projectNameFocused)
                    .onSubmit(commitProjectRename)
                    .onExitCommand { renamingProject = false }
                    .onChange(of: projectNameFocused) { _, focused in
                        if !focused && renamingProject { commitProjectRename() }
                    }
            } else {
                Text(project.name)
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
            }
            if runningCount > 0 {
                RunningDot()
                Text("\(runningCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.green)
            }
            if attentionCount > 0 && !isExpanded {
                Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                Text("\(attentionCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.accentColor)
            }
            Spacer()
            Button {
                store.createWorktreeQuick(project: project)
            } label: {
                Image(systemName: "plus.square.on.square")
            }
            .buttonStyle(SidebarIconButtonStyle())
            .help("New worktree (one click, auto-named)")
            Button {
                worktreeOptionsProject = project
            } label: {
                Image(systemName: "slider.horizontal.3")
            }
            .buttonStyle(SidebarIconButtonStyle())
            .help("New worktree with options — name, branch, base")
        }
        .contentShape(Rectangle())
        .contextMenu {
            Button("New Worktree") { store.createWorktreeQuick(project: project) }
            Button("New Worktree with Options… (name / branch / base)") {
                worktreeOptionsProject = project
            }
            Button("Rename Project…") {
                projectDraftName = project.name
                renamingProject = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { projectNameFocused = true }
            }
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([project.url])
            }
            Divider()
            Button("Remove Project from List", role: .destructive) {
                store.removeProject(project)
            }
        }
    }

    private func commitProjectRename() {
        renamingProject = false
        store.rename(projectID: project.id, to: projectDraftName)
    }

    private var isExpanded: Bool {
        store.projects.first(where: { $0.id == project.id })?.isExpanded ?? true
    }

    private func toggleExpanded() {
        guard let index = store.projects.firstIndex(where: { $0.id == project.id }) else { return }
        store.projects[index].isExpanded.toggle()
        store.save()
    }
}

private struct WorktreeRows: View {
    @EnvironmentObject var store: AppStore
    let worktree: Worktree
    @State private var confirmDiskDelete = false
    @State private var renamingWorktree = false
    @State private var worktreeDraftName = ""
    @FocusState private var worktreeNameFocused: Bool

    var body: some View {
        Group {
            worktreeRow
                .padding(.leading, 14)
                .tag(SidebarSelection.worktree(worktree.id))
            if isExpanded {
                ForEach(store.sessions(in: worktree)) { session in
                    SessionRow(session: session)
                        .tag(SidebarSelection.session(session.id))
                        .padding(.leading, 34)
                }
                let archived = store.archivedSessions(in: worktree)
                if !archived.isEmpty {
                    DisclosureGroup("Archived (\(archived.count))") {
                        ForEach(archived) { session in
                            HStack(spacing: 6) {
                                Image(systemName: session.engine.symbol)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                Text(session.title)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Spacer()
                                Button("Restore") { store.setArchived(sessionID: session.id, false) }
                                    .buttonStyle(.borderless)
                                    .font(.caption2)
                            }
                            .contextMenu {
                                Button("Restore") { store.setArchived(sessionID: session.id, false) }
                                Button("Delete Session", role: .destructive) {
                                    store.deleteSession(session)
                                }
                            }
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 34)
                }
            }
        }
    }

    private var runningCount: Int {
        store.sessions(in: worktree).filter { store.runningSessions.contains($0.id) }.count
    }

    private var attentionCount: Int {
        store.sessions(in: worktree).filter { store.needsAttention.contains($0.id) }.count
    }

    private var worktreeRow: some View {
        HStack(spacing: 6) {
            Button {
                toggleExpanded()
            } label: {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption2)
                    .frame(width: 10)
            }
            .buttonStyle(SidebarIconButtonStyle())
            Image(systemName: worktree.isMain ? "house" : "square.on.square.dashed")
                .font(.caption)
                .foregroundStyle(worktree.isMain ? Color.secondary : Color.purple)
            VStack(alignment: .leading, spacing: 1) {
                if renamingWorktree {
                    TextField("", text: $worktreeDraftName)
                        .textFieldStyle(.roundedBorder)
                        .font(.callout)
                        .focused($worktreeNameFocused)
                        .onSubmit(commitWorktreeRename)
                        .onExitCommand { renamingWorktree = false }
                        .onChange(of: worktreeNameFocused) { _, focused in
                            if !focused && renamingWorktree { commitWorktreeRename() }
                        }
                } else {
                    Text(worktree.name)
                        .fontWeight(.medium)
                        .lineLimit(1)
                }
                if let branch = worktree.branch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            if runningCount > 0 {
                RunningDot()
                if runningCount > 1 {
                    Text("\(runningCount)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.green)
                }
            }
            if attentionCount > 0 && !isExpanded {
                Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                Text("\(attentionCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.accentColor)
            }
            Spacer()
            if worktree.isPinned {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .help("Pinned to the top")
            }
            Button {
                store.createSessionQuick(worktree: worktree)
            } label: {
                Image(systemName: "plus.bubble")
                    .font(.caption)
            }
            .buttonStyle(SidebarIconButtonStyle())
            .help("New session (one click — engine/access changeable in the header)")
            Menu {
                worktreeActions
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.caption)
            }
            .menuStyle(.borderlessButton)
            .buttonStyle(.plain)      // without this the menu draws its bezel: a black disc
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Pin, archive, rename, delete")
        }
        .contentShape(Rectangle())
        .contextMenu {
            worktreeActions
        }
        .confirmationDialog(
            "Do you really want to delete “\(worktree.name)”?",
            isPresented: $confirmDiskDelete, titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                store.deleteWorktreeFromDisk(worktree)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(deleteWarning)
        }
    }

    private var deleteWarning: String {
        let sessionCount = store.sessions.filter { $0.worktreeID == worktree.id }.count
        return "This deletes the folder \(worktree.path), any uncommitted changes in it, and "
            + "\(sessionCount) session\(sessionCount == 1 ? "" : "s") with their transcripts.\n\n"
            + "The branch \(worktree.branch ?? "it is on") is NOT deleted — your commits stay in "
            + "the repository."
    }

    @ViewBuilder
    private var worktreeActions: some View {
        Button("Open Worktree Page") { store.selectedWorktreeID = worktree.id }
        Button("New Session") { store.createSessionQuick(worktree: worktree) }
        Button("Rename…") {
            worktreeDraftName = worktree.name
            renamingWorktree = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { worktreeNameFocused = true }
        }
        Divider()
        Button(worktree.isPinned ? "Unpin" : "Pin to Top") {
            store.togglePin(worktreeID: worktree.id)
        }
        if !worktree.isMain {
            Button("Archive") { store.setArchived(worktreeID: worktree.id, true) }
        }
        Button("Reveal in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting(
                [URL(fileURLWithPath: worktree.path)])
        }
        if !worktree.isMain {
            Divider()
            Button("Remove from Sidebar (keep on disk)") {
                store.removeWorktreeFromList(worktree)
            }
            Button("Delete Worktree…", role: .destructive) {
                confirmDiskDelete = true
            }
        }
    }

    private func commitWorktreeRename() {
        renamingWorktree = false
        store.rename(worktreeID: worktree.id, to: worktreeDraftName)
    }

    private var isExpanded: Bool {
        store.worktrees.first(where: { $0.id == worktree.id })?.isExpanded ?? true
    }

    private func toggleExpanded() {
        guard let index = store.worktrees.firstIndex(where: { $0.id == worktree.id }) else { return }
        store.worktrees[index].isExpanded.toggle()
        store.save()
    }
}

private struct SessionRow: View {
    @EnvironmentObject var store: AppStore
    let session: Session
    @State private var confirmDelete = false
    @State private var renaming = false
    @State private var draftName = ""
    @FocusState private var nameFocused: Bool

    private var isRunning: Bool { store.runningSessions.contains(session.id) }
    private var needsAttention: Bool { store.needsAttention.contains(session.id) }
    private var failed: Bool {
        store.transcripts[session.id]?.last { $0.role != .info }?.role == .error
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: session.engine.symbol)
                .foregroundStyle(session.engine == .claude ? Color.orange : Color.teal)
                .font(.caption)
            if renaming {
                TextField("", text: $draftName)
                    .textFieldStyle(.roundedBorder)
                    .font(.callout)
                    .focused($nameFocused)
                    .onSubmit(commitRename)
                    .onExitCommand { renaming = false }
                    .onChange(of: nameFocused) { _, focused in
                        if !focused && renaming { commitRename() }
                    }
            } else {
                Text(session.title)
                    .lineLimit(1)
                    .fontWeight(needsAttention ? .semibold : .regular)
            }
            Spacer()
            if session.isPinned {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            if isRunning {
                RunningDot()
            } else if failed && needsAttention {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .help("This session ended with an error")
            } else if needsAttention {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 7, height: 7)
                    .help("Finished while you were elsewhere")
            }
            Menu {
                sessionActions
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.caption)
            }
            .menuStyle(.borderlessButton)
            .buttonStyle(.plain)      // without this the menu draws its bezel: a black disc
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Pin, archive, rename, delete")
        }
        .contextMenu { sessionActions }
        .confirmationDialog("Delete “\(session.title)”?", isPresented: $confirmDelete) {
            Button("Delete Session", role: .destructive) {
                store.deleteSession(session)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only the chat is deleted. The worktree is untouched.")
        }
    }

    @ViewBuilder
    private var sessionActions: some View {
        Button("Rename…") {
            draftName = session.title
            renaming = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { nameFocused = true }
        }
        Button(session.isPinned ? "Unpin" : "Pin to Top") {
            store.togglePin(sessionID: session.id)
        }
        Button("Archive") { store.setArchived(sessionID: session.id, true) }
        Divider()
        Button("Delete Session", role: .destructive) { confirmDelete = true }
    }

    private func commitRename() {
        renaming = false
        store.rename(sessionID: session.id, to: draftName)
    }
}
