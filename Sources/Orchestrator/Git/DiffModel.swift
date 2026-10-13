import Foundation

/// What the review panel is diffing.
enum DiffScope: Hashable, Identifiable {
    case uncommitted          // working tree (incl. staged) vs HEAD
    case staged               // index vs HEAD
    case branch               // everything on this branch vs its base
    case remote               // vs the branch's upstream
    case commit(sha: String, subject: String)

    var id: String {
        switch self {
        case .uncommitted: return "uncommitted"
        case .staged: return "staged"
        case .branch: return "branch"
        case .remote: return "remote"
        case .commit(let sha, _): return "commit-" + sha
        }
    }

    var label: String {
        switch self {
        case .uncommitted: return "Uncommitted"
        case .staged: return "Staged"
        case .branch: return "Branch vs base"
        case .remote: return "vs Remote"
        case .commit(_, let subject): return subject
        }
    }
}

struct CommitInfo: Identifiable, Hashable {
    var sha: String
    var shortSHA: String
    var subject: String
    var author: String
    var relativeDate: String
    var id: String { sha }
}

struct DiffLine: Identifiable, Hashable {
    enum Kind { case context, addition, deletion, hunkHeader }
    var id: Int
    var kind: Kind
    /// Text without the leading +/-/space marker.
    var text: String
    var oldLine: Int?
    var newLine: Int?
}

struct DiffHunk: Identifiable, Hashable {
    var id: Int
    var header: String
    var lines: [DiffLine]
}

struct DiffFile: Identifiable, Hashable {
    var path: String
    var oldPath: String?
    var status: String      // A, M, D, R, ??
    var added: Int = 0
    var removed: Int = 0
    var isBinary: Bool = false
    var hunks: [DiffHunk] = []
    var id: String { path }

    var language: String { (path as NSString).pathExtension.lowercased() }
}

/// Parses `git diff` unified output into files → hunks → lines, tracking both sides'
/// line numbers so the viewer can show gutters and map a click back to a real file line.
enum DiffParser {
    static func parse(_ text: String) -> [DiffFile] {
        var files: [DiffFile] = []
        var current: DiffFile? = nil
        var hunk: DiffHunk? = nil
        var lineID = 0
        var hunkID = 0
        var oldNumber = 0
        var newNumber = 0

        func closeHunk() {
            if let open = hunk { current?.hunks.append(open) }
            hunk = nil
        }
        func closeFile() {
            closeHunk()
            if let open = current { files.append(open) }
            current = nil
        }

        var lines = text.components(separatedBy: "\n")
        // Real git output ends with a newline, which yields a trailing "" that would otherwise
        // be parsed as one more context line with fabricated gutter numbers.
        if lines.last == "" { lines.removeLast() }

        for raw in lines {
            // Windows checkouts diff with CRLF; the \r is not part of the code.
            let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw

            if line.hasPrefix("diff --git ") {
                closeFile()
                current = DiffFile(path: provisionalPath(line), status: "M")
                continue
            }
            guard current != nil else { continue }

            // File-level headers only exist BEFORE the first hunk. Inside a hunk, "--- " and
            // "++ " are ordinary deleted/added lines (SQL comments, Lua, Haskell, Ada...).
            if hunk == nil {
                if line.hasPrefix("new file") { current?.status = "A"; continue }
                if line.hasPrefix("deleted file") { current?.status = "D"; continue }
                if line.hasPrefix("rename from ") {
                    current?.oldPath = String(line.dropFirst("rename from ".count))
                    current?.status = "R"
                    continue
                }
                if line.hasPrefix("rename to ") {
                    current?.path = String(line.dropFirst("rename to ".count))
                    current?.status = "R"
                    continue
                }
                if line.hasPrefix("Binary files") { current?.isBinary = true; continue }
                // "+++ b/<path>" is authoritative for the name, unlike the "diff --git" line
                // which is ambiguous when a directory name contains " b/".
                if line.hasPrefix("+++ ") {
                    let value = headerPath(line.dropFirst(4))
                    if value != "/dev/null" {
                        current?.path = value.hasPrefix("b/") ? String(value.dropFirst(2)) : value
                    }
                    continue
                }
                if line.hasPrefix("--- ") {
                    let value = headerPath(line.dropFirst(4))
                    if value == "/dev/null" {
                        current?.status = "A"
                    } else if current?.path.hasPrefix("diff --git") == true {
                        // Deleted file: there is no +++ path to recover the name from.
                        current?.path = value.hasPrefix("a/") ? String(value.dropFirst(2)) : value
                    }
                    continue
                }
                if line.hasPrefix("index ") || line.hasPrefix("similarity ")
                    || line.hasPrefix("old mode") || line.hasPrefix("new mode")
                    || line.hasPrefix("dissimilarity ") || line.hasPrefix("copy from ")
                    || line.hasPrefix("copy to ") {
                    continue
                }
            }

            if line.hasPrefix("@@") {
                closeHunk()
                hunkID += 1
                lineID += 1
                let (old, new) = hunkStarts(line)
                oldNumber = old
                newNumber = new
                hunk = DiffHunk(id: hunkID, header: line, lines: [
                    DiffLine(id: lineID, kind: .hunkHeader, text: line, oldLine: nil, newLine: nil)
                ])
                continue
            }

            guard hunk != nil else { continue }
            if line.hasPrefix("\\") { continue }   // "\ No newline at end of file"
            lineID += 1
            if line.hasPrefix("+") {
                hunk?.lines.append(DiffLine(
                    id: lineID, kind: .addition, text: String(line.dropFirst()),
                    oldLine: nil, newLine: newNumber))
                newNumber += 1
                current?.added += 1
            } else if line.hasPrefix("-") {
                hunk?.lines.append(DiffLine(
                    id: lineID, kind: .deletion, text: String(line.dropFirst()),
                    oldLine: oldNumber, newLine: nil))
                oldNumber += 1
                current?.removed += 1
            } else {
                hunk?.lines.append(DiffLine(
                    id: lineID, kind: .context, text: line.isEmpty ? "" : String(line.dropFirst()),
                    oldLine: oldNumber, newLine: newNumber))
                oldNumber += 1
                newNumber += 1
            }
        }
        closeFile()
        return files
    }

    /// git appends a TAB after the name when a path contains spaces, and quotes paths that
    /// contain unusual characters.
    private static func headerPath(_ value: Substring) -> String {
        var path = String(value)
        while path.hasSuffix("\t") || path.hasSuffix(" ") { path.removeLast() }
        if path.hasPrefix("\"") && path.hasSuffix("\"") && path.count >= 2 {
            path = String(path.dropFirst().dropLast())
                .replacingOccurrences(of: "\\\"", with: "\"")
                .replacingOccurrences(of: "\\\\", with: "\\")
        }
        return path
    }

    /// Best effort only — "diff --git a/x b/y" is ambiguous when a path contains " b/".
    /// The "+++ b/<path>" line that follows is authoritative and overwrites this.
    private static func provisionalPath(_ header: String) -> String {
        let body = String(header.dropFirst("diff --git ".count))
        if let range = body.range(of: " b/", options: .backwards) {
            return String(body[range.upperBound...])
        }
        return header
    }

    /// "@@ -12,7 +12,9 @@" → (12, 12)
    private static func hunkStarts(_ header: String) -> (Int, Int) {
        let parts = header.components(separatedBy: " ")
        var old = 1, new = 1
        for part in parts {
            if part.hasPrefix("-") {
                old = Int(part.dropFirst().components(separatedBy: ",")[0]) ?? 1
            } else if part.hasPrefix("+") {
                new = Int(part.dropFirst().components(separatedBy: ",")[0]) ?? 1
            }
        }
        return (old, new)
    }
}
