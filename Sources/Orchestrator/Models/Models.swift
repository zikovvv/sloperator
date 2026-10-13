import Foundation

enum EngineKind: String, Codable, CaseIterable, Identifiable {
    case claude
    case codex

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        }
    }
    var symbol: String {
        switch self {
        case .claude: return "asterisk.circle.fill"
        case .codex: return "hexagon.fill"
        }
    }
}

/// Unified access level, mapped to each CLI's own flags.
/// claude: safe -> default, edits -> --permission-mode acceptEdits, full -> --dangerously-skip-permissions
/// codex:  safe -> --sandbox read-only, edits -> --sandbox workspace-write, full -> --dangerously-bypass-approvals-and-sandbox
enum AccessMode: String, Codable, CaseIterable, Identifiable {
    case safe
    case edits
    case full

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .safe: return "Read Only"
        case .edits: return "Auto Edits"
        case .full: return "Full Access"
        }
    }
    var symbol: String {
        switch self {
        case .safe: return "eye"
        case .edits: return "pencil"
        case .full: return "bolt.fill"
        }
    }
    var help: String {
        switch self {
        case .safe: return "Agent can read but tool calls that modify anything are denied / sandboxed read-only."
        case .edits: return "File edits auto-approved; codex runs in workspace-write sandbox."
        case .full: return "All permission checks skipped. Use inside a worktree."
        }
    }
}

/// Hierarchy: Project → Worktree (the unit of work, never recycled) → Sessions.
struct Project: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var name: String
    var path: String
    var isGit: Bool = false
    var isExpanded: Bool = true

    var url: URL { URL(fileURLWithPath: path) }

    init(id: UUID = UUID(), name: String, path: String, isGit: Bool = false,
         isExpanded: Bool = true) {
        self.id = id
        self.name = name
        self.path = path
        self.isGit = isGit
        self.isExpanded = isExpanded
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Project"
        path = try c.decode(String.self, forKey: .path)
        isGit = try c.decodeIfPresent(Bool.self, forKey: .isGit) ?? false
        isExpanded = try c.decodeIfPresent(Bool.self, forKey: .isExpanded) ?? true
    }
}

struct Worktree: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var projectID: UUID
    /// Display name == the worktree subdirectory name (or "main" for the project checkout).
    var name: String
    var path: String
    /// Branch at creation time — display code shows the LIVE branch, this is informational.
    var branch: String? = nil
    /// What the review diff compares against.
    var baseBranch: String? = nil
    /// True for the pseudo-worktree that is the project checkout itself.
    var isMain: Bool = false
    var isExpanded: Bool = true
    var isPinned: Bool = false
    /// Hidden from the main list; never touches the worktree on disk.
    var isArchived: Bool = false
    var createdAt: Date = Date()

    init(id: UUID = UUID(), projectID: UUID, name: String, path: String,
         branch: String? = nil, baseBranch: String? = nil, isMain: Bool = false,
         isExpanded: Bool = true, isPinned: Bool = false, isArchived: Bool = false,
         createdAt: Date = Date()) {
        self.id = id
        self.projectID = projectID
        self.name = name
        self.path = path
        self.branch = branch
        self.baseBranch = baseBranch
        self.isMain = isMain
        self.isExpanded = isExpanded
        self.isPinned = isPinned
        self.isArchived = isArchived
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        projectID = try c.decode(UUID.self, forKey: .projectID)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "worktree"
        path = try c.decode(String.self, forKey: .path)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        baseBranch = try c.decodeIfPresent(String.self, forKey: .baseBranch)
        isMain = try c.decodeIfPresent(Bool.self, forKey: .isMain) ?? false
        isExpanded = try c.decodeIfPresent(Bool.self, forKey: .isExpanded) ?? true
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        isArchived = try c.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
    }
}

/// What happens to a message sent while the agent is mid-turn.
enum SteeringMode: String, Codable, CaseIterable, Identifiable {
    case steer
    case queue

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .steer: return "Steer"
        case .queue: return "Queue"
        }
    }
    var help: String {
        switch self {
        case .steer: return "Interrupt the running turn and inject this message now (conversation resumes with full context)."
        case .queue: return "Hold the message and deliver it automatically when the agent finishes the current turn."
        }
    }
}

struct Session: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var worktreeID: UUID
    var title: String
    var engine: EngineKind = .claude
    var accessMode: AccessMode = .edits
    var steeringMode: SteeringMode = .steer
    /// nil = engine default. Claude: id/alias for --model. Codex: -m value.
    var model: String? = nil
    /// nil = engine default. Claude: --effort. Codex: model_reasoning_effort.
    var effort: String? = nil

    /// Backend conversation ids, kept separately so mid-flight engine switches can resume either side.
    var claudeSessionID: String? = nil
    var codexThreadID: String? = nil

    var createdAt: Date = Date()
    var lastActivityAt: Date = Date()
    var isPinned: Bool = false
    var isArchived: Bool = false

    // Cumulative usage across all turns (both engines).
    var totalCostUSD: Double = 0
    var inputTokens: Int = 0
    var cachedInputTokens: Int = 0
    var outputTokens: Int = 0

    init(id: UUID = UUID(), worktreeID: UUID, title: String,
         engine: EngineKind = .claude, accessMode: AccessMode = .edits) {
        self.id = id
        self.worktreeID = worktreeID
        self.title = title
        self.engine = engine
        self.accessMode = accessMode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        worktreeID = try c.decode(UUID.self, forKey: .worktreeID)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Session"
        engine = try c.decodeIfPresent(EngineKind.self, forKey: .engine) ?? .claude
        accessMode = try c.decodeIfPresent(AccessMode.self, forKey: .accessMode) ?? .edits
        steeringMode = try c.decodeIfPresent(SteeringMode.self, forKey: .steeringMode) ?? .steer
        model = try c.decodeIfPresent(String.self, forKey: .model)
        effort = try c.decodeIfPresent(String.self, forKey: .effort)
        claudeSessionID = try c.decodeIfPresent(String.self, forKey: .claudeSessionID)
        codexThreadID = try c.decodeIfPresent(String.self, forKey: .codexThreadID)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        lastActivityAt = try c.decodeIfPresent(Date.self, forKey: .lastActivityAt) ?? Date()
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        isArchived = try c.decodeIfPresent(Bool.self, forKey: .isArchived) ?? false
        totalCostUSD = try c.decodeIfPresent(Double.self, forKey: .totalCostUSD) ?? 0
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        cachedInputTokens = try c.decodeIfPresent(Int.self, forKey: .cachedInputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
    }
}

/// App-wide settings. Worktrees are never recycled automatically; the only way one is
/// destroyed is the explicit, confirmed Delete button on its page.
struct AppSettings: Codable, Equatable {
    var worktreeRootOverride: String? = nil
    /// Codex doesn't report dollar cost — computed from these per-Mtok rates.
    var codexInputPerMTok: Double = 1.25
    var codexCachedInputPerMTok: Double = 0.125
    var codexOutputPerMTok: Double = 10.0

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        worktreeRootOverride = try c.decodeIfPresent(String.self, forKey: .worktreeRootOverride)
        codexInputPerMTok = try c.decodeIfPresent(Double.self, forKey: .codexInputPerMTok) ?? 1.25
        codexCachedInputPerMTok = try c.decodeIfPresent(Double.self, forKey: .codexCachedInputPerMTok) ?? 0.125
        codexOutputPerMTok = try c.decodeIfPresent(Double.self, forKey: .codexOutputPerMTok) ?? 10.0
    }
}

struct TurnUsage {
    var costUSD: Double? = nil
    var inputTokens: Int = 0
    var cachedInputTokens: Int = 0
    var outputTokens: Int = 0
}

enum TranscriptRole: String, Codable {
    case user
    case assistant
    case thinking
    case tool
    case info
    case error
}

struct TranscriptItem: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var role: TranscriptRole
    var text: String
    var toolName: String? = nil
    var toolOutput: String? = nil
    var engine: EngineKind? = nil
    var timestamp: Date = Date()
}

/// A note pinned to a line in the diff. Collected in the composer and only sent when the
/// user actually sends a message — never on its own.
struct ReviewComment: Identifiable, Codable, Hashable {
    var id: UUID = UUID()
    var file: String
    var line: Int
    /// The code the comment is about, for context in the prompt.
    var snippet: String
    var body: String

    init(id: UUID = UUID(), file: String, line: Int, snippet: String, body: String) {
        self.id = id
        self.file = file
        self.line = line
        self.snippet = snippet
        self.body = body
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        file = try c.decodeIfPresent(String.self, forKey: .file) ?? ""
        line = try c.decodeIfPresent(Int.self, forKey: .line) ?? 0
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
    }
}

/// What the sidebar has selected — a chat, or a worktree's own page.
enum SidebarSelection: Hashable {
    case worktree(UUID)
    case session(UUID)
}

/// Model / reasoning-effort choices offered per engine (nil id = engine default).
enum EngineOptions {
    static func models(for engine: EngineKind) -> [(label: String, id: String?)] {
        switch engine {
        case .claude:
            return [
                ("Default", nil),
                ("Fable 5", "claude-fable-5"),
                ("Opus 5", "claude-opus-5"),
                ("Sonnet 5", "claude-sonnet-5"),
                ("Haiku 4.5", "claude-haiku-4-5-20251001"),
            ]
        case .codex:
            return [
                ("Default", nil),
                ("gpt-5.5", "gpt-5.5"),
                ("gpt-5.5-codex", "gpt-5.5-codex"),
                ("gpt-5.2-codex", "gpt-5.2-codex"),
                ("gpt-5.2", "gpt-5.2"),
            ]
        }
    }

    static func efforts(for engine: EngineKind) -> [String?] {
        switch engine {
        case .claude: return [nil, "low", "medium", "high", "xhigh", "max"]
        case .codex: return [nil, "minimal", "low", "medium", "high", "xhigh"]
        }
    }
}

/// Events emitted by an engine while a turn is running.
enum AgentEvent {
    case backendSessionStarted(id: String)
    case assistantText(String)
    case thinking(String)
    case toolStarted(id: String, name: String, detail: String)
    case toolFinished(id: String, output: String?, failed: Bool)
    case turnCompleted(summary: String?, usage: TurnUsage)
    case turnFailed(String)
    case raw(String)
}
