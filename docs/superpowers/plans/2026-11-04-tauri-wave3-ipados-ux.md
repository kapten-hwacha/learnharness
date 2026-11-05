# Wave 3: iPadOS Target & Touch UX Implementation Plan

**Branch:** `experiment/cliproxy-custom-provider`  
**Spec:** `docs/superpowers/specs/2026-11-04-tauri-wave3-ipados-ux-design.md`

---

## Task 1: iOS Build & Rust Target Configuration
- **Files**:
  - `src-tauri/tauri.ios.conf.json` (create)
  - `src-tauri/src/lib.rs` (update)
  - `src-tauri/src/window.rs` (update)
  - `src-tauri/src/updater.rs` (update)
  - `src-tauri/src/exec.rs` (update)
- **Work**:
  1. Create `src-tauri/tauri.ios.conf.json` with iOS bundle settings, custom URL scheme `learnharness`, and mobile window configuration.
  2. In `src-tauri/src/lib.rs`:
     - Wrap desktop menu creation and menu event handlers with `#[cfg(desktop)]` (or `#[cfg(not(target_os = "ios"))]`).
  3. In `src-tauri/src/window.rs`:
     - Make `lh_expand_window` a no-op on iOS (`#[cfg(target_os = "ios")]`).
  4. In `src-tauri/src/updater.rs`:
     - Stub updater functions to idle on iOS (`#[cfg(target_os = "ios")]`).
  5. In `src-tauri/src/exec.rs`:
     - Return unsupported errors if executed on iOS (`#[cfg(target_os = "ios")]`).
- **Tests**:
  - `cargo test --manifest-path src-tauri/Cargo.toml`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`

---

## Task 2: Platform Abstraction & iPadOS Preload
- **Files**:
  - `src/client/platform.ts` (create/update)
  - `src/client/tauri-preload.ts` (update)
  - `src/client/main.tsx` (update)
  - `components/sidebar.tsx` (update)
  - `tests/desktop-platform.test.ts` (update)
  - `tests/file-path-preload.test.ts` (update)
- **Work**:
  1. In `src/client/platform.ts`:
     - Implement robust platform detection: `isIos()`, `isDesktop()`, `isTauri()`, `getPlatform()`.
     - Accurately detect iPadOS (including Apple Silicon Safari userAgent `MacIntel` + touch points > 1).
  2. In `src/client/tauri-preload.ts`:
     - Accept `"ios"` as a valid platform in `TauriPreloadDeps`.
     - In `window.lh`: expose `isIos: boolean`, `isMobile: boolean`.
     - Add `importFile(file: File): Promise<string>` to store file content directly into `memfs` for document import on iPadOS.
  3. In `src/client/main.tsx` & `components/sidebar.tsx`:
     - Apply `.lh-ios` class on `document.documentElement` when running on iPadOS.
     - Apply `.lh-desktop` (and alias `.lh-electron`) on macOS/Windows/Linux desktop.
- **Tests**:
  - `npx tsx --test tests/desktop-platform.test.ts`
  - `npx tsx --test tests/file-path-preload.test.ts`

---

## Task 3: Touch, Safe-Area & Viewport UX
- **Files**:
  - `index.html` (update)
  - `app/globals.css` (update)
  - `components/top-bar.tsx` (update)
  - `components/sidebar.tsx` (update)
  - `components/file-path-drop-zone.tsx` (update)
- **Work**:
  1. In `index.html`:
     - Add `viewport-fit=cover, user-scalable=no` to viewport meta tag.
  2. In `app/globals.css`:
     - Define `--lh-sat`, `--lh-sab`, `--lh-sal`, `--lh-sar` mapped to `env(safe-area-inset-*)`.
     - In `.lh-ios`:
       - Add safe-area padding to top bars and bottom action zones.
       - Zero out traffic-light gutters (`lh-wco-gutter`, `lh-closed-toggle`).
       - Disable pull-to-refresh (`overscroll-behavior-y: none`).
       - Remove tap callouts (`-webkit-touch-callout: none`, `-webkit-tap-highlight-color: transparent`).
  3. In `components/top-bar.tsx` & `components/sidebar.tsx`:
     - Ensure top bar renders cleanly beneath the iPad status bar using safe-area insets without overlapping.
  4. In `components/file-path-drop-zone.tsx`:
     - Support native `<input type="file" />` trigger when running on iPadOS where Finder drag-and-drop does not provide file system paths.
- **Tests**:
  - `npx tsc --noEmit`
  - `npx eslint .`
  - `npx vite build`
  - End-to-end integration test of CSS classes and platform behavior in `tests/desktop-platform.test.ts`.

---

## Task 4: Documentation & CI Apple Build Guide
- **Files**:
  - `docs/ipados-build-guide.md` (create)
  - `.github/workflows/ci.yml` (update)
- **Work**:
  1. Create `docs/ipados-build-guide.md` explaining how to build and run the iOS project on macOS with Xcode, including codesigning, simulator launch (`npx tauri ios dev`), and device deployment.
  2. Update CI workflow to verify compilation and tests.
