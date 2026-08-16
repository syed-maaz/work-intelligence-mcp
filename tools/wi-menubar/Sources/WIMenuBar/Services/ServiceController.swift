//
//  ServiceController.swift
//
//  Spawns and stops the subprocess for a single service (bridge | web | docs).
//
//  Design constraints:
//   * One controller instance per service. Owns at most one running Process.
//   * Logs go to ~/Library/Logs/wi-menubar/<service>.log (append). Stdout and
//     stderr are merged into the same file. No rotation in v1 — we just keep
//     appending. A ring buffer / daily rotation can come in Phase 1.5 if log
//     size becomes a problem in practice.
//   * We do NOT inherit our process's environment blindly. Instead we set up
//     a minimal env block (PATH + HOME + a small allowlist) and let the
//     spawned command load .env via node --env-file. This avoids leaking the
//     menubar app's quirky env into long-running services.
//   * The repo root is fixed at compile time via WI_REPO_ROOT. We resolve it
//     once on the main actor by climbing up from this file's path.
//
//  Lifecycle from the user's POV:
//   * Click "Connect"  -> spawn child, status: starting, poller takes over
//                         and flips to running on first healthy probe
//   * Click "Stop"     -> SIGTERM the child, wait up to 3s, then SIGKILL
//   * App quit         -> coordinator stops all controllers in reverse order
//

import Foundation

final class ServiceController {

    // MARK: - Service definition

    /// Static config for one service. Keeps the spawn details next to the data
    /// so adding a 4th service later is a single struct value, not scattered
    /// switch statements.
    struct Definition {
        let id: String              // "bridge" | "web" | "docs"
        let displayName: String
        let port: Int

        /// The shell command we run from `workingDirectory`. Used only when
        /// `executable` is nil (legacy path); otherwise we invoke
        /// `executable` with `arguments` directly and skip the shell entirely
        /// to avoid PATH races between Homebrew node and nvm node.
        let shellCommand: String

        /// Absolute working directory for the spawned process.
        let workingDirectory: String

        /// HTTP probe path the poller hits (e.g. "/api/status" or "/").
        let healthPath: String

        /// If true, probe with GET. If false, HEAD. Some dev servers (Vite)
        /// don't implement HEAD correctly and 404, so we GET those.
        let probeWithGET: Bool

        /// Optional direct executable. When set, spawn this binary with
        /// `arguments` and skip the login-shell wrapper. We use this for
        /// the bridge so we can pin nvm's Node 24 (ABI 137) instead of
        /// inheriting Homebrew's Node 26 (ABI 147) via /bin/zsh -lc.
        let executable: String?

        /// Argument list when `executable` is set.
        let arguments: [String]

        /// Extra env vars to inject (on top of the inherited allowlist).
        /// Used to set SKIP_SYNC=1 for the bridge without needing the shell
        /// to parse it.
        let extraEnv: [String: String]
    }

    // MARK: - Static factory: the three services for this repo

    /// Build the three controllers we care about, anchored at `repoRoot`.
    /// `repoRoot` is the absolute path to work-intelligence-mcp/.
    static func defaultControllers(repoRoot: String, logDirectory: String) -> [ServiceController] {
        // Resolve the user's preferred node binary once. If NvmResolver returns
        // nil we fall back to bare "node" via the shell — that path will likely
        // fail with the ABI mismatch, but at least the failure will be in the
        // log alongside an explicit NvmResolver warning explaining why.
        let nodePath = NvmResolver.nodePath
        // npm lives in the same bin directory as the chosen node.
        let npmPath: String? = nodePath.map { (path: String) -> String in
            // /Users/.../v24.7.0/bin/node -> /Users/.../v24.7.0/bin/npm
            let dir = (path as NSString).deletingLastPathComponent
            return "\(dir)/npm"
        }

        let defs: [Definition] = [
            Definition(
                id: "bridge",
                displayName: "Bridge",
                port: 3132,
                // shellCommand is the fallback only (used when executable == nil).
                shellCommand: "SKIP_SYNC=1 exec node --env-file=.env web-server.js",
                workingDirectory: repoRoot,
                healthPath: "/api/status",
                probeWithGET: true,
                // Direct invocation: this is the fix for the Node 26 ABI 147
                // vs better-sqlite3 ABI 137 crash. By naming the exact node
                // binary we want, we bypass the /bin/zsh -lc PATH race that
                // let Homebrew node 26 win over nvm node 24.
                executable: nodePath,
                arguments: ["--env-file=.env", "web-server.js"],
                extraEnv: ["SKIP_SYNC": "1"]
            ),
            Definition(
                id: "web",
                displayName: "Web UI",
                port: 5175,
                shellCommand: "npm run dev",
                workingDirectory: repoRoot + "/web",
                healthPath: "/",
                probeWithGET: true,
                // Pin npm too so vite spawns the right node for its own
                // dev-server child. Vite/esbuild don't load better-sqlite3
                // so the ABI mismatch wouldn't crash them directly, but
                // consistency keeps surprises away.
                executable: npmPath,
                arguments: ["run", "dev"],
                extraEnv: [:]
            ),
            Definition(
                id: "docs",
                displayName: "Docs",
                port: 3000,
                shellCommand: "npm start",
                workingDirectory: repoRoot + "/docs",
                healthPath: "/",
                probeWithGET: true,
                executable: npmPath,
                arguments: ["start"],
                extraEnv: [:]
            )
        ]
        return defs.map { ServiceController(definition: $0, logDirectory: logDirectory) }
    }

    // MARK: - Instance state

    let definition: Definition
    private let logDirectory: String

    /// Currently-running child process, if we spawned one. Stays non-nil from
    /// `start()` returning until the child exits (whether by Stop or crash).
    private var process: Process?

    /// File handle for the log file we're appending to. Closed on stop.
    private var logHandle: FileHandle?

    /// Called when the child terminates for any reason. The coordinator sets
    /// this to drive status transitions (running -> crashed or stopped).
    var onTermination: ((Process) -> Void)?

    init(definition: Definition, logDirectory: String) {
        self.definition = definition
        self.logDirectory = logDirectory
    }

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    var ownedPID: Int32? {
        guard let process = process, process.isRunning else { return nil }
        return process.processIdentifier
    }

    // MARK: - Start

    /// Spawn the child. Returns the PID on success, throws on failure.
    /// Idempotent: returns the existing PID if a child is already running.
    @discardableResult
    func start() throws -> Int32 {
        if let process = process, process.isRunning {
            WILog.services.debug("\(definition.id).start() — already running pid \(process.processIdentifier)")
            return process.processIdentifier
        }

        WILog.services.info("\(definition.id).start() — spawning in \(definition.workingDirectory)")

        // Make sure the log directory exists. Failure to create it is fatal
        // for this call but recoverable on retry.
        try FileManager.default.createDirectory(
            atPath: logDirectory,
            withIntermediateDirectories: true
        )

        let logPath = "\(logDirectory)/\(definition.id).log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }

        // Open in append mode. Each start() appends a session marker so it's
        // easy to find where the most recent run begins.
        guard let handle = FileHandle(forWritingAtPath: logPath) else {
            throw NSError(
                domain: "ServiceController",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Cannot open log file at \(logPath)"]
            )
        }
        handle.seekToEndOfFile()
        let header = "\n===== \(ISO8601DateFormatter().string(from: Date())) — starting \(definition.id) =====\n"
        if let data = header.data(using: .utf8) { handle.write(data) }

        let process = Process()
        // Two modes:
        //   A. definition.executable set -> invoke that binary directly. No
        //      shell, no PATH games, no Homebrew-vs-nvm race. Used by all
        //      three services when NvmResolver found a node binary.
        //   B. Fallback to /bin/zsh -lc shellCommand. Last-resort path that
        //      may load Homebrew's node 26 and crash on better-sqlite3.
        if let exe = definition.executable {
            process.executableURL = URL(fileURLWithPath: exe)
            process.arguments = definition.arguments
            WILog.services.info("\(definition.id) — using direct executable: \(exe) \(definition.arguments.joined(separator: " "))")
        } else {
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lc", definition.shellCommand]
            WILog.services.warn("\(definition.id) — falling back to /bin/zsh -lc (NvmResolver returned nil)")
        }
        process.currentDirectoryURL = URL(fileURLWithPath: definition.workingDirectory)

        // Minimal env: keep HOME, USER, LANG. When we're going direct (mode A)
        // we also need PATH so child processes (e.g. npm spawning node, npm
        // looking up sh for lifecycle scripts) can find their dependencies.
        // We build PATH from the node binary's bin dir + standard system dirs.
        var env: [String: String] = [:]
        for key in ["HOME", "USER", "LANG", "TERM", "TMPDIR"] {
            if let v = ProcessInfo.processInfo.environment[key] { env[key] = v }
        }
        if let exe = definition.executable {
            // Put the chosen node's bin dir FIRST so any child `node` calls
            // pick the same binary. Then the usual system PATH for sh, env,
            // git, etc. Don't include /opt/homebrew/bin here — that's what
            // caused the ABI mismatch in the first place.
            let nodeBin = (exe as NSString).deletingLastPathComponent
            env["PATH"] = "\(nodeBin):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        }
        // Merge per-definition extras (SKIP_SYNC=1 for bridge, etc.).
        for (k, v) in definition.extraEnv { env[k] = v }
        process.environment = env

        process.standardOutput = handle
        process.standardError = handle

        // Capture self weakly to avoid retaining the controller past the
        // child's lifetime if the coordinator releases us.
        process.terminationHandler = { [weak self] terminated in
            guard let self = self else { return }
            let code = terminated.terminationStatus
            let reasonRaw = terminated.terminationReason.rawValue
            WILog.services.warn("\(self.definition.id) — child exited code=\(code) reason=\(reasonRaw)")
            // Write a tail marker, close the log handle.
            if let data = "===== exited code=\(code) =====\n".data(using: .utf8) {
                self.logHandle?.write(data)
            }
            try? self.logHandle?.close()
            self.logHandle = nil
            self.onTermination?(terminated)
            self.process = nil
        }

        try process.run()
        WILog.services.info("\(definition.id) — running pid \(process.processIdentifier), log → \(logPath)")
        self.process = process
        self.logHandle = handle
        return process.processIdentifier
    }

    // MARK: - Stop

    /// Send SIGTERM, give the child 3 seconds, then SIGKILL. Safe to call
    /// when nothing is running — no-op.
    func stop() {
        guard let process = process, process.isRunning else { return }
        process.terminate() // SIGTERM
        // Polite wait. We don't block the caller's thread: dispatch the
        // kill-after-timeout to a background queue.
        let pid = process.processIdentifier
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 3.0) {
            // If still alive after 3s, send SIGKILL via kill(2). Using the
            // POSIX kill function rather than NSTask because Process has no
            // SIGKILL primitive.
            let stillAlive = kill(pid, 0) == 0
            if stillAlive {
                _ = kill(pid, SIGKILL)
            }
        }
    }
}
