import Testing
import Foundation
@testable import Orchestrator

@Suite("Unified diff parsing")
struct DiffParserTests {
    @Test("Line-number gutters follow both sides of a hunk")
    func gutters() {
        let diff = """
        diff --git a/app.py b/app.py
        index 111..222 100644
        --- a/app.py
        +++ b/app.py
        @@ -10,4 +10,5 @@ def greet():
         context one
        -removed line
        +added line
        +second added
         context two
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        let lines = files[0].hunks.flatMap(\.lines).filter { $0.kind != .hunkHeader }
        // old side: 10 (context), 11 (removed), then 12 for the trailing context
        #expect(lines[0].oldLine == 10)
        #expect(lines[0].newLine == 10)
        #expect(lines[1].kind == .deletion)
        #expect(lines[1].oldLine == 11)
        #expect(lines[1].newLine == nil)
        #expect(lines[2].kind == .addition)
        #expect(lines[2].newLine == 11)
        #expect(lines[2].oldLine == nil)
        #expect(lines[3].newLine == 12)
        #expect(lines[4].oldLine == 12)
        #expect(lines[4].newLine == 13)
        #expect(files[0].added == 2)
        #expect(files[0].removed == 1)
    }

    @Test("A new file is reported as added, not modified")
    func newFile() {
        let diff = """
        diff --git a/notes.md b/notes.md
        new file mode 100644
        index 000..2c3 100644
        --- /dev/null
        +++ b/notes.md
        @@ -0,0 +1,2 @@
        +one
        +two
        """
        let files = DiffParser.parse(diff)
        #expect(files.first?.status == "A")
        #expect(files.first?.added == 2)
    }

    @Test("Deletions and renames keep their status")
    func deletionsAndRenames() {
        let diff = """
        diff --git a/gone.txt b/gone.txt
        deleted file mode 100644
        --- a/gone.txt
        +++ /dev/null
        @@ -1,1 +0,0 @@
        -bye
        diff --git a/old.txt b/new.txt
        similarity index 90%
        rename from old.txt
        rename to new.txt
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 2)
        #expect(files[0].status == "D")
        #expect(files[1].status == "R")
        #expect(files[1].oldPath == "old.txt")
    }

    @Test("Binary files are flagged instead of parsed as text")
    func binary() {
        let diff = """
        diff --git a/logo.png b/logo.png
        index 111..222 100644
        Binary files a/logo.png and b/logo.png differ
        """
        #expect(DiffParser.parse(diff).first?.isBinary == true)
    }

    @Test("'\\ No newline at end of file' is not treated as a diff line")
    func noNewlineMarker() {
        let diff = """
        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1,1 +1,1 @@
        -old
        \\ No newline at end of file
        +new
        \\ No newline at end of file
        """
        let files = DiffParser.parse(diff)
        let lines = files[0].hunks.flatMap(\.lines).filter { $0.kind != .hunkHeader }
        #expect(lines.count == 2)
        #expect(files[0].added == 1)
        #expect(files[0].removed == 1)
    }

    @Test("Multiple hunks in one file each get their own numbering")
    func multipleHunks() {
        let diff = """
        diff --git a/a.swift b/a.swift
        --- a/a.swift
        +++ b/a.swift
        @@ -1,2 +1,2 @@
         alpha
        -beta
        +BETA
        @@ -50,2 +50,3 @@
         gamma
        +delta
        """
        let files = DiffParser.parse(diff)
        #expect(files[0].hunks.count == 2)
        let second = files[0].hunks[1].lines.filter { $0.kind != .hunkHeader }
        #expect(second[0].oldLine == 50)
        #expect(second[1].newLine == 51)
    }

    @Test("Empty diff yields no files rather than a phantom entry")
    func emptyDiff() {
        #expect(DiffParser.parse("").isEmpty)
        #expect(DiffParser.parse("\n").isEmpty)
    }
}
