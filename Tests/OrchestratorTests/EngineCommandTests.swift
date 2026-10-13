import Testing
import Foundation
@testable import Orchestrator

/// The CLIs are the product's whole surface — these pin how we invoke them.
@Suite("Engine command construction")
struct EngineCommandTests {
    private func session(engine: EngineKind, access: AccessMode = .edits) -> Session {
        var session = Session(worktreeID: UUID(), title: "t")
        session.engine = engine
        session.accessMode = access
        return session
    }

    /// `codex exec resume <id> --sandbox ...` is rejected by the CLI:
    /// "tip: to pass '--sandbox' as a value, use '-- --sandbox'". Options must precede `resume`.
    @Test("Codex resume puts every option before the resume subcommand")
    func codexResumeOptionOrder() throws {
        var resumed = session(engine: .codex)
        resumed.model = "gpt-5.5"
        resumed.effort = "high"
        let command = try CodexEngine.command(
            session: resumed, prompt: "hello", resumeThreadID: "thread-123")
        let args = command.arguments

        let resumeIndex = try #require(args.firstIndex(of: "resume"))
        for option in ["--sandbox", "--json", "--skip-git-repo-check", "--model", "-c"] {
            if let index = args.firstIndex(of: option) {
                #expect(index < resumeIndex, "\(option) must come before `resume`")
            }
        }
        // The thread id follows `resume`, and the prompt is last.
        #expect(args[resumeIndex + 1] == "thread-123")
        #expect(args.last == "hello")
    }

    @Test("Full access still bypasses the sandbox when resuming")
    func codexResumeFullAccess() throws {
        let command = try CodexEngine.command(
            session: session(engine: .codex, access: .full),
            prompt: "go", resumeThreadID: "abc")
        #expect(command.arguments.contains("--dangerously-bypass-approvals-and-sandbox"))
        #expect(!command.arguments.contains("--sandbox"))
    }

    @Test("A fresh Codex turn carries the CLAUDE.md preamble; a resumed one does not")
    func codexPreambleOnlyWhenFresh() throws {
        let fresh = try CodexEngine.command(
            session: session(engine: .codex), prompt: "hi", resumeThreadID: nil)
        #expect(fresh.arguments.last?.contains("~/.claude/CLAUDE.md") == true)
        #expect(fresh.arguments.contains { $0.contains("project_doc_fallback_filenames") })

        let resumed = try CodexEngine.command(
            session: session(engine: .codex), prompt: "hi", resumeThreadID: "abc")
        #expect(resumed.arguments.last == "hi")
    }

    @Test("Claude resumes by id and never also passes --session-id")
    func claudeResume() throws {
        var resumed = session(engine: .claude)
        resumed.claudeSessionID = "sess-1"
        let command = try ClaudeEngine.command(
            session: resumed, prompt: "hi", resumeID: "sess-1", newSessionID: "new-1")
        #expect(command.arguments.contains("--resume"))
        #expect(!command.arguments.contains("--session-id"))

        let fresh = try ClaudeEngine.command(
            session: session(engine: .claude), prompt: "hi", resumeID: nil, newSessionID: "new-1")
        #expect(fresh.arguments.contains("--session-id"))
        #expect(!fresh.arguments.contains("--resume"))
    }

    @Test("Access modes map to each CLI's own flags")
    func accessModes() throws {
        let claudeSafe = try ClaudeEngine.command(
            session: session(engine: .claude, access: .safe), prompt: "x",
            resumeID: nil, newSessionID: "n")
        #expect(claudeSafe.arguments.contains("default"))

        let claudeFull = try ClaudeEngine.command(
            session: session(engine: .claude, access: .full), prompt: "x",
            resumeID: nil, newSessionID: "n")
        #expect(claudeFull.arguments.contains("--dangerously-skip-permissions"))

        let codexSafe = try CodexEngine.command(
            session: session(engine: .codex, access: .safe), prompt: "x", resumeThreadID: nil)
        #expect(codexSafe.arguments.contains("read-only"))
    }
}
