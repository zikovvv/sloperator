import Foundation
import SwiftUI
import AppKit

/// One in-flight turn: subprocess + parser + bookkeeping to map tool ids to transcript rows.
final class TurnRunner {
    let runner = ProcessRunner()
    let parser: TurnParser
    /// The engine this turn was launched with. Events must be attributed to it, not to the
    /// session's current engine, which the user can change while the process is still exiting.
    let engine: EngineKind
    var toolItemIDs: [String: UUID] = [:]

    init(parser: TurnParser, engine: EngineKind) {
        self.parser = parser
        self.engine = engine
    }
}

/// Why a turn's process was interrupted, so the exit can be reported honestly.
enum StopReason {
    case manual
    case steer
}

@MainActor
final class AppStore: ObservableObject {
    @Published var projects: [Project] = []
    @Published var worktrees: [Worktree] = []
    @Published var sessions: [Session] = []
    @Published var tab: AppTab = .sessions
    @Published var selectedSessionID: UUID? = nil {
        didSet {
            if let selectedSessionID {
                needsAttention.remove(selectedSessionID)
                selectedWorktreeID = nil
            }
        }
    }
    /// Set when a worktree row (rather than a session) is selected in the sidebar. The two
    /// selections are mutually exclusive: MainView shows the session when both are set, so
    /// leaving a stale session id here made "Open Worktree Page" do nothing.
    @Published var selectedWorktreeID: UUID? = nil {
        didSet {
            if selectedWorktreeID != nil, selectedSessionID != nil { selectedSessionID = nil }
        }
    }
    /// Projects with a worktree being created right now, so the sidebar can show progress.
    @Published var creatingWorktreeProjects: Set<UUID> = []
    /// Sessions that finished while you were looking elsewhere.
    @Published var needsAttention: Set<UUID> = [] {
        didSet { refreshDockBadge() }
    }
    @Published var transcripts: [UUID: [TranscriptItem]] = [:]
    @Published var runningSessions: Set<UUID> = [] {
        didSet { refreshDockBadge() }
    }
    /// Messages sent while the agent was busy, delivered when the turn ends.
    @Published var queuedMessages: [UUID: [String]] = [:]
    /// Unsent composer text per session — survives switching sessions and relaunch.
    @Published var drafts: [UUID: String] = [:]
    /// Line comments staged from the review panel, per session. They ride along with the
    /// next message the user sends; they are never delivered on their own.
    @Published var reviewComments: [UUID: [ReviewComment]] = [:]
    /// Bumped after every completed turn so the review panel refreshes.
    @Published var reviewGeneration: Int = 0
    @Published var lastError: String? = nil
    @Published var settings = AppSettings() {
        didSet { if settings != oldValue { save() } }
    }

    /// Credential health per engine, so the UI can prompt for re-login before turns start failing.
    @Published var authStates: [EngineKind: AuthState] = [:]
    @Published var authBannerDismissed = false

    private var runners: [UUID: TurnRunner] = [:]
    private var stopReasons: [UUID: StopReason] = [:]
    private var pendingTranscriptSaves: Set<UUID> = []
    private var transcriptSaveScheduled = false
    /// Transcript count each engine last saw, per session — used to bridge context after switches.
    private var lastSeenIndex: [UUID: [String: Int]] = [:]

    private let stateDir: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ClaudeOrchestrator")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(
            at: dir.appendingPathComponent("transcripts"), withIntermediateDirectories: true)
        return dir
    }()

    init() {
        load()
        refreshAuthStates()
    }

    // MARK: - Credentials

    /// Running count, plus a dot when finished sessions are waiting for you.
    private func refreshDockBadge() {
        let running = runningSessions.count
        let waiting = needsAttention.count
        let label: String
        switch (running, waiting) {
        case (0, 0): label = ""
        case (0, _): label = "●"
        case (_, 0): label = "\(running)"
        default: label = "\(running)●"
        }
        NSApp?.dockTile.badgeLabel = label
    }

    /// Bounce the dock and post a system notification so a finished agent reaches you in
    /// another app. Silent for the session you're already looking at.
    private func notifyTurnFinished(sessionID: UUID) {
        guard sessionID != selectedSessionID,
              let session = sessions.first(where: { $0.id == sessionID })
        else { return }
        let lastLine = transcripts[sessionID]?.last { $0.role == .assistant || $0.role == .error }
        let failed = lastLine?.role == .error
        NSApp?.requestUserAttention(.informationalRequest)
        let notification = NSUserNotification()
        notification.title = failed ? "\(session.title) — failed" : "\(session.title) — finished"
        notification.subtitle = worktree(for: session)?.name
        notification.informativeText = String((lastLine?.text ?? "").prefix(180))
        NSUserNotificationCenter.default.deliver(notification)
    }

    func refreshAuthStates() {
        DispatchQueue.global(qos: .utility).async {
            let states = [EngineKind.claude, .codex].reduce(into: [EngineKind: AuthState]()) {
                $0[$1] = AuthService.check(engine: $1)
            }
            DispatchQueue.main.async {
                self.authStates = states
                if !(states.values.contains { $0.isProblem }) {
                    self.authBannerDismissed = false
                }
            }
        }
    }

    /// Engines with a credential problem, restricted to ones this app actually has sessions for.
    var authProblems: [(engine: EngineKind, state: AuthState)] {
        authStates
            .filter { $0.value.isProblem }
            .map { (engine: $0.key, state: $0.value) }
            .sorted { $0.engine.rawValue < $1.engine.rawValue }
    }

    func startLogin(for engine: EngineKind) {
        if !AuthService.startLogin(for: engine) {
            lastError = "Couldn't open Terminal automatically. The command is on your clipboard — "
                + "paste it into a terminal."
        }
    }

    // MARK: - Persistence

    private struct PersistedState: Codable {
        var projects: [Project]
        var worktrees: [Worktree]?
        var sessions: [Session]
        var selectedSessionID: UUID?
        var lastSeenIndex: [UUID: [String: Int]]?
        var settings: AppSettings?
        var drafts: [UUID: String]?
        var reviewComments: [UUID: [ReviewComment]]?
        var queuedMessages: [UUID: [String]]?
    }

    private func load() {
        let url = stateDir.appendingPathComponent("state.json")
        guard let data = try? Data(contentsOf: url) else { return }
        guard let state = try? JSONDecoder().decode(PersistedState.self, from: data) else {
            // Never silently start empty: the next save() would overwrite the only copy of
            // every project, worktree and session record.
            let backup = stateDir.appendingPathComponent(
                "state.json.corrupt-\(Int(Date().timeIntervalSince1970))")
            try? FileManager.default.moveItem(at: url, to: backup)
            lastError = "Your saved state could not be read and has been set aside at "
                + "\(backup.lastPathComponent). Starting empty — the file is still there if it "
                + "can be recovered."
            return
        }
        projects = state.projects
        worktrees = state.worktrees ?? []
        sessions = state.sessions
        selectedSessionID = state.selectedSessionID
        lastSeenIndex = state.lastSeenIndex ?? [:]
        settings = state.settings ?? AppSettings()
        drafts = state.drafts ?? [:]
        reviewComments = state.reviewComments ?? [:]
        queuedMessages = state.queuedMessages ?? [:]
        for session in sessions {
            transcripts[session.id] = loadTranscript(session.id)
        }
    }

    func save() {
        let state = PersistedState(
            projects: projects, worktrees: worktrees, sessions: sessions,
            selectedSessionID: selectedSessionID, lastSeenIndex: lastSeenIndex,
            settings: settings, drafts: drafts.filter { !$0.value.isEmpty },
            reviewComments: reviewComments.filter { !$0.value.isEmpty },
            queuedMessages: queuedMessages.filter { !$0.value.isEmpty })
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(state) {
            try? data.write(to: stateDir.appendingPathComponent("state.json"), options: .atomic)
        }
    }

    private func loadTranscript(_ id: UUID) -> [TranscriptItem] {
        let url = stateDir.appendingPathComponent("transcripts/\(id.uuidString).json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([TranscriptItem].self, from: data)) ?? []
    }

    private func saveTranscript(_ id: UUID) {
        pendingTranscriptSaves.remove(id)
        let url = stateDir.appendingPathComponent("transcripts/\(id.uuidString).json")
        if let data = try? JSONEncoder().encode(transcripts[id] ?? []) {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// A streaming turn appends dozens of tool events per second and each save re-encodes the
    /// whole transcript, so coalesce them. Anything the user would hate to lose (their own
    /// messages, replies, errors) still writes through immediately.
    private func scheduleTranscriptSave(_ id: UUID) {
        pendingTranscriptSaves.insert(id)
        guard !transcriptSaveScheduled else { return }
        transcriptSaveScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.transcriptSaveScheduled = false
            for id in self.pendingTranscriptSaves { self.saveTranscript(id) }
        }
    }

    // MARK: - Lookups

    func project(id: UUID) -> Project? { projects.first { $0.id == id } }
    func worktree(id: UUID) -> Worktree? { worktrees.first { $0.id == id } }
    func worktree(for session: Session) -> Worktree? { worktree(id: session.worktreeID) }
    func project(for worktree: Worktree) -> Project? { project(id: worktree.projectID) }
    func project(forSession session: Session) -> Project? {
        worktree(for: session).flatMap { project(for: $0) }
    }
    func workingPath(for session: Session) -> String {
        worktree(for: session)?.path ?? FileManager.default.homeDirectoryForCurrentUser.path
    }
    func worktrees(in project: Project) -> [Worktree] {
        worktrees
            .filter { $0.projectID == project.id && !$0.isArchived }
            .sorted { a, b in
                if a.isMain != b.isMain { return a.isMain }
                if a.isPinned != b.isPinned { return a.isPinned }
                return a.createdAt > b.createdAt
            }
    }

    func archivedWorktrees(in project: Project) -> [Worktree] {
        worktrees
            .filter { $0.projectID == project.id && $0.isArchived }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func sessions(in worktree: Worktree) -> [Session] {
        sessions
            .filter { $0.worktreeID == worktree.id && !$0.isArchived }
            .sorted { a, b in
                if a.isPinned != b.isPinned { return a.isPinned }
                return a.createdAt < b.createdAt
            }
    }

    func archivedSessions(in worktree: Worktree) -> [Session] {
        sessions
            .filter { $0.worktreeID == worktree.id && $0.isArchived }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    // MARK: - Pin / archive

    func togglePin(sessionID: UUID) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].isPinned.toggle()
        save()
    }

    func togglePin(worktreeID: UUID) {
        guard let index = worktrees.firstIndex(where: { $0.id == worktreeID }) else { return }
        worktrees[index].isPinned.toggle()
        save()
    }

    /// Archiving only hides things from the list — no process is killed, nothing is deleted.
    func setArchived(sessionID: UUID, _ archived: Bool) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].isArchived = archived
        if archived && selectedSessionID == sessionID { selectedSessionID = nil }
        save()
    }

    func setArchived(worktreeID: UUID, _ archived: Bool) {
        guard let index = worktrees.firstIndex(where: { $0.id == worktreeID }) else { return }
        worktrees[index].isArchived = archived
        if archived && selectedWorktreeID == worktreeID { selectedWorktreeID = nil }
        save()
    }

    // MARK: - Projects

    /// `git init` on a large folder can take minutes, so all of it runs off the main actor.
    func addProject(path: String) {
        let normalized = (path as NSString).standardizingPath
        guard !projects.contains(where: { $0.path == normalized }) else { return }
        Task.detached(priority: .userInitiated) {
            let isGit = GitService.isGitRepo(normalized) || GitService.initRepo(normalized)
            let branch = GitService.currentBranch(normalized)
            let base = GitService.defaultBranch(normalized)
            await MainActor.run {
                guard !self.projects.contains(where: { $0.path == normalized }) else { return }
                if !isGit {
                    self.lastError = "Could not initialize a git repository in \(normalized)."
                }
                let project = Project(
                    name: (normalized as NSString).lastPathComponent,
                    path: normalized, isGit: isGit)
                self.projects.append(project)
                // The project checkout itself is the "main" pseudo-worktree.
                self.worktrees.append(Worktree(
                    projectID: project.id, name: "main", path: normalized,
                    branch: branch, baseBranch: base, isMain: true))
                self.save()
            }
        }
    }

    func removeProject(_ project: Project) {
        // Archived worktrees are filtered out of worktrees(in:); skipping them left their
        // sessions in the store forever, invisible but still counted in Usage.
        for worktree in worktrees.filter({ $0.projectID == project.id }) {
            removeWorktreeFromList(worktree)
        }
        projects.removeAll { $0.id == project.id }
        save()
    }

    // MARK: - Worktrees

    /// Creates a real git worktree unit. Optionally moves main's uncommitted work into it.
    /// Runs git off the main actor: `worktree add` measured 6.7s on a large repo, and a
    /// stash move can take longer, which froze the whole window including streaming agents.
    func createWorktree(
        project: Project, name: String, moveCurrentWork: Bool,
        branch: String? = nil, base: String? = nil, checkoutExisting: Bool = false
    ) {
        let slug = Self.slugify(name.isEmpty ? "work" : name)
        let root = settings.worktreeRootOverride
        creatingWorktreeProjects.insert(project.id)
        Task.detached(priority: .userInitiated) {
            do {
                let created = try GitService.createWorktree(
                    projectPath: project.path, projectName: project.name, slug: slug,
                    rootOverride: root, branch: branch, base: base,
                    checkoutExisting: checkoutExisting)
                var moveError: String? = nil
                if moveCurrentWork {
                    moveError = GitService.moveCurrentWork(
                        from: project.path, to: created.0)
                }
                let baseBranch = base ?? GitService.currentBranch(project.path)
                    ?? GitService.defaultBranch(project.path)
                await MainActor.run {
                    self.creatingWorktreeProjects.remove(project.id)
                    let worktree = Worktree(
                        projectID: project.id,
                        name: name.isEmpty ? (created.0 as NSString).lastPathComponent : name,
                        path: created.0,
                        branch: created.1,
                        baseBranch: baseBranch)
                    self.worktrees.append(worktree)
                    if let moveError { self.lastError = moveError }
                    if let index = self.projects.firstIndex(where: { $0.id == project.id }) {
                        self.projects[index].isExpanded = true
                    }
                    self.save()
                }
            } catch {
                await MainActor.run {
                    self.creatingWorktreeProjects.remove(project.id)
                    self.lastError = error.localizedDescription
                }
            }
        }
    }

    /// Worktree checked out at the PR's head, plus a session to review it.
    func startPRReview(project: Project, prNumber: Int, title: String, baseBranch: String?) {
        Task.detached(priority: .userInitiated) {
            do {
                let created = try GitService.createPRWorktree(
                    projectPath: project.path, projectName: project.name,
                    prNumber: prNumber, baseBranch: baseBranch,
                    rootOverride: await self.settings.worktreeRootOverride)
                await MainActor.run {
                    let worktree = Worktree(
                        projectID: project.id,
                        name: (created.path as NSString).lastPathComponent,
                        path: created.path,
                        branch: created.branch,
                        baseBranch: baseBranch ?? GitService.defaultBranch(project.path))
                    self.worktrees.append(worktree)
                    self.createSession(
                        worktree: worktree,
                        title: "Review PR #\(prNumber): \(title)",
                        engine: .claude, accessMode: .edits)
                    self.tab = .sessions
                    self.save()
                }
            } catch {
                await MainActor.run { self.lastError = error.localizedDescription }
            }
        }
    }

    /// Removes the unit from the sidebar. Disk deletion is a separate, gated call.
    func removeWorktreeFromList(_ worktree: Worktree) {
        for session in sessions.filter({ $0.worktreeID == worktree.id }) {
            deleteSessionRecord(session)
        }
        LSPManager.shared.shutdownWorkspace(worktree.path)
        worktrees.removeAll { $0.id == worktree.id }
        save()
    }

    /// Destroys the worktree folder and this app's data for it. Never automatic — only ever
    /// reached from an explicit, confirmed user action, and never for a project's own checkout.
    ///
    /// Disk first: if removal fails, the records stay so the worktree is still reachable in the
    /// UI instead of becoming an orphaned folder nobody can see.
    func deleteWorktreeFromDisk(_ worktree: Worktree) {
        guard !worktree.isMain, let project = project(for: worktree) else { return }
        LSPManager.shared.shutdownWorkspace(worktree.path)
        GitService.removeWorktree(projectPath: project.path, worktreePath: worktree.path)
        if FileManager.default.fileExists(atPath: worktree.path) {
            // git refuses when the checkout is dirty in ways --force won't cover.
            do {
                try FileManager.default.removeItem(atPath: worktree.path)
            } catch {
                lastError = "Could not delete \(worktree.path): \(error.localizedDescription)\n"
                    + "Nothing was removed from the app, so the worktree is still listed here."
                return
            }
            GitService.pruneWorktrees(project.path)
        }
        for session in sessions.filter({ $0.worktreeID == worktree.id }) {
            deleteSessionRecord(session)
        }
        worktrees.removeAll { $0.id == worktree.id }
        if selectedWorktreeID == worktree.id { selectedWorktreeID = nil }
        save()
    }

    // MARK: - Sessions

    func createSession(
        worktree: Worktree, title: String, engine: EngineKind, accessMode: AccessMode
    ) {
        let session = Session(
            worktreeID: worktree.id,
            title: title.isEmpty ? "New session" : title,
            engine: engine,
            accessMode: accessMode)
        sessions.insert(session, at: 0)
        transcripts[session.id] = []
        selectedSessionID = session.id
        save()
    }

    /// One-click session: inherits engine/access from the worktree's most recent session.
    /// Everything is changeable later from the header bar.
    func createSessionQuick(worktree: Worktree) {
        // A collapsed parent would hide the row we just created.
        expand(worktreeID: worktree.id)
        let last = sessions(in: worktree).max { $0.createdAt < $1.createdAt }
        createSession(
            worktree: worktree,
            title: "New session",
            engine: last?.engine ?? .claude,
            accessMode: last?.accessMode ?? .edits)
    }

    /// One-click worktree: auto-named wt-N.
    func createWorktreeQuick(project: Project) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) {
            projects[index].isExpanded = true
        }
        let n = worktrees(in: project).filter { !$0.isMain }.count + 1
        createWorktree(project: project, name: "wt-\(n)", moveCurrentWork: false)
    }

    func deleteSession(_ session: Session) {
        stop(sessionID: session.id)
        deleteSessionRecord(session)
        save()
    }

    private func deleteSessionRecord(_ session: Session) {
        stop(sessionID: session.id)
        stopReasons.removeValue(forKey: session.id)
        needsAttention.remove(session.id)
        sessions.removeAll { $0.id == session.id }
        transcripts.removeValue(forKey: session.id)
        queuedMessages.removeValue(forKey: session.id)
        drafts.removeValue(forKey: session.id)
        reviewComments.removeValue(forKey: session.id)
        try? FileManager.default.removeItem(
            at: stateDir.appendingPathComponent("transcripts/\(session.id.uuidString).json"))
        if selectedSessionID == session.id { selectedSessionID = nil }
    }

    /// Sidebar order, flattened — used by next/previous session navigation.
    var orderedSessions: [Session] {
        projects.flatMap { project in
            worktrees(in: project).flatMap { sessions(in: $0) }
        }
    }

    func selectSession(offset: Int) {
        let ordered = orderedSessions
        guard !ordered.isEmpty else { return }
        guard let current = selectedSessionID,
              let index = ordered.firstIndex(where: { $0.id == current })
        else {
            selectedSessionID = ordered.first?.id
            revealSelected()
            return
        }
        let next = (index + offset + ordered.count) % ordered.count
        selectedSessionID = ordered[next].id
        revealSelected()
    }

    /// Jump to the next session that finished while you were elsewhere.
    func selectNextNeedingAttention() {
        let ordered = orderedSessions
        guard let target = ordered.first(where: { needsAttention.contains($0.id) })
                ?? ordered.first(where: { runningSessions.contains($0.id) })
        else { return }
        tab = .sessions
        selectedSessionID = target.id
        revealSelected()
    }

    private func revealSelected() {
        guard let id = selectedSessionID,
              let session = sessions.first(where: { $0.id == id })
        else { return }
        expand(worktreeID: session.worktreeID)
    }

    /// Reveals a worktree and its project in the sidebar.
    func expand(worktreeID: UUID) {
        guard let wtIndex = worktrees.firstIndex(where: { $0.id == worktreeID }) else { return }
        worktrees[wtIndex].isExpanded = true
        let projectID = worktrees[wtIndex].projectID
        if let pIndex = projects.firstIndex(where: { $0.id == projectID }) {
            projects[pIndex].isExpanded = true
        }
    }

    static func slugify(_ title: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let words = title.lowercased()
            .components(separatedBy: allowed.inverted)
            .filter { !$0.isEmpty }
        let slug = words.prefix(5).joined(separator: "-")
        return slug.isEmpty ? "work-\(Int.random(in: 1000...9999))" : String(slug.prefix(40))
    }

    /// Keyed by id, never by array index: inserting or deleting a session would otherwise
    /// leave a live binding writing into the wrong slot (or trapping on a shrunken array).
    func binding(for sessionID: UUID) -> Binding<Session>? {
        guard sessions.contains(where: { $0.id == sessionID }) else { return nil }
        return Binding(
            get: { self.sessions.first { $0.id == sessionID } ?? Session(worktreeID: UUID(), title: "") },
            set: { self.updateSession($0) }
        )
    }

    /// One binding for the sidebar List, which holds sessions and worktrees together.
    var sidebarSelection: Binding<SidebarSelection?> {
        Binding(
            get: {
                if let id = self.selectedSessionID { return .session(id) }
                if let id = self.selectedWorktreeID { return .worktree(id) }
                return nil
            },
            set: { value in
                switch value {
                case .session(let id):
                    self.selectedWorktreeID = nil
                    self.selectedSessionID = id
                case .worktree(let id):
                    self.selectedSessionID = nil
                    self.selectedWorktreeID = id
                case nil:
                    break
                }
            }
        )
    }

    func updateWorktree(_ worktree: Worktree) {
        guard let index = worktrees.firstIndex(where: { $0.id == worktree.id }) else { return }
        worktrees[index] = worktree
        save()
    }

    func rename(sessionID: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        sessions[index].title = trimmed
        save()
    }

    /// Display name only — the worktree's path on disk never moves.
    func rename(worktreeID: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let index = worktrees.firstIndex(where: { $0.id == worktreeID }) else { return }
        worktrees[index].name = trimmed
        save()
    }

    func rename(projectID: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let index = projects.firstIndex(where: { $0.id == projectID }) else { return }
        projects[index].name = trimmed
        save()
    }

    func updateSession(_ session: Session) {
        guard let index = sessions.firstIndex(where: { $0.id == session.id }) else { return }
        sessions[index] = session
        save()
    }

    // MARK: - Engine switching

    func switchEngine(sessionID: UUID, to engine: EngineKind) {
        guard var session = sessions.first(where: { $0.id == sessionID }) else { return }
        guard session.engine != engine else { return }
        if runningSessions.contains(sessionID) {
            stop(sessionID: sessionID)
        }
        session.engine = engine
        // Model/effort are engine-specific — reset any value the new engine doesn't know.
        if !EngineOptions.models(for: engine).contains(where: { $0.id == session.model }) {
            session.model = nil
        }
        if !EngineOptions.efforts(for: engine).contains(session.effort) {
            session.effort = nil
        }
        updateSession(session)
        appendItem(sessionID: sessionID, TranscriptItem(
            role: .info, text: "Switched to \(engine.displayName)", engine: engine))
    }

    // MARK: - Sending turns (with steer/queue while busy)

    func addReviewComment(sessionID: UUID, _ comment: ReviewComment) {
        reviewComments[sessionID, default: []].append(comment)
        save()
    }

    func removeReviewComment(sessionID: UUID, id: UUID) {
        reviewComments[sessionID]?.removeAll { $0.id == id }
        save()
    }

    func clearReviewComments(sessionID: UUID) {
        reviewComments[sessionID] = []
        save()
    }

    /// Comments are folded into the message the user sends, then cleared.
    private func withReviewComments(sessionID: UUID, _ text: String) -> String {
        let comments = reviewComments[sessionID] ?? []
        guard !comments.isEmpty else { return text }
        let rendered = comments.map { comment in
            """
            \(comment.file):\(comment.line)
            ```
            \(comment.snippet)
            ```
            \(comment.body)
            """
        }.joined(separator: "\n\n")
        reviewComments[sessionID] = []
        return """
        Review comments on the diff:

        \(rendered)

        \(text)
        """
    }

    func send(sessionID: UUID, prompt: String) {
        guard let session = sessions.first(where: { $0.id == sessionID }) else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let withComments = withReviewComments(sessionID: sessionID, trimmed)
        appendItem(sessionID: sessionID, TranscriptItem(role: .user, text: withComments, engine: session.engine))
        queuedMessages[sessionID, default: []].append(withComments)
        save()   // a queued message must not evaporate on quit

        if runningSessions.contains(sessionID) {
            switch session.steeringMode {
            case .steer:
                appendItem(sessionID: sessionID, TranscriptItem(
                    role: .info, text: "Steering: interrupting current turn…"))
                interrupt(sessionID: sessionID, reason: .steer) // onExit relaunches
            case .queue:
                appendItem(sessionID: sessionID, TranscriptItem(
                    role: .info, text: "Queued — will be delivered when the agent finishes."))
            }
        } else {
            launchQueued(sessionID: sessionID)
        }
    }

    private func launchQueued(sessionID: UUID) {
        guard var session = sessions.first(where: { $0.id == sessionID }) else { return }
        guard !runningSessions.contains(sessionID) else { return }
        let queued = queuedMessages[sessionID] ?? []
        guard !queued.isEmpty else { return }
        // Cleared only once the process is actually running, so a failed launch never
        // swallows what the user typed.
        let prompt = queued.joined(separator: "\n\n")

        if session.title == "New session", let first = queued.first {
            session.title = String(first.prefix(48))
        }

        var bridged = bridgedPrompt(session: session, prompt: prompt, pendingCount: queued.count)
        if let siblingInfo = siblingSessionsBlock(for: session) {
            bridged = siblingInfo + "\n\n" + bridged
        }
        let engine = session.engine
        let parser: TurnParser = engine == .claude ? ClaudeEngine.Parser() : CodexEngine.Parser()
        let turn = TurnRunner(parser: parser, engine: engine)
        let command: EngineCommand
        do {
            switch engine {
            case .claude:
                // Not persisted here: if the launch fails, a committed id would make every
                // later turn --resume a conversation that never existed. The CLI's own
                // init event sets it.
                let newID = UUID().uuidString
                command = try ClaudeEngine.command(
                    session: session, prompt: bridged,
                    resumeID: session.claudeSessionID, newSessionID: newID)
            case .codex:
                command = try CodexEngine.command(
                    session: session, prompt: bridged, resumeThreadID: session.codexThreadID)
            }
        } catch {
            appendItem(sessionID: sessionID, TranscriptItem(role: .error, text: error.localizedDescription))
            return
        }
        session.lastActivityAt = Date()
        updateSession(session)

        runners[sessionID] = turn
        runningSessions.insert(sessionID)

        do {
            try turn.runner.start(
                executable: command.executable,
                arguments: command.arguments,
                currentDirectory: workingPath(for: session),
                onLine: { [weak self] line in
                    guard let self else { return }
                    for event in turn.parser.parse(line: line) {
                        self.apply(event: event, sessionID: sessionID, turn: turn)
                    }
                },
                onExit: { [weak self] status, stderr in
                    guard let self else { return }
                    self.runningSessions.remove(sessionID)
                    // Deleted mid-turn: don't recreate its transcript file or badge it.
                    guard self.sessions.contains(where: { $0.id == sessionID }) else {
                        self.runners.removeValue(forKey: sessionID)
                        self.stopReasons.removeValue(forKey: sessionID)
                        return
                    }
                    self.runners.removeValue(forKey: sessionID)
                    let reason = self.stopReasons.removeValue(forKey: sessionID)
                    switch reason {
                    case .manual:
                        // A deliberate stop is not a crash; don't cry wolf about the exit status.
                        self.appendItem(sessionID: sessionID, TranscriptItem(role: .info, text: "Stopped"))
                        let queued = self.queuedMessages[sessionID] ?? []
                        if !queued.isEmpty {
                            self.appendItem(sessionID: sessionID, TranscriptItem(
                                role: .info,
                                text: "\(queued.count) queued message(s) held — they'll be sent "
                                    + "with your next message."))
                        }
                    case .steer, nil:
                        // Don't stack a generic exit error on top of the engine's own message.
                        let alreadyReported = self.transcripts[sessionID]?
                            .suffix(2).contains { $0.role == .error } ?? false
                        if status != 0 && !alreadyReported && reason == nil {
                            let detail = stderr.split(separator: "\n").suffix(6).joined(separator: "\n")
                            let text = "Process exited with status \(status)"
                                + (detail.isEmpty ? "" : "\n\(detail)")
                            self.appendItem(sessionID: sessionID, TranscriptItem(role: .error, text: text))
                            if Self.isAuthFailure(detail) {
                                self.noteAuthFailure(engine: turn.engine)
                            }
                        }
                    }
                    self.markEngineCaughtUp(sessionID: sessionID, engine: turn.engine)
                    self.reviewGeneration += 1
                    if sessionID != self.selectedSessionID {
                        self.needsAttention.insert(sessionID)
                    }
                    self.notifyTurnFinished(sessionID: sessionID)
                    self.saveTranscript(sessionID)
                    self.save()
                    if reason != .manual {
                        // Deliver anything the user sent while the agent was busy.
                        self.launchQueued(sessionID: sessionID)
                    }
                }
            )
            queuedMessages[sessionID] = []
        } catch {
            runningSessions.remove(sessionID)
            runners.removeValue(forKey: sessionID)
            appendItem(sessionID: sessionID, TranscriptItem(
                role: .error,
                text: "Failed to launch: \(error.localizedDescription)\nYour message is still queued."))
        }
    }

    /// User pressed Stop: end the turn and hold anything queued.
    func stop(sessionID: UUID) {
        interrupt(sessionID: sessionID, reason: .manual)
    }

    func stopAllRunning() {
        for sessionID in runningSessions { interrupt(sessionID: sessionID, reason: .manual) }
    }

    private func interrupt(sessionID: UUID, reason: StopReason) {
        guard runners[sessionID] != nil else { return }
        stopReasons[sessionID] = reason
        runners[sessionID]?.runner.terminate()
    }

    /// If the current engine missed turns (other engine ran, or a steered interrupt), prepend the
    /// missing slice of transcript so the takeover is seamless.
    private func bridgedPrompt(session: Session, prompt: String, pendingCount: Int) -> String {
        let engineKey = session.engine.rawValue
        let items = transcripts[session.id] ?? []
        // Drop the user items that make up this very prompt.
        var history = items
        var dropped = 0
        while dropped < pendingCount, let last = history.last(where: { $0.role == .user }) {
            history.removeAll { $0.id == last.id }
            dropped += 1
        }
        let seen = lastSeenIndex[session.id]?[engineKey] ?? 0
        let backendExists = session.engine == .claude
            ? session.claudeSessionID != nil
            : session.codexThreadID != nil

        let unseen = backendExists ? Array(history.dropFirst(seen)) : history
        let relevant = unseen.filter { $0.role == .user || $0.role == .assistant }
        guard !relevant.isEmpty else { return prompt }

        var lines: [String] = []
        for item in relevant {
            let who = item.role == .user ? "USER" : "ASSISTANT (\(item.engine?.displayName ?? "agent"))"
            lines.append("[\(who)]\n\(item.text)")
        }
        var context = lines.joined(separator: "\n\n")
        if context.count > 24000 {
            context = "…(earlier context truncated)…\n" + String(context.suffix(24000))
        }
        let header = backendExists
            ? "Context bridge: catch up on conversation that happened outside this thread before answering:"
            : "You are taking over an in-progress coding session from another AI agent. Full conversation so far (oldest first):"
        return """
        \(header)

        \(context)

        --- end of context. The user's next message follows. Continue seamlessly; do not re-introduce yourself or re-do completed work. ---

        \(prompt)
        """
    }

    func transcriptPath(for sessionID: UUID) -> String {
        stateDir.appendingPathComponent("transcripts/\(sessionID.uuidString).json").path
    }

    /// Tells the agent about sibling sessions in the same worktree so parallel sessions can
    /// coordinate by reading each other's transcript files.
    private func siblingSessionsBlock(for session: Session) -> String? {
        guard let worktree = worktree(for: session) else { return nil }
        let siblings = sessions(in: worktree).filter { $0.id != session.id }
        guard !siblings.isEmpty else { return nil }
        let lines = siblings.map { sibling in
            let status = runningSessions.contains(sibling.id) ? "RUNNING NOW" : "idle"
            return "- \"\(sibling.title)\" (\(sibling.engine.displayName), \(status)) — transcript JSON: \(transcriptPath(for: sibling.id))"
        }
        return """
        [Orchestrator context] You are agent session "\(session.title)" in worktree \(worktree.path). \
        Other agent sessions share this same worktree; you can read their full conversation \
        transcripts (JSON) at the paths below to see what they did or are doing, and should avoid \
        clobbering files a RUNNING session is working on:
        \(lines.joined(separator: "\n"))
        """
    }

    private func markEngineCaughtUp(sessionID: UUID, engine: EngineKind) {
        var seen = lastSeenIndex[sessionID] ?? [:]
        seen[engine.rawValue] = (transcripts[sessionID] ?? []).count
        lastSeenIndex[sessionID] = seen
    }

    // MARK: - Event application

    private func apply(event: AgentEvent, sessionID: UUID, turn: TurnRunner) {
        guard var session = sessions.first(where: { $0.id == sessionID }) else { return }
        let engine = turn.engine
        switch event {
        case .backendSessionStarted(let id):
            switch engine {
            case .claude: session.claudeSessionID = id
            case .codex: session.codexThreadID = id
            }
            session.lastActivityAt = Date()
            updateSession(session)
        case .assistantText(let text):
            appendItem(sessionID: sessionID, TranscriptItem(role: .assistant, text: text, engine: engine))
        case .thinking(let text):
            appendItem(sessionID: sessionID, TranscriptItem(role: .thinking, text: text, engine: engine))
        case .toolStarted(let id, let name, let detail):
            let item = TranscriptItem(role: .tool, text: detail, toolName: name, engine: engine)
            turn.toolItemIDs[id] = item.id
            appendItem(sessionID: sessionID, item)
        case .toolFinished(let id, let output, let failed):
            guard let itemID = turn.toolItemIDs[id],
                  var items = transcripts[sessionID],
                  let index = items.firstIndex(where: { $0.id == itemID })
            else { return }
            var text = output ?? (failed ? "failed" : "")
            if text.count > 6000 { text = String(text.prefix(6000)) + "\n…(truncated)" }
            items[index].toolOutput = (failed ? "⚠️ " : "") + text
            transcripts[sessionID] = items
        case .turnCompleted(let summary, let usage):
            session.inputTokens += usage.inputTokens
            session.cachedInputTokens += usage.cachedInputTokens
            session.outputTokens += usage.outputTokens
            if let cost = usage.costUSD {
                session.totalCostUSD += cost
            } else if engine == .codex {
                let rates = settings
                let uncached = max(0, usage.inputTokens - usage.cachedInputTokens)
                session.totalCostUSD +=
                    Double(uncached) / 1e6 * rates.codexInputPerMTok
                    + Double(usage.cachedInputTokens) / 1e6 * rates.codexCachedInputPerMTok
                    + Double(usage.outputTokens) / 1e6 * rates.codexOutputPerMTok
            }
            session.lastActivityAt = Date()
            updateSession(session)
            if let summary {
                appendItem(sessionID: sessionID, TranscriptItem(role: .info, text: summary, engine: engine))
            }
        case .turnFailed(let message):
            appendItem(sessionID: sessionID, TranscriptItem(role: .error, text: message, engine: engine))
            if Self.isAuthFailure(message) {
                noteAuthFailure(engine: engine)
            }
            if message.contains("No conversation found") {
                // The stored backend id is dead; start fresh rather than failing forever.
                switch engine {
                case .claude: session.claudeSessionID = nil
                case .codex: session.codexThreadID = nil
                }
                updateSession(session)
                appendItem(sessionID: sessionID, TranscriptItem(
                    role: .info,
                    text: "That conversation no longer exists on disk. The next message starts a "
                        + "fresh one; this transcript is replayed as context."))
            }
        case .raw:
            break
        }
    }

    nonisolated static func isAuthFailure(_ message: String) -> Bool {
        let text = message.lowercased()
        return text.contains("401") || text.contains("oauth")
            || text.contains("authenticate") || text.contains("unauthorized")
    }

    /// A 401 mid-turn is proof the credentials are dead, whatever the pre-flight check believed.
    private func noteAuthFailure(engine: EngineKind) {
        authStates[engine] = .expired(nil)
        authBannerDismissed = false
    }

    private func appendItem(sessionID: UUID, _ item: TranscriptItem) {
        transcripts[sessionID, default: []].append(item)
        switch item.role {
        case .tool, .thinking:
            scheduleTranscriptSave(sessionID)
        case .user, .assistant, .error, .info:
            saveTranscript(sessionID)
        }
    }
}
