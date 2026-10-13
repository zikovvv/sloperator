import Foundation

struct ChangedFile: Identifiable, Hashable {
    var path: String
    var status: String // A, M, D, R, ??
    var id: String { path }

    var statusColorName: String {
        switch status {
        case "A", "??": return "green"
        case "D": return "red"
        default: return "yellow"
        }
    }
}

enum GitService {
    /// git init + initial commit so worktrees can be created immediately.
    static func initRepo(_ path: String) -> Bool {
        guard Shell.run("/usr/bin/git", ["init"], cwd: path).ok else { return false }
        Shell.git(["add", "-A"], repo: path)
        let commit = Shell.git(["commit", "-m", "Initial commit"], repo: path)
        if !commit.ok {
            // Empty dir or nothing staged — create an empty root commit.
            Shell.git(["commit", "--allow-empty", "-m", "Initial commit"], repo: path)
        }
        return isGitRepo(path)
    }

    /// Stash uncommitted+untracked work in `projectPath` and re-apply it inside `worktreePath`.
    /// The stash object store is shared across worktrees, which makes this possible.
    ///
    /// Never uses bare `stash pop`: the stash stack is repo-global, so another worktree (or the
    /// user) pushing a stash in between would make `pop` apply and drop the wrong one. The exact
    /// commit created by our push is resolved and applied by sha, then dropped by identity.
    static func moveCurrentWork(from projectPath: String, to worktreePath: String) -> String? {
        let status = Shell.git(["status", "--porcelain"], repo: projectPath)
        guard !status.stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil // nothing to move
        }
        let label = "orchestrator-move-\(UUID().uuidString)"
        let push = Shell.git(
            ["stash", "push", "--include-untracked", "-m", label], repo: projectPath)
        guard push.ok else { return "git stash failed: \(push.stderr)" }

        guard let sha = stashSha(repo: projectPath, label: label) else {
            // e.g. only a dirty submodule pointer: `stash push` exits 0 without creating an entry.
            return push.stdout.contains("No local changes to save")
                ? "Nothing could be moved: git found no local changes to stash (a dirty submodule "
                    + "alone does not stash). Your work is untouched in the main checkout."
                : "Stashed your work but could not identify the stash entry; it is safe in `git stash list`."
        }
        let apply = Shell.git(["stash", "apply", sha], repo: worktreePath)
        guard apply.ok else {
            return "Could not apply your work in the new worktree; it is preserved in "
                + "`git stash list` (\(label)): \(apply.stderr)"
        }
        // Only drop once the content is safely applied, and only this exact entry.
        if let ref = stashRef(repo: projectPath, label: label) {
            Shell.git(["stash", "drop", ref], repo: projectPath)
        }
        return nil
    }

    private static func stashEntry(repo: String, label: String) -> (ref: String, sha: String)? {
        let list = Shell.git(["stash", "list", "--format=%gd %H %gs"], repo: repo)
        for line in list.stdout.split(separator: "\n") where line.contains(label) {
            let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
            if parts.count >= 2 { return (parts[0], parts[1]) }
        }
        return nil
    }

    private static func stashSha(repo: String, label: String) -> String? {
        stashEntry(repo: repo, label: label)?.sha
    }

    private static func stashRef(repo: String, label: String) -> String? {
        stashEntry(repo: repo, label: label)?.ref
    }

    static func isGitRepo(_ path: String) -> Bool {
        Shell.git(["rev-parse", "--is-inside-work-tree"], repo: path).stdout
            .trimmingCharacters(in: .whitespacesAndNewlines) == "true"
    }

    static func currentBranch(_ path: String) -> String? {
        let r = Shell.git(["rev-parse", "--abbrev-ref", "HEAD"], repo: path)
        guard r.ok else { return nil }
        let b = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return b.isEmpty ? nil : b
    }

    static func defaultBranch(_ path: String) -> String {
        let r = Shell.git(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], repo: path)
        if r.ok {
            let name = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if let slash = name.firstIndex(of: "/") {
                return String(name[name.index(after: slash)...])
            }
        }
        for candidate in ["main", "master"] {
            if Shell.git(["rev-parse", "--verify", "refs/heads/\(candidate)"], repo: path).ok {
                return candidate
            }
        }
        return currentBranch(path) ?? "main"
    }

    /// Local branches (current first), then remote-only ones. Two git calls total — never one
    /// per branch: this repo has 1100+ refs and a subprocess each would take ~30 seconds.
    static func branches(_ path: String, includeRemote: Bool = true) -> [String] {
        func refs(_ pattern: String) -> [String] {
            let r = Shell.git(
                ["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", pattern],
                repo: path)
            guard r.ok else { return [] }
            return r.stdout.split(separator: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && !$0.hasSuffix("/HEAD") }
        }

        var locals = refs("refs/heads")
        if let current = currentBranch(path), let index = locals.firstIndex(of: current) {
            locals.remove(at: index)
            locals.insert(current, at: 0)
        }
        guard includeRemote else { return locals }

        // Hide a remote ref when the same branch already exists locally.
        let localNames = Set(locals)
        let remotes = refs("refs/remotes").filter {
            !localNames.contains(($0 as NSString).lastPathComponent)
        }
        return locals + remotes
    }

    /// "origin/team/login" -> "team/login". Falls back to dropping the first component when
    /// the remote is not one git knows about.
    static func localName(forRemoteRef ref: String, repo: String) -> String {
        let remotes = Shell.run("/usr/bin/git", ["-C", repo, "remote"]).stdout
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        for remote in remotes where ref.hasPrefix(remote + "/") {
            return String(ref.dropFirst(remote.count + 1))
        }
        guard let slash = ref.firstIndex(of: "/") else { return ref }
        return String(ref[ref.index(after: slash)...])
    }

    static func isLocalBranch(_ name: String, repo: String) -> Bool {
        Shell.git(["show-ref", "--verify", "--quiet", "refs/heads/\(name)"], repo: repo).ok
    }

    /// Branches that already have a worktree checked out — git refuses to check them out twice.
    static func branchesInUse(_ path: String) -> Set<String> {
        let r = Shell.git(["worktree", "list", "--porcelain"], repo: path)
        var used: Set<String> = []
        for line in r.stdout.split(separator: "\n") where line.hasPrefix("branch ") {
            let ref = line.dropFirst("branch ".count).trimmingCharacters(in: .whitespaces)
            // "refs/heads/feature/login" -> "feature/login": strip only the refs prefix, never
            // take the last path component, or every slashed branch looks unused.
            used.insert(ref.hasPrefix("refs/heads/")
                ? String(ref.dropFirst("refs/heads/".count)) : ref)
        }
        return used
    }

    static func worktreesRoot(projectName: String) -> String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".orchestrator/worktrees")
            .appendingPathComponent(projectName).path
    }

    /// Creates a worktree. `branch` nil means auto-name from `slug`; `base` nil means current
    /// HEAD. Set `checkoutExisting` to attach to a branch that already exists instead of
    /// creating one. Returns (worktreePath, branchName).
    static func createWorktree(
        projectPath: String, projectName: String, slug: String, rootOverride: String? = nil,
        branch requestedBranch: String? = nil, base: String? = nil,
        checkoutExisting: Bool = false
    ) throws -> (String, String) {
        if checkoutExisting, let existing = requestedBranch {
            let root = rootOverride.map { ($0 as NSString).expandingTildeInPath + "/" + projectName }
                ?? worktreesRoot(projectName: projectName)
            try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
            var path = root + "/" + slugify(existing)
            var attempt = 1
            while FileManager.default.fileExists(atPath: path) {
                attempt += 1
                path = root + "/" + slugify(existing) + "-\(attempt)"
            }
            var args = ["worktree", "add", path, existing]
            var resulting = existing
            if !isLocalBranch(existing, repo: projectPath) {
                // A remote-tracking ref: create the local branch that follows it. Only the
                // remote name is stripped — "origin/team/login" becomes "team/login", not "login".
                let local = localName(forRemoteRef: existing, repo: projectPath)
                resulting = local
                args = ["worktree", "add", "--track", "-b", local, path, existing]
            }
            let r = Shell.git(args, repo: projectPath)
            guard r.ok else {
                throw NSError(domain: "git", code: Int(r.status), userInfo: [
                    NSLocalizedDescriptionKey: "git worktree add failed: \(r.stderr)"
                ])
            }
            return (path, resulting)
        }
        return try createNewBranchWorktree(
            projectPath: projectPath, projectName: projectName, slug: slug,
            rootOverride: rootOverride, requestedBranch: requestedBranch, base: base)
    }

    private static func slugify(_ value: String) -> String {
        value.replacingOccurrences(of: "/", with: "-")
    }

    private static func createNewBranchWorktree(
        projectPath: String, projectName: String, slug: String, rootOverride: String?,
        requestedBranch: String?, base: String?
    ) throws -> (String, String) {
        let root = rootOverride.map { ($0 as NSString).expandingTildeInPath + "/" + projectName }
            ?? worktreesRoot(projectName: projectName)
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        var branch = requestedBranch.map(slugifyBranch) ?? "orch/\(slug)"
        var path = root + "/" + slugify(branch.replacingOccurrences(of: "orch/", with: ""))
        var attempt = 1
        while FileManager.default.fileExists(atPath: path)
            || Shell.git(["rev-parse", "--verify", "refs/heads/\(branch)"], repo: projectPath).ok {
            attempt += 1
            let stem = requestedBranch.map(slugifyBranch) ?? "orch/\(slug)"
            branch = "\(stem)-\(attempt)"
            path = root + "/" + slugify(branch.replacingOccurrences(of: "orch/", with: ""))
        }
        var args = ["worktree", "add", "-b", branch, path]
        if let base, !base.isEmpty { args.append(base) }
        let r = Shell.git(args, repo: projectPath)
        guard r.ok else {
            throw NSError(domain: "git", code: Int(r.status), userInfo: [
                NSLocalizedDescriptionKey: "git worktree add failed: \(r.stderr)"
            ])
        }
        return (path, branch)
    }

    /// Worktree containing the PR's head commit, so a review session reviews the PR and not main.
    static func createPRWorktree(
        projectPath: String, projectName: String, prNumber: Int, baseBranch: String?,
        rootOverride: String? = nil
    ) throws -> (path: String, branch: String) {
        let fetch = Shell.git(
            ["fetch", "origin", "pull/\(prNumber)/head:orch/pr-\(prNumber)", "--force"],
            repo: projectPath)
        guard fetch.ok else {
            throw NSError(domain: "git", code: Int(fetch.status), userInfo: [
                NSLocalizedDescriptionKey: "Could not fetch PR #\(prNumber): \(fetch.stderr)"
            ])
        }
        let root = rootOverride.map { ($0 as NSString).expandingTildeInPath + "/" + projectName }
            ?? worktreesRoot(projectName: projectName)
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        var path = root + "/pr-\(prNumber)"
        var attempt = 1
        while FileManager.default.fileExists(atPath: path) {
            attempt += 1
            path = root + "/pr-\(prNumber)-\(attempt)"
        }
        let add = Shell.git(["worktree", "add", path, "orch/pr-\(prNumber)"], repo: projectPath)
        guard add.ok else {
            throw NSError(domain: "git", code: Int(add.status), userInfo: [
                NSLocalizedDescriptionKey: "git worktree add failed: \(add.stderr)"
            ])
        }
        return (path, "orch/pr-\(prNumber)")
    }

    private static func slugifyBranch(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "-")
    }

    static func removeWorktree(projectPath: String, worktreePath: String) {
        Shell.git(["worktree", "remove", "--force", worktreePath], repo: projectPath)
        Shell.git(["worktree", "prune"], repo: projectPath)
    }

    static func pruneWorktrees(_ projectPath: String) {
        Shell.git(["worktree", "prune"], repo: projectPath)
    }

    static func mergeBase(_ path: String, base: String) -> String? {
        let r = Shell.git(["merge-base", base, "HEAD"], repo: path)
        guard r.ok else { return nil }
        let sha = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return sha.isEmpty ? nil : sha
    }

    /// Changed files: working tree vs merge-base with `base` (falls back to HEAD), plus untracked.
    static func changedFiles(_ path: String, base: String?) -> [ChangedFile] {
        let target = base.flatMap { mergeBase(path, base: $0) } ?? "HEAD"
        var files: [String: ChangedFile] = [:]
        let diff = Shell.git(["diff", "--name-status", target], repo: path)
        for line in diff.stdout.split(separator: "\n") {
            let parts = line.split(separator: "\t", maxSplits: 2)
            guard parts.count >= 2 else { continue }
            let status = String(parts[0].prefix(1))
            let file = String(parts.count == 3 ? parts[2] : parts[1])
            files[file] = ChangedFile(path: file, status: status)
        }
        let untracked = Shell.git(["ls-files", "--others", "--exclude-standard"], repo: path)
        for line in untracked.stdout.split(separator: "\n") {
            let file = String(line)
            files[file] = ChangedFile(path: file, status: "??")
        }
        return files.values.sorted { $0.path < $1.path }
    }

    // MARK: - Scoped diffs

    /// Upstream ref for the checked-out branch, e.g. "origin/feature/x".
    static func upstream(_ path: String) -> String? {
        let r = Shell.git(
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repo: path)
        guard r.ok else { return nil }
        let value = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    /// The git arguments that produce a diff for a scope, minus context/file options.
    private static func diffCommand(_ scope: DiffScope, path: String, base: String?) -> [String] {
        switch scope {
        case .uncommitted:
            return ["diff", "HEAD"]
        case .staged:
            return ["diff", "--cached"]
        case .branch:
            let target = base.flatMap { mergeBase(path, base: $0) } ?? "HEAD"
            return ["diff", target]
        case .remote:
            guard let upstream = upstream(path) else { return ["diff", "HEAD"] }
            return ["diff", upstream]
        case .commit(let sha, _):
            return ["show", "--format=", sha]
        }
    }

    static func diff(
        _ path: String, scope: DiffScope, base: String?, file: String? = nil, context: Int = 3
    ) -> String {
        var args = diffCommand(scope, path: path, base: base)
        args.append("-U\(context)")
        if let file { args += ["--", file] }
        var text = Shell.git(args, repo: path).stdout

        // Untracked files aren't in any diff; synthesize one so new work is reviewable.
        // Each costs a git process, so an un-ignored build directory would otherwise stall
        // every refresh — cap the count and skip anything too big to review by eye.
        if scope == .uncommitted {
            let candidates = untrackedFiles(path).filter { file == nil || file == $0 }
            for untracked in candidates.prefix(maxUntrackedFilesInDiff) {
                let absolute = path + "/" + untracked
                var isDirectory: ObjCBool = false
                // An agent can delete a file between listing and diffing; git then prints a
                // usage error to stderr for a path it cannot access.
                guard FileManager.default.fileExists(atPath: absolute, isDirectory: &isDirectory),
                      !isDirectory.boolValue
                else { continue }
                let size = (try? FileManager.default.attributesOfItem(
                    atPath: absolute)[.size]) as? Int ?? 0
                guard size <= maxUntrackedFileBytes else { continue }
                let synthetic = Shell.git(
                    ["diff", "--no-index", "-U\(context)", "--", "/dev/null", untracked],
                    repo: path)
                text += synthetic.stdout
            }
        }
        return text
    }

    static let maxUntrackedFilesInDiff = 60
    static let maxUntrackedFileBytes = 512 * 1024

    static func untrackedFiles(_ path: String) -> [String] {
        Shell.git(["ls-files", "--others", "--exclude-standard"], repo: path)
            .stdout.split(separator: "\n").map(String.init)
    }

    /// Commits on this branch that aren't on its base, newest first.
    static func commits(_ path: String, base: String?, limit: Int = 100) -> [CommitInfo] {
        var args = ["log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar", "-n", "\(limit)"]
        if let base, let merge = mergeBase(path, base: base) {
            args.append("\(merge)..HEAD")
        }
        let r = Shell.git(args, repo: path)
        guard r.ok else { return [] }
        return r.stdout.split(separator: "\n").compactMap { line in
            let parts = line.components(separatedBy: "\u{1f}")
            guard parts.count >= 5 else { return nil }
            return CommitInfo(
                sha: parts[0], shortSHA: parts[1], subject: parts[2],
                author: parts[3], relativeDate: parts[4])
        }
    }

    /// Per-file added/removed counts for a scope, so the tree can show stats without
    /// parsing every hunk.
    static func stats(_ path: String, scope: DiffScope, base: String?) -> [String: (Int, Int)] {
        var args = diffCommand(scope, path: path, base: base)
        args.append("--numstat")
        var result: [String: (Int, Int)] = [:]
        for line in Shell.git(args, repo: path).stdout.split(separator: "\n") {
            let parts = line.components(separatedBy: "\t")
            guard parts.count >= 3 else { continue }
            result[parts[2]] = (Int(parts[0]) ?? 0, Int(parts[1]) ?? 0)
        }
        return result
    }

    /// A file's full text at a revision, for "expand to whole file" context.
    static func fileContents(_ path: String, revision: String, file: String) -> String? {
        let r = Shell.git(["show", "\(revision):\(file)"], repo: path)
        return r.ok ? r.stdout : nil
    }

    static func diff(_ path: String, base: String?, file: String?) -> String {
        let target = base.flatMap { mergeBase(path, base: $0) } ?? "HEAD"
        var args = ["diff", target]
        if let file {
            // Untracked files aren't in `git diff`; synthesize a diff against /dev/null.
            let tracked = Shell.git(["ls-files", "--error-unmatch", file], repo: path).ok
            if !tracked {
                let r = Shell.git(["diff", "--no-index", "--", "/dev/null", file], repo: path)
                return r.stdout
            }
            args += ["--", file]
        }
        return Shell.git(args, repo: path).stdout
    }

    static func diffStat(_ path: String, base: String?) -> (added: Int, removed: Int) {
        let target = base.flatMap { mergeBase(path, base: $0) } ?? "HEAD"
        let r = Shell.git(["diff", "--numstat", target], repo: path)
        var added = 0, removed = 0
        for line in r.stdout.split(separator: "\n") {
            let parts = line.split(separator: "\t")
            guard parts.count >= 2 else { continue }
            added += Int(parts[0]) ?? 0
            removed += Int(parts[1]) ?? 0
        }
        return (added, removed)
    }
}
