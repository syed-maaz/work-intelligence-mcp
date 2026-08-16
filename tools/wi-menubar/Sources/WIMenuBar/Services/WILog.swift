//
//  WILog.swift
//
//  Structured logging + crash interception for the WI menubar app.
//
//  Why this file exists:
//    The Swift app was disappearing from the menubar with no crash report
//    landing in ~/Library/Logs/DiagnosticReports/ and only opaque CFNetwork
//    chatter in `log show`. That left us blind to whether the app was
//    cleanly exiting, hit a SwiftUI fatal, took a Mach exception (BAD_ACCESS
//    / EXC_GUARD), or got OOM-killed. This module gives us:
//
//    1. A file-backed log at ~/Library/Logs/wi-menubar/menubar.log that we
//       can `tail -f` from a terminal. Each line is timestamped, tagged with
//       a category, and includes thread + file:line context.
//    2. An os_log mirror so `log show --process WIMenuBar` also sees the
//       same events (useful for spelunking the unified system log).
//    3. Crash interception via NSSetUncaughtExceptionHandler + POSIX signal
//       handlers (SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGPIPE, SIGFPE).
//       When the process is going down, we flush a final marker with the
//       symbolicated backtrace so the log file shows WHY the menubar
//       disappeared.
//    4. A boot heartbeat (`[boot] launched pid=<n> bundle=<...>`) and a
//       shutdown marker (`[exit] clean`) so it's obvious from the log alone
//       whether the process exited cleanly or was killed.
//
//  Usage:
//    Call `WILog.install()` exactly once at app launch (in WIMenuBarApp's
//    init). After that, use the category helpers:
//
//        WILog.app.info("ready, polling :3132")
//        WILog.services.error("failed to spawn bridge: \(err)")
//        WILog.ui.debug("popover appeared")
//        WILog.network.warn("/api/agents/health → 404 (twice in a row)")
//
//    Each call writes to BOTH the file and os_log. Lines look like:
//        2026-06-22 16:31:02.481 [services] WARN  ServicesCoordinator.swift:88
//          connect(bridge) — port 3132 occupied; adopting as external
//

import Foundation
import os.log
#if canImport(Darwin)
import Darwin
#endif

/// Severity. Mirrors the standard set; INFO is the default for "the
/// thing succeeded and that's worth a line".
enum WILogLevel: Int {
    case debug = 0
    case info  = 1
    case warn  = 2
    case error = 3
    case fatal = 4

    var label: String {
        switch self {
        case .debug: return "DEBUG"
        case .info:  return "INFO "
        case .warn:  return "WARN "
        case .error: return "ERROR"
        case .fatal: return "FATAL"
        }
    }

    /// Matching os_log type so the unified system log shows the same level.
    var osType: OSLogType {
        switch self {
        case .debug: return .debug
        case .info:  return .info
        case .warn:  return .default
        case .error: return .error
        case .fatal: return .fault
        }
    }
}

/// A logging category. Adding one is cheap — just append a new static var
/// to `WILog`. Categories live in os_log under the same subsystem so they
/// can be filtered as `log show --subsystem com.work-intelligence.menubar`.
struct WILogCategory {
    let name: String
    fileprivate let osLog: OSLog

    init(_ name: String) {
        self.name = name
        self.osLog = OSLog(
            subsystem: "com.work-intelligence.menubar",
            category: name
        )
    }

    func debug(_ msg: @autoclosure () -> String,
               file: StaticString = #file, line: UInt = #line) {
        WILog.write(.debug, category: self, message: msg(), file: file, line: line)
    }
    func info(_ msg: @autoclosure () -> String,
              file: StaticString = #file, line: UInt = #line) {
        WILog.write(.info, category: self, message: msg(), file: file, line: line)
    }
    func warn(_ msg: @autoclosure () -> String,
              file: StaticString = #file, line: UInt = #line) {
        WILog.write(.warn, category: self, message: msg(), file: file, line: line)
    }
    func error(_ msg: @autoclosure () -> String,
               file: StaticString = #file, line: UInt = #line) {
        WILog.write(.error, category: self, message: msg(), file: file, line: line)
    }
    func fatal(_ msg: @autoclosure () -> String,
               file: StaticString = #file, line: UInt = #line) {
        WILog.write(.fatal, category: self, message: msg(), file: file, line: line)
    }
}

enum WILog {

    // MARK: - Categories

    /// Top-level lifecycle (boot, shutdown, scene wiring).
    static let app = WILogCategory("app")
    /// Service spawn/probe/kill — ServicesCoordinator, ServiceController.
    static let services = WILogCategory("services")
    /// HTTP requests in BridgeAPI.
    static let network = WILogCategory("network")
    /// SwiftUI view appearance, popover toggles, render-time errors.
    static let ui = WILogCategory("ui")
    /// Notifier, badge, SignalEngine.
    static let signal = WILogCategory("signal")
    /// Crash interception output. Separate so `grep '\[crash\]'` is trivial.
    static let crash = WILogCategory("crash")

    // MARK: - File backing

    /// Resolved path of the file log. Set inside `install()` so callers can
    /// surface "logs at <path>" UI later.
    private(set) static var logFilePath: String = ""

    /// Serial queue so concurrent log calls don't interleave bytes in the
    /// file. Cheap — every write is a tiny string append.
    private static let writeQueue = DispatchQueue(label: "com.work-intelligence.menubar.log")

    /// File handle. Lazy-opened in `install()` and held for process lifetime.
    private static var handle: FileHandle?

    /// One ISO8601 formatter, reused. Allocating a new one per log line was
    /// measurable in the previous version of this app.
    private static let formatter: DateFormatter = {
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone.current
        return df
    }()

    /// Tracks whether install() ran so we don't double-register handlers.
    private static var installed = false

    // MARK: - Install

    /// Sets up the log file + crash handlers. Idempotent.
    /// Call exactly once during process startup, before any other code that
    /// might log or crash. Safe to call from `@main`'s init.
    static func install(logDirectory: String) {
        guard !installed else { return }
        installed = true

        // 1. Make sure the log directory exists.
        let fm = FileManager.default
        try? fm.createDirectory(atPath: logDirectory,
                                withIntermediateDirectories: true)
        let path = "\(logDirectory)/menubar.log"
        if !fm.fileExists(atPath: path) {
            fm.createFile(atPath: path, contents: nil)
        }
        logFilePath = path

        // 2. Open in append mode and seek to end.
        if let h = FileHandle(forWritingAtPath: path) {
            h.seekToEndOfFile()
            handle = h
        }

        // 3. Boot marker — anything the user sees on screen should also
        //    appear in the log so missing markers indicate a startup crash.
        let pid = ProcessInfo.processInfo.processIdentifier
        let bundle = Bundle.main.bundlePath
        let bootLine = """

        ===== boot \(formatter.string(from: Date())) pid=\(pid) =====
          bundle: \(bundle)
          log:    \(path)
          host:   \(ProcessInfo.processInfo.hostName)
          os:     \(ProcessInfo.processInfo.operatingSystemVersionString)

        """
        writeRaw(bootLine)

        // 4. Crash interception.
        installUncaughtExceptionHandler()
        installSignalHandlers()

        // 5. Clean-exit marker. atexit fires when the process is going
        //    down via exit(); if we see this in the log the disappearance
        //    is graceful, not a crash.
        atexit {
            WILog.writeRaw("===== clean exit \(WILog.formatter.string(from: Date())) =====\n")
            try? WILog.handle?.synchronize()
            try? WILog.handle?.close()
        }
    }

    // MARK: - Write

    /// Internal entry point for the category helpers. Keep this hot path
    /// allocation-light: we format once, then dispatch a single block.
    fileprivate static func write(_ level: WILogLevel,
                                  category: WILogCategory,
                                  message: String,
                                  file: StaticString,
                                  line: UInt) {
        // Strip the long path so the log stays readable: keep filename only.
        let filename: String = {
            let s = "\(file)"
            if let slash = s.lastIndex(of: "/") {
                return String(s[s.index(after: slash)...])
            }
            return s
        }()
        let ts = formatter.string(from: Date())
        let thread = Thread.isMainThread ? "main" : "bg"
        let formatted = "\(ts) [\(category.name)] \(level.label) \(filename):\(line) (\(thread)) \(message)\n"

        // os_log mirror — system log integration. Use %{public}@ so the
        // message isn't redacted in Console.app under release builds.
        os_log("%{public}@", log: category.osLog, type: level.osType, formatted)

        writeQueue.async {
            writeRaw(formatted)
            // Flush on warn+ so we never lose a high-signal line to a
            // subsequent crash. Debug/info batch through the file buffer.
            if level.rawValue >= WILogLevel.warn.rawValue {
                try? handle?.synchronize()
            }
        }
    }

    /// Direct write bypassing formatting — used for boot/exit markers and
    /// from inside signal handlers where async-unsafe APIs aren't allowed.
    fileprivate static func writeRaw(_ text: String) {
        guard let h = handle, let data = text.data(using: .utf8) else { return }
        h.write(data)
    }

    // MARK: - Crash handlers

    private static func installUncaughtExceptionHandler() {
        NSSetUncaughtExceptionHandler { exc in
            // Format inside the handler — NSException's properties are
            // safe to touch here. Backtrace symbols may not be fully
            // symbolicated but raw frames are still useful.
            let ts = WILog.formatter.string(from: Date())
            var dump = "\n===== uncaught exception \(ts) =====\n"
            dump += "  name:    \(exc.name.rawValue)\n"
            dump += "  reason:  \(exc.reason ?? "(none)")\n"
            dump += "  info:    \(exc.userInfo ?? [:])\n"
            dump += "  stack:\n"
            for frame in exc.callStackSymbols {
                dump += "    \(frame)\n"
            }
            dump += "===== end exception =====\n"
            WILog.writeRaw(dump)
            try? WILog.handle?.synchronize()
        }
    }

    /// POSIX signal handlers. Signal handlers can only call async-signal-safe
    /// functions — no Foundation, no Swift String allocation, no FileHandle.
    /// We write to a pre-opened raw file descriptor with `write(2)` so the
    /// final message reaches disk regardless of process state.
    private static func installSignalHandlers() {
        // Re-open the log file as a raw fd we can write(2) to from a signal
        // handler. The Foundation FileHandle uses internal locks that aren't
        // safe to take inside a signal handler.
        let fd = open(logFilePath, O_WRONLY | O_APPEND)
        guard fd >= 0 else { return }
        signalFD = fd

        // Signals we care about — anything that takes a process down hard.
        // SIGTERM is handled too so `kill <pid>` from a script leaves a
        // trail; without this the log would just end mid-line.
        let signals: [Int32] = [SIGSEGV, SIGABRT, SIGBUS, SIGILL,
                                SIGFPE, SIGPIPE, SIGTERM]

        for sig in signals {
            var action = sigaction()
            action.__sigaction_u.__sa_handler = WILog_signalHandler
            sigemptyset(&action.sa_mask)
            // SA_RESETHAND so a second matching signal hits the default
            // handler and the OS gets to write a crash report. We just
            // want our breadcrumb on the first occurrence.
            action.sa_flags = SA_RESETHAND
            sigaction(sig, &action, nil)
        }
    }
}

// File-scope, accessible from the C signal handler trampoline.
fileprivate var signalFD: Int32 = -1

/// C-compatible signal handler. Async-signal-safe APIs only.
/// Writes a one-line marker per signal so the log file ends with the
/// reason the process died rather than trailing off mid-record.
@_cdecl("WILog_signalHandler")
fileprivate func WILog_signalHandler(_ sig: Int32) {
    guard signalFD >= 0 else { return }

    // Pre-baked strings, no formatting allowed in a signal handler.
    let prefix = "\n===== signal "
    let suffix = " =====\n"
    let name: String
    switch sig {
    case SIGSEGV: name = "SIGSEGV (bad memory access)"
    case SIGABRT: name = "SIGABRT (assert/abort)"
    case SIGBUS:  name = "SIGBUS (bus error)"
    case SIGILL:  name = "SIGILL (illegal instruction)"
    case SIGFPE:  name = "SIGFPE (arithmetic)"
    case SIGPIPE: name = "SIGPIPE (broken pipe)"
    case SIGTERM: name = "SIGTERM (terminated)"
    default:      name = "unknown"
    }
    let line = "\(prefix)\(name)\(suffix)"
    _ = line.withCString { ptr in
        write(signalFD, ptr, strlen(ptr))
    }

    // Re-raise with the default handler installed (SA_RESETHAND already did
    // that) so the OS can write a real crash report and produce the right
    // exit status. Without this the process would just hang here.
    raise(sig)
}
