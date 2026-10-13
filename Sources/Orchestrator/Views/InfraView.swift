import SwiftUI
import AppKit

/// Explorer for the machine's Claude infrastructure: CLAUDE.md files, memories,
/// hooks, skills, agents, commands — browsable and editable without digging in Finder.
struct InfraView: View {
    @EnvironmentObject var store: AppStore

    enum Category: String, CaseIterable, Identifiable {
        case claudeMD = "CLAUDE.md"
        case memories = "Memories"
        case hooks = "Hooks"
        case skills = "Skills"
        case agents = "Agents"
        case commands = "Commands"

        var id: String { rawValue }
        var symbol: String {
            switch self {
            case .claudeMD: return "doc.text.fill"
            case .memories: return "brain.head.profile"
            case .hooks: return "link"
            case .skills: return "wand.and.stars"
            case .agents: return "person.2.fill"
            case .commands: return "terminal.fill"
            }
        }
    }

    struct Item: Identifiable, Hashable {
        var title: String
        var subtitle: String
        var path: String
        var group: String
        var id: String { path }
    }

    @State private var category: Category = .claudeMD
    @State private var items: [Item] = []
    @State private var selectedItemID: String? = nil
    @State private var fileContent: String = ""
    @State private var originalContent: String = ""
    @State private var loadError: String? = nil
    /// Navigation the user asked for but that is waiting on the unsaved-changes dialog.
    /// Reverting `selectedItemID` inside its own onChange used to fire the handler a second
    /// time, and that pass reloaded the file from disk — destroying the edits the dialog was
    /// still asking about.
    private enum PendingNavigation {
        case item(String?)
        case category(from: Category, to: Category)
    }
    @State private var pending: PendingNavigation? = nil
    @State private var suppressReload = false
    @State private var confirmDiscard = false
    /// The file whose text is actually in the editor. Everything about dirty-tracking and
    /// saving keys off THIS, never off the current selection, so a save can never write one
    /// file's contents into another.
    @State private var loadedPath: String? = nil
    /// Modification date at load time — a save refuses if the file changed underneath us.
    @State private var loadedModified: Date? = nil
    @State private var previewing = true

    private var home: String { FileManager.default.homeDirectoryForCurrentUser.path }

    var body: some View {
        HSplitView {
            categoryList
                .frame(width: 170)
            itemList
                .frame(minWidth: 240, idealWidth: 300)
            editor
                .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
                .layoutPriority(1)
        }
        .onAppear(perform: reload)
        .onChange(of: category) { oldValue, newValue in
            guard oldValue != newValue else { return }
            if suppressReload { suppressReload = false; return }
            if isDirty {
                // Leave the editor untouched until the user answers.
                pending = .category(from: oldValue, to: newValue)
                confirmDiscard = true
                return
            }
            openCategory()
        }
        .onChange(of: selectedItemID) { oldValue, newValue in
            guard oldValue != newValue else { return }
            if suppressReload { suppressReload = false; return }
            if isDirty, let loadedPath, loadedPath != pathFor(newValue) {
                pending = .item(newValue)
                confirmDiscard = true
                return   // nothing is loaded or cleared while the dialog is up
            }
            loadSelectedFile()
        }
        .confirmationDialog("You have unsaved changes", isPresented: $confirmDiscard) {
            Button("Save and Switch") {
                if saveFile() { applyPending() } else { pending = nil }
            }
            Button("Discard Changes", role: .destructive) {
                clearEditor()
                applyPending()
            }
            Button("Cancel", role: .cancel) { cancelPending() }
        } message: {
            Text(unsavedMessage)
        }
    }

    private var categoryList: some View {
        List(Category.allCases, selection: Binding(
            get: { category },
            set: { if let c = $0 { category = c } }
        )) { cat in
            Label(cat.rawValue, systemImage: cat.symbol)
                .tag(cat)
        }
        .listStyle(.sidebar)
    }

    private var itemList: some View {
        VStack(spacing: 0) {
            List(selection: $selectedItemID) {
                ForEach(groupedItems, id: \.0) { group, groupItems in
                    Section(group) {
                        ForEach(groupItems) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).lineLimit(1)
                                if !item.subtitle.isEmpty {
                                    Text(item.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            .tag(item.id)
                            .contextMenu {
                                Button("Reveal in Finder") {
                                    NSWorkspace.shared.activateFileViewerSelecting(
                                        [URL(fileURLWithPath: item.path)])
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.inset)
            HStack {
                Text("\(items.count) items")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Spacer()
                Button {
                    reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(isDirty)
                .help(isDirty ? "Save or revert your edits first" : "Rescan")
            }
            .padding(6)
        }
    }

    private var groupedItems: [(String, [Item])] {
        var order: [String] = []
        var groups: [String: [Item]] = [:]
        for item in items {
            if groups[item.group] == nil { order.append(item.group) }
            groups[item.group, default: []].append(item)
        }
        return order.map { ($0, groups[$0]!) }
    }

    private var isDirty: Bool { loadedPath != nil && fileContent != originalContent }

    private var isMarkdown: Bool {
        ((loadedPath ?? "") as NSString).pathExtension.lowercased() == "md"
    }

    /// Follows a Markdown link. Files already in the list are just selected; anything else is
    /// added under "Linked" so it can be read (and edited) with the same machinery.
    private func openLinkedFile(_ path: String) {
        if let existing = items.first(where: { $0.path == path }) {
            selectedItemID = existing.id
            return
        }
        guard FileManager.default.fileExists(atPath: path) else { return }
        let item = Item(
            title: (path as NSString).lastPathComponent,
            subtitle: (path as NSString).deletingLastPathComponent
                .replacingOccurrences(of: home, with: "~"),
            path: path,
            group: "Linked")
        items.append(item)
        selectedItemID = item.id
    }

    private func pathFor(_ id: String?) -> String? {
        items.first { $0.id == id }?.path
    }

    private func clearEditor() {
        fileContent = ""
        originalContent = ""
        loadedPath = nil
        loadedModified = nil
        loadError = nil
    }

    private var editor: some View {
        VStack(spacing: 0) {
            if let selected = items.first(where: { $0.id == selectedItemID }) {
                HStack(spacing: 8) {
                    Text(selected.path.replacingOccurrences(of: home, with: "~"))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .textSelection(.enabled)
                    Spacer()
                    if isMarkdown {
                        Picker("", selection: $previewing) {
                            Text("Preview").tag(true)
                            Text("Edit").tag(false)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .frame(width: 140)
                        .disabled(isDirty)
                        .help(isDirty ? "Save or revert first" : "Rendered vs raw")
                    }
                    if isDirty {
                        Button("Revert") {
                            fileContent = originalContent
                        }
                        Button("Save") { saveFile() }
                            .buttonStyle(.borderedProminent)
                            .keyboardShortcut("s", modifiers: .command)
                    }
                }
                .padding(8)
                Divider()
                if let loadError {
                    Text(loadError)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if isMarkdown && previewing && !isDirty {
                    ScrollView {
                        MarkdownView(
                            text: fileContent,
                            baseDirectory: (loadedPath as NSString?)?.deletingLastPathComponent,
                            onOpenFile: openLinkedFile)
                            .padding(16)
                            .frame(maxWidth: 820, alignment: .leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .textBackgroundColor))
                } else {
                    TextEditor(text: $fileContent)
                        .font(.system(size: 12.5, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .background(Color(nsColor: .textBackgroundColor))
                }
            } else {
                Text("Select an item")
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var unsavedMessage: String {
        let name = ((loadedPath ?? "") as NSString).lastPathComponent
        return "Your edits to \(name) have not been saved."
    }

    private func openCategory() {
        selectedItemID = nil
        clearEditor()
        reload()
    }

    /// The user confirmed: carry out the navigation that was waiting.
    private func applyPending() {
        guard let navigation = pending else { return }
        pending = nil
        switch navigation {
        case .item:
            // The selection was never moved off the target, so just load it.
            loadSelectedFile()
        case .category:
            openCategory()
        }
    }

    /// The user backed out: put the selection back on the file they were editing.
    private func cancelPending() {
        guard let navigation = pending else { return }
        pending = nil
        suppressReload = true
        switch navigation {
        case .item:
            selectedItemID = items.first { $0.path == loadedPath }?.id
        case .category(let from, _):
            category = from
        }
    }

    private func loadSelectedFile() {
        guard let selected = items.first(where: { $0.id == selectedItemID }) else {
            clearEditor()
            return
        }
        do {
            let content = try String(contentsOfFile: selected.path, encoding: .utf8)
            fileContent = content
            originalContent = content
            loadedPath = selected.path
            loadedModified = (try? FileManager.default
                .attributesOfItem(atPath: selected.path)[.modificationDate]) as? Date
            loadError = nil
        } catch {
            clearEditor()
            loadError = "Could not read file: \(error.localizedDescription)"
        }
    }

    /// Always writes to the file that was loaded, never to whatever happens to be selected.
    /// Returns false when nothing was written, so callers do not navigate away from unsaved work.
    @discardableResult
    private func saveFile() -> Bool {
        guard let path = loadedPath else { return false }
        let onDisk = (try? FileManager.default
            .attributesOfItem(atPath: path)[.modificationDate]) as? Date
        if let onDisk, let loadedModified, onDisk > loadedModified {
            loadError = "\((path as NSString).lastPathComponent) changed on disk since you "
                + "opened it (an agent may have edited it). Reload before saving, or your edit "
                + "would overwrite theirs."
            return false
        }
        do {
            try fileContent.write(toFile: path, atomically: true, encoding: .utf8)
            originalContent = fileContent
            loadedModified = (try? FileManager.default
                .attributesOfItem(atPath: path)[.modificationDate]) as? Date
            return true
        } catch {
            loadError = "Save failed: \(error.localizedDescription)"
            return false
        }
    }

    // MARK: - Scanning

    private func reload() {
        let projects = store.projects
        let cat = category
        DispatchQueue.global(qos: .userInitiated).async {
            let scanned = Self.scan(category: cat, projects: projects, home: home)
            DispatchQueue.main.async {
                items = scanned
                if selectedItemID == nil || !scanned.contains(where: { $0.id == selectedItemID }) {
                    selectedItemID = scanned.first?.id
                }
                loadSelectedFile()
            }
        }
    }

    private static func scan(category: Category, projects: [Project], home: String) -> [Item] {
        let fm = FileManager.default
        var items: [Item] = []

        func addIfExists(_ path: String, title: String, subtitle: String, group: String) {
            if fm.fileExists(atPath: path) {
                items.append(Item(title: title, subtitle: subtitle, path: path, group: group))
            }
        }

        switch category {
        case .claudeMD:
            addIfExists("\(home)/.claude/CLAUDE.md",
                        title: "Global CLAUDE.md",
                        subtitle: "Applies to every project", group: "Global")
            for project in projects {
                addIfExists("\(project.path)/CLAUDE.md",
                            title: "CLAUDE.md", subtitle: project.path, group: project.name)
                addIfExists("\(project.path)/CLAUDE.local.md",
                            title: "CLAUDE.local.md", subtitle: "Not committed", group: project.name)
                // Nested CLAUDE.md files a few levels down.
                if let enumerator = fm.enumerator(
                    at: URL(fileURLWithPath: project.path),
                    includingPropertiesForKeys: nil,
                    options: [.skipsHiddenFiles, .skipsPackageDescendants]
                ) {
                    for case let url as URL in enumerator {
                        if enumerator.level > 4 { enumerator.skipDescendants(); continue }
                        if url.lastPathComponent == "node_modules" || url.lastPathComponent == ".git" {
                            enumerator.skipDescendants(); continue
                        }
                        if url.lastPathComponent == "CLAUDE.md" && url.path != project.path + "/CLAUDE.md" {
                            let rel = String(url.path.dropFirst(project.path.count + 1))
                            items.append(Item(title: rel, subtitle: "Nested", path: url.path, group: project.name))
                        }
                    }
                }
            }
        case .memories:
            let projectsDir = "\(home)/.claude/projects"
            for slug in (try? fm.contentsOfDirectory(atPath: projectsDir))?.sorted() ?? [] {
                let memoryDir = projectsDir + "/" + slug + "/memory"
                guard let files = try? fm.contentsOfDirectory(atPath: memoryDir), !files.isEmpty else { continue }
                let group = slug.replacingOccurrences(of: "-", with: "/")
                    .replacingOccurrences(of: "//", with: "/.")
                for file in files.sorted() where file.hasSuffix(".md") {
                    let path = memoryDir + "/" + file
                    let firstLine = (try? String(contentsOfFile: path, encoding: .utf8))?
                        .split(separator: "\n")
                        .first(where: { $0.hasPrefix("description:") })
                        .map { $0.dropFirst(12).trimmingCharacters(in: .whitespaces) } ?? ""
                    items.append(Item(
                        title: file == "MEMORY.md" ? "📇 MEMORY.md (index)" : file,
                        subtitle: firstLine, path: path, group: group))
                }
            }
            items.sort { a, b in
                if a.group != b.group { return a.group < b.group }
                return a.title.contains("MEMORY.md") ? true
                    : b.title.contains("MEMORY.md") ? false : a.title < b.title
            }
        case .hooks:
            addIfExists("\(home)/.claude/settings.json",
                        title: "Global settings.json",
                        subtitle: hooksSummary("\(home)/.claude/settings.json"), group: "Global")
            for project in projects {
                addIfExists("\(project.path)/.claude/settings.json",
                            title: "settings.json",
                            subtitle: hooksSummary("\(project.path)/.claude/settings.json"),
                            group: project.name)
                addIfExists("\(project.path)/.claude/settings.local.json",
                            title: "settings.local.json",
                            subtitle: hooksSummary("\(project.path)/.claude/settings.local.json"),
                            group: project.name)
            }
            let hooksDir = "\(home)/.claude/hooks"
            for file in (try? fm.contentsOfDirectory(atPath: hooksDir))?.sorted() ?? [] {
                let path = hooksDir + "/" + file
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue {
                    items.append(Item(title: file, subtitle: "Hook script", path: path, group: "Hook scripts"))
                }
            }
        case .skills, .agents, .commands:
            let wanted: SkillInfo.Kind = category == .skills ? .skill
                : category == .agents ? .agent : .command
            var catalog = SkillCatalog.scan(projectPath: nil)
            for project in projects {
                catalog += SkillCatalog.scan(projectPath: project.path)
                    .filter { $0.source == .project }
            }
            var seen = Set<String>()
            for info in catalog where info.kind == wanted {
                guard seen.insert(info.path).inserted else { continue }
                items.append(Item(
                    title: info.name,
                    subtitle: info.description,
                    path: info.path,
                    group: info.source.rawValue.capitalized))
            }
        }
        return items
    }

    private static func hooksSummary(_ path: String) -> String {
        guard let data = FileManager.default.contents(atPath: path),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let hooks = obj["hooks"] as? [String: Any], !hooks.isEmpty
        else { return "No hooks" }
        return "Hooks: " + hooks.keys.sorted().joined(separator: ", ")
    }
}
