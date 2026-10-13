import Foundation
import AppKit

/// Credential health for an engine. `claude auth status` reports loggedIn:true even when the
/// stored token is long expired, so the expiry is checked separately.
enum AuthState: Equatable {
    case ok
    case expiringSoon(Date)
    case expired(Date?)
    case loggedOut
    /// Couldn't determine (CLI missing, keychain unreadable) — never shown as a problem.
    case unknown

    /// Only a dead credential is a problem. A short-lived access token near expiry is normal —
    /// the CLI refreshes it itself — and banner-nagging about it would be pure noise.
    var isProblem: Bool {
        switch self {
        case .expired, .loggedOut: return true
        case .expiringSoon, .ok, .unknown: return false
        }
    }

    func message(for engine: EngineKind) -> String {
        let name = engine.displayName
        switch self {
        case .loggedOut:
            return "\(name) is not logged in — sessions using it will fail."
        case .expired(let when):
            let suffix = when.map { " on \($0.formatted(date: .abbreviated, time: .omitted))" } ?? ""
            return "\(name) credentials expired\(suffix) and could not be refreshed. "
                + "New sessions will fail with a 401 until you log in again."
        case .expiringSoon(let when):
            return "\(name) credentials expire \(when.formatted(date: .abbreviated, time: .shortened))."
        case .ok, .unknown:
            return ""
        }
    }
}

enum AuthService {
    /// Reads the credential blob to get its expiry, and returns only that — the token itself is
    /// never logged, persisted or displayed.
    static func check(engine: EngineKind) -> AuthState {
        switch engine {
        case .claude: return checkClaude()
        case .codex: return checkCodex()
        }
    }

    private static func checkClaude() -> AuthState {
        guard let exe = ProcessRunner.findExecutable("claude") else { return .unknown }
        let status = Shell.run(exe, ["auth", "status", "--json"])
        if status.ok,
           let data = status.stdout.data(using: .utf8),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           obj["loggedIn"] as? Bool == false {
            return .loggedOut
        }
        return expiryState(from: keychainExpiry(service: "Claude Code-credentials", key: "claudeAiOauth"))
    }

    private static func checkCodex() -> AuthState {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/auth.json")
        guard FileManager.default.fileExists(atPath: path.path) else { return .unknown }
        return .ok
    }

    private static func expiryState(from expiry: Date?) -> AuthState {
        guard let expiry else { return .unknown }
        if expiry <= Date() { return .expired(expiry) }
        if expiry.timeIntervalSinceNow < 24 * 3600 { return .expiringSoon(expiry) }
        return .ok
    }

    private static func keychainExpiry(service: String, key: String) -> Date? {
        let result = Shell.run("/usr/bin/security", ["find-generic-password", "-s", service, "-w"])
        guard result.ok,
              let data = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                .data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return nil }
        let blob = (obj[key] as? [String: Any]) ?? obj
        guard let raw = blob["expiresAt"] as? Double else { return nil }
        return Date(timeIntervalSince1970: raw > 1e12 ? raw / 1000 : raw)
    }

    /// Opens Terminal on the login command. Only falls back to the clipboard if automation was
    /// refused — clobbering the user's clipboard on the happy path would be rude.
    @discardableResult
    static func startLogin(for engine: EngineKind) -> Bool {
        let command = engine == .claude ? "claude auth login" : "codex login"
        let script = """
        tell application "Terminal"
            activate
            do script "\(command)"
        end tell
        """
        if Shell.run("/usr/bin/osascript", ["-e", script]).ok { return true }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        return false
    }
}
