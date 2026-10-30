import Foundation

/// The Studio's Node server, run as a child of the app.
///
/// The web UI is the same one `rm-studio` serves to a browser. The app owns the
/// process: it picks a free port, starts Node, waits until the page answers, and
/// stops it on quit. If the app dies first, the server sees its parent go
/// (`RM_STUDIO_PARENT_PID`) and exits on its own.
@MainActor
final class StudioServer: ObservableObject {
    enum State: Equatable {
        case starting
        case ready(URL)
        case failed(String)
    }

    @Published private(set) var state: State = .starting

    private var process: Process?
    private var logHandle: FileHandle?

    static let logURL: URL = {
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Logs/RoleModel Studio", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        return logs.appending(path: "studio.log")
    }()

    func start() {
        stop()
        state = .starting

        guard let toolkit = Self.toolkitURL() else {
            state = .failed("The Studio's files are missing from the app. Reinstall RoleModel Studio.")
            return
        }
        guard let node = Self.nodeURL() else {
            state = .failed("Node is missing from the app. Reinstall RoleModel Studio.")
            return
        }
        guard let port = Self.freePort() else {
            state = .failed("No free port to run the Studio on.")
            return
        }

        FileManager.default.createFile(atPath: Self.logURL.path, contents: nil)
        let log = try? FileHandle(forWritingTo: Self.logURL)
        logHandle = log

        let process = Process()
        process.executableURL = node
        process.currentDirectoryURL = toolkit
        var arguments = [toolkit.appending(path: "bin/rm-studio.mjs").path, "--port", String(port), "--no-open"]
        if Bundle.main.url(forResource: "toolkit", withExtension: nil) != nil {
            // An installed copy never changes under itself, so it needs no watcher.
            arguments.append("--no-watch")
        }
        process.arguments = arguments
        process.environment = Self.environment(node: node)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log ?? FileHandle.nullDevice
        process.standardError = log ?? FileHandle.nullDevice
        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            Task { @MainActor in self?.processEnded(finished, status: status) }
        }

        do {
            try process.run()
        } catch {
            state = .failed("Node did not start: \(error.localizedDescription)")
            return
        }
        self.process = process

        let url = URL(string: "http://127.0.0.1:\(port)/")!
        Task { await waitUntilReady(url, process: process) }
    }

    func stop() {
        guard let process, process.isRunning else { return }
        process.terminationHandler = nil
        process.terminate()
        process.waitUntilExit()
        self.process = nil
        try? logHandle?.close()
        logHandle = nil
    }

    private func waitUntilReady(_ url: URL, process: Process) async {
        let deadline = Date().addingTimeInterval(60)
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        while Date() < deadline, process.isRunning, self.process === process {
            if let (_, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200 {
                state = .ready(url)
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        if self.process === process, process.isRunning {
            state = .failed("The Studio did not answer within a minute.\n\n\(Self.logTail())")
        }
    }

    private func processEnded(_ finished: Process, status: Int32) {
        guard process === finished else { return }
        process = nil
        state = .failed("The Studio stopped (exit \(status)).\n\n\(Self.logTail())")
    }

    // MARK: - Finding things

    /// The toolkit inside the app, or — in a Debug build — the checkout this file is in.
    static func toolkitURL() -> URL? {
        if let bundled = Bundle.main.url(forResource: "toolkit", withExtension: nil) {
            return bundled
        }
        #if DEBUG
        let checkout = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: checkout.appending(path: "bin/rm-studio.mjs").path) {
            return checkout
        }
        #endif
        return nil
    }

    /// The Node inside the app, or one on this Mac in a Debug build.
    static func nodeURL() -> URL? {
        if let bundled = Bundle.main.url(forResource: "node", withExtension: nil, subdirectory: "runtime") {
            return bundled
        }
        #if DEBUG
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.nodenv/shims/node"]
        if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return URL(fileURLWithPath: found)
        }
        #endif
        return nil
    }

    /// A launched app gets a bare PATH. Homebrew's folders are where ffmpeg and
    /// the other tools the Studio runs live; the app's own Node goes first so a
    /// child that runs `node` gets the same one.
    static func environment(node: URL) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let path = [
            node.deletingLastPathComponent().path,
            "/opt/homebrew/bin", "/usr/local/bin",
            env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        env["PATH"] = path.joined(separator: ":")
        env["RM_STUDIO_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        env["RM_STUDIO_HOST"] = "mac"
        return env
    }

    /// Ask the kernel for a port nobody holds, then give it back for Node to take.
    static func freePort() -> Int? {
        let socketFD = socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else { return nil }
        defer { close(socketFD) }

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketFD, $0, length) == 0 && getsockname(socketFD, $0, &length) == 0
            }
        }
        return bound ? Int(UInt16(bigEndian: address.sin_port)) : nil
    }

    static func logTail(lines: Int = 12) -> String {
        guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
        return text.split(separator: "\n").suffix(lines).joined(separator: "\n")
    }
}
