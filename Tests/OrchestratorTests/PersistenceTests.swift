import Testing
import Foundation
@testable import Orchestrator

/// Regression pins for the state-wipe bug: Swift's synthesized decoder requires a key for
/// every property, so adding a field made every existing state.json undecodable and the app
/// started empty.
@Suite("Tolerant decoding of saved state")
struct PersistenceTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test("A worktree saved before isPinned/isArchived existed still loads")
    func worktreeFromOlderVersion() throws {
        let json = """
        {"id":"6E8C9A1E-0000-4000-8000-000000000001",
         "projectID":"6E8C9A1E-0000-4000-8000-000000000002",
         "name":"wt-1","path":"/tmp/wt-1","isMain":false,"isExpanded":true,
         "createdAt":783000000.0}
        """
        let worktree = try decode(Worktree.self, json)
        #expect(worktree.name == "wt-1")
        #expect(worktree.isPinned == false)
        #expect(worktree.isArchived == false)
    }

    @Test("A session saved before steering/model/effort existed still loads")
    func sessionFromOlderVersion() throws {
        let json = """
        {"id":"6E8C9A1E-0000-4000-8000-000000000003",
         "worktreeID":"6E8C9A1E-0000-4000-8000-000000000001",
         "title":"smoke test","engine":"codex","accessMode":"edits",
         "createdAt":783000000.0,"lastActivityAt":783000000.0,"isArchived":false,
         "totalCostUSD":0.057,"inputTokens":10,"cachedInputTokens":5,"outputTokens":2}
        """
        let session = try decode(Session.self, json)
        #expect(session.title == "smoke test")
        #expect(session.engine == .codex)
        #expect(session.steeringMode == .steer)   // defaulted, not required
        #expect(session.model == nil)
        #expect(session.isPinned == false)
        #expect(session.totalCostUSD == 0.057)
    }

    @Test("A project without isGit still loads")
    func projectFromOlderVersion() throws {
        let project = try decode(Project.self, #"{"name":"demoproj","path":"/tmp/demoproj"}"#)
        #expect(project.path == "/tmp/demoproj")
        #expect(project.isGit == false)
        #expect(project.isExpanded == true)
    }

    @Test("Settings tolerate keys added later")
    func settingsFromOlderVersion() throws {
        let settings = try decode(AppSettings.self, #"{"codexOutputPerMTok":12.5}"#)
        #expect(settings.codexOutputPerMTok == 12.5)
        #expect(settings.codexInputPerMTok == 1.25)
        #expect(settings.worktreeRootOverride == nil)
    }

    @Test("A key that no longer exists is ignored, not fatal")
    func removedKeyIsIgnored() throws {
        let settings = try decode(
            AppSettings.self, #"{"allowWorktreeDeletion":true,"codexInputPerMTok":2.0}"#)
        #expect(settings.codexInputPerMTok == 2.0)
    }

    @Test("Round-tripping keeps every field")
    func roundTrip() throws {
        var session = Session(worktreeID: UUID(), title: "round trip")
        session.isPinned = true
        session.model = "claude-opus-5"
        session.effort = "high"
        session.outputTokens = 42
        let data = try JSONEncoder().encode(session)
        let decoded = try JSONDecoder().decode(Session.self, from: data)
        #expect(decoded.isPinned)
        #expect(decoded.model == "claude-opus-5")
        #expect(decoded.effort == "high")
        #expect(decoded.outputTokens == 42)
    }
}

@Suite("Engine failure classification")
struct EngineFailureTests {
    @Test("Auth failures are recognised from the CLI's own wording")
    func authFailures() {
        #expect(AppStore.isAuthFailure("API Error: 401 OAuth access token has expired."))
        #expect(AppStore.isAuthFailure("Failed to authenticate"))
        #expect(AppStore.isAuthFailure("unauthorized"))
        #expect(!AppStore.isAuthFailure("No conversation found with session ID: abc"))
        #expect(!AppStore.isAuthFailure("compilation failed"))
    }
}
