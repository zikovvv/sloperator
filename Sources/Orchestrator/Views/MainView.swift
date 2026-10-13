import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case sessions = "Sessions"
    case infra = "Claude Infra"
    case usage = "Usage"
    case prs = "Pull Requests"

    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .sessions: return "bubble.left.and.bubble.right"
        case .infra: return "books.vertical"
        case .usage: return "gauge.with.needle"
        case .prs: return "arrow.triangle.pull"
        }
    }
}

struct MainView: View {
    @EnvironmentObject var store: AppStore
    @State private var showReview = true

    private var tab: AppTab { store.tab }

    var body: some View {
        VStack(spacing: 0) {
            AuthBanner()
            content
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("", selection: $store.tab) {
                    ForEach(AppTab.allCases) { tab in
                        Label(tab.rawValue, systemImage: tab.symbol).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelStyle(.titleAndIcon)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .switchToSessionsTab)) { _ in
            store.tab = .sessions
        }
        .onReceive(NotificationCenter.default.publisher(for: .toggleReviewPanel)) { _ in
            withAnimation { showReview.toggle() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .lspProblem)) { note in
            // Navigation quietly doing nothing is worse than saying pyright is missing.
            if let message = note.object as? String { store.lastError = message }
        }
        .alert("Error", isPresented: Binding(
            get: { store.lastError != nil },
            set: { if !$0 { store.lastError = nil } }
        )) {
            Button("OK") { store.lastError = nil }
        } message: {
            Text(store.lastError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        Group {
            switch tab {
            case .sessions:
                NavigationSplitView {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 400)
                } detail: {
                    if let sessionID = store.selectedSessionID,
                       let binding = store.binding(for: sessionID) {
                        SessionDetailView(session: binding, showReview: $showReview)
                            .id(sessionID)
                    } else if let worktreeID = store.selectedWorktreeID,
                              let worktree = store.worktree(id: worktreeID) {
                        WorktreeDetailView(worktree: worktree)
                            .id(worktreeID)
                    } else {
                        EmptyStateView()
                    }
                }
            case .infra:
                InfraView()
            case .usage:
                UsageView()
            case .prs:
                PullRequestsView()
            }
        }
    }
}

struct SessionDetailView: View {
    @EnvironmentObject var store: AppStore
    @Binding var session: Session
    @Binding var showReview: Bool

    var body: some View {
        let worktree = store.worktree(for: session)
        VStack(spacing: 0) {
            HeaderBarView(session: $session, worktree: worktree, showReview: $showReview)
            Divider()
            HSplitView {
                ChatView(session: $session)
                    .frame(minWidth: 420)
                    .layoutPriority(1)
                if showReview, let worktree {
                    ReviewPanel(
                        workspacePath: worktree.path,
                        baseBranch: worktree.isMain ? nil : worktree.baseBranch,
                        sessionID: session.id)
                        // No idealWidth: it re-asserts itself on every content change and
                        // makes the panel jump around while a diff loads.
                        .frame(minWidth: 420)
                }
            }
        }
    }
}

struct EmptyStateView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 42))
                .foregroundStyle(.tertiary)
            Text("No session selected")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("Add a project with the + button in the sidebar,\nthen create a session inside it (⌘⇧N).")
                .font(.callout)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
