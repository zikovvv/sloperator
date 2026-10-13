import Foundation

/// Runs a subprocess, streaming stdout line-by-line to a callback. Not an actor: callbacks
/// hop to the main queue so UI code can consume them directly.
final class ProcessRunner {
    private let process = Process()
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private var stdoutBuffer = Data()
    private var stderrData = Data()
    private let queue = DispatchQueue(label: "orchestrator.process")
    private static let maxStderrBytes = 64 * 1024
    private var hasFinished = false

    private(set) var isRunning = false

    /// PATH for spawned CLIs — GUI apps don't inherit shell PATH, so build one.
    static func defaultEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extras = [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/miniconda3/bin",
            "\(home)/.bun/bin",
            "\(home)/.nvm/current/bin",
        ]
        let base = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = (extras + [base]).joined(separator: ":")
        // Nested-session markers confuse the claude CLI when this app itself was launched from one.
        env.removeValue(forKey: "CLAUDECODE")
        env.removeValue(forKey: "CLAUDE_CODE_SSE_PORT")
        env.removeValue(forKey: "CLAUDE_CODE_ENTRYPOINT")
        return env
    }

    static func findExecutable(_ name: String) -> String? {
        let env = defaultEnvironment()
        for dir in (env["PATH"] ?? "").split(separator: ":") {
            let candidate = String(dir) + "/" + name
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    func start(
        executable: String,
        arguments: [String],
        currentDirectory: String,
        onLine: @escaping (String) -> Void,
        onExit: @escaping (Int32, String) -> Void
    ) throws {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: currentDirectory)
        process.environment = Self.defaultEnvironment()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.standardInput = FileHandle.nullDevice
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            self.queue.async {
                if data.isEmpty { return }
                self.stdoutBuffer.append(data)
                while let nl = self.stdoutBuffer.firstIndex(of: 0x0A) {
                    let lineData = self.stdoutBuffer.subdata(in: self.stdoutBuffer.startIndex..<nl)
                    self.stdoutBuffer.removeSubrange(self.stdoutBuffer.startIndex...nl)
                    if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                        DispatchQueue.main.async { onLine(line) }
                    }
                }
            }
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            self.queue.async {
                self.stderrData.append(data)
                // Chatty agents (MCP warnings etc.) can emit megabytes; only the tail is ever
                // shown, so cap the buffer instead of growing it for the life of the turn.
                if self.stderrData.count > Self.maxStderrBytes {
                    self.stderrData.removeFirst(self.stderrData.count - Self.maxStderrBytes)
                }
            }
        }
        process.terminationHandler = { [weak self] proc in
            ProcessJanitor.shared.unregister(pid: proc.processIdentifier)
            guard let self else { return }
            // Never readToEnd() here: an agent-spawned grandchild (a dev server, a `cmd &`)
            // inherits the pipe's write end, so the read would block until *it* exits and the
            // session would hang forever. The readability handlers have already delivered
            // everything; give them a beat to land, then flush what we have.
            self.queue.asyncAfter(deadline: .now() + 0.25) {
                self.finish(status: proc.terminationStatus, onLine: onLine, onExit: onExit)
            }
        }
        try process.run()
        ProcessJanitor.shared.register(process)
        isRunning = true
    }

    /// Runs exactly once per process, on `queue`.
    private func finish(
        status: Int32,
        onLine: @escaping (String) -> Void,
        onExit: @escaping (Int32, String) -> Void
    ) {
        guard !hasFinished else { return }
        hasFinished = true
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
        for chunk in stdoutBuffer.split(separator: 0x0A) {
            if let line = String(data: chunk, encoding: .utf8), !line.isEmpty {
                DispatchQueue.main.async { onLine(line) }
            }
        }
        stdoutBuffer.removeAll()
        let err = String(data: stderrData, encoding: .utf8) ?? ""
        DispatchQueue.main.async {
            self.isRunning = false
            onExit(status, err)
        }
    }

    /// Stops the agent AND anything it started. Signalling only the CLI leaves dev servers and
    /// test runners alive with ports bound.
    ///
    /// Two details this has to get right: the tree is snapshotted *before* signalling, because
    /// once the parent dies its children reparent to launchd and become unfindable; and the
    /// escalation is never gated on the parent still running, because a backgrounded child
    /// ignores SIGINT (POSIX, non-interactive shell) and outliving the parent is precisely the
    /// case that leaks.
    func terminate() {
        guard isRunning else { return }
        let tree = ProcessJanitor.processTree(process.processIdentifier)
        ProcessJanitor.signal(tree, SIGINT)   // lets the CLI exit cleanly
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            ProcessJanitor.signal(tree, SIGTERM)
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                ProcessJanitor.signal(tree, SIGKILL)
            }
        }
    }
}

/// Synchronous helper for short commands (git etc.).
enum Shell {
    struct Result {
        let status: Int32
        let stdout: String
        let stderr: String
        var ok: Bool { status == 0 }
    }

    @discardableResult
    static func run(_ executable: String, _ arguments: [String], cwd: String? = nil) -> Result {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        process.environment = ProcessRunner.defaultEnvironment()
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return Result(status: -1, stdout: "", stderr: "\(error)")
        }
        // Both pipes must be drained concurrently: reading stdout to EOF first lets a child
        // that fills the stderr pipe buffer block forever (git/gh can be very chatty).
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        for (pipe, sink) in [(out, { outData = $0 }), (err, { errData = $0 })]
            as [(Pipe, (Data) -> Void)] {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                sink(pipe.fileHandleForReading.readDataToEndOfFile())
                group.leave()
            }
        }
        group.wait()
        process.waitUntilExit()
        // Lossy on purpose: one latin-1 byte anywhere in a diff would otherwise turn the whole
        // output into "" and the review panel would claim there are no changes.
        return Result(
            status: process.terminationStatus,
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData, as: UTF8.self)
        )
    }

    @discardableResult
    static func git(_ arguments: [String], repo: String) -> Result {
        run("/usr/bin/git", ["-C", repo] + arguments)
    }
}
