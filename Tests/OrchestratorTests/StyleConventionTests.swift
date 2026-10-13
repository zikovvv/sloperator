import Testing
import Foundation

/// A `ButtonStyle` (or `LabelStyle`, `ToggleStyle`, …) is not a `View`, so a property wrapper
/// that needs view identity — @State, @StateObject, @GestureState, @FocusState — has no storage
/// attached to anything. SwiftUI's behaviour is then undefined; in this app it showed up as
/// buttons intermittently drawing filled/black. Hover state belongs in a nested View.
@Suite("SwiftUI style conventions")
struct StyleConventionTests {
    private var sourcesDirectory: URL {
        URL(fileURLWithPath: #filePath)          // Tests/OrchestratorTests/ThisFile.swift
            .deletingLastPathComponent()          // Tests/OrchestratorTests
            .deletingLastPathComponent()          // Tests
            .deletingLastPathComponent()          // repo root
            .appendingPathComponent("Sources")
    }

    private func swiftFiles() throws -> [URL] {
        guard let walker = FileManager.default.enumerator(
            at: sourcesDirectory, includingPropertiesForKeys: nil) else { return [] }
        return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    @Test("No style type declares view state directly")
    func stylesDoNotHoldViewState() throws {
        let styleProtocols = ["ButtonStyle", "LabelStyle", "ToggleStyle", "MenuStyle",
                              "ProgressViewStyle", "TextFieldStyle"]
        let viewStateWrappers = ["@State", "@StateObject", "@GestureState", "@FocusState"]
        var offenders: [String] = []

        for file in try swiftFiles() {
            let text = try String(contentsOf: file, encoding: .utf8)
            let lines = text.components(separatedBy: "\n")
            var depth = 0
            var insideStyleAtDepth: Int? = nil

            for line in lines {
                let declaresStyle = line.contains("struct ")
                    && styleProtocols.contains { line.contains(": \($0)") }
                if declaresStyle, insideStyleAtDepth == nil { insideStyleAtDepth = depth }

                // A nested View inside the style is the correct place for state, so stop
                // flagging once we descend into one.
                let opensNestedView = line.contains("struct ") && line.contains(": View")

                if let styleDepth = insideStyleAtDepth, !opensNestedView,
                   depth == styleDepth + 1,
                   viewStateWrappers.contains(where: { line.contains($0) }) {
                    offenders.append("\(file.lastPathComponent): \(line.trimmingCharacters(in: .whitespaces))")
                }

                depth += line.filter { $0 == "{" }.count
                depth -= line.filter { $0 == "}" }.count
                if let styleDepth = insideStyleAtDepth, depth <= styleDepth {
                    insideStyleAtDepth = nil
                }
            }
        }
        #expect(offenders.isEmpty, "view state declared on a style type: \(offenders)")
    }
}
