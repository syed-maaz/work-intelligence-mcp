//
//  Notifier.swift
//
//  macOS user notifications with de-dup. Two delivery paths:
//
//   1. UserNotifications framework (UN) — the "modern" path. Requires a
//      properly-signed bundle. For ad-hoc-signed dev builds, UN silently
//      drops notifications even after authorization is granted, because the
//      system can't verify the bundle's identity for the notification center.
//
//   2. AppleScript fallback — invokes `osascript -e 'display notification ...'`.
//      This always works because osascript is system-signed and inherits
//      delivery permission. Less rich (no actions, no images) but it actually
//      shows up.
//
//  We try UN first (so a signed release build gets the nicer experience), and
//  always also fire osascript so dev builds aren't silent. If both deliver the
//  user might see a duplicate, but in practice UN drops silently when signing
//  is ad-hoc — so you get exactly one banner.
//
//  De-dup key: (stableID, fingerprint) tuple stored in UserDefaults for the
//  last 6 hours.
//

import Foundation
import UserNotifications

final class Notifier {

    private let center = UNUserNotificationCenter.current()
    private let userDefaultsKey = "wi.menubar.notifier.shownSignals"
    private let dedupeWindow: TimeInterval = 6 * 60 * 60  // 6 hours
    /// How long after the first banner we re-fire ONCE for still-unresolved
    /// critical signals. The original "every 5 min" cadence was banner spam;
    /// the new single re-fire keeps the escalation feedback (you'll see it
    /// twice if you ignored it the first time) without the spam.
    /// Task 4 in `.planning/wi-menubar-notifications/01-UX-ANALYSIS-AND-PLAN.md`.
    private let escalationDelay: TimeInterval = 30 * 60  // 30 minutes

    func requestAuthorizationIfNeeded() {
        center.getNotificationSettings { [weak self] settings in
            guard let self = self else { return }
            if settings.authorizationStatus == .notDetermined {
                self.center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
            }
        }
    }

    func processSnapshot(_ signals: [AttentionSignal]) {
        var shown = loadShown()
        let now = Date()

        // Prune old dedupe entries.
        shown = shown.filter { _, entry in
            now.timeIntervalSince(entry.lastShown) < dedupeWindow
        }

        for signal in signals {
            // Defect B (.planning/wi-menubar-notifications/01): warnings stay
            // visible in popover + menubar dot + count badge. Banners are
            // interruptions; reserve them for actionable critical state. The
            // previous design banner-spammed on warnings (stale Cypher
            // sessions, drift items, expiring tokens) where the popover dot
            // already conveys the state non-intrusively.
            guard signal.severity == .critical else { continue }

            let key = "\(signal.stableID)::\(signal.fingerprint)"

            // Three branches:
            //   1. Inside dedupe window AND already escalated → silence.
            //   2. Inside dedupe window AND past escalation delay AND not
            //      escalated yet → fire the single re-fire and mark.
            //   3. New / outside dedupe window → fire and start the clock.
            if let prev = shown[key], now.timeIntervalSince(prev.lastShown) < dedupeWindow {
                let elapsed = now.timeIntervalSince(prev.lastShown)
                if !prev.escalated && elapsed >= escalationDelay {
                    post(signal)
                    shown[key] = DedupeEntry(lastShown: prev.lastShown, escalated: true)
                }
                continue
            }
            // First banner — fresh entry.
            post(signal)
            shown[key] = DedupeEntry(lastShown: now, escalated: false)
        }

        saveShown(shown)
    }

    // MARK: - Delivery

    private func post(_ signal: AttentionSignal) {
        postViaUserNotifications(signal)
        postViaAppleScript(signal)
    }

    /// The "official" delivery path. Works for full Developer-ID-signed apps.
    /// For ad-hoc-signed dev bundles, notifications often go to the void.
    private func postViaUserNotifications(_ signal: AttentionSignal) {
        let content = UNMutableNotificationContent()
        content.title = signal.title
        content.body = signal.body
        // Subtitle is the subsystem label (e.g. "WI · Cypher") so the user
        // can tell which subsystem fired the banner at a glance when 3+
        // are stacked in Notification Center. Defect D in the plan.
        content.subtitle = signal.category.subsystemLabel
        if signal.severity == .critical {
            content.sound = .default
        }
        content.categoryIdentifier = signal.category.rawValue

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let request = UNNotificationRequest(
            identifier: "wi.\(signal.stableID).\(UUID().uuidString.prefix(6))",
            content: content,
            trigger: trigger
        )
        center.add(request, withCompletionHandler: nil)
    }

    /// Reliable fallback for ad-hoc-signed bundles. `osascript display
    /// notification` always renders because osascript itself has the
    /// entitlement we lack.
    private func postViaAppleScript(_ signal: AttentionSignal) {
        // Build the body. AppleScript only lets us pass title + subtitle +
        // body (no actions). We concatenate the action hint into the body so
        // the user can copy-paste the npm command from the notification.
        var bodyParts: [String] = [signal.body]
        if let hint = signal.actionHint, !hint.isEmpty {
            bodyParts.append("→ \(hint)")
        }
        let body = bodyParts.joined(separator: "\n")

        // Escape any embedded quotes / backslashes for safe AppleScript embedding.
        let escTitle = appleEscape(signal.title)
        let escBody = appleEscape(body)
        // Subsystem label (e.g. "WI · MCP Tokens") so a banner is self-
        // identifying without opening the popover. Defect D in the plan.
        let escSubtitle = appleEscape(signal.category.subsystemLabel)

        let script: String
        if signal.severity == .critical {
            // "sound name "Glass"" plays the system sound + shows banner.
            script = "display notification \"\(escBody)\" with title \"\(escTitle)\" subtitle \"\(escSubtitle)\" sound name \"Glass\""
        } else {
            script = "display notification \"\(escBody)\" with title \"\(escTitle)\" subtitle \"\(escSubtitle)\""
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        task.standardOutput = Pipe()
        task.standardError = Pipe()
        do { try task.run() } catch { /* best-effort; ignore failures */ }
    }

    private func appleEscape(_ s: String) -> String {
        // AppleScript string escaping: \\ and " need backslashes; newlines stay literal.
        return s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " — ")
    }

    // MARK: - UserDefaults persistence

    /// Persisted dedupe entry. `escalated` was added in Task 4 (single 30-min
    /// re-fire). Old entries written before that change had no `escalated`
    /// field; the `try?` in `loadShown` falls back to an empty map on decode
    /// failure, which means at worst we lose ~6h of dedupe state once on
    /// upgrade. Acceptable: the user gets one extra banner per still-critical
    /// signal post-upgrade, then steady-state behavior resumes.
    private struct DedupeEntry: Codable {
        let lastShown: Date
        /// True once the 30-min escalation re-fire has been posted for this
        /// (stableID, fingerprint) tuple. Defaults to false in the decode
        /// fallback for old entries.
        var escalated: Bool = false
    }

    private func loadShown() -> [String: DedupeEntry] {
        guard let data = UserDefaults.standard.data(forKey: userDefaultsKey),
              let decoded = try? JSONDecoder().decode([String: DedupeEntry].self, from: data)
        else { return [:] }
        return decoded
    }

    private func saveShown(_ map: [String: DedupeEntry]) {
        if let data = try? JSONEncoder().encode(map) {
            UserDefaults.standard.set(data, forKey: userDefaultsKey)
        }
    }
}
