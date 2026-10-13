import Foundation

struct PullRequest: Identifiable, Hashable {
    var number: Int
    var title: String
    var url: String
    var headRefName: String
    var baseRefName: String
    var isDraft: Bool
    var state: String
    var author: String
    var updatedAt: String
    var checks: String // "pass" | "fail" | "pending" | ""

    var id: Int { number }
}

struct ServiceError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum GitHubService {
    static func listPRs(projectPath: String) -> Result<[PullRequest], ServiceError> {
        guard let gh = ProcessRunner.findExecutable("gh") else {
            return .failure(ServiceError(message: "GitHub CLI (`gh`) not found on PATH."))
        }
        let result = Shell.run(gh, [
            "pr", "list", "--limit", "50", "--state", "open",
            "--json", "number,title,url,headRefName,baseRefName,isDraft,state,author,updatedAt,statusCheckRollup",
        ], cwd: projectPath)
        guard result.ok else {
            let err = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return .failure(ServiceError(message: err.isEmpty ? "gh pr list failed" : err))
        }
        guard let data = result.stdout.data(using: .utf8),
              let array = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        else {
            return .failure(ServiceError(message: "Could not parse gh output"))
        }
        let prs = array.compactMap { obj -> PullRequest? in
            guard let number = obj["number"] as? Int,
                  let title = obj["title"] as? String,
                  let url = obj["url"] as? String
            else { return nil }
            var checks = ""
            if let rollup = obj["statusCheckRollup"] as? [[String: Any]], !rollup.isEmpty {
                let conclusions = rollup.compactMap {
                    ($0["conclusion"] as? String) ?? ($0["state"] as? String)
                }.map { $0.uppercased() }
                if conclusions.contains(where: { $0 == "FAILURE" || $0 == "ERROR" }) {
                    checks = "fail"
                } else if conclusions.contains(where: { $0 == "" || $0 == "PENDING" || $0 == "IN_PROGRESS" || $0 == "QUEUED" }) {
                    checks = "pending"
                } else {
                    checks = "pass"
                }
            }
            return PullRequest(
                number: number,
                title: title,
                url: url,
                headRefName: obj["headRefName"] as? String ?? "",
                baseRefName: obj["baseRefName"] as? String ?? "",
                isDraft: obj["isDraft"] as? Bool ?? false,
                state: obj["state"] as? String ?? "",
                author: ((obj["author"] as? [String: Any])?["login"] as? String) ?? "",
                updatedAt: obj["updatedAt"] as? String ?? "",
                checks: checks)
        }
        return .success(prs)
    }
}
