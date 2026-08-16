#!/usr/bin/env bash
#
# bundle.sh — wrap the SPM-built binary into a proper macOS .app bundle.
#
# Why this exists: `swift build -c release` produces a plain Mach-O executable
# at .build/release/WIMenuBar. macOS Launch Services (and the menubar API
# itself) need a .app *bundle* — a directory with a specific layout and an
# Info.plist — to register the app as a UI program rather than a command-line
# tool. Without bundling, the menubar item never appears.
#
# What this script does, in order:
#   1. Verify the release binary exists.
#   2. Create WIMenuBar.app/Contents/{MacOS,Resources} layout.
#   3. Copy the binary into Contents/MacOS/.
#   4. Write a minimal Info.plist (bundle id, version, LSUIElement = YES).
#   5. Ad-hoc codesign so macOS lets the user run it without quarantine prompts.
#
# Critical Info.plist keys:
#   CFBundleIdentifier  — com.work-intelligence.menubar (locks prefs storage)
#   LSUIElement         — YES (hides the Dock icon; menubar-only behaviour)
#   LSMinimumSystemVersion — 13.0 (matches Package.swift platform pin)
#
# Re-runnable. Cleans the previous bundle each time.

set -euo pipefail

# Resolve script dir → project dir = parent of scripts/
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$HERE")"
cd "$PROJECT_DIR"

APP_NAME="WIMenuBar"
APP_BUNDLE="${APP_NAME}.app"
BUNDLE_ID="com.work-intelligence.menubar"
BUNDLE_VERSION="0.1.0"
MIN_MACOS="13.0"

BIN_SRC=".build/release/${APP_NAME}"

if [[ ! -x "${BIN_SRC}" ]]; then
  echo "ERROR: ${BIN_SRC} not found. Run 'swift build -c release' first." >&2
  exit 1
fi

echo "[bundle] wrapping ${BIN_SRC} → ${APP_BUNDLE}"

# Clean any prior bundle
rm -rf "${APP_BUNDLE}"

# 1. Skeleton
mkdir -p "${APP_BUNDLE}/Contents/MacOS"
mkdir -p "${APP_BUNDLE}/Contents/Resources"

# 2. Binary
cp "${BIN_SRC}" "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"
chmod +x "${APP_BUNDLE}/Contents/MacOS/${APP_NAME}"

# 3. Info.plist (the bare minimum macOS needs to treat this as an app)
cat > "${APP_BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>WI MenuBar</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleVersion</key>
    <string>${BUNDLE_VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${BUNDLE_VERSION}</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <!-- LSUIElement = YES means: no Dock icon, no menubar (the macOS one,
         not the app's own). Required for a menubar-only utility. -->
    <key>LSUIElement</key>
    <true/>
    <!-- High-resolution capable — necessary for SwiftUI to render crisply on
         Retina displays. Without this, the popover renders at 1x. -->
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# 4. Ad-hoc codesign. "-" signer means no real identity — uses an ephemeral
#    signature that satisfies Gatekeeper for locally-built apps. Required on
#    Apple Silicon: unsigned binaries are killed by the kernel on launch.
echo "[bundle] ad-hoc codesigning..."
codesign --force --deep --sign - "${APP_BUNDLE}" 2>&1 | sed 's/^/[codesign] /'

echo "[bundle] verifying signature..."
codesign --verify --verbose=1 "${APP_BUNDLE}" 2>&1 | sed 's/^/[codesign] /'

echo "[bundle] done → ${PROJECT_DIR}/${APP_BUNDLE}"
