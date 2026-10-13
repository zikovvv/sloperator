import Foundation

/// Ensures no agent subprocess outlives the app.
/// - Normal quit: killAll() from applicationWillTerminate.
/// - Hard kill / crash: live PIDs are persisted; the next launch reaps whatever is left.
///
/// Two things must never happen:
/// 1. Killing a stranger. PIDs get recycled, so each entry records the process start time and a
///    PID is only reaped when its start time still matches exactly.
/// 2. Killing a *sibling's* agents. Several instances of this app can run at once (the dev loop
///    uses `swift run` alongside the bundle), so each entry records the owning app's PID and
///    entries owned by a live instance are left strictly alone.
final class ProcessJanitor {
    static let shared = ProcessJanitor()

    private struct Entry: Codable {
        let pid: Int32
        /// `ps -o lstart=` at spawn time, e.g. "Wed Aug 26 20:33:48 2026".
        let started: String
        /// PID of the app instance that spawned it.
        var owner: Int32 = 0
    }

    private let queue = DispatchQueue(label: "orchestrator.janitor")
    private let ownPID = ProcessInfo.processInfo.processIdentifier
    private var processes: [Int32: Process] = [:]
    private var entries: [Int32: Entry] = [:]

    private var pidsFile: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ClaudeOrchestrator/running_pids.json")
    }

    private static func startTime(of pid: Int32) -> String? {
        let result = Shell.run("/bin/ps", ["-p", "\(pid)", "-o", "lstart="])
        let value = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private static func isAlive(_ pid: Int32) -> Bool {
        pid > 0 && kill(pid, 0) == 0
    }

    /// Agents spawn their own children (dev servers, test runners). Killing only the agent
    /// leaves those running, so signal the whole subtree, deepest first.
    static func descendants(of pid: Int32) -> [Int32] {
        let listing = Shell.run("/bin/ps", ["-axo", "pid=,ppid="]).stdout
        var childrenByParent: [Int32: [Int32]] = [:]
        for line in listing.split(separator: "\n") {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true)
            guard parts.count == 2, let child = Int32(parts[0]), let parent = Int32(parts[1])
            else { continue }
            childrenByParent[parent, default: []].append(child)
        }
        var result: [Int32] = []
        var frontier = [pid]
        while let next = frontier.popLast() {
            for child in childrenByParent[next] ?? [] {
                result.append(child)
                frontier.append(child)
            }
        }
        return result.reversed()
    }

    /// The process and everything below it, deepest first. Snapshot this BEFORE signalling
    /// anything: once the agent dies its children are reparented to launchd and become
    /// unfindable.
    static func processTree(_ pid: Int32) -> [Int32] {
        descendants(of: pid) + [pid]
    }

    static func signal(_ tree: [Int32], _ sig: Int32) {
        for pid in tree { kill(pid, sig) }
    }

    func register(_ process: Process) {
        let pid = process.processIdentifier
        // ps is a fork+exec; keep it off whatever thread launched the agent.
        queue.async { [self] in
            guard let started = Self.startTime(of: pid) else { return }
            processes[pid] = process
            entries[pid] = Entry(pid: pid, started: started, owner: ownPID)
            persist()
        }
    }

    func unregister(pid: Int32) {
        queue.async { [self] in
            processes.removeValue(forKey: pid)
            entries.removeValue(forKey: pid)
            persist()
        }
    }

    /// Writes our own entries plus any belonging to other instances that are still alive, so
    /// siblings never erase each other's bookkeeping.
    private func persist() {
        let foreign = (try? JSONDecoder().decode([Entry].self, from: Data(contentsOf: pidsFile)))?
            .filter { $0.owner != ownPID && Self.isAlive($0.owner) } ?? []
        let all = Array(entries.values) + foreign
        if let data = try? JSONEncoder().encode(all) {
            try? data.write(to: pidsFile, options: .atomic)
        }
    }

    /// Normal app termination — take every child down with us.
    func killAll() {
        queue.sync {
            let trees = processes.keys.map { Self.processTree($0) }
            for tree in trees { Self.signal(tree, SIGTERM) }
            usleep(300_000)
            for tree in trees { Self.signal(tree, SIGKILL) }
            processes.removeAll()
            entries.removeAll()
            persist()
        }
    }

    /// Launch-time cleanup for agents orphaned by a hard kill (SIGKILL / crash / force quit),
    /// where applicationWillTerminate never ran.
    func reapOrphans() {
        queue.async { [self] in
            guard let data = try? Data(contentsOf: pidsFile),
                  let stale = try? JSONDecoder().decode([Entry].self, from: data),
                  !stale.isEmpty
            else { return }
            var killed: [[Int32]] = []
            for entry in stale where Self.isAlive(entry.pid) {
                // Owned by an instance that is still running: not an orphan, hands off.
                guard !Self.isAlive(entry.owner) || entry.owner == ownPID else { continue }
                // Same pid AND same start time, or it isn't the process we think it is.
                guard Self.startTime(of: entry.pid) == entry.started else { continue }
                let tree = Self.processTree(entry.pid)
                Self.signal(tree, SIGTERM)
                killed.append(tree)
            }
            if !killed.isEmpty {
                sleep(2)
                for tree in killed { Self.signal(tree, SIGKILL) }
                NSLog("ProcessJanitor: reaped \(killed.count) orphaned agent process(es) from a previous run")
            }
            persist()
        }
    }
}
