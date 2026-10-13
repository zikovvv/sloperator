import SwiftUI

@main
struct OrchestratorApp: App {
    @StateObject private var store = AppStore()
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup(Self.windowTitle) {
            MainView()
                .environmentObject(store)
                .frame(minWidth: 1100, minHeight: 700)
                .onAppear { appDelegate.store = store }
        }
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Session") {
                    NotificationCenter.default.post(name: .newSessionRequested, object: nil)
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                Button("New Worktree") {
                    NotificationCenter.default.post(name: .newWorktreeRequested, object: nil)
                }
                .keyboardShortcut("n", modifiers: [.command, .option])
            }
            CommandGroup(after: .toolbar) {
                Button("Sessions") { store.tab = .sessions }
                    .keyboardShortcut("1", modifiers: .command)
                Button("Claude Infra") { store.tab = .infra }
                    .keyboardShortcut("2", modifiers: .command)
                Button("Usage") { store.tab = .usage }
                    .keyboardShortcut("3", modifiers: .command)
                Button("Pull Requests") { store.tab = .prs }
                    .keyboardShortcut("4", modifiers: .command)
                Divider()
                Button("Toggle Review Panel") {
                    NotificationCenter.default.post(name: .toggleReviewPanel, object: nil)
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
            }
            CommandMenu("Agents") {
                Button("Stop Current Turn") {
                    if let id = store.selectedSessionID { store.stop(sessionID: id) }
                }
                .keyboardShortcut(".", modifiers: .command)

                Button("Stop All Running Agents") { store.stopAllRunning() }
                    .keyboardShortcut(".", modifiers: [.command, .option])

                Divider()
                Button("Next Session Needing Attention") { store.selectNextNeedingAttention() }
                    .keyboardShortcut("a", modifiers: [.command, .shift])
                Button("Next Session") { store.selectSession(offset: 1) }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                Button("Previous Session") { store.selectSession(offset: -1) }
                    .keyboardShortcut("[", modifiers: [.command, .shift])

                Divider()
                Button("Focus Composer") {
                    NotificationCenter.default.post(name: .focusComposer, object: nil)
                }
                .keyboardShortcut("l", modifiers: .command)
            }
        }
        Settings {
            SettingsView()
                .environmentObject(store)
        }
    }
}

extension OrchestratorApp {
    /// The build is in the title on purpose: "did my rebuild actually reach the app I just
    /// launched?" is otherwise unanswerable from the UI.
    static var windowTitle: String {
        let info = Bundle.main.infoDictionary
        guard let build = info?["CFBundleShortVersionString"] as? String,
              let commit = info?["CFBundleVersion"] as? String
        else { return "Orchestrator (unbundled dev build)" }
        return "Orchestrator — \(build) · \(commit)"
    }
}

extension Notification.Name {
    static let newSessionRequested = Notification.Name("newSessionRequested")
    static let newWorktreeRequested = Notification.Name("newWorktreeRequested")
    static let openFileInReview = Notification.Name("openFileInReview")
    static let focusComposer = Notification.Name("focusComposer")
    static let toggleReviewPanel = Notification.Name("toggleReviewPanel")
    static let lspProblem = Notification.Name("lspProblem")
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var store: AppStore?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Needed when launched via `swift run` (no bundle): show a real UI app.
        NSApp.setActivationPolicy(.regular)
        // Only steal focus when unbundled; `open -g` must stay in the background.
        if Bundle.main.bundleIdentifier == nil {
            NSApp.activate(ignoringOtherApps: true)
        }
        // Kill agents left over from a previous instance that was hard-killed.
        ProcessJanitor.shared.reapOrphans()
    }

    /// Quitting kills every running agent, so make an accidental ⌘Q recoverable.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let store, !store.runningSessions.isEmpty else { return .terminateNow }
        let count = store.runningSessions.count
        let alert = NSAlert()
        alert.messageText = "\(count) agent\(count == 1 ? " is" : "s are") still working"
        alert.informativeText = "Quitting stops \(count == 1 ? "it" : "them") immediately. "
            + "Any work not yet written to disk is lost."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit and Stop \(count == 1 ? "Agent" : "Agents")")
        alert.addButton(withTitle: "Keep Working")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Drafts and queued messages are only written by save(); without this they are lost
        // whenever the last keystroke was not followed by some unrelated save.
        store?.save()
        ProcessJanitor.shared.killAll()
    }
}
