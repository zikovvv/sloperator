import Foundation

/// Routes files to the right language server, one client per (workspace, server).
@MainActor
final class LSPManager: ObservableObject {
    static let shared = LSPManager()

    private struct ServerSpec {
        var binary: String
        var arguments: [String]
        var languageID: String
    }

    private var clients: [String: LSPClient] = [:]
    /// In-flight startups, so a burst of hovers awaits the same server instead of spawning
    /// a new pyright each time (they are hundreds of MB apiece).
    private var starting: [String: Task<LSPClient?, Never>] = [:]
    @Published var lastError: String? = nil

    private func spec(forExtension ext: String) -> ServerSpec? {
        switch ext {
        case "py", "pyi":
            return ServerSpec(binary: "pyright-langserver", arguments: ["--stdio"], languageID: "python")
        case "ts", "tsx", "js", "jsx", "mjs", "cjs":
            guard ProcessRunner.findExecutable("typescript-language-server") != nil else { return nil }
            let lang = ext.hasPrefix("t") ? "typescript" : "javascript"
            return ServerSpec(binary: "typescript-language-server", arguments: ["--stdio"], languageID: lang)
        default:
            return nil
        }
    }

    func supports(path: String) -> Bool {
        spec(forExtension: (path as NSString).pathExtension.lowercased()) != nil
    }

    private func client(workspace: String, filePath: String) async -> (LSPClient, String)? {
        let ext = (filePath as NSString).pathExtension.lowercased()
        guard let spec = spec(forExtension: ext) else { return nil }
        let key = workspace + "|" + spec.binary
        if let existing = clients[key], existing.isAlive {
            return (existing, spec.languageID)
        }
        if let pending = starting[key] {
            return await pending.value.map { ($0, spec.languageID) }
        }
        guard let binaryPath = ProcessRunner.findExecutable(spec.binary) else {
            lastError = "\(spec.binary) not found on PATH"
            return nil
        }
        let task = Task<LSPClient?, Never> { [weak self] in
            let client = LSPClient(workspacePath: workspace)
            do {
                try client.start(executable: binaryPath, arguments: spec.arguments)
                try await client.initialize()
                await MainActor.run { self?.clients[key] = client }
                return client
            } catch {
                client.stop()
                await MainActor.run {
                    self?.lastError = "LSP start failed: \(error.localizedDescription)"
                }
                return nil
            }
        }
        starting[key] = task
        let client = await task.value
        starting[key] = nil
        return client.map { ($0, spec.languageID) }
    }

    private func syncedClient(workspace: String, filePath: String) async -> LSPClient? {
        guard let (client, languageID) = await client(workspace: workspace, filePath: filePath),
              let content = try? String(contentsOfFile: filePath, encoding: .utf8)
        else { return nil }
        client.syncDocument(path: filePath, content: content, languageID: languageID)
        return client
    }

    func hover(workspace: String, filePath: String, line: Int, character: Int) async -> LSPHover? {
        guard let client = await syncedClient(workspace: workspace, filePath: filePath) else { return nil }
        return try? await client.hover(path: filePath, line: line, character: character)
    }

    func definition(workspace: String, filePath: String, line: Int, character: Int) async -> [LSPLocation] {
        guard let client = await syncedClient(workspace: workspace, filePath: filePath) else { return [] }
        return (try? await client.definition(path: filePath, line: line, character: character)) ?? []
    }

    func shutdownWorkspace(_ workspace: String) {
        for (key, client) in clients where key.hasPrefix(workspace + "|") {
            client.stop()
            clients.removeValue(forKey: key)
        }
    }
}
