import SwiftUI

/// Changed files as a collapsible directory tree with per-file +/- stats.
struct DiffFileTree: View {
    let files: [DiffFile]
    @Binding var selection: String?
    @Binding var collapsedFolders: Set<String>

    private struct Node: Identifiable {
        var name: String
        var path: String          // folder path, or full file path for leaves
        var file: DiffFile?
        var children: [Node]
        var id: String { path }

        var added: Int { file?.added ?? children.reduce(0) { $0 + $1.added } }
        var removed: Int { file?.removed ?? children.reduce(0) { $0 + $1.removed } }
    }

    private var root: [Node] {
        var folders: [String: [DiffFile]] = [:]
        for file in files {
            let directory = (file.path as NSString).deletingLastPathComponent
            folders[directory, default: []].append(file)
        }
        // Flat folder rows keep deep paths readable without an N-level indent dance.
        return folders.keys.sorted().map { directory in
            Node(
                name: directory.isEmpty ? "." : directory,
                path: directory.isEmpty ? "." : directory,
                file: nil,
                children: (folders[directory] ?? [])
                    .sorted { $0.path < $1.path }
                    .map { file in
                        Node(name: (file.path as NSString).lastPathComponent,
                             path: file.path, file: file, children: [])
                    })
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 1) {
                ForEach(root) { folder in
                    folderRow(folder)
                    if !collapsedFolders.contains(folder.path) {
                        ForEach(folder.children) { leaf in
                            fileRow(leaf)
                        }
                    }
                }
                if files.isEmpty {
                    Text("No changes in this range.")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                        .padding(10)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func folderRow(_ folder: Node) -> some View {
        let collapsed = collapsedFolders.contains(folder.path)
        return Button {
            if collapsed { collapsedFolders.remove(folder.path) }
            else { collapsedFolders.insert(folder.path) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: "folder")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(folder.name)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer()
                stats(folder.added, folder.removed)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func fileRow(_ leaf: Node) -> some View {
        let selected = selection == leaf.path
        return Button {
            selection = leaf.path
        } label: {
            HStack(spacing: 6) {
                Text(statusLetter(leaf.file?.status ?? "M"))
                    .font(.caption2.weight(.bold).monospaced())
                    .foregroundStyle(statusColor(leaf.file?.status ?? "M"))
                    .frame(width: 12)
                Text(leaf.name)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                stats(leaf.added, leaf.removed)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .padding(.leading, 14)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(selected ? Color.accentColor.opacity(0.25) : .clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func stats(_ added: Int, _ removed: Int) -> some View {
        HStack(spacing: 4) {
            if added > 0 {
                Text("+\(added)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.green)
            }
            if removed > 0 {
                Text("−\(removed)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.red)
            }
        }
    }

    private func statusLetter(_ status: String) -> String {
        status == "??" ? "A" : status
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "A", "??": return .green
        case "D": return .red
        case "R": return .blue
        default: return .yellow
        }
    }
}
