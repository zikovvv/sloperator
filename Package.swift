// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Orchestrator",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Orchestrator",
            path: "Sources/Orchestrator"
        ),
        .testTarget(
            name: "OrchestratorTests",
            dependencies: ["Orchestrator"],
            path: "Tests/OrchestratorTests"
        ),
    ]
)
