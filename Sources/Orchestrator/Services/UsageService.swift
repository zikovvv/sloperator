import Foundation

/// Live Claude Code usage, reconstructed from ~/.claude/projects/**.jsonl the same way
/// ccusage does: activity is grouped into 5-hour billing blocks.
struct UsageBlock {
    var start: Date
    var end: Date { start.addingTimeInterval(5 * 3600) }
    var isActive: Bool { Date() < end }
    var messages: Int = 0
    var inputTokens: Int = 0
    var cachedTokens: Int = 0
    var outputTokens: Int = 0
    var tokensByModel: [String: Int] = [:]
    var lastActivity: Date = .distantPast
}

enum UsageService {
    private struct Event {
        let timestamp: Date
        let model: String
        let input: Int
        let cached: Int
        let output: Int
        /// (message id, request id). Claude Code writes one line per content block, each
        /// repeating the same usage, and streams progressively growing totals — lines sharing
        /// a key describe ONE message and are merged, never summed.
        let key: String?
    }

    private struct CacheEntry {
        let modified: Date
        let size: Int
        let events: [Event]
    }

    /// Re-parsing every transcript on a timer cost seconds of CPU and hundreds of MB of RSS,
    /// so per-file results are memoised until the file's mtime or size changes.
    private static var cache: [String: CacheEntry] = [:]
    private static let cacheLock = NSLock()

    /// Scans recent transcript files and returns blocks from the last ~30 hours, newest last.
    static func scanBlocks() -> [UsageBlock] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let projectsDir = home + "/.claude/projects"
        let cutoff = Date().addingTimeInterval(-30 * 3600)

        // Transcripts nest several levels deep (subagent transcripts etc.) — walk recursively.
        guard let enumerator = FileManager.default.enumerator(
            at: URL(fileURLWithPath: projectsDir),
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var events: [Event] = []
        var seenPaths: Set<String> = []
        for case let url as URL in enumerator {
            guard url.pathExtension == "jsonl" else { continue }
            let values = try? url.resourceValues(
                forKeys: [.contentModificationDateKey, .fileSizeKey])
            guard let modified = values?.contentModificationDate, modified > cutoff else { continue }
            let size = values?.fileSize ?? 0
            let path = url.path
            seenPaths.insert(path)

            cacheLock.lock()
            let hit = cache[path]
            cacheLock.unlock()
            if let hit, hit.modified == modified, hit.size == size {
                events.append(contentsOf: hit.events)
                continue
            }
            let parsed = parse(url: url, cutoff: cutoff)
            cacheLock.lock()
            cache[path] = CacheEntry(modified: modified, size: size, events: parsed)
            cacheLock.unlock()
            events.append(contentsOf: parsed)
        }
        cacheLock.lock()
        cache = cache.filter { seenPaths.contains($0.key) }
        cacheLock.unlock()

        return blocks(from: merge(events))
    }

    private static func parse(url: URL, cutoff: Date) -> [Event] {
        // Memory-mapped so a 30MB transcript never lands in the resident set.
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return [] }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoPlain = ISO8601DateFormatter()

        var parsed: [Event] = []
        autoreleasepool {
            for lineData in data.split(separator: 0x0A) {
                guard lineData.count > 40 else { continue } // cheap pre-filter
                guard let obj = (try? JSONSerialization.jsonObject(with: lineData)) as? [String: Any],
                      obj["type"] as? String == "assistant",
                      let message = obj["message"] as? [String: Any],
                      let usage = message["usage"] as? [String: Any],
                      let stamp = obj["timestamp"] as? String,
                      let ts = iso.date(from: stamp) ?? isoPlain.date(from: stamp),
                      ts > cutoff
                else { continue }
                let model = message["model"] as? String ?? "unknown"
                guard model != "<synthetic>" else { continue }
                parsed.append(Event(
                    timestamp: ts,
                    model: model,
                    input: usage["input_tokens"] as? Int ?? 0,
                    cached: (usage["cache_read_input_tokens"] as? Int ?? 0)
                        + (usage["cache_creation_input_tokens"] as? Int ?? 0),
                    output: usage["output_tokens"] as? Int ?? 0,
                    key: dedupKey(obj, message)))
            }
        }
        return parsed
    }

    private static func dedupKey(_ obj: [String: Any], _ message: [String: Any]) -> String? {
        let messageID = message["id"] as? String
        let requestID = obj["requestId"] as? String
        if messageID == nil && requestID == nil { return nil }
        return (messageID ?? "") + "|" + (requestID ?? "")
    }

    /// Collapses the repeated lines of one message into a single event, keeping the largest
    /// reported usage (the last line written) and the earliest timestamp.
    private static func merge(_ events: [Event]) -> [Event] {
        var keyed: [String: Event] = [:]
        var unkeyed: [Event] = []
        for event in events {
            guard let key = event.key else {
                unkeyed.append(event)
                continue
            }
            if let existing = keyed[key] {
                keyed[key] = Event(
                    timestamp: min(existing.timestamp, event.timestamp),
                    model: event.model,
                    input: max(existing.input, event.input),
                    cached: max(existing.cached, event.cached),
                    output: max(existing.output, event.output),
                    key: key)
            } else {
                keyed[key] = event
            }
        }
        return (unkeyed + Array(keyed.values)).sorted { $0.timestamp < $1.timestamp }
    }

    private static func blocks(from events: [Event]) -> [UsageBlock] {
        guard !events.isEmpty else { return [] }
        var blocks: [UsageBlock] = []
        var current: UsageBlock? = nil
        var lastTS: Date = .distantPast
        for event in events {
            let needsNewBlock: Bool
            if let block = current {
                needsNewBlock = event.timestamp >= block.end
                    || event.timestamp.timeIntervalSince(lastTS) >= 5 * 3600
            } else {
                needsNewBlock = true
            }
            if needsNewBlock {
                if let block = current { blocks.append(block) }
                current = UsageBlock(start: floorToHour(event.timestamp))
            }
            current?.messages += 1
            current?.inputTokens += event.input
            current?.cachedTokens += event.cached
            current?.outputTokens += event.output
            current?.tokensByModel[shortModel(event.model), default: 0] += event.input + event.output
            current?.lastActivity = event.timestamp
            lastTS = event.timestamp
        }
        if let block = current { blocks.append(block) }
        return blocks
    }

    private static func floorToHour(_ date: Date) -> Date {
        let interval = date.timeIntervalSince1970
        return Date(timeIntervalSince1970: (interval / 3600).rounded(.down) * 3600)
    }

    static func shortModel(_ model: String) -> String {
        if model.contains("fable") { return "fable" }
        if model.contains("opus") { return "opus" }
        if model.contains("sonnet") { return "sonnet" }
        if model.contains("haiku") { return "haiku" }
        return model
    }
}
