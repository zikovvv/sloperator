import SwiftUI
import AppKit

struct SettingsView: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        Form {
            Section("Worktrees") {
                LabeledContent("Location") {
                    HStack {
                        Text(store.settings.worktreeRootOverride ?? "~/.orchestrator/worktrees")
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Button("Change…") { pickWorktreeRoot() }
                        if store.settings.worktreeRootOverride != nil {
                            Button("Reset") { store.settings.worktreeRootOverride = nil }
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Worktrees are never deleted automatically")
                    Text("Nothing recycles them: closing sessions, removing them from the sidebar and archiving all leave the folder untouched. The only way one is destroyed is the red Delete button on its page, which asks for confirmation first.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Codex pricing (per 1M tokens, for cost display)") {
                priceField("Input", $store.settings.codexInputPerMTok)
                priceField("Cached input", $store.settings.codexCachedInputPerMTok)
                priceField("Output", $store.settings.codexOutputPerMTok)
                Text("Claude sessions report exact cost from the CLI; these rates only price Codex token usage.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 560, height: 420)
    }

    private func priceField(_ label: String, _ value: Binding<Double>) -> some View {
        LabeledContent(label) {
            TextField("", value: value, format: .number.precision(.fractionLength(0...4)))
                .frame(width: 90)
                .multilineTextAlignment(.trailing)
        }
    }

    private func pickWorktreeRoot() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Use as Worktree Root"
        if panel.runModal() == .OK, let url = panel.url {
            store.settings.worktreeRootOverride = url.path
        }
    }
}
