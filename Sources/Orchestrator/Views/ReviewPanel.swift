import SwiftUI
import AppKit

/// Right-hand review panel: what changed, in which range, with a VSCode-ish diff —
/// file tree, syntax highlighting, adjustable context, go-to-definition, line comments.
struct ReviewPanel: View {
    @EnvironmentObject var store: AppStore
    let workspacePath: String
    let baseBranch: String?
    /// Comments are staged against the session you're chatting with.
    var sessionID: UUID?

    enum Tab: String, CaseIterable {
        case diff = "Diff"
        case source = "Source"
    }

    @State private var tab: Tab = .diff
    @State private var scope: DiffScope = .uncommitted
    @State private var files: [DiffFile] = []
    @State private var selectedFile: String? = nil
    @State private var collapsedFolders: Set<String> = []
    @State private var commits: [CommitInfo] = []
    @State private var loading = false
    /// A refresh asked for while one was in flight; dropping it left the panel showing a
    /// different scope than the menu claimed.
    @State private var refreshQueued = false
    @State private var sourceStack: [SourceLocation] = []
    @AppStorage("reviewContextLines") private var contextLines = 3

    /// One shared publisher: creating it inside `body` restarts the timer on every view
    /// update, so it can end up never firing while an agent streams.
    private static let autoRefresh = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    struct SourceLocation: Equatable {
        var path: String
        var line: Int?
    }

    private var currentFile: DiffFile? {
        files.first { $0.path == selectedFile } ?? files.first
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            Divider()
            content
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { refresh() }
        .onChange(of: store.reviewGeneration) { refresh() }
        .onChange(of: scope) { refresh() }
        .onChange(of: contextLines) { refresh() }
        .onChange(of: workspacePath) {
            scope = .uncommitted
            refresh()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openFileInReview)) { note in
            guard let path = note.object as? String else { return }
            openInSource(path: path, line: nil)
        }
        .onReceive(Self.autoRefresh) { _ in
            if !store.runningSessions.isEmpty && scope == .uncommitted { refresh() }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Text("Review")
                    .font(.headline)
                if loading { ProgressView().controlSize(.small) }
                Spacer()
                Text("+\(totalAdded)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.green)
                Text("−\(totalRemoved)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.red)
                Button {
                    refresh()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
            }
            HStack(spacing: 6) {
                scopeMenu
                Spacer()
                contextMenu
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private var scopeMenu: some View {
        Menu {
            Button("Uncommitted") { scope = .uncommitted }
            Button("Staged") { scope = .staged }
            if baseBranch != nil {
                Button("Branch vs \(baseBranch ?? "base")") { scope = .branch }
            }
            Button("vs Remote (upstream)") { scope = .remote }
            if !commits.isEmpty {
                Divider()
                Section("Commits") {
                    ForEach(commits) { commit in
                        Button("\(commit.shortSHA)  \(commit.subject)") {
                            scope = .commit(sha: commit.sha, subject: commit.subject)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.caption)
                Text(scope.label)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .menuStyle(.borderlessButton)
        .frame(maxWidth: 230, alignment: .leading)
        .help("What to compare")
    }

    private var contextMenu: some View {
        Menu {
            ForEach([0, 3, 10, 25, 200], id: \.self) { count in
                Button(count >= 200 ? "Whole file" : "\(count) lines") { contextLines = count }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.and.down.text.horizontal")
                    .font(.caption)
                Text(contextLines >= 200 ? "Full" : "±\(contextLines)")
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("How much surrounding context to show")
    }

    private var totalAdded: Int { files.reduce(0) { $0 + $1.added } }
    private var totalRemoved: Int { files.reduce(0) { $0 + $1.removed } }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .diff:
            VSplitView {
                DiffFileTree(
                    files: files, selection: $selectedFile, collapsedFolders: $collapsedFolders)
                    .frame(minHeight: 90, idealHeight: 150, maxHeight: 320)
                if let file = currentFile {
                    DiffContentView(
                        file: file,
                        workspace: workspacePath,
                        onOpenLocation: { path, line in openInSource(path: path, line: line) },
                        onAddComment: { comment in
                            guard let sessionID else { return }
                            store.addReviewComment(sessionID: sessionID, comment)
                        })
                } else {
                    placeholder("Nothing to show for “\(scope.label)”.")
                }
            }
        case .source:
            if let current = sourceStack.last {
                CodeNavigatorView(
                    workspace: workspacePath,
                    location: ReviewPanelSourceLocation(path: current.path, line: current.line),
                    canGoBack: sourceStack.count > 1,
                    onBack: { if sourceStack.count > 1 { sourceStack.removeLast() } },
                    onNavigate: { location in
                        sourceStack.append(SourceLocation(path: location.path, line: location.line))
                    })
            } else {
                placeholder("Pick a file in the Diff tab, or ⌘-click a symbol there.\n"
                            + "⌘-click here follows definitions; hover shows types.")
            }
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.tertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func openInSource(path: String, line: Int?) {
        let absolute = path.hasPrefix("/") ? path : workspacePath + "/" + path
        guard FileManager.default.fileExists(atPath: absolute) else { return }
        tab = .source
        sourceStack.append(SourceLocation(path: absolute, line: line))
    }

    // MARK: - Loading

    private func refresh() {
        guard !loading else {
            refreshQueued = true
            return
        }
        loading = true
        let path = workspacePath
        let base = baseBranch
        let scope = scope
        let context = contextLines
        DispatchQueue.global(qos: .userInitiated).async {
            let text = GitService.diff(path, scope: scope, base: base, context: context)
            var parsed = DiffParser.parse(text)
            let stats = GitService.stats(path, scope: scope, base: base)
            for index in parsed.indices {
                if let counts = stats[parsed[index].path] {
                    parsed[index].added = counts.0
                    parsed[index].removed = counts.1
                }
            }
            let log = GitService.commits(path, base: base)
            DispatchQueue.main.async {
                files = parsed
                commits = log
                if selectedFile == nil || !parsed.contains(where: { $0.path == selectedFile }) {
                    selectedFile = parsed.first?.path
                }
                loading = false
                if refreshQueued {
                    refreshQueued = false
                    refresh()
                }
            }
        }
    }
}

/// Bridges to CodeNavigatorView's own location type.
typealias ReviewPanelSourceLocation = CodeSourceLocation
