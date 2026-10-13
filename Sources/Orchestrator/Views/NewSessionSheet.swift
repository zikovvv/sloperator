import SwiftUI

/// Worktree creation with real choices: name, which branch, and what it forks from.
/// The one-click sidebar button skips all of this.
struct NewWorktreeSheet: View {
    @EnvironmentObject var store: AppStore
    @Environment(\.dismiss) var dismiss
    let project: Project

    private enum BranchMode: String, CaseIterable, Identifiable {
        case new = "New branch"
        case existing = "Existing branch"
        var id: String { rawValue }
    }

    @State private var name = ""
    @State private var mode: BranchMode = .new
    @State private var newBranch = ""
    @State private var existingBranch = ""
    @State private var base = ""
    @State private var branches: [String] = []
    @State private var inUse: Set<String> = []
    @State private var moveCurrentWork = false
    @State private var branchesLoading = true

    private var availableExisting: [String] {
        branches.filter { !inUse.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New worktree in \(project.name)")
                .font(.headline)

            LabeledContent("Name") {
                TextField("optional — defaults to the branch name", text: $name)
            }

            Picker("Branch", selection: $mode) {
                ForEach(BranchMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            switch mode {
            case .new:
                LabeledContent("New branch") {
                    TextField("orch/my-work", text: $newBranch)
                }
                LabeledContent("Fork from") {
                    BranchPicker(
                        branches: branches, selection: $base, noneLabel: "Current HEAD",
                        placeholder: "Search \(branches.count) branches…",
                        isLoading: branchesLoading)
                }
            case .existing:
                LabeledContent("Check out") {
                    BranchPicker(
                        branches: availableExisting, selection: $existingBranch,
                        placeholder: "Search \(availableExisting.count) branches…",
                        isLoading: branchesLoading)
                }
                if availableExisting.isEmpty {
                    Text("Every local branch is already checked out in another worktree.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }

            Toggle(isOn: $moveCurrentWork) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Move current uncommitted work into it")
                    Text("Stashes what's dirty in the main checkout and re-applies it here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Lives under \(store.settings.worktreeRootOverride ?? "~/.orchestrator/worktrees") — never recycled automatically.")
                .font(.caption)
                .foregroundStyle(.tertiary)

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create Worktree", action: create)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(!project.isGit || (mode == .existing && existingBranch.isEmpty))
            }
        }
        .padding(20)
        .frame(width: 520)
        .onAppear(perform: loadBranches)
    }

    private func create() {
        let branch = mode == .new
            ? newBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            : existingBranch
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        store.createWorktree(
            project: project,
            name: label.isEmpty ? branch.replacingOccurrences(of: "/", with: "-") : label,
            moveCurrentWork: moveCurrentWork,
            branch: branch.isEmpty ? nil : branch,
            base: mode == .new && !base.isEmpty ? base : nil,
            checkoutExisting: mode == .existing)
        dismiss()
    }

    private func loadBranches() {
        let path = project.path
        DispatchQueue.global(qos: .userInitiated).async {
            let all = GitService.branches(path)
            let used = GitService.branchesInUse(path)
            DispatchQueue.main.async {
                branches = all
                inUse = used
                branchesLoading = false
            }
        }
    }
}
