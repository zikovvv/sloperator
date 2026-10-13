import SwiftUI

/// Small, dependency-free tokenizer. Not a parser: it colours keywords, strings, comments,
/// numbers and type-ish identifiers, which is what makes a diff readable.
enum SyntaxHighlighter {
    struct Theme {
        var keyword = Color(red: 0.78, green: 0.36, blue: 0.75)
        var string = Color(red: 0.80, green: 0.44, blue: 0.30)
        var comment = Color.secondary
        var number = Color(red: 0.36, green: 0.60, blue: 0.83)
        var type = Color(red: 0.30, green: 0.65, blue: 0.60)
    }

    static let theme = Theme()

    private static let keywordsByLanguage: [String: Set<String>] = [
        "swift": ["func", "let", "var", "if", "else", "guard", "return", "struct", "class", "enum",
                  "protocol", "extension", "import", "for", "while", "in", "switch", "case",
                  "default", "break", "continue", "private", "public", "internal", "static",
                  "self", "init", "deinit", "throws", "try", "catch", "async", "await", "nil",
                  "true", "false", "some", "any", "where", "as", "is", "defer", "lazy", "weak"],
        "python": ["def", "class", "if", "elif", "else", "return", "import", "from", "as", "for",
                   "while", "in", "not", "and", "or", "None", "True", "False", "try", "except",
                   "finally", "raise", "with", "yield", "lambda", "pass", "break", "continue",
                   "global", "nonlocal", "assert", "async", "await", "del", "self"],
        "javascript": ["function", "const", "let", "var", "if", "else", "return", "class",
                       "extends", "import", "export", "from", "for", "while", "of", "in", "new",
                       "this", "null", "undefined", "true", "false", "try", "catch", "finally",
                       "throw", "async", "await", "yield", "switch", "case", "default", "break",
                       "continue", "typeof", "instanceof", "delete", "void", "interface", "type"],
        "go": ["func", "var", "const", "type", "struct", "interface", "if", "else", "for", "range",
               "return", "package", "import", "go", "defer", "chan", "select", "switch", "case",
               "default", "break", "continue", "nil", "true", "false", "map", "make", "new"],
        "rust": ["fn", "let", "mut", "if", "else", "match", "struct", "enum", "impl", "trait",
                 "use", "pub", "mod", "return", "for", "while", "loop", "in", "self", "Self",
                 "async", "await", "move", "ref", "where", "as", "dyn", "const", "static",
                 "true", "false", "None", "Some", "Ok", "Err"],
        "shell": ["if", "then", "else", "fi", "for", "in", "do", "done", "while", "case", "esac",
                  "function", "return", "export", "local", "echo", "set", "source"],
    ]

    private static func language(for ext: String) -> String? {
        switch ext {
        case "swift": return "swift"
        case "py", "pyi": return "python"
        case "js", "jsx", "ts", "tsx", "mjs", "cjs", "json": return "javascript"
        case "go": return "go"
        case "rs": return "rust"
        case "sh", "bash", "zsh": return "shell"
        default: return nil
        }
    }

    private static func commentPrefix(_ language: String) -> String {
        switch language {
        case "python", "shell": return "#"
        default: return "//"
        }
    }

    /// Highlights one line. `inBlockComment` carries /* */ state so a file can be coloured
    /// sequentially without re-scanning from the top for every row.
    static func highlight(
        _ line: String, extension ext: String, inBlockComment: inout Bool
    ) -> AttributedString {
        guard let language = language(for: ext) else { return AttributedString(line) }

        if inBlockComment {
            if let end = line.range(of: "*/") {
                var head = AttributedString(String(line[line.startIndex..<end.upperBound]))
                head.foregroundColor = theme.comment
                inBlockComment = false
                var nested = false
                head.append(highlight(String(line[end.upperBound...]), extension: ext,
                                      inBlockComment: &nested))
                return head
            }
            var all = AttributedString(line)
            all.foregroundColor = theme.comment
            return all
        }

        if language != "python", language != "shell", let start = line.range(of: "/*") {
            var carry = false
            var head = highlight(String(line[line.startIndex..<start.lowerBound]),
                                 extension: ext, inBlockComment: &carry)
            var tail = AttributedString(String(line[start.lowerBound...]))
            tail.foregroundColor = theme.comment
            head.append(tail)
            inBlockComment = !line[start.lowerBound...].contains("*/")
            return head
        }

        let prefix = commentPrefix(language)
        if let commentStart = line.range(of: prefix),
           !isInsideString(line, index: commentStart.lowerBound) {
            var code = highlightTokens(String(line[line.startIndex..<commentStart.lowerBound]),
                                       language: language)
            var comment = AttributedString(String(line[commentStart.lowerBound...]))
            comment.foregroundColor = theme.comment
            code.append(comment)
            return code
        }
        return highlightTokens(line, language: language)
    }

    private static func isInsideString(_ line: String, index: String.Index) -> Bool {
        line[line.startIndex..<index].filter { $0 == "\"" }.count % 2 == 1
    }

    private static func highlightTokens(_ line: String, language: String) -> AttributedString {
        let keywords = keywordsByLanguage[language] ?? []
        var output = AttributedString()
        var token = ""
        var inString = false
        var delimiter: Character = "\""

        func flush() {
            guard !token.isEmpty else { return }
            var piece = AttributedString(token)
            if keywords.contains(token) {
                piece.foregroundColor = theme.keyword
            } else if token.first?.isNumber == true {
                piece.foregroundColor = theme.number
            } else if token.first?.isUppercase == true {
                piece.foregroundColor = theme.type
            }
            output.append(piece)
            token = ""
        }

        for character in line {
            if inString {
                token.append(character)
                if character == delimiter {
                    var piece = AttributedString(token)
                    piece.foregroundColor = theme.string
                    output.append(piece)
                    token = ""
                    inString = false
                }
                continue
            }
            if character == "\"" || character == "'" || character == "`" {
                flush()
                inString = true
                delimiter = character
                token.append(character)
                continue
            }
            if character.isLetter || character.isNumber || character == "_" || character == "$" {
                token.append(character)
            } else {
                flush()
                output.append(AttributedString(String(character)))
            }
        }
        if inString {
            var piece = AttributedString(token)
            piece.foregroundColor = theme.string
            output.append(piece)
        } else {
            flush()
        }
        return output
    }
}
