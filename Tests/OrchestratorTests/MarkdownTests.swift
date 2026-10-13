import Testing
import Foundation
@testable import Orchestrator

@Suite("Markdown block parsing")
struct MarkdownTests {
    @Test("Headings, paragraphs and rules are separated")
    func structure() {
        let blocks = MarkdownRenderer.blocks(from: """
        # Title

        Some prose here.

        ---

        ## Section
        """)
        guard case .heading(let level, let text, _) = blocks[0] else {
            Issue.record("expected heading, got \(blocks[0])"); return
        }
        #expect(level == 1)
        #expect(text == "Title")
        guard case .paragraph = blocks[1] else { Issue.record("expected paragraph"); return }
        guard case .rule = blocks[2] else { Issue.record("expected rule"); return }
        guard case .heading(let secondLevel, _, _) = blocks[3] else {
            Issue.record("expected heading"); return
        }
        #expect(secondLevel == 2)
    }

    @Test("A '#' that is not a heading stays prose")
    func hashWithoutSpace() {
        let blocks = MarkdownRenderer.blocks(from: "#hashtag not a heading")
        guard case .paragraph = blocks[0] else {
            Issue.record("expected paragraph, got \(blocks[0])"); return
        }
    }

    @Test("Bullets and numbered lists group into one block each")
    func lists() {
        let blocks = MarkdownRenderer.blocks(from: """
        - one
        - two

        1. first
        2. second
        """)
        guard case .bullet(let items, _) = blocks[0] else {
            Issue.record("expected bullets"); return
        }
        #expect(items == ["one", "two"])
        guard case .numbered(let numbered, _) = blocks[1] else {
            Issue.record("expected numbered list"); return
        }
        #expect(numbered.map(\.text) == ["first", "second"])
        #expect(numbered.first?.marker == "1.")
    }

    @Test("Fenced code keeps its language and inner blank lines")
    func fencedCode() {
        let blocks = MarkdownRenderer.blocks(from: """
        ```swift
        let x = 1

        let y = 2
        ```
        """)
        guard case .code(let language, let code, _) = blocks[0] else {
            Issue.record("expected code block"); return
        }
        #expect(language == "swift")
        #expect(code == "let x = 1\n\nlet y = 2")
    }

    @Test("Markdown inside a fence is not parsed as markdown")
    func fenceProtectsContent() {
        let blocks = MarkdownRenderer.blocks(from: """
        ```
        # not a heading
        - not a bullet
        ```
        """)
        #expect(blocks.count == 1)
        guard case .code = blocks[0] else { Issue.record("expected a single code block"); return }
    }

    @Test("An unterminated fence does not swallow the parser")
    func unterminatedFence() {
        let blocks = MarkdownRenderer.blocks(from: "```\nstuff\nmore")
        #expect(blocks.count == 1)
        guard case .code(_, let code, _) = blocks[0] else {
            Issue.record("expected code"); return
        }
        #expect(code == "stuff\nmore")
    }

    @Test("Tables parse their header and rows")
    func tables() {
        let blocks = MarkdownRenderer.blocks(from: """
        | Name | Count |
        |------|-------|
        | a    | 1     |
        | b    | 2     |
        """)
        guard case .table(let header, let rows, _) = blocks[0] else {
            Issue.record("expected table, got \(blocks[0])"); return
        }
        #expect(header == ["Name", "Count"])
        #expect(rows == [["a", "1"], ["b", "2"]])
    }

    @Test("Blockquotes collapse into one block")
    func quotes() {
        let blocks = MarkdownRenderer.blocks(from: "> first\n> second")
        guard case .quote(let text, _) = blocks[0] else {
            Issue.record("expected quote"); return
        }
        #expect(text == "first\nsecond")
    }

    @Test("Wiki links become ordinary Markdown links")
    func wikiLinks() {
        let expanded = MarkdownRenderer.expandWikiLinks(
            "See [[orchestrator-app-architecture]] and [[notes.md]].")
        #expect(expanded.contains("[orchestrator-app-architecture](orchestrator-app-architecture.md)"))
        #expect(expanded.contains("[notes.md](notes.md)"))
    }

    @Test("Text without wiki links is untouched")
    func wikiLinksNoop() {
        let text = "An array literal [1, 2] and a [link](x.md)."
        #expect(MarkdownRenderer.expandWikiLinks(text) == text)
    }
}

@Suite("Markdown link resolution")
struct MarkdownLinkTests {
    @Test("Web links stay web links")
    func web() {
        #expect(MarkdownLinkTarget.resolve("https://example.com/x", base: "/tmp")
                == .web(URL(string: "https://example.com/x")!))
    }

    @Test("Relative links resolve against the document's directory")
    func relative() {
        #expect(MarkdownLinkTarget.resolve("notes.md", base: "/tmp/docs")
                == .file(path: "/tmp/docs/notes.md"))
        #expect(MarkdownLinkTarget.resolve("../other/notes.md", base: "/tmp/docs")
                == .file(path: "/tmp/other/notes.md"))
    }

    @Test("Absolute and tilde paths resolve without a base")
    func absolute() {
        #expect(MarkdownLinkTarget.resolve("/etc/hosts", base: nil) == .file(path: "/etc/hosts"))
        let home = NSHomeDirectory()
        #expect(MarkdownLinkTarget.resolve("~/x.md", base: nil) == .file(path: home + "/x.md"))
    }

    @Test("Anchors are stripped before resolving")
    func anchors() {
        #expect(MarkdownLinkTarget.resolve("notes.md#section", base: "/tmp")
                == .file(path: "/tmp/notes.md"))
    }

    @Test("A relative link with no base is left unresolved rather than guessed")
    func noBase() {
        #expect(MarkdownLinkTarget.resolve("notes.md", base: nil) == .unresolved("notes.md"))
    }
}
