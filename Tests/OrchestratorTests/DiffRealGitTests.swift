import Testing
import Foundation
@testable import Orchestrator

/// Fixtures produced by real `git diff`, not hand-written literals: the hand-written kind
/// never has a trailing newline, which is exactly the shape real output always has.
@Suite("Diff parsing against real git output", .serialized)
struct DiffRealGitTests {
    private func makeRepo() throws -> String {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("orch-diff-\(UUID().uuidString)")
        let repo = root.appendingPathComponent("repo").path
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        Shell.run("/usr/bin/git", ["init", "-q", "-b", "main"], cwd: repo)
        Shell.git(["config", "user.email", "test@example.com"], repo: repo)
        Shell.git(["config", "user.name", "Test"], repo: repo)
        return repo
    }

    private func cleanup(_ repo: String) {
        try? FileManager.default.removeItem(atPath: (repo as NSString).deletingLastPathComponent)
    }

    private func commit(_ repo: String, _ message: String) {
        Shell.git(["add", "-A"], repo: repo)
        Shell.git(["commit", "-qm", message], repo: repo)
    }

    @Test("Real output does not gain a phantom trailing context line")
    func noPhantomTrailingLine() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        try "one\ntwo\nthree\n".write(toFile: repo + "/a.txt", atomically: true, encoding: .utf8)
        commit(repo, "init")
        try "one\nCHANGED\nthree\n".write(toFile: repo + "/a.txt", atomically: true, encoding: .utf8)

        let files = DiffParser.parse(GitService.diff(repo, scope: .uncommitted, base: nil))
        let file = try #require(files.first { $0.path.hasSuffix("a.txt") })
        let lines = file.hunks.flatMap(\.lines).filter { $0.kind != .hunkHeader }
        // one / -two / +CHANGED / three — nothing after it.
        #expect(lines.count == 4)
        #expect(lines.last?.text == "three")
        #expect(file.added == 1)
        #expect(file.removed == 1)
    }

    /// A deleted SQL/Lua/Haskell comment starts with "-- ", which looks like a "--- " file
    /// header only if the parser checks headers before hunk content.
    @Test("A deleted line starting with '-- ' is a deletion, not a header")
    func deletedDashDashLine() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        try "line1\n-- sql comment\nline3\n".write(
            toFile: repo + "/a.sql", atomically: true, encoding: .utf8)
        commit(repo, "init")
        try "line1\nline3\n".write(toFile: repo + "/a.sql", atomically: true, encoding: .utf8)

        let files = DiffParser.parse(GitService.diff(repo, scope: .uncommitted, base: nil))
        let file = try #require(files.first { $0.path.hasSuffix("a.sql") })
        #expect(file.removed == 1)
        let deletions = file.hunks.flatMap(\.lines).filter { $0.kind == .deletion }
        #expect(deletions.map(\.text) == ["-- sql comment"])
        // Gutters after the deletion must stay aligned with the real file.
        let context = file.hunks.flatMap(\.lines).filter { $0.kind == .context }
        #expect(context.last?.oldLine == 3)
    }

    @Test("An added line starting with '++ ' is an addition, not a header")
    func addedPlusPlusLine() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        try "a\n".write(toFile: repo + "/x.txt", atomically: true, encoding: .utf8)
        commit(repo, "init")
        try "a\n++ not a header\n".write(toFile: repo + "/x.txt", atomically: true, encoding: .utf8)

        let file = try #require(
            DiffParser.parse(GitService.diff(repo, scope: .uncommitted, base: nil))
                .first { $0.path.hasSuffix("x.txt") })
        #expect(file.added == 1)
        #expect(file.hunks.flatMap(\.lines).contains { $0.text == "++ not a header" })
    }

    @Test("A directory whose name ends in ' b' does not corrupt the file path")
    func pathContainingSpaceB() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        let directory = repo + "/dir b"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        try "one\n".write(toFile: directory + "/f.txt", atomically: true, encoding: .utf8)
        commit(repo, "init")
        try "two\n".write(toFile: directory + "/f.txt", atomically: true, encoding: .utf8)

        let files = DiffParser.parse(GitService.diff(repo, scope: .uncommitted, base: nil))
        #expect(files.count == 1)
        #expect(files[0].path == "dir b/f.txt")
    }

    @Test("CRLF files do not carry a stray carriage return into the viewer")
    func crlfLines() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        try "alpha\r\nbeta\r\n".write(toFile: repo + "/c.txt", atomically: true, encoding: .utf8)
        commit(repo, "init")
        try "alpha\r\nGAMMA\r\n".write(toFile: repo + "/c.txt", atomically: true, encoding: .utf8)

        let file = try #require(
            DiffParser.parse(GitService.diff(repo, scope: .uncommitted, base: nil))
                .first { $0.path.hasSuffix("c.txt") })
        for line in file.hunks.flatMap(\.lines) {
            #expect(!line.text.contains("\r"), "line kept a carriage return: \(line.text.debugDescription)")
        }
    }

    @Test("A file that is not valid UTF-8 does not blank the whole diff")
    func nonUTF8DoesNotBlankEverything() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        try "readable\n".write(toFile: repo + "/good.txt", atomically: true, encoding: .utf8)
        // Latin-1 bytes git still treats as text.
        var bytes = Data("header\n".utf8)
        bytes.append(contentsOf: [0xE9, 0xE8, 0xFF, 0x0A])
        try bytes.write(to: URL(fileURLWithPath: repo + "/latin.txt"))
        commit(repo, "init")
        try "readable and changed\n".write(
            toFile: repo + "/good.txt", atomically: true, encoding: .utf8)
        var changed = Data("header changed\n".utf8)
        changed.append(contentsOf: [0xE9, 0xE8, 0xFF, 0x0A])
        try changed.write(to: URL(fileURLWithPath: repo + "/latin.txt"))

        let files = DiffParser.parse(GitService.diff(repo, scope: .uncommitted, base: nil))
        // The readable file must still be reviewable even though a sibling has odd bytes.
        #expect(files.contains { $0.path.hasSuffix("good.txt") },
                "one non-UTF-8 file blanked the entire diff")
    }
}
