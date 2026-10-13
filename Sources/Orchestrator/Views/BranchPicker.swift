import SwiftUI

/// fzf-style subsequence scoring: "fbz" matches "feature/bar-baz", and consecutive runs,
/// word boundaries and prefixes all score higher so the obvious candidate lands on top.
enum FuzzyMatch {
    static func score(_ candidate: String, query: String) -> Int? {
        guard !query.isEmpty else { return 0 }
        let haystack = Array(candidate.lowercased())
        let needle = Array(query.lowercased())

        // A literal substring is always the best kind of match.
        if let range = candidate.lowercased().range(of: query.lowercased()) {
            let offset = candidate.distance(from: candidate.startIndex, to: range.lowerBound)
            return 1000 - offset - candidate.count / 4
        }

        var score = 0
        var hIndex = 0
        var lastMatch = -1
        for needleChar in needle {
            var found = false
            while hIndex < haystack.count {
                let current = haystack[hIndex]
                hIndex += 1
                guard current == needleChar else { continue }
                if lastMatch == hIndex - 2 { score += 8 }          // consecutive
                if hIndex - 1 == 0 { score += 12 }                  // prefix
                else if "/-_. ".contains(haystack[hIndex - 2]) { score += 10 } // word start
                lastMatch = hIndex - 1
                found = true
                break
            }
            guard found else { return nil }
        }
        return score - candidate.count / 8
    }

    static func rank(_ candidates: [String], query: String) -> [String] {
        guard !query.isEmpty else { return candidates }
        return candidates
            .compactMap { candidate in
                score(candidate, query: query).map { (candidate, $0) }
            }
            .sorted {
                $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.count < $1.0.count
            }
            .map(\.0)
    }
}

/// Searchable branch chooser — a plain Picker is useless with hundreds of branches.
struct BranchPicker: View {
    let branches: [String]
    @Binding var selection: String
    var noneLabel: String? = nil
    var placeholder = "Search branches…"
    var isLoading = false

    @State private var open = false
    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var searchFocused: Bool

    private var matches: [String] {
        let ranked = FuzzyMatch.rank(branches, query: query)
        return Array(ranked.prefix(200))
    }

    var body: some View {
        Button {
            open.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(selection.isEmpty ? (noneLabel ?? "Choose a branch…") : selection)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(selection.isEmpty ? .secondary : .primary)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.06))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $open, arrowEdge: .bottom) {
            picker
        }
    }

    private var picker: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(placeholder, text: $query)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .onSubmit(commitHighlighted)
                    .onKeyPress(.downArrow) { move(1) }
                    .onKeyPress(.upArrow) { move(-1) }
                    .onKeyPress(.escape) { open = false; return .handled }
                if !query.isEmpty {
                    Button {
                        query = ""
                        highlighted = 0
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let noneLabel {
                            rowView(value: "", label: noneLabel, index: -1)
                        }
                        ForEach(Array(matches.enumerated()), id: \.element) { index, branch in
                            rowView(value: branch, label: branch, index: index)
                                .id(index)
                        }
                        if isLoading && branches.isEmpty {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("Reading branches…")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(10)
                        } else if matches.isEmpty && !query.isEmpty {
                            Text("No branch matches “\(query)”")
                                .font(.callout)
                                .foregroundStyle(.tertiary)
                                .padding(10)
                        } else if branches.isEmpty {
                            Text("No branches found in this repository.")
                                .font(.callout)
                                .foregroundStyle(.tertiary)
                                .padding(10)
                        }
                    }
                }
                .frame(height: 280)
                .onChange(of: highlighted) {
                    proxy.scrollTo(highlighted, anchor: .center)
                }
            }
            Divider()
            HStack {
                Text(isLoading && branches.isEmpty
                     ? "loading…" : "\(matches.count) of \(branches.count)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
                Text("↑↓ then ⏎")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
        }
        .frame(width: 420)
        .onAppear {
            query = ""
            highlighted = 0
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { searchFocused = true }
        }
    }

    private func rowView(value: String, label: String, index: Int) -> some View {
        Button {
            selection = value
            open = false
        } label: {
            HStack(spacing: 6) {
                if value == selection {
                    Image(systemName: "checkmark")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 12)
                } else {
                    Spacer().frame(width: 12)
                }
                Text(label)
                    .font(value.isEmpty ? .callout.italic() : .system(.callout, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                if value.hasPrefix("origin/") {
                    Text("remote")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(index == highlighted ? Color.accentColor.opacity(0.25) : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func move(_ delta: Int) -> KeyPress.Result {
        guard !matches.isEmpty else { return .ignored }
        let lower = noneLabel == nil ? 0 : -1
        highlighted = max(lower, min(matches.count - 1, highlighted + delta))
        return .handled
    }

    private func commitHighlighted() {
        if highlighted < 0 {
            selection = ""
        } else if matches.indices.contains(highlighted) {
            selection = matches[highlighted]
        }
        open = false
    }
}
