import SwiftUI
import AppKit

/// The diff itself: gutters with both sides' line numbers, syntax highlighting,
/// ⌘-click go-to-definition, hover type info, and a "+" on every line to attach a
/// comment to the chat.
struct DiffContentView: View {
    let file: DiffFile
    let workspace: String
    /// Called when a definition lookup resolves, so the panel can open that file.
    var onOpenLocation: (String, Int) -> Void
    var onAddComment: (ReviewComment) -> Void

    @State private var hoveredLine: Int? = nil
    @State private var commentingLine: DiffLine? = nil
    @State private var commentBody = ""
    @State private var hoverInfo: String? = nil
    @FocusState private var commentFocused: Bool

    /// Highlighting is expensive (~140ms for 3k lines) and `body` re-runs on every hover and
    /// every store publish, so it is computed once per file, off the main thread.
    @State private var colours: [Int: AttributedString] = [:]

    private static let highlightLineLimit = 4000

    private static func highlight(_ file: DiffFile) -> [Int: AttributedString] {
        var result: [Int: AttributedString] = [:]
        var inBlockComment = false
        let ext = file.language
        var count = 0
        for hunk in file.hunks {
            for line in hunk.lines where line.kind != .hunkHeader {
                count += 1
                // Past this size the colour is not worth stalling on; plain text still renders.
                guard count <= highlightLineLimit else { return result }
                result[line.id] = SyntaxHighlighter.highlight(
                    line.text, extension: ext, inBlockComment: &inBlockComment)
            }
        }
        return result
    }

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(file.hunks) { hunk in
                    ForEach(hunk.lines) { line in
                        row(line, highlighted: colours[line.id])
                    }
                }
                if file.isBinary {
                    Text("Binary file — no textual diff.")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                        .padding(12)
                } else if file.hunks.isEmpty {
                    // Rename-only and mode-only changes have no hunks; an empty pane looks broken.
                    VStack(alignment: .leading, spacing: 4) {
                        if file.status == "R", let oldPath = file.oldPath {
                            Label("Renamed from \(oldPath)", systemImage: "arrow.right.doc.on.clipboard")
                        } else {
                            Label("No textual changes in this file", systemImage: "doc")
                        }
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(12)
                }
            }
            .padding(.vertical, 4)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .overlay(alignment: .topTrailing) { hoverPopover }
        .task(id: file.id) {
            let target = file
            let computed = await Task.detached(priority: .userInitiated) {
                Self.highlight(target)
            }.value
            guard !Task.isCancelled else { return }
            colours = computed
        }
    }

    @ViewBuilder
    private var hoverPopover: some View {
        if let hoverInfo {
            Text(hoverInfo)
                .font(.system(size: 11.5, design: .monospaced))
                .padding(8)
                .frame(maxWidth: 420, alignment: .leading)
                .background(.regularMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .shadow(radius: 8)
                .padding(8)
                .onTapGesture { self.hoverInfo = nil }
        }
    }

    @ViewBuilder
    private func row(_ line: DiffLine, highlighted: AttributedString?) -> some View {
        if line.kind == .hunkHeader {
            Text(line.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.blue)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.blue.opacity(0.08))
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 0) {
                    gutter(line.oldLine)
                    gutter(line.newLine)
                    commentButton(line)
                    Text(marker(line))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .frame(width: 12)
                    Text(highlighted ?? AttributedString(line.text))
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .onTapGesture {
                            if NSEvent.modifierFlags.contains(.command) { jumpToDefinition(line) }
                        }
                    Spacer(minLength: 12)
                }
                .padding(.vertical, 0.5)
                .background(background(line.kind))
                .onHover { hovering in
                    hoveredLine = hovering ? line.id : (hoveredLine == line.id ? nil : hoveredLine)
                }
                if commentingLine?.id == line.id { commentEditor(line) }
            }
        }
    }

    private func gutter(_ number: Int?) -> some View {
        Text(number.map(String.init) ?? "")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(.tertiary)
            .frame(width: 40, alignment: .trailing)
            .padding(.trailing, 4)
    }

    private func commentButton(_ line: DiffLine) -> some View {
        Button {
            commentingLine = line
            commentBody = ""
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { commentFocused = true }
        } label: {
            Image(systemName: "plus.square.fill")
                .font(.system(size: 10))
                .foregroundStyle(hoveredLine == line.id ? Color.accentColor : .clear)
        }
        .buttonStyle(.plain)
        .frame(width: 16)
        .help("Comment on this line — attaches to your next message")
    }

    private func commentEditor(_ line: DiffLine) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Comment on \((file.path as NSString).lastPathComponent):\(line.newLine ?? line.oldLine ?? 0)")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $commentBody)
                .font(.callout)
                .frame(height: 60)
                .focused($commentFocused)
                .scrollContentBackground(.hidden)
                .background(Color.primary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            HStack {
                Text("Attaches to the chat; sent when you send your message.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
                Button("Cancel") { commentingLine = nil }
                Button("Attach") {
                    let comment = ReviewComment(
                        file: file.path,
                        line: line.newLine ?? line.oldLine ?? 0,
                        snippet: line.text,
                        body: commentBody.trimmingCharacters(in: .whitespacesAndNewlines))
                    if !comment.body.isEmpty { onAddComment(comment) }
                    commentingLine = nil
                }
                .buttonStyle(.borderedProminent)
                .disabled(commentBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(10)
        .background(Color.accentColor.opacity(0.07))
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.accentColor).frame(width: 2)
        }
    }

    private func marker(_ line: DiffLine) -> String {
        switch line.kind {
        case .addition: return "+"
        case .deletion: return "−"
        default: return " "
        }
    }

    private func background(_ kind: DiffLine.Kind) -> Color {
        switch kind {
        case .addition: return .green.opacity(0.13)
        case .deletion: return .red.opacity(0.13)
        default: return .clear
        }
    }

    /// Maps a diff line back to a real file position and asks the language server.
    private func jumpToDefinition(_ line: DiffLine) {
        guard let lineNumber = line.newLine else { return }
        let absolute = workspace + "/" + file.path
        let column = max(0, line.text.count - line.text.drop(while: { $0 == " " }).count)
        Task { @MainActor in
            let locations = await LSPManager.shared.definition(
                workspace: workspace, filePath: absolute,
                line: lineNumber - 1, character: column)
            if let target = locations.first {
                onOpenLocation(target.path, target.line + 1)
            } else if let hover = await LSPManager.shared.hover(
                workspace: workspace, filePath: absolute,
                line: lineNumber - 1, character: column) {
                hoverInfo = hover.text
            } else {
                NSSound.beep()
            }
        }
    }
}
