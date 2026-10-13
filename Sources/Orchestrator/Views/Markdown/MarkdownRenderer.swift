import Foundation

/// Block-level Markdown. SwiftUI's AttributedString handles inline syntax well but flattens
/// everything else, so headings, lists, quotes, fences, rules and tables are parsed here and
/// only the inline runs are handed to AttributedString.
enum MarkdownBlock: Identifiable, Hashable {
    case heading(level: Int, text: String, id: Int)
    case paragraph(text: String, id: Int)
    case bullet(items: [String], id: Int)
    case numbered(items: [(marker: String, text: String)], id: Int)
    case quote(text: String, id: Int)
    case code(language: String?, text: String, id: Int)
    case rule(id: Int)
    case table(header: [String], rows: [[String]], id: Int)

    var id: Int {
        switch self {
        case .heading(_, _, let id), .paragraph(_, let id), .bullet(_, let id),
             .numbered(_, let id), .quote(_, let id), .code(_, _, let id),
             .rule(let id), .table(_, _, let id):
            return id
        }
    }

    static func == (lhs: MarkdownBlock, rhs: MarkdownBlock) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

enum MarkdownRenderer {
    /// `[[wiki-link]]` is the convention in Claude memory files; rewrite it to a normal link
    /// so the inline parser and the link router both understand it.
    static func expandWikiLinks(_ text: String) -> String {
        var result = ""
        var rest = Substring(text)
        while let open = rest.range(of: "[["), let close = rest.range(of: "]]"),
              close.lowerBound > open.upperBound {
            result += rest[rest.startIndex..<open.lowerBound]
            let name = String(rest[open.upperBound..<close.lowerBound])
            let target = name.hasSuffix(".md") ? name : name + ".md"
            result += "[\(name)](\(target))"
            rest = rest[close.upperBound...]
        }
        result += rest
        return result
    }

    static func blocks(from markdown: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var id = 0
        func nextID() -> Int { id += 1; return id }

        let lines = markdown.components(separatedBy: "\n")
        var index = 0
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(text: paragraph.joined(separator: "\n"), id: nextID()))
            paragraph = []
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code — consume verbatim to the closing fence (or end of file).
            if trimmed.hasPrefix("```") {
                flushParagraph()
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                index += 1
                while index < lines.count,
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    body.append(lines[index])
                    index += 1
                }
                index += 1 // closing fence
                blocks.append(.code(
                    language: language.isEmpty ? nil : language,
                    text: body.joined(separator: "\n"), id: nextID()))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.rule(id: nextID()))
                index += 1
                continue
            }

            if let level = headingLevel(trimmed) {
                flushParagraph()
                let text = String(trimmed.dropFirst(level)).trimmingCharacters(in: .whitespaces)
                blocks.append(.heading(level: level, text: text, id: nextID()))
                index += 1
                continue
            }

            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushParagraph()
                var quoted: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard candidate.hasPrefix(">") else { break }
                    quoted.append(String(candidate.dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(text: quoted.joined(separator: "\n"), id: nextID()))
                continue
            }

            if isBullet(trimmed) {
                flushParagraph()
                var items: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard isBullet(candidate) else {
                        // A wrapped continuation line belongs to the previous bullet.
                        if !items.isEmpty, !candidate.isEmpty, !isStructural(candidate),
                           lines[index].hasPrefix("  ") {
                            items[items.count - 1] += " " + candidate
                            index += 1
                            continue
                        }
                        break
                    }
                    items.append(String(candidate.dropFirst(2)))
                    index += 1
                }
                blocks.append(.bullet(items: items, id: nextID()))
                continue
            }

            if let _ = numberedMarker(trimmed) {
                flushParagraph()
                var items: [(String, String)] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard let marker = numberedMarker(candidate) else { break }
                    let body = String(candidate.dropFirst(marker.count))
                        .trimmingCharacters(in: .whitespaces)
                    items.append((marker.trimmingCharacters(in: .whitespaces), body))
                    index += 1
                }
                blocks.append(.numbered(items: items, id: nextID()))
                continue
            }

            if trimmed.hasPrefix("|"), index + 1 < lines.count,
               isTableSeparator(lines[index + 1].trimmingCharacters(in: .whitespaces)) {
                flushParagraph()
                let header = tableCells(trimmed)
                index += 2
                var rows: [[String]] = []
                while index < lines.count,
                      lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(tableCells(lines[index].trimmingCharacters(in: .whitespaces)))
                    index += 1
                }
                blocks.append(.table(header: header, rows: rows, id: nextID()))
                continue
            }

            paragraph.append(line)
            index += 1
        }
        flushParagraph()
        return blocks
    }

    private static func headingLevel(_ line: String) -> Int? {
        var level = 0
        for character in line {
            if character == "#" { level += 1 } else { break }
        }
        guard level > 0, level <= 6 else { return nil }
        let rest = line.dropFirst(level)
        return rest.isEmpty || rest.hasPrefix(" ") ? level : nil
    }

    private static func isBullet(_ line: String) -> Bool {
        line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ")
    }

    /// "12. " → "12." so the original numbering is preserved when rendering.
    private static func numberedMarker(_ line: String) -> String? {
        var digits = ""
        for character in line {
            if character.isNumber { digits.append(character) } else { break }
        }
        guard !digits.isEmpty else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return digits + String(rest.prefix(2))
    }

    private static func isStructural(_ line: String) -> Bool {
        isBullet(line) || numberedMarker(line) != nil || headingLevel(line) != nil
            || line.hasPrefix(">") || line.hasPrefix("```") || line.hasPrefix("|")
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        guard line.hasPrefix("|") else { return false }
        return line.allSatisfy { "|-: ".contains($0) } && line.contains("-")
    }

    private static func tableCells(_ line: String) -> [String] {
        let cells: [String] = line.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        // A row is written "| a | b |", so the split has an empty cell at each end.
        return Array(cells.dropFirst().dropLast())
    }
}

/// Where a Markdown link points once resolved against the document it appeared in.
enum MarkdownLinkTarget: Equatable {
    case web(URL)
    case file(path: String)
    case unresolved(String)

    /// `base` is the directory of the document holding the link.
    static func resolve(_ raw: String, base: String?) -> MarkdownLinkTarget {
        // Strip any anchor; we have nothing to scroll to yet.
        let withoutAnchor = raw.contains("#") && !raw.hasPrefix("#")
            ? String(raw[raw.startIndex..<raw.firstIndex(of: "#")!])
            : raw
        if withoutAnchor.isEmpty { return .unresolved(raw) }

        if let url = URL(string: withoutAnchor), let scheme = url.scheme?.lowercased() {
            if scheme == "http" || scheme == "https" { return .web(url) }
            if scheme == "file" { return .file(path: url.path) }
        }
        if withoutAnchor.hasPrefix("/") { return .file(path: withoutAnchor) }
        if withoutAnchor.hasPrefix("~") {
            return .file(path: (withoutAnchor as NSString).expandingTildeInPath)
        }
        guard let base else { return .unresolved(raw) }
        let joined = (base as NSString).appendingPathComponent(withoutAnchor)
        return .file(path: (joined as NSString).standardizingPath)
    }
}
