import Foundation

struct LSPPosition: Codable, Hashable {
    var line: Int
    var character: Int
}

struct LSPLocation: Hashable {
    var path: String
    var line: Int      // 0-based
    var character: Int // 0-based
}

struct LSPHover {
    var text: String
}

/// Resumes a continuation exactly once, whichever of the reply or the timeout arrives first.
private final class ContinuationBox: @unchecked Sendable {
    private var continuation: CheckedContinuation<Any?, Error>?
    private let lock = NSLock()

    func store(_ continuation: CheckedContinuation<Any?, Error>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    func finish(with result: Result<Any?, Error>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        guard let pending else { return }
        pending.resume(with: result)
    }
}

/// Minimal Language Server Protocol client over stdio (Content-Length framing).
/// One instance per (workspace, server command).
final class LSPClient {
    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let queue = DispatchQueue(label: "orchestrator.lsp")
    private var buffer = Data()
    private var nextID = 1
    private var pending: [Int: (Result<Any?, Error>) -> Void] = [:]
    private var openDocs: [String: (version: Int, content: String)] = [:]
    private(set) var isAlive = false

    let workspacePath: String

    init(workspacePath: String) {
        self.workspacePath = workspacePath
    }

    func start(executable: String, arguments: [String]) throws {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: workspacePath)
        process.environment = ProcessRunner.defaultEnvironment()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            self.queue.async {
                self.buffer.append(data)
                self.drainMessages()
            }
        }
        process.terminationHandler = { [weak self] proc in
            ProcessJanitor.shared.unregister(pid: proc.processIdentifier)
            guard let self else { return }
            self.queue.async {
                self.isAlive = false
                for (_, callback) in self.pending {
                    callback(.failure(NSError(domain: "lsp", code: -2, userInfo: [
                        NSLocalizedDescriptionKey: "language server exited"
                    ])))
                }
                self.pending.removeAll()
            }
        }
        try process.run()
        ProcessJanitor.shared.register(process)
        isAlive = true
    }

    func stop() {
        queue.async { [self] in
            isAlive = false
            process.terminate()
        }
    }

    // MARK: framing

    private func drainMessages() {
        while true {
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return }
            let headerData = buffer.subdata(in: buffer.startIndex..<headerEnd.lowerBound)
            guard let header = String(data: headerData, encoding: .utf8) else { return }
            var contentLength = 0
            for line in header.split(separator: "\r\n") {
                if line.lowercased().hasPrefix("content-length:") {
                    contentLength = Int(line.dropFirst("content-length:".count)
                        .trimmingCharacters(in: .whitespaces)) ?? 0
                }
            }
            let bodyStart = headerEnd.upperBound
            guard buffer.count - buffer.distance(from: buffer.startIndex, to: bodyStart) >= contentLength else { return }
            let bodyEnd = buffer.index(bodyStart, offsetBy: contentLength)
            let body = buffer.subdata(in: bodyStart..<bodyEnd)
            buffer.removeSubrange(buffer.startIndex..<bodyEnd)
            if let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
                handleMessage(obj)
            }
        }
    }

    private func handleMessage(_ obj: [String: Any]) {
        if let id = obj["id"] as? Int, obj["method"] == nil {
            // Response to one of our requests.
            guard let callback = pending.removeValue(forKey: id) else { return }
            if let error = obj["error"] as? [String: Any] {
                let message = error["message"] as? String ?? "LSP error"
                callback(.failure(NSError(domain: "lsp", code: -1, userInfo: [NSLocalizedDescriptionKey: message])))
            } else {
                callback(.success(obj["result"] ?? nil))
            }
            return
        }
        if let method = obj["method"] as? String, let id = obj["id"] {
            // Server-to-client request: answer generically so the server never stalls.
            var result: Any? = nil
            if method == "workspace/configuration" {
                let count = ((obj["params"] as? [String: Any])?["items"] as? [Any])?.count ?? 1
                result = Array(repeating: NSNull(), count: count)
            }
            sendRaw(["jsonrpc": "2.0", "id": id, "result": result ?? NSNull()])
        }
        // Notifications (diagnostics etc.) are ignored for now.
    }

    private func sendRaw(_ obj: [String: Any]) {
        guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var data = Data("Content-Length: \(body.count)\r\n\r\n".utf8)
        data.append(body)
        stdinPipe.fileHandleForWriting.write(data)
    }

    private func request(_ method: String, _ params: [String: Any], completion: @escaping (Result<Any?, Error>) -> Void) {
        queue.async { [self] in
            guard isAlive else {
                completion(.failure(NSError(domain: "lsp", code: -3, userInfo: [
                    NSLocalizedDescriptionKey: "language server not running"
                ])))
                return
            }
            let id = nextID
            nextID += 1
            pending[id] = completion
            sendRaw(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        }
    }

    private func notify(_ method: String, _ params: [String: Any]) {
        queue.async { [self] in
            guard isAlive else { return }
            sendRaw(["jsonrpc": "2.0", "method": method, "params": params])
        }
    }

    /// Every request carries a deadline: a language server that is still indexing may simply
    /// never answer, and an un-resumed continuation makes ⌘-click silently do nothing forever.
    private func requestAsync(
        _ method: String, _ params: [String: Any], timeout: TimeInterval = 8
    ) async throws -> Any? {
        let box = ContinuationBox()
        return try await withCheckedThrowingContinuation { continuation in
            box.store(continuation)
            request(method, params) { result in box.finish(with: result) }
            queue.asyncAfter(deadline: .now() + timeout) {
                box.finish(with: .failure(NSError(domain: "lsp", code: -4, userInfo: [
                    NSLocalizedDescriptionKey: "\(method) timed out after \(Int(timeout))s"
                ])))
            }
        }
    }

    // MARK: lifecycle

    func initialize() async throws {
        let rootURI = URL(fileURLWithPath: workspacePath).absoluteString
        _ = try await requestAsync("initialize", [
            "processId": ProcessInfo.processInfo.processIdentifier,
            "rootUri": rootURI,
            "workspaceFolders": [["uri": rootURI, "name": (workspacePath as NSString).lastPathComponent]],
            "capabilities": [
                "textDocument": [
                    "hover": ["contentFormat": ["markdown", "plaintext"]],
                    "definition": [:],
                    "synchronization": ["didSave": true],
                ],
                "workspace": ["configuration": true],
            ],
        ])
        notify("initialized", [:])
    }

    static func uri(for path: String) -> String {
        URL(fileURLWithPath: path).absoluteString
    }

    /// Open or refresh a document so the server has the current on-disk content.
    func syncDocument(path: String, content: String, languageID: String) {
        let uri = Self.uri(for: path)
        // sendRaw directly rather than notify(): notify() would enqueue a *second* block, letting
        // a hover/definition request slip in front of the didOpen and get answered on nothing.
        queue.async { [self] in
            guard isAlive else { return }
            if let existing = openDocs[uri] {
                guard existing.content != content else { return }
                let version = existing.version + 1
                openDocs[uri] = (version, content)
                sendRaw([
                    "jsonrpc": "2.0",
                    "method": "textDocument/didChange",
                    "params": [
                        "textDocument": ["uri": uri, "version": version],
                        "contentChanges": [["text": content]],
                    ],
                ])
            } else {
                openDocs[uri] = (1, content)
                sendRaw([
                    "jsonrpc": "2.0",
                    "method": "textDocument/didOpen",
                    "params": [
                        "textDocument": [
                            "uri": uri, "languageId": languageID, "version": 1, "text": content,
                        ],
                    ],
                ])
            }
        }
    }

    // MARK: features

    func hover(path: String, line: Int, character: Int) async throws -> LSPHover? {
        let result = try await requestAsync("textDocument/hover", [
            "textDocument": ["uri": Self.uri(for: path)],
            "position": ["line": line, "character": character],
        ])
        guard let dict = result as? [String: Any] else { return nil }
        if let contents = dict["contents"] as? [String: Any], let value = contents["value"] as? String {
            return LSPHover(text: value)
        }
        if let value = dict["contents"] as? String {
            return LSPHover(text: value)
        }
        if let parts = dict["contents"] as? [Any] {
            let texts = parts.compactMap { part -> String? in
                if let s = part as? String { return s }
                if let d = part as? [String: Any] { return d["value"] as? String }
                return nil
            }
            if !texts.isEmpty { return LSPHover(text: texts.joined(separator: "\n\n")) }
        }
        return nil
    }

    func definition(path: String, line: Int, character: Int) async throws -> [LSPLocation] {
        let result = try await requestAsync("textDocument/definition", [
            "textDocument": ["uri": Self.uri(for: path)],
            "position": ["line": line, "character": character],
        ])
        return Self.parseLocations(result)
    }

    static func parseLocations(_ result: Any?) -> [LSPLocation] {
        var raw: [[String: Any]] = []
        if let single = result as? [String: Any] {
            raw = [single]
        } else if let many = result as? [[String: Any]] {
            raw = many
        }
        return raw.compactMap { loc in
            let uriString = (loc["uri"] as? String) ?? (loc["targetUri"] as? String)
            let range = (loc["range"] as? [String: Any]) ?? (loc["targetSelectionRange"] as? [String: Any])
            guard let uriString, let range,
                  let start = range["start"] as? [String: Any],
                  let line = start["line"] as? Int,
                  let character = start["character"] as? Int,
                  let url = URL(string: uriString), url.isFileURL
            else { return nil }
            return LSPLocation(path: url.path, line: line, character: character)
        }
    }
}
