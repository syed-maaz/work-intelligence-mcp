// swift-tools-version: 5.9
//
// WIMenuBar — macOS menubar app for the Work Intelligence bridge.
//
// Why SPM and not Xcode: the project must build with only Command Line Tools
// installed (no Xcode.app). `swift build` works from the CLT toolchain;
// `xcodebuild` does not. This manifest declares a single executable target
// that the bundle.sh script later wraps into a proper .app for Launch Services.
//
// Platform pinned to macOS 13 because MenuBarExtra (the API that gives us
// the native menubar item + popover) was introduced in that release.

import PackageDescription

let package = Package(
    name: "WIMenuBar",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "WIMenuBar",
            path: "Sources/WIMenuBar"
        )
    ]
)
