import SwiftUI

struct ChatView: View {
    @EnvironmentObject var store: AppStore
    @Binding var session: Session
    @State private var catalog: [SkillInfo] = []
    @State private var hintIndex = 0
    @State private var expandedItems: Set<UUID> = []
    /// False while the user has scrolled up to read history — never yank them back down.
    @State private var pinnedToBottom = true
    @State private var unseenWhileScrolled = 0
    @State private var turnStarted: Date? = nil
    @State private var elapsed = ""
    @FocusState private var composerFocused: Bool

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    /// Drafts live in the store so switching sessions doesn't destroy half-typed prompts.
    private var draft: Binding<String> {
        Binding(
            get: { store.drafts[session.id] ?? "" },
            set: { store.drafts[session.id] = $0 }
        )
    }

    private var transcript: [TranscriptItem] {
        store.transcripts[session.id] ?? []
    }
    private var isRunning: Bool {
        store.runningSessions.contains(session.id)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    transcriptList
                }
                .overlay(alignment: .bottom) { jumpToLatest(proxy: proxy) }
                .onChange(of: transcript.count) {
                    if pinnedToBottom {
                        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                    } else {
                        unseenWhileScrolled += 1
                    }
                }
                .onAppear { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
            }
            Divider()
            if !attachedComments.isEmpty { commentAttachments }
            if !hintMatches.isEmpty {
                skillHints
            }
            composer
        }
        .background(Color(nsColor: .textBackgroundColor))
        .onAppear(perform: loadCatalog)
        .onReceive(ticker) { _ in updateElapsed() }
        .onChange(of: isRunning) {
            turnStarted = isRunning ? Date() : nil
            updateElapsed()
        }
        .onReceive(NotificationCenter.default.publisher(for: .focusComposer)) { _ in
            composerFocused = true
        }
    }

    private var transcriptList: some View {
        LazyVStack(alignment: .leading, spacing: 10) {
            if transcript.isEmpty {
                emptyHint
            }
            ForEach(transcript) { item in
                TranscriptItemView(
                    item: item,
                    expanded: expansionBinding(for: item.id),
                    onOpenFile: openFileInReview
                )
                .id(item.id)
            }
            if isRunning { runningIndicator }
            Color.clear
                .frame(height: 1)
                .id(Self.bottomAnchor)
                .onAppear {
                    pinnedToBottom = true
                    unseenWhileScrolled = 0
                }
                .onDisappear { pinnedToBottom = false }
        }
        .padding(14)
    }

    private func expansionBinding(for id: UUID) -> Binding<Bool> {
        Binding(
            get: { expandedItems.contains(id) },
            set: { isOn in
                if isOn { expandedItems.insert(id) } else { expandedItems.remove(id) }
            }
        )
    }

    private func openFileInReview(_ path: String) {
        NotificationCenter.default.post(name: .openFileInReview, object: path)
    }

    private static let bottomAnchor = "transcript-bottom"

    private var runningIndicator: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("\(session.engine.displayName) is working\(elapsed.isEmpty ? "" : " · \(elapsed)")")
                .font(.callout)
                .foregroundStyle(.secondary)
            if let tool = activeToolLabel {
                Text("· \(tool)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    /// The most recent tool that hasn't reported output yet — what the agent is doing right now.
    private var activeToolLabel: String? {
        guard let item = transcript.last(where: { $0.role == .tool }),
              (item.toolOutput ?? "").isEmpty
        else { return nil }
        let detail = item.text.split(separator: "\n").first.map(String.init) ?? ""
        return "\(item.toolName ?? "tool") \(detail.prefix(60))"
    }

    private func updateElapsed() {
        guard let turnStarted else { elapsed = ""; return }
        let seconds = Int(Date().timeIntervalSince(turnStarted))
        elapsed = seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }

    @ViewBuilder
    private func jumpToLatest(proxy: ScrollViewProxy) -> some View {
        if !pinnedToBottom && unseenWhileScrolled > 0 {
            Button {
                withAnimation { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
                pinnedToBottom = true
                unseenWhileScrolled = 0
            } label: {
                Label("\(unseenWhileScrolled) new", systemImage: "arrow.down")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color.accentColor))
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .padding(.bottom, 10)
        }
    }

    private func loadCatalog() {
        let path = store.workingPath(for: session)
        DispatchQueue.global(qos: .utility).async {
            let scanned = SkillCatalog.scan(projectPath: path)
            DispatchQueue.main.async { catalog = scanned }
        }
    }

    // MARK: - Slash-skill autocomplete

    /// The "/word" being typed at the caret end, if any.
    private var slashQuery: String? {
        let text = draft.wrappedValue
        guard let slash = text.lastIndex(of: "/") else { return nil }
        let isStart = slash == text.startIndex
            || text[text.index(before: slash)].isWhitespace
        guard isStart else { return nil }
        let query = text[text.index(after: slash)...]
        guard !query.contains(" "), !query.contains("\n") else { return nil }
        return String(query)
    }

    private var hintMatches: [SkillInfo] {
        guard let query = slashQuery?.lowercased() else { return [] }
        return catalog
            .filter { $0.kind != .agent }
            .filter { query.isEmpty || $0.name.lowercased().contains(query) }
            .sorted { a, b in
                let aPrefix = a.name.lowercased().hasPrefix(query)
                let bPrefix = b.name.lowercased().hasPrefix(query)
                if aPrefix != bPrefix { return aPrefix }
                return a.name < b.name
            }
            .prefix(6)
            .map { $0 }
    }

    private func applyHint(_ skill: SkillInfo) {
        let text = draft.wrappedValue
        if let slash = text.lastIndex(of: "/") {
            draft.wrappedValue = String(text[text.startIndex..<slash]) + skill.invocation
        } else {
            draft.wrappedValue = skill.invocation
        }
        hintIndex = 0
        composerFocused = true
    }

    private var skillHints: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(hintMatches.enumerated()), id: \.element.id) { index, skill in
                Button {
                    applyHint(skill)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: skill.kind == .skill ? "wand.and.stars" : "terminal")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 16)
                        Text("/\(skill.name)")
                            .font(.callout.monospaced())
                            .fontWeight(.medium)
                        Text(skill.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                        Text(skill.source.rawValue)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                    .contentShape(Rectangle())
                    .background(index == hintIndex ? Color.accentColor.opacity(0.25) : .clear)
                }
                .buttonStyle(.plain)
            }
        }
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.12)))
        .shadow(radius: 10, y: -2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.top, 6)
    }

    private var emptyHint: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Session ready")
                    .font(.headline)
                Text("Working in \(store.workingPath(for: session))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Text("CLAUDE.md files are picked up natively by both engines. Type below to start — ⏎ sends, ⇧⏎ inserts a newline, / shows your skills.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if !quickStarts.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Quick start")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    FlowLayout(spacing: 6) {
                        ForEach(quickStarts) { skill in
                            Button {
                                applyHint(skill)
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: skill.kind == .agent ? "person.fill" : "wand.and.stars")
                                        .font(.caption2)
                                    Text(skill.kind == .agent ? skill.name : "/\(skill.name)")
                                        .font(.callout)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Capsule().fill(Color.accentColor.opacity(0.12)))
                            }
                            .buttonStyle(.plain)
                            .help(skill.description)
                        }
                    }
                }
            }
        }
        .padding(.bottom, 8)
    }

    private var quickStarts: [SkillInfo] {
        let preferred = catalog.filter { $0.source == .project }
        let rest = catalog.filter { $0.source != .project }
        return Array((preferred + rest).prefix(14))
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...12)
                .font(.body)
                .focused($composerFocused)
                .onSubmit(submitFromKeyboard)
                .onKeyPress(.upArrow) { moveHint(-1) }
                .onKeyPress(.downArrow) { moveHint(1) }
                .onKeyPress(.tab) { acceptHint() }
                .onKeyPress(.escape) {
                    guard !hintMatches.isEmpty else { return .ignored }
                    hintIndex = 0
                    draft.wrappedValue = draft.wrappedValue.replacingOccurrences(
                        of: "/" + (slashQuery ?? ""), with: "")
                    return .handled
                }
                .padding(10)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.primary.opacity(0.05))
                )

            // Always mounted so the send button never shifts under the cursor mid-turn.
            Button {
                store.stop(sessionID: session.id)
            } label: {
                Image(systemName: "stop.circle.fill")
                    .font(.title2)
                    .foregroundStyle(isRunning ? .red : Color.secondary.opacity(0.35))
            }
            .buttonStyle(.plain)
            .disabled(!isRunning)
            .help("Stop the current turn (⌘.)")

            Button(action: send) {
                Image(systemName: isRunning && session.steeringMode == .steer
                      ? "bolt.circle.fill" : "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(isDraftEmpty ? Color.secondary : Color.accentColor)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(isDraftEmpty)
            .help(isRunning
                  ? (session.steeringMode == .steer ? "Steer now (interrupts)" : "Queue message")
                  : "Send (⏎ or ⌘⏎)")
        }
        .padding(10)
        .background(.bar)
        .onAppear { composerFocused = true }
    }

    private var attachedComments: [ReviewComment] {
        store.reviewComments[session.id] ?? []
    }

    /// Staged line comments. They ride along with the next message — never sent alone.
    private var commentAttachments: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(attachedComments) { comment in
                HStack(spacing: 6) {
                    Image(systemName: "text.bubble")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                    Text("\((comment.file as NSString).lastPathComponent):\(comment.line)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    Text(comment.body)
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    Button {
                        store.removeReviewComment(sessionID: session.id, id: comment.id)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            Text("Attached to your next message — press ⏎ to send.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.accentColor.opacity(0.07))
    }

    private var placeholder: String {
        if isRunning {
            return session.steeringMode == .steer
                ? "Steer \(session.engine.displayName) (interrupts current turn)…"
                : "Queue for \(session.engine.displayName)…"
        }
        return "Message \(session.engine.displayName)…    ⏎ send · ⇧⏎ newline · / skills"
    }

    private var isDraftEmpty: Bool {
        draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func moveHint(_ delta: Int) -> KeyPress.Result {
        guard !hintMatches.isEmpty else { return .ignored }
        hintIndex = max(0, min(hintMatches.count - 1, hintIndex + delta))
        return .handled
    }

    private func acceptHint() -> KeyPress.Result {
        guard hintMatches.indices.contains(hintIndex) else { return .ignored }
        applyHint(hintMatches[hintIndex])
        return .handled
    }

    /// Return picks the highlighted skill when the menu is open, otherwise sends.
    private func submitFromKeyboard() {
        if hintMatches.indices.contains(hintIndex), slashQuery != nil {
            applyHint(hintMatches[hintIndex])
            return
        }
        send()
    }

    private func send() {
        let text = draft.wrappedValue
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        draft.wrappedValue = ""
        hintIndex = 0
        store.send(sessionID: session.id, prompt: text)
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem
    @Binding var expanded: Bool
    var onOpenFile: (String) -> Void = { _ in }

    var body: some View {
        content
            .contextMenu {
                Button("Copy") { copyToPasteboard(item.text) }
                if let output = item.toolOutput, !output.isEmpty {
                    Button("Copy Output") { copyToPasteboard(output) }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch item.role {
        case .user:
            HStack {
                Spacer(minLength: 60)
                MessageBody(text: item.text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.accentColor.opacity(0.18))
                    )
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if let engine = item.engine {
                        Label(engine.displayName, systemImage: engine.symbol)
                            .font(.caption2)
                            .foregroundStyle(engine == .claude ? Color.orange : Color.teal)
                    }
                    Text(item.timestamp.formatted(date: .omitted, time: .shortened))
                        .font(.caption2)
                        .foregroundStyle(.quaternary)
                }
                MessageBody(text: item.text)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .thinking:
            DisclosureGroup(isExpanded: $expanded) {
                Text(item.text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.top, 4)
            } label: {
                Label("Thinking", systemImage: "brain")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .tool:
            toolRow
        case .info:
            Text(item.text)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .center)
        case .error:
            Label(item.text, systemImage: "xmark.octagon.fill")
                .font(.callout)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        }
    }

    private var toolRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: toolIcon)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(item.toolName ?? "tool")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                if let path = filePath {
                    Button {
                        onOpenFile(path)
                    } label: {
                        Text(path)
                            .font(.system(.caption, design: .monospaced))
                            .underline()
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .help("Open in the review panel")
                } else {
                    // The command is the most useful thing on the row — let it breathe.
                    Text(item.text)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
                if item.toolOutput?.hasPrefix("⚠️") == true {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.yellow)
                }
                Spacer()
                if hasOutput {
                    Button {
                        withAnimation { expanded.toggle() }
                    } label: {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                    }
                    .buttonStyle(.plain)
                }
            }
            if expanded, let output = item.toolOutput {
                ScrollView([.vertical, .horizontal]) {
                    Text(output)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(8)
                }
                .frame(maxHeight: 320)
                .background(Color.primary.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(alignment: .topTrailing) {
                    Button("Copy") { copyToPasteboard(output) }
                        .buttonStyle(.borderless)
                        .font(.caption2)
                        .padding(4)
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// File-ish detail from an edit/read tool, so it can be opened in the review panel.
    private var filePath: String? {
        let name = (item.toolName ?? "").lowercased()
        guard ["read", "edit", "write", "notebookedit"].contains(name) else { return nil }
        let first = item.text.split(separator: "\n").first.map(String.init) ?? item.text
        let candidate = first.split(separator: " ").last.map(String.init) ?? first
        return candidate.contains("/") ? candidate : nil
    }

    private var hasOutput: Bool {
        !(item.toolOutput ?? "").isEmpty
    }

    private var toolIcon: String {
        switch (item.toolName ?? "").lowercased() {
        case "bash", "shell": return "terminal"
        case "edit", "write", "notebookedit": return "pencil"
        case "read": return "doc.text"
        case "grep", "glob", "web_search", "websearch": return "magnifyingglass"
        default: return "wrench.and.screwdriver"
        }
    }
}

private func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

/// Agent prose as real Markdown: headings, lists, quotes, tables and fenced code, with
/// links routed rather than rendered as dead text.
struct MessageBody: View {
    let text: String
    var workingDirectory: String? = nil
    var onOpenFile: ((String) -> Void)? = nil

    var body: some View {
        MarkdownView(text: text, baseDirectory: workingDirectory, onOpenFile: onOpenFile)
    }
}

/// Minimal wrapping flow layout for chip rows.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 600
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
