import Testing
@testable import Orchestrator

@Test func fuzzyMatchFindsSubsequence() {
    #expect(FuzzyMatch.score("feature/bar-baz", query: "fbz") != nil)
}
