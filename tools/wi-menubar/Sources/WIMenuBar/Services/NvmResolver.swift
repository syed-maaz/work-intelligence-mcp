// NvmResolver.swift — find the user's preferred `node` binary deterministically.
//
// We CANNOT rely on `/bin/zsh -lc 'nvm use default && node …'` from a spawned
// process. The user's .zprofile loads Homebrew shellenv first, so /opt/homebrew/
// bin/node (Node 26, ABI 147) wins the PATH lookup before .zshrc gets a chance
// to run `nvm use default`. Meanwhile our project's `better-sqlite3` is built
// for Node 24 (ABI 137). The result is `NODE_MODULE_VERSION 147` crashes on
// every bridge boot from the menubar.
//
// Fix: resolve the absolute path of nvm's default Node ourselves, at boot,
// and invoke it directly. No shell, no PATH races.
//
// Resolution order:
//   1. ~/.nvm/alias/default contains a major version (e.g. "24") or a
//      full version (e.g. "v24.7.0") or an alias name (e.g. "lts/iron").
//   2. We resolve that to a real installed directory under
//      ~/.nvm/versions/node/v<X.Y.Z>/bin/node.
//   3. Fallback: highest-version v* directory under ~/.nvm/versions/node/.
//   4. Fallback: /usr/local/bin/node, /opt/homebrew/bin/node (only if we
//      couldn't find nvm at all — these may be ABI-mismatched).
//
// The resolution is performed once on first access and cached for the
// lifetime of the menubar process.

import Foundation

enum NvmResolver {

    /// Cached path to the chosen node binary. nil if nothing usable was
    /// found anywhere — caller should fall back to "node" and let the
    /// shell PATH decide (probably also broken, but at least it'll log).
    static let nodePath: String? = resolve()

    /// One-time resolution. Logs each step so a future failure is debuggable
    /// from `~/Library/Logs/wi-menubar/menubar.log`.
    private static func resolve() -> String? {
        let home = NSHomeDirectory()
        let nvmRoot = "\(home)/.nvm"
        let nodeVersionsDir = "\(nvmRoot)/versions/node"

        // Step 1: read ~/.nvm/alias/default if it exists.
        let aliasFile = "\(nvmRoot)/alias/default"
        var preferred: String? = nil
        if let data = try? String(contentsOfFile: aliasFile, encoding: .utf8) {
            preferred = data.trimmingCharacters(in: .whitespacesAndNewlines)
            WILog.services.info("NvmResolver: ~/.nvm/alias/default = '\(preferred ?? "")'")
        } else {
            WILog.services.info("NvmResolver: no ~/.nvm/alias/default")
        }

        // Step 2: enumerate installed versions.
        let fm = FileManager.default
        var installed: [String] = []
        if let entries = try? fm.contentsOfDirectory(atPath: nodeVersionsDir) {
            // Keep only v* directories.
            installed = entries.filter { $0.hasPrefix("v") }.sorted(by: versionGreater)
            let list = installed.joined(separator: ", ")
            WILog.services.info("NvmResolver: installed = \(list)")
        } else {
            WILog.services.info("NvmResolver: no \(nodeVersionsDir)")
        }

        // Step 2a: try to match `preferred` against installed.
        if let preferred = preferred {
            // Case A: full version like "v24.7.0" — match exactly.
            if preferred.hasPrefix("v"), installed.contains(preferred) {
                return nodeBin(versionsDir: nodeVersionsDir, version: preferred)
            }
            // Case B: pure number like "24" or "24.7.0" — match by prefix
            // after prepending "v".
            let normalized = preferred.hasPrefix("v") ? preferred : "v\(preferred)"
            if installed.contains(normalized) {
                return nodeBin(versionsDir: nodeVersionsDir, version: normalized)
            }
            // Case C: number is a major (e.g. "24"). Match the first
            // installed version whose major matches.
            if let match = installed.first(where: { $0.hasPrefix(normalized + ".") || $0 == normalized }) {
                return nodeBin(versionsDir: nodeVersionsDir, version: match)
            }
            // Case D: an alias name like "lts/iron" — we can't resolve those
            // without running nvm itself. Fall through to step 3.
            WILog.services.warn("NvmResolver: alias '\(preferred)' did not match any installed version")
        }

        // Step 3: pick the highest installed version.
        if let highest = installed.first {
            WILog.services.info("NvmResolver: falling back to highest installed: \(highest)")
            return nodeBin(versionsDir: nodeVersionsDir, version: highest)
        }

        // Step 4: brew / system fallbacks. We deliberately try /usr/local
        // before /opt/homebrew because users who explicitly installed an
        // older node via the official .pkg usually want that one.
        for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node"] {
            if fm.isExecutableFile(atPath: candidate) {
                WILog.services.warn("NvmResolver: nvm unavailable, falling back to \(candidate) — ABI mismatch possible")
                return candidate
            }
        }

        WILog.services.error("NvmResolver: no node binary found anywhere")
        return nil
    }

    /// Sort helper: "v24.7.0" > "v22.18.0" > "v20.18.3".
    private static func versionGreater(_ lhs: String, _ rhs: String) -> Bool {
        let l = parseVersion(lhs)
        let r = parseVersion(rhs)
        return l.lexicographicallyPrecedes(r) == false && l != r
    }

    /// Parse "v24.7.0" -> [24, 7, 0]. Anything unparseable -> [0].
    private static func parseVersion(_ s: String) -> [Int] {
        let trimmed = s.hasPrefix("v") ? String(s.dropFirst()) : s
        return trimmed.split(separator: ".").map { Int($0) ?? 0 }
    }

    /// Confirm the node binary exists at the resolved path; return it or nil.
    private static func nodeBin(versionsDir: String, version: String) -> String? {
        let path = "\(versionsDir)/\(version)/bin/node"
        if FileManager.default.isExecutableFile(atPath: path) {
            WILog.services.info("NvmResolver: chose \(path)")
            return path
        }
        WILog.services.warn("NvmResolver: \(path) does not exist or is not executable")
        return nil
    }
}
