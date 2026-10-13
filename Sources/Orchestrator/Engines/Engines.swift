import Foundation

struct EngineCommand {
    var executable: String
    var arguments: [String]
}

enum EngineError: Error, LocalizedError {
    case binaryNotFound(String)
    var errorDescription: String? {
        if case .binaryNotFound(let name) = self {
            return "Could not find `\(name)` on PATH. Install it or symlink it into ~/.local/bin."
        }
        return nil
    }
}

protocol TurnParser {
    func parse(line: String) -> [AgentEvent]
}

// MARK: - Claude

enum ClaudeEngine {
    /// `resumeID == nil` means fresh backend session; `newSessionID` is pre-generated so the
    /// app knows the id even before the init event arrives.
    static func command(
        session: Session, prompt: String, resumeID: String?, newSessionID: String
    ) throws -> EngineCommand {
        guard let exe = ProcessRunner.findExecutable("claude") else {
            throw EngineError.binaryNotFound("claude")
        }
        var args = ["-p", "--output-format", "stream-json", "--verbose"]
        if let resumeID {
            args += ["--resume", resumeID]
        } else {
            args += ["--session-id", newSessionID]
        }
        switch session.accessMode {
        case .safe:
            args += ["--permission-mode", "default"]
        case .edits:
            args += ["--permission-mode", "acceptEdits"]
        case .full:
            args += ["--dangerously-skip-permissions"]
        }
        if let model = session.model, !model.isEmpty {
            args += ["--model", model]
        }
        if let effort = session.effort, !effort.isEmpty {
            args += ["--effort", effort]
        }
        args.append(prompt)
        return EngineCommand(executable: exe, arguments: args)
    }

    final class Parser: TurnParser {
        private var toolNames: [String: String] = [:]

        func parse(line: String) -> [AgentEvent] {
            guard let data = line.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let type = obj["type"] as? String
            else { return [] }

            switch type {
            case "system":
                if obj["subtype"] as? String == "init", let sid = obj["session_id"] as? String {
                    return [.backendSessionStarted(id: sid)]
                }
                return []
            case "assistant":
                guard let message = obj["message"] as? [String: Any],
                      let content = message["content"] as? [[String: Any]] else { return [] }
                var events: [AgentEvent] = []
                for block in content {
                    switch block["type"] as? String {
                    case "text":
                        if let text = block["text"] as? String, !text.isEmpty {
                            events.append(.assistantText(text))
                        }
                    case "thinking":
                        if let text = block["thinking"] as? String, !text.isEmpty {
                            events.append(.thinking(text))
                        }
                    case "tool_use":
                        let id = block["id"] as? String ?? UUID().uuidString
                        let name = block["name"] as? String ?? "tool"
                        toolNames[id] = name
                        events.append(.toolStarted(id: id, name: name, detail: Self.summarizeInput(block["input"])))
                    default: break
                    }
                }
                return events
            case "user":
                guard let message = obj["message"] as? [String: Any],
                      let content = message["content"] as? [[String: Any]] else { return [] }
                var events: [AgentEvent] = []
                for block in content where block["type"] as? String == "tool_result" {
                    let id = block["tool_use_id"] as? String ?? ""
                    let failed = block["is_error"] as? Bool ?? false
                    events.append(.toolFinished(id: id, output: Self.flattenContent(block["content"]), failed: failed))
                }
                return events
            case "result":
                let isError = obj["is_error"] as? Bool ?? false
                if isError {
                    // A real failure payload has no `result` key; the reason is in `errors`.
                    let reasons = (obj["errors"] as? [Any])?.compactMap { item -> String? in
                        if let text = item as? String { return text }
                        if let dict = item as? [String: Any] {
                            return dict["message"] as? String ?? dict["error"] as? String
                        }
                        return nil
                    } ?? []
                    let detail = reasons.isEmpty
                        ? (obj["result"] as? String)
                        : reasons.joined(separator: "\n")
                    let subtype = obj["subtype"] as? String
                    return [.turnFailed(detail ?? subtype ?? "Turn failed")]
                }
                var usage = TurnUsage()
                usage.costUSD = obj["total_cost_usd"] as? Double
                if let u = obj["usage"] as? [String: Any] {
                    usage.inputTokens = u["input_tokens"] as? Int ?? 0
                    usage.cachedInputTokens = (u["cache_read_input_tokens"] as? Int ?? 0)
                        + (u["cache_creation_input_tokens"] as? Int ?? 0)
                    usage.outputTokens = u["output_tokens"] as? Int ?? 0
                }
                var parts: [String] = []
                if let cost = usage.costUSD {
                    parts.append(String(format: "$%.4f", cost))
                }
                if let duration = obj["duration_ms"] as? Double {
                    parts.append(String(format: "%.1fs", duration / 1000))
                }
                if let turns = obj["num_turns"] as? Int {
                    parts.append("\(turns) steps")
                }
                return [.turnCompleted(
                    summary: parts.isEmpty ? nil : parts.joined(separator: " · "),
                    usage: usage)]
            default:
                return []
            }
        }

        static func summarizeInput(_ input: Any?) -> String {
            guard let dict = input as? [String: Any] else { return "" }
            if let cmd = dict["command"] as? String { return cmd }
            if let path = dict["file_path"] as? String { return path }
            if let pattern = dict["pattern"] as? String { return pattern }
            if let desc = dict["description"] as? String { return desc }
            if let prompt = dict["prompt"] as? String { return String(prompt.prefix(200)) }
            if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
               let s = String(data: data, encoding: .utf8) {
                return String(s.prefix(300))
            }
            return ""
        }

        static func flattenContent(_ content: Any?) -> String? {
            if let s = content as? String { return s }
            if let blocks = content as? [[String: Any]] {
                let texts = blocks.compactMap { $0["text"] as? String }
                if !texts.isEmpty { return texts.joined(separator: "\n") }
            }
            return nil
        }
    }
}

// MARK: - Codex

enum CodexEngine {
    static let claudeMdPreamble = """
    System note: this machine is set up around Claude Code conventions, not AGENTS.md. \
    Global operating instructions live at ~/.claude/CLAUDE.md — read that file now and obey it \
    for the whole session. Project-level CLAUDE.md files (already injected as project docs) are \
    authoritative. Ignore any AGENTS.md files.
    """

    static func command(session: Session, prompt: String, resumeThreadID: String?) throws -> EngineCommand {
        guard let exe = ProcessRunner.findExecutable("codex") else {
            throw EngineError.binaryNotFound("codex")
        }
        // Every option must precede `resume`: the subcommand rejects --sandbox outright
        // ("tip: to pass '--sandbox' as a value, use '-- --sandbox'"), which silently broke
        // the second and every later turn of a Codex conversation.
        var args = ["exec"]
        args += [
            "--json",
            "--skip-git-repo-check",
            "-c", "project_doc_fallback_filenames=[\"CLAUDE.md\"]",
        ]
        switch session.accessMode {
        case .safe:
            args += ["--sandbox", "read-only"]
        case .edits:
            args += ["--sandbox", "workspace-write"]
        case .full:
            args += ["--dangerously-bypass-approvals-and-sandbox"]
        }
        if let model = session.model, !model.isEmpty {
            args += ["--model", model]
        }
        if let effort = session.effort, !effort.isEmpty {
            args += ["-c", "model_reasoning_effort=\"\(effort)\""]
        }
        if let resumeThreadID {
            args += ["resume", resumeThreadID]
        }
        let fullPrompt = resumeThreadID == nil ? claudeMdPreamble + "\n\n" + prompt : prompt
        args.append(fullPrompt)
        return EngineCommand(executable: exe, arguments: args)
    }

    final class Parser: TurnParser {
        /// Items already surfaced as started, so item.completed only emits the finish.
        private var startedItems: Set<String> = []

        func parse(line: String) -> [AgentEvent] {
            guard let data = line.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let type = obj["type"] as? String
            else { return [] }

            switch type {
            case "thread.started":
                if let id = obj["thread_id"] as? String {
                    return [.backendSessionStarted(id: id)]
                }
                return []
            case "item.started", "item.updated", "item.completed":
                guard let item = obj["item"] as? [String: Any],
                      let itemType = item["type"] as? String else { return [] }
                let id = item["id"] as? String ?? UUID().uuidString
                let completed = type == "item.completed"
                switch itemType {
                case "agent_message":
                    guard completed, let text = item["text"] as? String, !text.isEmpty else { return [] }
                    return [.assistantText(text)]
                case "reasoning":
                    guard completed, let text = item["text"] as? String, !text.isEmpty else { return [] }
                    return [.thinking(text)]
                case "command_execution":
                    let cmd = item["command"] as? String ?? ""
                    var events: [AgentEvent] = []
                    if !startedItems.contains(id) {
                        startedItems.insert(id)
                        events.append(.toolStarted(id: id, name: "shell", detail: cmd))
                    }
                    if completed {
                        let exitCode = item["exit_code"] as? Int ?? 0
                        events.append(.toolFinished(
                            id: id,
                            output: item["aggregated_output"] as? String,
                            failed: exitCode != 0
                        ))
                    }
                    return events
                case "file_change":
                    guard completed else { return [] }
                    let changes = (item["changes"] as? [[String: Any]])?
                        .compactMap { change -> String? in
                            guard let path = change["path"] as? String else { return nil }
                            let kind = change["kind"] as? String ?? "edit"
                            return "\(kind) \(path)"
                        }
                        .joined(separator: "\n") ?? ""
                    return [
                        .toolStarted(id: id, name: "edit", detail: changes),
                        .toolFinished(id: id, output: nil, failed: false),
                    ]
                case "mcp_tool_call":
                    let name = [item["server"] as? String, item["tool"] as? String]
                        .compactMap { $0 }.joined(separator: ".")
                    var events: [AgentEvent] = []
                    if !startedItems.contains(id) {
                        startedItems.insert(id)
                        events.append(.toolStarted(id: id, name: name.isEmpty ? "mcp" : name, detail: ""))
                    }
                    if completed {
                        let failed = (item["status"] as? String) == "failed"
                        events.append(.toolFinished(id: id, output: nil, failed: failed))
                    }
                    return events
                case "web_search":
                    guard completed else { return [] }
                    let query = item["query"] as? String ?? ""
                    return [
                        .toolStarted(id: id, name: "web_search", detail: query),
                        .toolFinished(id: id, output: nil, failed: false),
                    ]
                case "todo_list":
                    return []
                case "error":
                    return [.turnFailed(item["message"] as? String ?? "error")]
                default:
                    return []
                }
            case "turn.completed":
                var usage = TurnUsage()
                var summary: String? = nil
                if let u = obj["usage"] as? [String: Any] {
                    usage.inputTokens = u["input_tokens"] as? Int ?? 0
                    usage.cachedInputTokens = u["cached_input_tokens"] as? Int ?? 0
                    usage.outputTokens = u["output_tokens"] as? Int ?? 0
                    summary = "\(usage.inputTokens) in · \(usage.outputTokens) out tokens"
                }
                return [.turnCompleted(summary: summary, usage: usage)]
            case "turn.failed":
                let err = ((obj["error"] as? [String: Any])?["message"] as? String) ?? "Turn failed"
                return [.turnFailed(err)]
            case "error":
                return [.turnFailed(obj["message"] as? String ?? "error")]
            default:
                return []
            }
        }
    }
}
