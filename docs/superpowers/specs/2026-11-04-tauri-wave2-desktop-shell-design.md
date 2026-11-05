# Tauri v2 Migration (Wave 2): Desktop Shell Replacing Electron — Design Specification

**Date:** 2026-11-04  
**Status:** Draft (Pending User Spec Review)  
**Topic:** Replace the Electron shell (`electron/main.cjs`, `preload.cjs`, `electron-builder.yml`) with a Tauri v2 Rust host (`src-tauri/`) that serves the Wave 1 Vite SPA + Backend Worker on macOS (and Windows/Linux desktop)  
**Depends on:** Wave 1 (`docs/superpowers/specs/2026-11-04-tauri-wave1-vite-worker-backend-design.md`), commits `5b2f6ec0..7ef34fee`

---

## 1. Context & Scope

Wave 1 moved the backend into a Dedicated Web Worker behind a `HostBridge` (`src/worker/host-bridge.ts`), with a browser-dev implementation backed by `src/worker/vite-dev-bridge.ts`. Wave 2 adds the **Tauri implementation of that same `HostBridge`**, recreates the `window.lh` surface that `electron/preload.cjs` exposed, and retires Electron.

### Decisions (from design Q&A)
1. **Full replacement:** Electron is removed, not kept side-by-side.
2. **Keep the pure-JS OAuth modules** (`electron/chatgpt.cjs`, `chatgpt-ipc.cjs`, `subscriptions.cjs`, `subscription-store.cjs`, `subscription-ipc.cjs`, `web-subscription-browser.cjs`). They have no Electron imports and are used by `src/server/web-subscriptions.ts` and their tests.
3. **Desktop-only subprocess bridge** (`#[cfg(not(target_os = "ios"))]`) so `claude-code`, `cliproxy`, and `quaderno` keep working on desktop and report unavailable on iPadOS (Wave 3).
4. **In-app updater** wired to Tauri's updater on packaged desktop builds; `disabled` in dev and on iPadOS.

### Non-Goals
- iPadOS target, touch/safe-area UX (Wave 3).
- Code signing / notarization / release CI redesign beyond keeping `desktop:dist` working (`tauri build`). Release verification tooling (`scripts/verify-release.ts`, `tests/verify-release.test.ts`) is removed with `electron-builder.yml` and is **not** replaced in this wave.

---

## 2. Architecture

```
WKWebView (Tauri)                         Rust host (src-tauri/)
 ├─ React SPA (src/client/main.tsx)        ├─ lh_fs_hydrate / lh_fs_sync / lh_fs_read_external
 ├─ window.lh  (src/client/tauri-preload)  ├─ lh_http_fetch (reqwest, streaming, status-preserving)
 └─ Backend Worker (src/worker/entry.ts)   ├─ lh_open_external (https-only)
     └─ HostBridge = createTauriHostBridge ├─ lh_oauth_listen_start / _close (127.0.0.1 loopback)
                                           ├─ lh_exec_command / lh_spawn_daemon  [desktop only]
                                           ├─ lh_expand_window / lh_set_zoom
                                           └─ lh_update_get / _check / _install
```

### 2.1 `src-tauri/` crate
- `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, plus modules `fs_bridge.rs`, `http_bridge.rs`, `oauth.rs`, `exec.rs`, `window.rs`, `updater.rs`.
- `tauri.conf.json`: identifier `com.amosblomqvist.learnharness`, productName `LearnHarness`; `build.beforeDevCommand: "npm run vite:dev"`, `build.devUrl: "http://localhost:5173"`, `build.beforeBuildCommand: "npm run vite:build"`, `build.frontendDist: "../dist-web"`.
- Main window: `width: 1440`, `height: 900`, `minWidth: 640`, `minHeight: 600`, macOS `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `trafficLightPosition: { x: 16, y: 22.5 }` (values copied from `electron/main.cjs`).
- **Data locations:** packaged = app data dir (`~/Library/Application Support/LearnHarness`); dev (`cfg!(debug_assertions)` or `LH_DEV`) = `LearnHarness-dev`; `LH_DATA_DIR` / `LH_AUTH_FILE` env overrides win. `auth.json` and `*-credentials.json` live beside the data dir with mode `0600`.
- **Security posture (parity with Electron's guards):** CSP restricting the webview to app origin; `lh_open_external` accepts only `https:` URLs without credentials; permission requests limited to media (mic/STT), clipboard write, and local fonts.

### 2.2 Host commands

| Command | Contract |
| :--- | :--- |
| `lh_fs_hydrate() -> HydratedFsSnapshot` | Reads data dir, auth/credential files, and bundled read-only assets (`src/agent/system-prompt.md`, `src/agent/prompts/**`, `skills/**`) shipped as Tauri resources. Same shape as the Vite dev bridge. |
| `lh_fs_sync(op: FsMutationOp)` | Applies `writeFile`/`appendFile`/`rename`/`unlink`/`mkdir`/`rm`. **Rejects any path not inside the data dir, or not equal to `auth.json` / a `*-credentials.json`** (including `..` traversal). Atomic write via temp + rename; `0600` on credential files. |
| `lh_fs_read_external(path) -> bytes` | Reads a user-selected file (e.g. dropped PDF). |
| `lh_http_fetch(req) -> stream` | `reqwest`, streams body chunks to the Worker, preserves upstream status/headers (4xx/5xx are returned, never replaced). |
| `lh_open_external(url)` | `https:` only; rejects userinfo. |
| `lh_oauth_listen_start() -> { port }` / `lh_oauth_listen_close()` | Binds `127.0.0.1:0`, accepts exactly the OAuth callback, forwards `{method,url,headers}` to the Worker, replies with the same plain-text body/headers `chatgpt.cjs` uses. |
| `lh_exec_command`, `lh_spawn_daemon` | Desktop only. Backs `child_process` in `src/worker/shims/node-stubs.ts` for `claude`, `cliproxyapi`, `uv`, `typst`. On iOS builds the commands are not compiled in; the shim returns unavailable errors. |
| `lh_expand_window()` / `lh_set_zoom(factor)` | Widen to `SIDEBAR_AUTOCLOSE = 928` if narrower. Zoom clamps to `[0.75, 2]`. |
| `lh_update_get/check/install` | See §2.4. |

### 2.3 `window.lh` (`src/client/tauri-preload.ts`)
Installed in `src/client/main.tsx` before React mounts when `window.__TAURI_INTERNALS__` exists. Must expose **exactly** the keys the existing Electron preload exposed (asserted by test): `platform`, `getPathForFile`, `subscriptionTransport` (`"web"`), `openSubscriptionBrowser`, `chatgpt`, `subscriptions`, `expandWindow`, `onZoom`, `getZoom`, `onUpdateStatus`, `installUpdate`, `getUpdateState`, `checkForUpdates`, `onOpenSettings`. No filesystem or raw invoke access is exposed.

- `platform`: `"darwin" | "win32" | "linux"`.
- `getPathForFile(file)`: resolved from Tauri drag-drop events (`tauri://drag-drop` paths matched to the dropped `File`); returns `""` when no OS path exists (never the file name).
- `chatgpt` / `subscriptions`: `window.lh.subscriptionTransport === "web"` routes these through the existing `/api/subscriptions` web bridge (`components/settings/subscription-client.ts` already does this), so no new IPC owner is needed; `openSubscriptionBrowser(action)` validates `/api/subscriptions/browser?id=<uuid>` (same regex as today), resolves the 303 `Location` from the Worker, and calls `lh_open_external`.
- Zoom ladder `[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]` via menu accelerators; every change emitted to `onZoom`.
- Menu: App menu (About, Check for Updates…, Hide, Quit), Edit roles, View (Reload, Actual Size, Zoom In/Out, Fullscreen), Window. "Check for Updates…" focuses the window and sends `onOpenSettings("general")`.

### 2.4 Updater
- States: `idle → checking → downloading | up-to-date → downloaded | error`, plus `disabled` (dev/unpackaged, and iOS). Snapshot carries `{ status, version, revision }`; later non-`downloaded` states never overwrite `downloaded`.
- Background check at startup and every 24h, **skipped when `settings.json` has `general.autoUpdate === false`** (read fresh each check; absent/corrupt → ON). Manual checks always run.
- Feed: GitHub Releases for `amosblomqvist/learnharness` via `tauri-plugin-updater`.
- Errors never crash the app; they log and report `error`.

### 2.5 `HostBridge` selection (`src/worker/host-bridge.ts`)
Add `createTauriHostBridge()` and have the default bridge pick Tauri when `__TAURI_INTERNALS__` is present, else the Vite dev bridge. `nativeFetch` must preserve upstream status codes.

---

## 3. Retiring Electron

**Delete:**
- `electron/main.cjs`, `electron/preload.cjs`, `electron/server-title-guard.cjs`, `electron/browser-service-readiness.cjs`, `electron/desktop-api.cjs`
- `electron-builder.yml`, `scripts/after-pack.cjs`, `scripts/build-server.mjs`, `scripts/verify-release.ts`, and the Electron-specific smoke scripts that launch the Electron binary (`scripts/smoke-server.mjs`, `scripts/smoke-provider-runtime.mjs`, `scripts/smoke-file-paths.mjs`, `scripts/smoke-demo-runtime.mjs`, `scripts/smoke-image-runtime.mjs`, `scripts/smoke-web-subscriptions.mjs` only if they cannot run without Electron/standalone Next — the implementer lists each deletion in its report).
- Tests that exist only for the removed shell: `tests/browser-service-lifetime.test.ts`, `tests/browser-service-readiness.test.ts`, `tests/server-title-guard.test.ts`, `tests/desktop-payload.test.ts`, `tests/mac-signing-toolchain.test.ts`, `tests/verify-release.test.ts`, `tests/desktop-api.test.ts`.

**Rewrite (keep intent, retarget to Tauri):**
- `tests/desktop-platform.test.ts` → tests `src/client/tauri-preload.ts` and `src-tauri/tauri.conf.json` (window size/min size, traffic-light coordinates, identifier).
- `tests/file-path-preload.test.ts` → path-only bridge: returns the OS path for a dropped file, `""` otherwise, never reads file content, exact key set above, no raw fs/invoke exposed.
- `tests/automatic-updates.test.ts` → updater state machine and `autoUpdate` opt-out against `src/client` + a pure TS reducer shared with the Rust-facing contract.
- `tests/chatgpt-file-store.test.ts`: drop the final test that reads `electron/main.cjs`; keep the assertion that `electron/chatgpt.cjs` contains no `safeStorage`/`encryptedStore`.

**Keep unchanged:** the pure-JS OAuth modules listed in §1 and their tests.

**Remove server-side desktop gate:** `proxy.ts` and `src/server/desktop-access.ts` guard a localhost HTTP server that no longer exists in the Tauri build. `proxy.ts` is deleted with the Next runtime path only if nothing else imports it; otherwise it stays untouched. The implementer reports which.

**`package.json`:** remove `main`, `electron`, `electron-builder`, `electron-updater`, `desktopName`; add `@tauri-apps/api`, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-http` (if used by the JS side), and dev dep `@tauri-apps/cli`. Scripts: `"desktop:dev": "tauri dev"`, `"desktop:dist": "tauri build"`. Existing `dev`/`build`/`start` Next scripts stay until the Next runtime is retired (not this wave).

---

## 4. Error Handling & Edge Cases
- **Path traversal in `lh_fs_sync`:** rejected before touching disk; returns an error to the Worker, which logs it without crashing.
- **OAuth listener:** one pending listener at a time; second `listen_start` returns an error; unsolicited paths get `404`; closes on completion, cancel, or timeout.
- **Drop without OS path:** `getPathForFile` returns `""`; the UI shows its existing "desktop app only" notice behavior.
- **Subprocess unavailable (binary missing / iOS):** shim returns the same "not installed / unavailable" status shapes the existing `/api/claude-code` and `/api/cliproxy` routes already handle.
- **Updater feed down:** `error` status; app keeps running.

---

## 5. Testing & Verification
1. **Rust (`cargo test --manifest-path src-tauri/Cargo.toml`):** path-boundary check (inside data dir ok; `..`, outside, sibling-prefix like `data-evil/` rejected), credential file mode `0600`, zoom clamp, `https`-only external URL validation, updater state transitions.
2. **TypeScript:** rewritten tests in §3, plus `tests/tauri-host-bridge.test.ts` covering `createTauriHostBridge()` (mocked `invoke`): hydrate/sync mapping, 4xx/5xx fetch fidelity, bridge selection.
3. **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npx vite build`, `cargo check` and `cargo test` in `src-tauri/`, and a `tauri build --debug` smoke that produces a launchable `.app` on macOS.
4. **Manual (user):** launch `npm run desktop:dev`, confirm chat round-trip, graph persistence across restart, PDF drop, and one OAuth sign-in. Not automatable here.
