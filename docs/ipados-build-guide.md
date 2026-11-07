# LearnHarness iPadOS Build & Toolchain Guide

LearnHarness uses a single unified codebase running across macOS desktop and iPadOS tablets powered by Tauri v2 and an in-browser Web Worker backend with `memfs`.

This guide documents the Apple build toolchain, prerequisites, codesigning configuration, and build commands for compiling and testing LearnHarness on iPadOS.

---

## 1. Prerequisites & Toolchain Setup

To compile and run LearnHarness on iPadOS (Simulator or physical iPad hardware), the following tools are required on a macOS host:

### System & Apple Tools
- **macOS Sonoma (14.0+) or Sequoia (15.0+)** running on Apple Silicon or Intel.
- **Xcode 15+** installed from the Mac App Store or Apple Developer portal.
- **Xcode Command Line Tools** pointed to full Xcode:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  ```
- **CocoaPods** and **XcodeGen** (used by Tauri v2 to generate the Xcode project):
  ```bash
  brew install cocoapods xcodegen
  ```

### Rust Mobile Targets
Ensure the iOS Rust target architectures are installed via `rustup`:
```bash
# Physical iPad (64-bit ARM)
rustup target add aarch64-apple-ios

# Apple Silicon iPad Simulator
rustup target add aarch64-apple-ios-sim

# Optional: Intel Mac Simulator (if using an x86_64 Mac)
rustup target add x86_64-apple-ios
```

---

## 2. Local Command Line Tools vs. Full Xcode.app

It is important to understand the boundary between local development and native iPadOS compilation:

| Capability | Command Line Tools Only | Full Xcode.app |
|---|---|---|
| Vite dev server (`npm run dev`) | Supported | Supported |
| TypeScript typechecking & linting | Supported | Supported |
| Web Worker & `memfs` runtime | Supported | Supported |
| Platform & preload unit tests (`npm test`) | Supported | Supported |
| Tauri Desktop host (`cargo test`, macOS desktop) | Supported | Supported |
| iOS Simulator compilation (`aarch64-apple-ios-sim`) | **Unsupported** (missing iOS SDK) | **Supported** |
| Physical iPad compilation (`aarch64-apple-ios`) | **Unsupported** (missing iOS SDK) | **Supported** |

### Why Command Line Tools Alone Cannot Compile for iOS
The standalone macOS Command Line Tools package (`/Library/Developer/CommandLineTools`) only ships with the macOS SDK (`MacOSX.sdk`). Compiling C/Objective-C/Rust dependencies for iOS requires the `iPhoneOS.platform` and `iPhoneSimulator.platform` SDKs bundled inside `/Applications/Xcode.app`.

If `xcode-select` is pointed to `/Library/Developer/CommandLineTools`, commands such as `cargo check --target aarch64-apple-ios-sim` will fail with:
```
xcrun: error: SDK "iphonesimulator" cannot be located
```
Switching `xcode-select` to `/Applications/Xcode.app/Contents/Developer` resolves this.

---

## 3. Apple Developer Signing & Team Configuration

iOS requires all binaries to be codesigned by an Apple Developer Team before installing onto physical hardware.

### Setting your Development Team ID
1. Locate your 10-character Apple Developer Team ID from [Apple Developer Account](https://developer.apple.com/account).
2. Set it in `src-tauri/tauri.ios.conf.json`:
   ```json
   {
     "bundle": {
       "iOS": {
         "developmentTeam": "YOUR_TEAM_ID_HERE"
       }
     }
   }
   ```
   Or export the environment variable:
   ```bash
   export APPLE_DEVELOPMENT_TEAM="YOUR_TEAM_ID_HERE"
   ```

### Bundle Identifier & Deep Linking
- **Bundle Identifier:** `com.hwacha.learnharness`
- **URL Scheme:** `learnharness`
  - On desktop, OAuth redirects use a local loopback server (`http://127.0.0.1:port/callback`).
  - On iPadOS, local loopback sockets trigger iOS Local Network permission dialogs. LearnHarness uses custom deep-link URI `learnharness://auth/callback` to seamlessly complete OAuth without socket listeners.

---

## 4. Tauri iOS Commands

All iOS commands are invoked via the Tauri CLI:

### 1. Initialize Native Xcode Project
Scaffold the native Apple project inside `src-tauri/gen/apple`:
```bash
npx tauri ios init
```
This generates `src-tauri/gen/apple/learnharness.xcodeproj` using `xcodegen` and installs CocoaPods dependencies.

### 2. Run in Simulator or Connected iPad
Launch the dev server and run the app in an iPad simulator:
```bash
npx tauri ios dev
```
To target a specific simulator or connected device:
```bash
# List available simulators and devices
npx tauri ios dev --list

# Target specific device
npx tauri ios dev --target "iPad Pro (13-inch) (M4)"
```

### 3. Build Production Archive / IPA
To build a signed release package for TestFlight or Ad-Hoc distribution:
```bash
npx tauri ios build
```
The compiled output is placed in `src-tauri/gen/apple/build/`.

---

## 5. iPadOS UX & Safe-Area Architecture

When running on iPadOS (`.lh-ios`), LearnHarness adapts its interface:

1. **Viewport & Scroll Containment:**
   - `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />`
   - `body { overscroll-behavior-y: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }`
   - Prevents iOS elastic rubber-band pull-down from disrupting transcript navigation.

2. **Safe-Area Custom Properties:**
   - `--lh-sat`: `env(safe-area-inset-top, 0px)`
   - `--lh-sab`: `env(safe-area-inset-bottom, 0px)`
   - `--lh-sal`: `env(safe-area-inset-left, 0px)`
   - `--lh-sar`: `env(safe-area-inset-right, 0px)`

3. **Top Bar & Sidebar:**
   - The top bar and sidebar header use `height: calc(3.75rem + var(--lh-sat))` with `padding-top: var(--lh-sat)` to render smoothly beneath the iPad status bar without clipping or content overlap.
   - Desktop traffic-light gutters (`lh-lights-gutter`, `lh-wco-gutter`, `lh-closed-toggle`) are zeroed out (`--lh-wco-right: 0px !important`).

4. **Touch & Document Handling:**
   - On desktop, dragging files from Finder yields OS POSIX paths via `tauri://drag-drop`.
   - On iPadOS, dropping files from Files.app or clicking UI elements marked with `[data-file-picker-trigger]` triggers document import. File contents are read into memory via `file.arrayBuffer()` and imported into `memfs` via `window.lh.importFile`, producing synthetic `/imported/<filename>` paths accessible by the Web Worker.

5. **Desktop Feature Stubs:**
   - Subprocess execution (`lh_exec_command`, `lh_spawn_daemon`) is safely rejected on iOS.
   - Auto-updater, application menu bars, and custom window resizing are no-oped to respect iPadOS sandboxing and Stage Manager window management.
