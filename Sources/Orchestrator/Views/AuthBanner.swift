import SwiftUI

/// App-wide prompt shown whenever an engine's credentials are dead or about to be.
/// One click opens Terminal on the right login command; the command is also copied.
struct AuthBanner: View {
    @EnvironmentObject var store: AppStore

    var body: some View {
        let problems = store.authProblems
        if !problems.isEmpty && !store.authBannerDismissed {
            VStack(spacing: 0) {
                ForEach(problems, id: \.engine) { problem in
                    row(engine: problem.engine, state: problem.state)
                }
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private func row(engine: EngineKind, state: AuthState) -> some View {
        let tint = Color.red

        return HStack(spacing: 10) {
            Image(systemName: "lock.trianglebadge.exclamationmark.fill")
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(state.message(for: engine))
                    .font(.callout.weight(.medium))
                Text(engine == .claude ? "Runs `claude auth login` in Terminal." : "Runs `codex login` in Terminal.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Re-authenticate") {
                store.startLogin(for: engine)
            }
            .buttonStyle(.borderedProminent)
            .tint(tint)
            Button("Re-check") {
                store.refreshAuthStates()
            }
            Button {
                withAnimation { store.authBannerDismissed = true }
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .help("Hide until the next failure")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(tint.opacity(0.14))
        .overlay(alignment: .bottom) {
            Rectangle().fill(tint.opacity(0.35)).frame(height: 1)
        }
    }
}
