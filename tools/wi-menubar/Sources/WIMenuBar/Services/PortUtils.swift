//
//  PortUtils.swift
//
//  Discover what's listening on a TCP port, regardless of who spawned it.
//  Used by ServicesCoordinator when the user clicks Stop on an "external"
//  service — we look up the listener PID and send SIGTERM directly.
//
//  We shell out to `lsof` rather than calling sysctl/proc APIs directly
//  because (a) lsof is rock-solid and ships with macOS, (b) the equivalent
//  Mach/sysctl dance is 200 lines of unsafe pointer wrangling we'd have to
//  test on every macOS update.
//

import Foundation

enum PortUtils {

    /// Return the PID of the process listening on `port`, or nil if nothing
    /// is listening (or lsof failed). Times out fast so we never block the UI.
    static func listenerPID(forPort port: Int, timeoutSeconds: Double = 1.5) -> Int32? {
        let task = Process()
        // -t = terse (just PIDs), one per line
        // -i TCP:<port> = filter by TCP port
        // -sTCP:LISTEN = only listening sockets (not established/outbound)
        // -nP = no DNS lookup, no port-name lookup (faster + deterministic)
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN"]

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()  // discard

        do {
            try task.run()
        } catch {
            return nil
        }

        // Bounded wait. lsof on a single port is sub-100ms in practice; if
        // it hangs we just give up and return nil.
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while task.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if task.isRunning {
            task.terminate()
            return nil
        }

        // lsof can return multiple lines if multiple processes listen (rare on
        // a single port — usually just IPv4+IPv6 same PID, dedup needed). Take
        // the first unique non-empty number.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let raw = String(data: data, encoding: .utf8) else { return nil }
        let pids = raw
            .split(whereSeparator: { $0.isNewline || $0.isWhitespace })
            .compactMap { Int32($0) }
        return pids.first
    }

    /// SIGTERM the given PID, escalating to SIGKILL after `escalateAfter`
    /// seconds if it's still alive. Returns immediately; the kill+escalate
    /// runs on a background queue.
    static func terminate(pid: Int32, escalateAfter: TimeInterval = 3.0) {
        _ = kill(pid, SIGTERM)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + escalateAfter) {
            // kill(pid, 0) returns 0 if the process exists and we can signal
            // it, -1 + ESRCH if it's gone.
            if kill(pid, 0) == 0 {
                _ = kill(pid, SIGKILL)
            }
        }
    }
}
