//
//  WIMenuBarApp.swift
//
//  Entry point for the WI menubar app.
//
//  Architecture intent:
//    * This file owns ONLY the @main attribute, the AppKit bridging glue
//      (StatusBarController + NSPopover host), and the construction of the
//      singleton ServicesCoordinator + DataCoordinator that the popover
//      observes.
//    * Composition of popover content happens in Views/PopoverView.swift.
//    * Per-feature UI lives under Features/<FeatureName>/.
//
//  Why NSStatusItem and not SwiftUI's MenuBarExtra:
//    MenuBarExtra was tried first (and worked for everything EXCEPT label
//    color). It renders the label as a Text view inside a constrained slot
//    that monochrome-tints to the menu bar foreground color — there is no
//    public API to give a per-glyph color that survives the tint pass.
//    Multiple attempts confirmed live 2026-06-23:
//      * `Image(systemName: "circle.fill").foregroundColor(.red)`     → white
//      * `Circle().fill(.red)`                                        → clipped
//      * `Text("●").foregroundColor(.red)`                            → white
//      * `Text("WI") + Text("●").foregroundColor(.red)` (concat)      → white
//    The macOS menu bar treats SwiftUI MenuBarExtra labels as template
//    content; `foregroundColor` is a tint hint, not a hard color.
//
//    NSStatusItem exposes the underlying button directly. By setting
//    `button.image = <colored NSImage>` with `isTemplate = false`, macOS
//    skips its template-tint pass and renders the actual RGBA pixels we
//    drew. That's the only path that survives in both light and dark
//    menu bars — verified live 2026-06-23.
//

import SwiftUI
import AppKit

// MARK: - App entry

@main
struct WIMenuBarApp: App {

    // Install logging + crash handlers BEFORE anything else runs. Using a
    // computed-once helper inside an init() block guarantees this fires
    // before SwiftUI starts evaluating @StateObject expressions, so a
    // crash during coordinator construction still leaves a trail in
    // ~/Library/Logs/wi-menubar/menubar.log.
    private static let _bootLogger: Void = {
        WILog.install(logDirectory: AppPaths.logDirectory)
        WILog.app.info("WIMenuBarApp boot — repoRoot=\(AppPaths.repoRoot)")
        return ()
    }()

    // AppDelegate owns the NSStatusItem + NSPopover lifecycle. SwiftUI's
    // App protocol doesn't have a first-class way to do that, so we attach
    // via @NSApplicationDelegateAdaptor.
    @NSApplicationDelegateAdaptor(StatusBarAppDelegate.self) private var appDelegate

    init() {
        _ = WIMenuBarApp._bootLogger
    }

    var body: some Scene {
        // Empty Settings scene — we don't want any actual app windows; the
        // status item + popover own the entire user surface. The Settings
        // scene is the only Scene type that produces zero visible windows
        // on launch (Window/WindowGroup would put something in the Dock,
        // even with LSUIElement=YES it's flaky on first run).
        Settings {
            EmptyView()
        }
    }
}

// MARK: - Status bar controller

/// Owns the NSStatusItem in the system menu bar and the NSPopover that
/// hosts the SwiftUI PopoverView when the user clicks the item.
///
/// State flow:
///   1. `applicationDidFinishLaunching` builds the status item, popover,
///      and two coordinators (services + data).
///   2. `data.$signals` Combine subscription redraws the status item's
///      image whenever signals change → menubar dot color stays current.
///   3. Clicking the status item toggles popover open/close. The popover
///      hosts an NSHostingView wrapping PopoverView with both coordinators
///      injected via environmentObject.
///
/// `@MainActor` because both ServicesCoordinator and DataCoordinator are
/// MainActor-isolated; constructing them eagerly here would otherwise
/// require an async hop. AppDelegate callbacks already run on the main
/// thread so this is just an annotation, not a behavior change.
@MainActor
final class StatusBarAppDelegate: NSObject, NSApplicationDelegate {

    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private let coordinator = ServicesCoordinator(
        repoRoot: AppPaths.repoRoot,
        logDirectory: AppPaths.logDirectory
    )
    private let data = DataCoordinator()

    /// Combine subscription that redraws the status icon when signals change.
    /// Kept as a property so it doesn't get deallocated.
    private var signalsObservation: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        WILog.app.info("StatusBarAppDelegate.applicationDidFinishLaunching")

        // Wire the two coordinators so service crashes can produce signals.
        coordinator.dataCoordinator = data

        // Build the popover that hosts our SwiftUI content.
        let pop = NSPopover()
        pop.behavior = .transient  // close on click-outside
        pop.animates = true
        let hosting = NSHostingController(rootView:
            PopoverView()
                .environmentObject(coordinator)
                .environmentObject(data)
        )
        pop.contentViewController = hosting
        // Set initial size so the first open isn't a flash of zero-sized
        // popover before SwiftUI's intrinsic size kicks in.
        pop.contentSize = NSSize(width: 420, height: 560)
        self.popover = pop

        // Build the status item.
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.target = self
            button.action = #selector(togglePopover(_:))
            // Allow left + right click handling (right-click could later
            // open a context menu; today both behave the same).
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            // imagePosition = .imageLeft puts the dot before the "WI" text.
            // We render the dot ourselves so this is essentially a no-op
            // hint to AppKit; the actual icon is composited into one image.
            button.imagePosition = .imageLeft

            // Suppress AppKit's default click highlight ("selection pill"
            // around the button). Without this the button renders a tinted
            // background rectangle when the popover is open OR when the
            // user is hovering with the mouse down — visually clashes with
            // all the other borderless status items in the menu bar.
            //
            // `(cell as? NSButtonCell)?.highlightsBy = []` is the proper
            // way: it tells the cell to not change appearance on any
            // mouse-down state. We do NOT set the button to be borderless
            // separately — the highlightsBy clear is sufficient AND
            // preserves the cell's bezel-less rendering of the image.
            if let cell = button.cell as? NSButtonCell {
                cell.highlightsBy = []
            }
        }
        self.statusItem = item

        // Initial draw — signals start empty, so this paints a green dot
        // and "WI". As soon as the first poll completes, redrawIcon will
        // be called by the Combine subscription below.
        redrawIcon(signals: data.signals)

        // Subscribe to signals changes. ObjectWillChangePublisher fires
        // BEFORE the @Published value updates, so we hop to the main queue
        // and re-read data.signals at that point.
        signalsObservation = data.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.redrawIcon(signals: self.data.signals)
            }
        }
    }

    // MARK: - Icon rendering

    /// Composites the status-bar icon: "WI" + a colored dot + optional count.
    ///
    /// Rendered as a single NSImage via NSImage(size:flipped:drawingHandler:).
    /// `isTemplate = false` is the critical bit: it tells AppKit to use the
    /// pixels we drew literally instead of running them through the menu-bar
    /// template-tint pass. Without `isTemplate = false`, the menu bar would
    /// re-tint our red/yellow/green dot to plain white.
    private func redrawIcon(signals: [AttentionSignal]) {
        let status = AggregateStatus.from(signals: signals)
        let dotColor: NSColor = {
            switch status {
            case .green:  return NSColor.systemGreen
            case .yellow: return NSColor.systemYellow
            case .red:    return NSColor.systemRed
            }
        }()

        // Text content. We draw "WI" in the menubar foreground color (white
        // on dark, black on light — let AppKit pick via NSColor.labelColor)
        // and the count in the dot's tint color. The dot itself is a circle
        // drawn between them.
        let title = "WI"
        let countText: String? = signals.isEmpty
            ? nil
            : (signals.count > 99 ? "99+" : "\(signals.count)")

        // Metrics. Menu bar items are ~22pt tall; we render at 18pt to leave
        // breathing room above/below.
        let height: CGFloat = 18
        let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
        let countFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let titleAttr: [NSAttributedString.Key: Any] = [
            .font: titleFont,
            .foregroundColor: NSColor.labelColor
        ]
        let countAttr: [NSAttributedString.Key: Any] = [
            .font: countFont,
            .foregroundColor: dotColor
        ]

        let titleSize = (title as NSString).size(withAttributes: titleAttr)
        let dotDiameter: CGFloat = 8
        let dotSpacing: CGFloat = 4
        let countSize: NSSize = countText.map {
            ($0 as NSString).size(withAttributes: countAttr)
        } ?? .zero

        // Compute total width: title + spacing + dot + (spacing + count)?
        var width = titleSize.width + dotSpacing + dotDiameter
        if !countSize.equalTo(.zero) {
            width += dotSpacing + countSize.width
        }
        // Add a small horizontal pad so the item doesn't crash against neighbours.
        width += 4

        let size = NSSize(width: ceil(width), height: height)
        let image = NSImage(size: size, flipped: false) { rect in
            // 1. "WI"
            let titleY = (rect.height - titleSize.height) / 2
            (title as NSString).draw(at: NSPoint(x: 2, y: titleY), withAttributes: titleAttr)

            // 2. Colored dot
            let dotX = 2 + titleSize.width + dotSpacing
            let dotY = (rect.height - dotDiameter) / 2
            let dotRect = NSRect(x: dotX, y: dotY,
                                 width: dotDiameter, height: dotDiameter)
            dotColor.setFill()
            NSBezierPath(ovalIn: dotRect).fill()

            // 3. Optional count
            if let count = countText, !countSize.equalTo(.zero) {
                let countX = dotX + dotDiameter + dotSpacing
                let countY = (rect.height - countSize.height) / 2
                (count as NSString).draw(at: NSPoint(x: countX, y: countY),
                                         withAttributes: countAttr)
            }
            return true
        }
        // CRITICAL: isTemplate = false. Without this, macOS recolors the
        // entire image to the menu-bar foreground color, losing our dot
        // and count tints. With it, the literal RGBA we drew is what shows.
        image.isTemplate = false
        statusItem.button?.image = image
        // Clear any text title — we baked it into the image so it can sit
        // in the same rendering pass as the dot.
        statusItem.button?.title = ""
        // Accessibility: VoiceOver still gets a meaningful label.
        statusItem.button?.toolTip = "WI status: \(status.rawValue) — \(signals.count) signals"
        statusItem.button?.setAccessibilityLabel(
            "WI status: \(status.rawValue), \(signals.count) signals"
        )
    }

    // MARK: - Popover toggle

    @objc private func togglePopover(_ sender: AnyObject?) {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: button.bounds,
                         of: button,
                         preferredEdge: .minY)
            // Intentionally do NOT call `window.makeKey()` here. Forcing
            // key-window status pushes focus onto the popover's first
            // focusable subview (the "Today" tab button), which macOS
            // then decorates with a blue focus ring — visually jarring
            // against the otherwise borderless popover chrome. The
            // popover is fully interactive without key-window status:
            // clicks still land, scroll wheels still work. The only
            // thing you lose is tab-key keyboard navigation, which we
            // don't need (no form fields here).
        }
    }
}

// MARK: - Combine sink helper

import Combine

extension Publisher where Failure == Never {
    /// Tiny wrapper so we can store an AnyCancellable without importing
    /// Combine at the call site every time. Pattern is the same as the
    /// stock `.sink(receiveValue:)` returning an AnyCancellable, just with
    /// the cancellable boxed to `Any` for the property type above.
    fileprivate func sink(_ handler: @escaping (Output) -> Void) -> Any {
        let cancellable = self.sink(receiveValue: handler)
        return cancellable
    }
}

// MARK: - Paths

/// Resolves the paths the app needs at runtime.
///
/// Repo root is read from the WI_REPO_ROOT environment variable if set
/// (useful for development), otherwise we fall back to walking up from the
/// .app bundle location until we find a directory containing both
/// `web-server.js` and `package.json`. As a last resort we hardcode the
/// known path — the user has the menubar app baked into one specific repo.
enum AppPaths {

    static let repoRoot: String = {
        if let env = ProcessInfo.processInfo.environment["WI_REPO_ROOT"], !env.isEmpty {
            return env
        }

        // Try climbing up from the bundle location. .app sits at
        // <repo>/tools/wi-menubar/WIMenuBar.app, so the repo is 3 levels up.
        let bundleURL = Bundle.main.bundleURL
        var candidate = bundleURL.deletingLastPathComponent() // /tools/wi-menubar
            .deletingLastPathComponent()                       // /tools
            .deletingLastPathComponent()                       // /<repo>

        if isRepoRoot(candidate.path) {
            return candidate.path
        }

        // Final fallback: the home-Desktop path observed during development.
        // If this drifts, the user will see a startup error in the bridge log
        // and can override via WI_REPO_ROOT.
        let home = ProcessInfo.processInfo.environment["HOME"] ?? "/Users"
        candidate = URL(fileURLWithPath: home)
            .appendingPathComponent("Desktop/projects/work-intelligence-mcp")
        return candidate.path
    }()

    static let logDirectory: String = {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSTemporaryDirectory()
        return "\(home)/Library/Logs/wi-menubar"
    }()

    private static func isRepoRoot(_ path: String) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: "\(path)/web-server.js")
            && fm.fileExists(atPath: "\(path)/package.json")
    }
}
