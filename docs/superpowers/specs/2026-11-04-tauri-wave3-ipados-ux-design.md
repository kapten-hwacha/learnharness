# Wave 3: iPadOS Target & Touch UX Design Spec

**Date:** 2026-11-04  
**Status:** Draft for Review  
**Prerequisites:** Wave 1 (Vite + In-Browser Worker Backend) & Wave 2 (Tauri v2 Desktop Host + Worker IPC Bridge)

---

## 1. Objective

Complete the transition of LearnHarness to iPadOS on-device support using Tauri v2, establishing a single unified codebase that runs across macOS desktop and iPadOS tablets.

Wave 1 moved the backend and Node.js route handlers into an in-browser Web Worker backed by `memfs` and WASM seams. Wave 2 built the native Tauri v2 Rust host and TypeScript bridge, retiring Electron. Wave 3 adapts the shell, UI chrome, touch interactions, safe-area layout, platform abstraction, and Apple build configuration for iPadOS.

---

## 2. Architecture & Platform Differentiation

LearnHarness detects its runtime platform across three tiers:
1. **Plain Browser Dev**: (`!__TAURI_INTERNALS__ && !lh`) -> Local Vite dev server with HTTP mock sync.
2. **Desktop (macOS / Windows / Linux)**: (`__TAURI_INTERNALS__ && !isIos`) -> Native Tauri host with window resizing, traffic lights, desktop menus, auto-updater, and subprocess execution.
3. **iPadOS**: (`__TAURI_INTERNALS__ && isIos`) -> Fullscreen WKWebView, safe-area insets, touch interactions, document picker file import, deep-link OAuth, with desktop-only systems (exec, window resize, auto-updater, application menu) safely stubbed/no-oped.

```
+---------------------------------------------------------------+
|                      LearnHarness Client                      |
|                  (React 19 + Tailwind v4 + Vite)              |
+---------------------------------------------------------------+
|                      tauri-preload.ts                         |
|  - Platform detection (darwin | win32 | linux | ios)          |
|  - Safe-area insets & CSS classes (.lh-ios, .lh-desktop)      |
|  - Virtual keyboard height detection                          |
+---------------------------------------------------------------+
                                |
             +------------------+------------------+
             |                                     |
    [Desktop (macOS/Win)]                      [iPadOS]
+--------------------------+          +-------------------------+
| - Traffic lights overlay |          | - Safe-area top/bottom  |
| - Custom window resizing |          | - Native touch gestures |
| - Native menus & updates |          | - File picker / memfs   |
| - CLI subprocess exec    |          | - Deep-link / Web OAuth |
+--------------------------+          +-------------------------+
             |                                     |
+---------------------------------------------------------------+
|                      Tauri v2 Rust Core                       |
|   src-tauri/src/{lib, fs_bridge, http_bridge, oauth, ...}     |
|   (iOS compilation targets: aarch64-apple-ios-sim, aarch64)  |
+---------------------------------------------------------------+
```

---

## 3. Detailed Design

### 3.1 Xcode Project & Apple Target Configuration
- **Scaffold**: `src-tauri/gen/apple/learnharness.xcodeproj` generated via `npx tauri ios init` (using `xcodegen`).
- **iOS Configuration**: `src-tauri/tauri.ios.conf.json` specifies:
  - Bundle identifier: `com.amosblomqvist.learnharness`
  - URL Scheme: `learnharness` (for OAuth deep linking)
  - Display name: `LearnHarness`
  - Minimum iOS version: `15.0`
- **Rust Targets**:
  - `aarch64-apple-ios-sim` (Apple Silicon iPad Simulator)
  - `aarch64-apple-ios` (Physical iPad hardware)

### 3.2 Rust Host Mobile Safety (`#[cfg(target_os = "ios")]`)
- **Desktop Menus**:
  `app.set_menu` and `app.on_menu_event` in `src-tauri/src/lib.rs` are compiled only under `#[cfg(desktop)]` (or `#[cfg(not(target_os = "ios"))]`). Mobile operating systems do not have application menu bars.
- **Auto-Updater**:
  In `src-tauri/src/updater.rs`, update checks and downloads return a disabled/unsupported status on iOS:
  ```rust
  #[cfg(target_os = "ios")]
  pub async fn lh_update_check(_app: tauri::AppHandle) -> Result<UpdateState, String> {
      Ok(UpdateState::idle())
  }
  ```
- **Window Sizing & Commands**:
  In `src-tauri/src/window.rs`, `lh_expand_window` immediately returns `Ok(())` on iOS, deferring entirely to iPadOS Stage Manager / Split View.
- **Subprocess Execution**:
  `exec.rs` commands (`lh_exec_command`, `lh_spawn_daemon`) return `Err("Subprocess execution is not supported on iOS".into())` when invoked on iOS.

### 3.3 Touch, Viewport & Safe-Area UX
- **Viewport Meta**:
  Update `index.html`:
  `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />`
- **CSS Safe Areas**:
  In `app/globals.css`, declare CSS custom properties:
  ```css
  :root {
      --lh-sat: env(safe-area-inset-top, 0px);
      --lh-sab: env(safe-area-inset-bottom, 0px);
      --lh-sal: env(safe-area-inset-left, 0px);
      --lh-sar: env(safe-area-inset-right, 0px);
  }
  ```
- **TopBar & Sidebar Adaptation**:
  - In `.lh-ios`:
    - TopBar padding-top includes `--lh-sat`.
    - Sidebar traffic-light gutter (`lh-wco-gutter`, `lh-closed-toggle`) is suppressed (width 0 / margin 0).
    - Top bar drag class (`lh-drag`) is inactive on touch devices.
- **Touch Gesture Tuning**:
  - `overscroll-behavior-y: none;` on `body` to eliminate rubber-band bounce interfering with scrolling cards and chat.
  - `-webkit-touch-callout: none;` on interactive chrome to prevent iOS long-press magnifying glass / callout on buttons.
  - `-webkit-tap-highlight-color: transparent;` for immediate visual responsiveness.

### 3.4 iPadOS File Import & Document Handling
- On desktop, drag & drop relies on native POSIX paths (`event.payload.paths`).
- On iPadOS, files dropped from Files.app or picked via `<input type="file" />` are read via `File.arrayBuffer()`.
- `window.lh.getDroppedFilePath(file)` returns synthetic path `/imported/<filename>` or stores file bytes directly into `memfs` so the backend Worker can immediately parse PDFs, images, and text notes.

### 3.5 iPadOS OAuth & Deep Linking
- On desktop, OAuth uses a local HTTP loopback server (`http://127.0.0.1:port/callback`).
- On iPadOS, local loopback sockets can trigger iOS local network security dialogs.
- Custom URL scheme `learnharness://auth/callback` is registered in `project.yml` and `tauri.ios.conf.json`.
- When an OAuth flow redirects to `learnharness://auth/callback?code=...`, Tauri's deep link handler catches it and emits `lh://oauth-callback` to the main window, completing authentication.

---

## 4. Verification & Testing Strategy

1. **Rust Verification**:
   - `cargo check --target aarch64-apple-ios-sim --manifest-path src-tauri/Cargo.toml` (or unit testing target-independent modules).
   - `cargo test --manifest-path src-tauri/Cargo.toml` (18+ tests passing).
2. **Platform & Preload Tests**:
   - Extend `tests/desktop-platform.test.ts` to test iOS platform detection, safe-area variables, and disabled desktop commands.
   - Test touch event handling and file import fallback in `tests/file-path-preload.test.ts`.
3. **Web & UI Verification**:
   - `npx tsc --noEmit` and `npx eslint .` clean.
   - `npx vite build` clean.
   - Verify that `.lh-ios` correctly sets safe-area insets and suppresses traffic-light gutters.
4. **CI Workflow**:
   - Add iOS build/check job or documentation for building in macOS runner with Xcode.
