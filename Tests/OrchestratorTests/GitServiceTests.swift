import Testing
import Foundation
@testable import Orchestrator

/// These drive real git in a temporary repo. They pin the paths that can destroy a user's work.
@Suite("Git worktree and stash safety", .serialized)
struct GitServiceTests {
    /// A throwaway repo with one commit. Caller deletes it.
    private func makeRepo() throws -> String {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("orch-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let repo = root.appendingPathComponent("repo").path
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        Shell.run("/usr/bin/git", ["init", "-q", "-b", "main"], cwd: repo)
        Shell.git(["config", "user.email", "test@example.com"], repo: repo)
        Shell.git(["config", "user.name", "Test"], repo: repo)
        try "base\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
        Shell.git(["add", "-A"], repo: repo)
        Shell.git(["commit", "-qm", "init"], repo: repo)
        return repo
    }

    private func cleanup(_ repo: String) {
        try? FileManager.default.removeItem(
            atPath: (repo as NSString).deletingLastPathComponent)
    }

    @Test("moveCurrentWork never applies somebody else's stash")
    func stashMoveIgnoresForeignStashes() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }

        // A stash that belongs to the user and must survive untouched.
        try "DECOY\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
        Shell.git(["stash", "push", "-q", "-m", "someone-elses-stash"], repo: repo)

        // The work we actually want moved, tracked and untracked.
        try "MY WORK\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
        try "NEW\n".write(toFile: repo + "/extra.txt", atomically: true, encoding: .utf8)

        let worktree = (repo as NSString).deletingLastPathComponent + "/wt"
        Shell.git(["worktree", "add", "-q", worktree, "-b", "feature"], repo: repo)

        let error = GitService.moveCurrentWork(from: repo, to: worktree)
        #expect(error == nil)
        #expect(try String(contentsOfFile: worktree + "/file.txt", encoding: .utf8) == "MY WORK\n")
        #expect(FileManager.default.fileExists(atPath: worktree + "/extra.txt"))

        // The decoy is still on the stack, unapplied.
        let stashes = Shell.git(["stash", "list"], repo: repo).stdout
        #expect(stashes.contains("someone-elses-stash"))
        #expect(!stashes.contains("orchestrator-move"))
    }

    @Test("moveCurrentWork says so honestly when there is nothing to move")
    func stashMoveWithCleanTree() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        let worktree = (repo as NSString).deletingLastPathComponent + "/wt"
        Shell.git(["worktree", "add", "-q", worktree, "-b", "feature"], repo: repo)
        #expect(GitService.moveCurrentWork(from: repo, to: worktree) == nil)
    }

    @Test("Deleting a worktree keeps its branch and commits")
    func deleteKeepsBranch() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        let worktree = (repo as NSString).deletingLastPathComponent + "/wt"
        Shell.git(["worktree", "add", "-q", worktree, "-b", "keepme"], repo: repo)
        try "dirty\n".write(toFile: worktree + "/dirty.txt", atomically: true, encoding: .utf8)

        GitService.removeWorktree(projectPath: repo, worktreePath: worktree)
        if FileManager.default.fileExists(atPath: worktree) {
            try? FileManager.default.removeItem(atPath: worktree)
            GitService.pruneWorktrees(repo)
        }

        #expect(!FileManager.default.fileExists(atPath: worktree))
        #expect(GitService.branches(repo, includeRemote: false).contains("keepme"))
        #expect(!Shell.git(["worktree", "list"], repo: repo).stdout.contains("/wt"))
    }

    @Test("A branch already checked out elsewhere is reported as in use")
    func branchesInUse() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        let worktree = (repo as NSString).deletingLastPathComponent + "/wt"
        Shell.git(["worktree", "add", "-q", worktree, "-b", "taken"], repo: repo)
        let used = GitService.branchesInUse(repo)
        #expect(used.contains("taken"))
        #expect(used.contains("main"))
    }

    @Test("A slashed branch checked out elsewhere is still reported as in use")
    func slashedBranchInUse() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        let worktree = (repo as NSString).deletingLastPathComponent + "/wt"
        Shell.git(["worktree", "add", "-q", worktree, "-b", "claude/bash-tool-exit-code-2"],
                  repo: repo)
        let used = GitService.branchesInUse(repo)
        // Taking the last path component would report "bash-tool-exit-code-2" and the branch
        // would wrongly appear available.
        #expect(used.contains("claude/bash-tool-exit-code-2"))
    }

    @Test("A remote ref keeps everything after the remote name")
    func remoteRefLocalName() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        Shell.git(["remote", "add", "origin", "https://example.com/x.git"], repo: repo)
        #expect(GitService.localName(forRemoteRef: "origin/team/login", repo: repo) == "team/login")
        #expect(GitService.localName(forRemoteRef: "origin/login", repo: repo) == "login")
        // Unknown remote: fall back to dropping the first component rather than mangling it.
        #expect(GitService.localName(forRemoteRef: "upstream/a/b", repo: repo) == "a/b")
    }

    @Test("Branch listing puts the current branch first and lists one entry per branch")
    func branchListing() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        Shell.git(["branch", "second"], repo: repo)
        Shell.git(["branch", "third"], repo: repo)
        let branches = GitService.branches(repo, includeRemote: false)
        #expect(branches.first == "main")
        #expect(Set(branches) == ["main", "second", "third"])
    }

    @Test("Diff scopes see uncommitted, staged and committed work separately")
    func diffScopes() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }

        try "staged change\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
        Shell.git(["add", "file.txt"], repo: repo)
        try "untracked\n".write(toFile: repo + "/new.txt", atomically: true, encoding: .utf8)

        let staged = DiffParser.parse(GitService.diff(repo, scope: .staged, base: nil))
        #expect(staged.contains { $0.path == "file.txt" })
        #expect(!staged.contains { $0.path == "new.txt" })

        // Uncommitted includes staged work and synthesised diffs for untracked files.
        let uncommitted = DiffParser.parse(GitService.diff(repo, scope: .uncommitted, base: nil))
        #expect(uncommitted.contains { $0.path.hasSuffix("file.txt") })
        #expect(uncommitted.contains { $0.path.hasSuffix("new.txt") })
    }

    @Test("Commit log is empty when the branch has nothing beyond its base")
    func commitsAgainstBase() throws {
        let repo = try makeRepo()
        defer { cleanup(repo) }
        #expect(GitService.commits(repo, base: "main").isEmpty)

        Shell.git(["checkout", "-q", "-b", "work"], repo: repo)
        try "more\n".write(toFile: repo + "/file.txt", atomically: true, encoding: .utf8)
        Shell.git(["commit", "-aqm", "a change"], repo: repo)

        let commits = GitService.commits(repo, base: "main")
        #expect(commits.count == 1)
        #expect(commits.first?.subject == "a change")
    }
}
