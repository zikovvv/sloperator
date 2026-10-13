import SwiftUI
import AppKit

/// Source browser with IDE-style navigation: ⌘-click = go to definition,
/// hover = type info (pyright / typescript-language-server via LSPManager).
/// Standalone so the review panel and the code viewer don't depend on each other's nesting.
struct CodeSourceLocation: Equatable {
    var path: String
    var line: Int?   // 1-based
}

struct CodeNavigatorView: View {
    let workspace: String
    let location: CodeSourceLocation
    let canGoBack: Bool
    let onBack: () -> Void
    let onNavigate: (CodeSourceLocation) -> Void

    @State private var content: String = ""
    @State private var loadFailed = false

    private var relativePath: String {
        location.path.hasPrefix(workspace + "/")
            ? String(location.path.dropFirst(workspace.count + 1))
            : location.path
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    onBack()
                } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.borderless)
                .disabled(!canGoBack)
                .help("Back")
                Text(relativePath + (location.line.map { ":\($0)" } ?? ""))
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.head)
                    .textSelection(.enabled)
                Spacer()
                if LSPManager.shared.supports(path: location.path) {
                    Label("⌘-click: definition · hover: types", systemImage: "info.circle")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .labelStyle(.titleOnly)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            Divider()
            if loadFailed {
                Text("Could not read \(location.path)")
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                CodeView(
                    content: content,
                    filePath: location.path,
                    workspace: workspace,
                    targetLine: location.line,
                    onNavigate: { path, line in
                        onNavigate(CodeSourceLocation(path: path, line: line))
                    }
                )
            }
        }
        .onAppear(perform: load)
        .onChange(of: location) { load() }
    }

    private func load() {
        if let text = try? String(contentsOfFile: location.path, encoding: .utf8) {
            content = text
            loadFailed = false
        } else {
            content = ""
            loadFailed = true
        }
    }
}

struct CodeView: NSViewRepresentable {
    let content: String
    let filePath: String
    let workspace: String
    let targetLine: Int? // 1-based
    let onNavigate: (String, Int) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = CodeNSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.backgroundColor = .textBackgroundColor
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 6, height: 6)
        textView.coordinator = context.coordinator

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? CodeNSTextView else { return }
        context.coordinator.parent = self
        if textView.string != content {
            textView.string = content
            textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            context.coordinator.appliedLine = nil
        }
        if context.coordinator.appliedLine != targetLine {
            context.coordinator.appliedLine = targetLine
            if let line = targetLine {
                DispatchQueue.main.async {
                    context.coordinator.highlightAndScroll(textView: textView, line: line)
                }
            }
        }
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator {
        var parent: CodeView
        var appliedLine: Int? = nil
        private var hoverPopover: NSPopover? = nil
        private var hoverWorkItem: DispatchWorkItem? = nil
        private var hoverTask: Task<Void, Never>? = nil

        init(_ parent: CodeView) {
            self.parent = parent
        }

        /// LSP positions are UTF-16 based, same unit as NSString — so work in NSString space.
        private func lineAndCharacter(of index: Int, in text: NSString) -> (line: Int, character: Int) {
            var line = 0
            var lineStart = 0
            var searchIndex = 0
            while searchIndex < index {
                let range = text.range(of: "\n", options: [], range: NSRange(location: searchIndex, length: index - searchIndex))
                if range.location == NSNotFound { break }
                line += 1
                lineStart = range.location + 1
                searchIndex = lineStart
            }
            return (line, index - lineStart)
        }

        func handleCommandClick(textView: CodeNSTextView, characterIndex: Int) {
            let text = textView.string as NSString
            guard characterIndex < text.length else { return }
            let (line, character) = lineAndCharacter(of: characterIndex, in: text)
            let (workspace, filePath) = (parent.workspace, parent.filePath)
            let navigate = parent.onNavigate
            Task { @MainActor in
                let locations = await LSPManager.shared.definition(
                    workspace: workspace, filePath: filePath, line: line, character: character)
                if let target = locations.first {
                    navigate(target.path, target.line + 1)
                } else {
                    NSSound.beep()
                    if let problem = LSPManager.shared.lastError {
                        LSPManager.shared.lastError = nil
                        NotificationCenter.default.post(
                            name: .lspProblem, object: problem)
                    }
                }
            }
        }

        func handleHover(textView: CodeNSTextView, characterIndex: Int) {
            hoverWorkItem?.cancel()
            hoverTask?.cancel()
            guard LSPManager.shared.supports(path: parent.filePath) else { return }
            let workItem = DispatchWorkItem { [weak self, weak textView] in
                guard let self, let textView else { return }
                self.requestHover(textView: textView, characterIndex: characterIndex)
            }
            hoverWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: workItem)
        }

        func showHoverNow(textView: CodeNSTextView, characterIndex: Int) {
            hoverWorkItem?.cancel()
            hoverTask?.cancel()
            requestHover(textView: textView, characterIndex: characterIndex)
        }

        func cancelHover() {
            hoverWorkItem?.cancel()
            hoverTask?.cancel()
            hoverPopover?.close()
            hoverPopover = nil
        }

        private func requestHover(textView: CodeNSTextView, characterIndex: Int) {
            let text = textView.string as NSString
            guard characterIndex < text.length else { return }
            // Only hover over identifier-ish characters.
            let char = Character(UnicodeScalar(text.character(at: characterIndex)) ?? " ")
            guard char.isLetter || char.isNumber || char == "_" else {
                hoverPopover?.close()
                return
            }
            let (line, character) = lineAndCharacter(of: characterIndex, in: text)
            let (workspace, filePath) = (parent.workspace, parent.filePath)
            hoverTask = Task { @MainActor [weak self, weak textView] in
                guard let hover = await LSPManager.shared.hover(
                    workspace: workspace, filePath: filePath, line: line, character: character),
                    let self, let textView, !Task.isCancelled
                else { return }
                self.showHoverPopover(text: hover.text, textView: textView, characterIndex: characterIndex)
            }
        }

        private func showHoverPopover(text: String, textView: NSTextView, characterIndex: Int) {
            hoverPopover?.close()
            let cleaned = text
                .replacingOccurrences(of: "```python\n", with: "")
                .replacingOccurrences(of: "```typescript\n", with: "")
                .replacingOccurrences(of: "```\n", with: "")
                .replacingOccurrences(of: "```", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleaned.isEmpty else { return }

            let controller = NSHostingController(rootView:
                Text(cleaned)
                    .font(.system(size: 11.5, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: 520, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            )
            let popover = NSPopover()
            popover.behavior = .transient
            popover.contentViewController = controller
            popover.contentSize = controller.view.fittingSize
            hoverPopover = popover

            guard let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else { return }
            let glyphRange = layoutManager.glyphRange(
                forCharacterRange: NSRange(location: characterIndex, length: 1), actualCharacterRange: nil)
            var rect = layoutManager.boundingRect(forGlyphRange: glyphRange, in: textContainer)
            rect.origin.x += textView.textContainerInset.width
            rect.origin.y += textView.textContainerInset.height
            popover.show(relativeTo: rect, of: textView, preferredEdge: .maxY)
        }

        func highlightAndScroll(textView: NSTextView, line: Int) {
            let text = textView.string as NSString
            var currentLine = 1
            var start = 0
            while currentLine < line {
                let range = text.range(of: "\n", options: [], range: NSRange(location: start, length: text.length - start))
                if range.location == NSNotFound { break }
                start = range.location + 1
                currentLine += 1
            }
            var end = text.range(of: "\n", options: [], range: NSRange(location: start, length: text.length - start)).location
            if end == NSNotFound { end = text.length }
            let lineRange = NSRange(location: start, length: max(0, end - start))
            textView.scrollRangeToVisible(lineRange)
            textView.layoutManager?.removeTemporaryAttribute(
                .backgroundColor, forCharacterRange: NSRange(location: 0, length: text.length))
            textView.layoutManager?.addTemporaryAttribute(
                .backgroundColor,
                value: NSColor.systemYellow.withAlphaComponent(0.25),
                forCharacterRange: lineRange)
        }
    }
}

/// NSTextView that reports ⌘-clicks and mouse hovers by character index.
final class CodeNSTextView: NSTextView {
    weak var coordinator: CodeView.Coordinator? = nil
    private var trackingArea: NSTrackingArea? = nil
    private var contextMenuCharacterIndex: Int = 0

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        contextMenuCharacterIndex = characterIndexForInsertion(at: point)
        let menu = super.menu(for: event) ?? NSMenu()
        let definitionItem = NSMenuItem(
            title: "Go to Definition", action: #selector(contextGoToDefinition), keyEquivalent: "")
        definitionItem.target = self
        let hoverItem = NSMenuItem(
            title: "Show Type Info", action: #selector(contextShowHover), keyEquivalent: "")
        hoverItem.target = self
        menu.insertItem(definitionItem, at: 0)
        menu.insertItem(hoverItem, at: 1)
        menu.insertItem(NSMenuItem.separator(), at: 2)
        return menu
    }

    @objc private func contextGoToDefinition() {
        coordinator?.handleCommandClick(textView: self, characterIndex: contextMenuCharacterIndex)
    }

    @objc private func contextShowHover() {
        coordinator?.showHoverNow(textView: self, characterIndex: contextMenuCharacterIndex)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            let point = convert(event.locationInWindow, from: nil)
            let index = characterIndexForInsertion(at: point)
            coordinator?.handleCommandClick(textView: self, characterIndex: index)
            return
        }
        coordinator?.cancelHover()
        super.mouseDown(with: event)
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        let point = convert(event.locationInWindow, from: nil)
        let index = characterIndexForInsertion(at: point)
        coordinator?.handleHover(textView: self, characterIndex: index)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        coordinator?.cancelHover()
    }
}
