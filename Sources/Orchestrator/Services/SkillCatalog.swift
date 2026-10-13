import Foundation

struct SkillInfo: Identifiable, Hashable {
    enum Kind: String { case skill, command, agent }
    enum Source: String { case global, project, plugin }

    var name: String
    var description: String
    var path: String
    var kind: Kind
    var source: Source

    var id: String { path }
    /// What gets inserted into the composer.
    var invocation: String {
        switch kind {
        case .skill, .command: return "/\(name) "
        case .agent: return "Use the \(name) subagent: "
        }
    }
}

enum SkillCatalog {
    private static var home: String { FileManager.default.homeDirectoryForCurrentUser.path }

    static func scan(projectPath: String?) -> [SkillInfo] {
        var results: [SkillInfo] = []
        let fm = FileManager.default

        func parseFrontmatter(_ path: String) -> (name: String?, description: String?) {
            guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return (nil, nil) }
            var name: String? = nil, description: String? = nil
            var inFrontmatter = false
            for line in content.split(separator: "\n", maxSplits: 60, omittingEmptySubsequences: false) {
                if line == "---" {
                    if inFrontmatter { break }
                    inFrontmatter = true
                    continue
                }
                guard inFrontmatter else { continue }
                if line.hasPrefix("name:") {
                    name = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("description:") {
                    description = line.dropFirst(12).trimmingCharacters(in: .whitespaces)
                }
            }
            return (name, description)
        }

        func addSkillsDir(_ dir: String, source: SkillInfo.Source) {
            guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for entry in entries.sorted() {
                let skillMD = dir + "/" + entry + "/SKILL.md"
                guard fm.fileExists(atPath: skillMD) else { continue }
                let (name, description) = parseFrontmatter(skillMD)
                results.append(SkillInfo(
                    name: name ?? entry,
                    description: firstSentence(description ?? ""),
                    path: skillMD, kind: .skill, source: source))
            }
        }

        func addCommandsDir(_ dir: String, source: SkillInfo.Source) {
            guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for entry in entries.sorted() where entry.hasSuffix(".md") {
                let path = dir + "/" + entry
                let (name, description) = parseFrontmatter(path)
                results.append(SkillInfo(
                    name: name ?? String(entry.dropLast(3)),
                    description: firstSentence(description ?? ""),
                    path: path, kind: .command, source: source))
            }
        }

        func addAgentsDir(_ dir: String, source: SkillInfo.Source) {
            guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for entry in entries.sorted() where entry.hasSuffix(".md") {
                let path = dir + "/" + entry
                let (name, description) = parseFrontmatter(path)
                results.append(SkillInfo(
                    name: name ?? String(entry.dropLast(3)),
                    description: firstSentence(description ?? ""),
                    path: path, kind: .agent, source: source))
            }
        }

        addSkillsDir("\(home)/.claude/skills", source: .global)
        addCommandsDir("\(home)/.claude/commands", source: .global)
        addAgentsDir("\(home)/.claude/agents", source: .global)

        if let projectPath {
            addSkillsDir("\(projectPath)/.claude/skills", source: .project)
            addCommandsDir("\(projectPath)/.claude/commands", source: .project)
            addAgentsDir("\(projectPath)/.claude/agents", source: .project)
        }

        // Plugins: find any skills/<name>/SKILL.md up to a few levels deep.
        let pluginsRoot = "\(home)/.claude/plugins"
        if let enumerator = fm.enumerator(
            at: URL(fileURLWithPath: pluginsRoot),
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) {
            for case let url as URL in enumerator {
                if enumerator.level > 6 { enumerator.skipDescendants(); continue }
                if url.lastPathComponent == "SKILL.md",
                   url.deletingLastPathComponent().deletingLastPathComponent()
                       .lastPathComponent == "skills" {
                    let (name, description) = parseFrontmatter(url.path)
                    results.append(SkillInfo(
                        name: name ?? url.deletingLastPathComponent().lastPathComponent,
                        description: firstSentence(description ?? ""),
                        path: url.path, kind: .skill, source: .plugin))
                }
            }
        }

        // De-dup by (kind, name), preferring project over global over plugin.
        var seen: Set<String> = []
        var deduped: [SkillInfo] = []
        let priority: [SkillInfo.Source] = [.project, .global, .plugin]
        for source in priority {
            for item in results where item.source == source {
                let key = item.kind.rawValue + "|" + item.name
                if seen.insert(key).inserted { deduped.append(item) }
            }
        }
        return deduped.sorted { $0.name < $1.name }
    }

    private static func firstSentence(_ text: String) -> String {
        let cleaned = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
        if let dot = cleaned.firstIndex(of: "."), cleaned.distance(from: cleaned.startIndex, to: dot) > 20 {
            return String(cleaned[...dot])
        }
        return String(cleaned.prefix(140))
    }
}
