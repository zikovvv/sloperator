import Testing
import Foundation
@testable import Orchestrator

@Suite("Subprocess lifecycle", .serialized)
struct ProcessTests {
    /// Stop must take the agent's children with it: agents routinely start dev servers and
    /// test runners, and leaving them alive keeps ports bound and CPU burning.
    @Test("terminate() kills the whole process tree, not just the CLI")
    func terminateKillsDescendants() async throws {
        let marker = FileManager.default.temporaryDirectory
            .appendingPathComponent("orch-grandchild-\(UUID().uuidString).pid")
        let runner = ProcessRunner()
        try runner.start(
            executable: "/bin/sh",
            arguments: ["-c", "sleep 120 & echo $! > \(marker.path); sleep 120"],
            currentDirectory: NSTemporaryDirectory(),
            onLine: { _ in },
            onExit: { _, _ in })

        // Wait for the grandchild to record its pid.
        var grandchild: Int32 = 0
        for _ in 0..<40 {
            if let text = try? String(contentsOf: marker, encoding: .utf8),
               let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 {
                grandchild = pid
                break
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(grandchild > 0, "grandchild never started")
        #expect(kill(grandchild, 0) == 0, "grandchild should be alive before terminate")

        runner.terminate()
        // SIGINT, then SIGTERM at +3s, then SIGKILL at +5s.
        try await Task.sleep(nanoseconds: 7_000_000_000)

        #expect(kill(grandchild, 0) != 0, "grandchild outlived terminate()")
        try? FileManager.default.removeItem(at: marker)
    }

    @Test("A grandchild holding stdout does not stop the turn from ending")
    func exitIsNotBlockedByGrandchild() async throws {
        let finished = Locked(false)
        let runner = ProcessRunner()
        try runner.start(
            executable: "/bin/sh",
            arguments: ["-c", "sleep 60 & echo hello; exit 0"],
            currentDirectory: NSTemporaryDirectory(),
            onLine: { _ in },
            onExit: { _, _ in finished.set(true) })

        for _ in 0..<80 where !finished.get() {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(finished.get(), "onExit never fired — the pipe read blocked on the grandchild")
        runner.terminate()
    }
}

/// Minimal box so the callbacks (which land on the main queue) can be observed from a test.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()
    init(_ value: Value) { self.value = value }
    func get() -> Value { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ newValue: Value) { lock.lock(); value = newValue; lock.unlock() }
}
