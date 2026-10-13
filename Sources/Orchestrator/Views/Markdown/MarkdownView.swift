import SwiftUI
import AppKit

/// Renders Markdown properly — headings, lists, quotes, fences, rules, tables — and routes
/// link clicks: web links to the browser, file links back into the app.
struct MarkdownView: View {
    let text: String
    /// Directory the document lives in, used to resolve relative and [[wiki]] links.
    var baseDirectory: String? = nil
    var onOpenFile: ((String) -> Void)? = nil

    private var blocks: [MarkdownBlock] {
        MarkdownRenderer.blocks(from: MarkdownRenderer.expandWikiLinks(text))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                view(for: block)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            switch MarkdownLinkTarget.resolve(url.absoluteString, base: baseDirectory) {
            case .web(let webURL):
                NSWorkspace.shared.open(webURL)
                return .handled
            case .file(let path):
                guard FileManager.default.fileExists(atPath: path) else { return .handled }
                if let onOpenFile {
                    onOpenFile(path)
                } else {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                }
                return .handled
            case .unresolved:
                return .handled
            }
        })
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text, _):
            Text(inline(text))
                .font(headingFont(level))
                .padding(.top, level <= 2 ? 6 : 2)
        case .paragraph(let text, _):
            Text(inline(text))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .bullet(let items, _):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        Text(inline(item))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .numbered(let items, _):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.marker)
                            .foregroundStyle(.secondary)
                            .font(.callout.monospacedDigit())
                        Text(inline(item.text))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .quote(let text, _):
            HStack(alignment: .top, spacing: 8) {
                Rectangle()
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                Text(inline(text))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .code(let language, let code, _):
            CodeBlock(code: code, language: language)
        case .rule:
            Divider()
        case .table(let header, let rows, _):
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    tableRow(header, isHeader: true)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        Divider()
                        tableRow(row, isHeader: false)
                    }
                }
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color.primary.opacity(0.12))
                )
            }
        }
    }

    private func tableRow(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(inline(cell))
                    .font(isHeader ? .callout.weight(.semibold) : .callout)
                    .frame(minWidth: 90, maxWidth: 320, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
            }
        }
        .background(isHeader ? Color.primary.opacity(0.05) : .clear)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2.weight(.bold)
        case 2: return .title3.weight(.semibold)
        case 3: return .headline
        default: return .callout.weight(.semibold)
        }
    }

    /// Inline syntax (bold, italic, code spans, links) via AttributedString; links keep their
    /// destination so openURL can route them.
    private func inline(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible)
        )) ?? AttributedString(text)
    }
}

/// Fenced code with a copy button and horizontal scrolling.
struct CodeBlock: View {
    let code: String
    var language: String? = nil

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(highlighted)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        .overlay(alignment: .topTrailing) {
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(code, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc").font(.caption2)
            }
            .buttonStyle(.borderless)
            .padding(6)
        }
    }

    private var highlighted: AttributedString {
        guard let language else { return AttributedString(code) }
        var inBlockComment = false
        var result = AttributedString()
        let lines = code.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            result.append(SyntaxHighlighter.highlight(
                line, extension: language, inBlockComment: &inBlockComment))
            if index < lines.count - 1 { result.append(AttributedString("\n")) }
        }
        return result
    }
}
