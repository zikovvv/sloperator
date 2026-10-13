import SwiftUI
import AppKit

struct PullRequestsView: View {
    @EnvironmentObject var store: AppStore
    @State private var selectedProjectID: UUID? = nil
    @State private var prs: [PullRequest] = []
    @State private var error: String? = nil
    @State private var loading = false

    private var selectedProject: Project? {
        store.projects.first { $0.id == selectedProjectID } ?? store.projects.first
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Project", selection: Binding(
                    get: { selectedProject?.id },
                    set: { selectedProjectID = $0 }
                )) {
                    ForEach(store.projects) { project in
                        Text(project.name).tag(Optional(project.id))
                    }
                }
                .frame(maxWidth: 300)
                Spacer()
                if loading { ProgressView().controlSize(.small) }
                Button {
                    refresh()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }
            .padding(10)
            Divider()

            if let error {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.title)
                        .foregroundStyle(.orange)
                    Text(error)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if prs.isEmpty && !loading {
                Text("No open pull requests.")
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(prs) { pr in
                    HStack(spacing: 10) {
                        checkIcon(pr)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text("#\(pr.number)")
                                    .font(.callout.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                Text(pr.title)
                                    .fontWeight(.medium)
                                    .lineLimit(1)
                                if pr.isDraft {
                                    Text("draft")
                                        .font(.caption2)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(Capsule().fill(Color.secondary.opacity(0.2)))
                                }
                            }
                            HStack(spacing: 8) {
                                Label(pr.headRefName, systemImage: "arrow.triangle.branch")
                                Text(pr.author)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Open") {
                            if let url = URL(string: pr.url) {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.link)
                    }
                    .padding(.vertical, 3)
                    .contextMenu {
                        Button("Open in Browser") {
                            if let url = URL(string: pr.url) { NSWorkspace.shared.open(url) }
                        }
                        Button("Copy URL") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(pr.url, forType: .string)
                        }
                        if let project = selectedProject {
                            Button("Start Review Session (checks out this PR)") {
                                store.startPRReview(
                                    project: project, prNumber: pr.number,
                                    title: pr.title, baseBranch: pr.baseRefName)
                            }
                        }
                    }
                }
                .listStyle(.inset)
            }
        }
        .onAppear(perform: refresh)
        .onChange(of: selectedProjectID) { refresh() }
    }

    private func checkIcon(_ pr: PullRequest) -> some View {
        Group {
            switch pr.checks {
            case "pass":
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case "fail":
                Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
            case "pending":
                Image(systemName: "clock.fill").foregroundStyle(.orange)
            default:
                Image(systemName: "circle.dashed").foregroundStyle(.secondary)
            }
        }
        .help("CI: \(pr.checks.isEmpty ? "no checks" : pr.checks)")
    }

    private func refresh() {
        guard let project = selectedProject else { return }
        loading = true
        error = nil
        DispatchQueue.global(qos: .userInitiated).async {
            let result = GitHubService.listPRs(projectPath: project.path)
            DispatchQueue.main.async {
                loading = false
                switch result {
                case .success(let list): prs = list
                case .failure(let serviceError):
                    prs = []
                    error = serviceError.message
                }
            }
        }
    }
}

extension Notification.Name {
    static let switchToSessionsTab = Notification.Name("switchToSessionsTab")
}
