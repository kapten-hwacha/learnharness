# Tauri v2 Migration (Wave 2): Desktop Shell Replacing Electron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tauri v2 Rust host (`src-tauri/`) that implements the Wave 1 `HostBridge`, recreates the `window.lh` surface, and then retire the Electron shell.

**Architecture:** Pure, Tauri-free Rust modules (`fs_bridge`, `exec`, `window`, `updater`) hold all security and state logic so `cargo test` covers them without a webview; `lib.rs` only registers thin `#[tauri::command]` wrappers. On the TS side, `createTauriHostBridge()` maps the four `HostBridge` methods onto those commands, and `src/client/tauri-preload.ts` installs `window.lh` before React mounts. Electron files and their shell-only tests are deleted last, after the replacements pass.

**Tech Stack:** Rust (Tauri v2, `reqwest`, `tauri-plugin-updater`), TypeScript, Vite, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-tauri-wave2-desktop-shell-design.md`

## Global Constraints

- Window: `width: 1440`, `height: 900`, `minWidth: 640`, `minHeight: 600`, macOS `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `trafficLightPosition: { x: 16.0, y: 22.5 }`; identifier `com.amosblomqvist.learnharness`; productName `LearnHarness`.
- `tauri.conf.json` build: `beforeDevCommand: "npm run vite:dev"`, `devUrl: "http://localhost:5173"`, `beforeBuildCommand: "npm run vite:build"`, `frontendDist: "../dist-web"`.
- `lh_fs_sync` rejects any path not inside the data dir, not equal to `auth.json`, and not a `*-credentials.json` in the user-data dir; credential files are written `0600`.
- `lh_http_fetch` returns upstream 4xx/5xx status and body unchanged.
- `lh_open_external` accepts only `https:` URLs with no username/password.
- Zoom clamps to `[0.75, 2]`; ladder is `[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]`; `SIDEBAR_AUTOCLOSE = 928`.
- `window.lh` keys are exactly: `platform`, `getPathForFile`, `subscriptionTransport`, `openSubscriptionBrowser`, `chatgpt`, `subscriptions`, `expandWindow`, `onZoom`, `getZoom`, `onUpdateStatus`, `installUpdate`, `getUpdateState`, `checkForUpdates`, `onOpenSettings`. No raw `invoke`, fs, or `webUtils` exposure.
- The pure-JS OAuth modules in `electron/` (`chatgpt.cjs`, `chatgpt-ipc.cjs`, `subscriptions.cjs`, `subscription-store.cjs`, `subscription-ipc.cjs`, `web-subscription-browser.cjs`) and their tests stay unchanged.
- Subprocess commands are compiled only with `#[cfg(not(target_os = "ios"))]`.
- Every changed file passes `npm run typecheck` and `npm run lint`; Rust passes `cargo fmt --check` and `cargo clippy -- -D warnings`.
- Do not stage unrelated dirty files (`components/chat.tsx`, `src/server/chat-handler.ts`, `tests/render-teach-soft-cap.test.tsx`, other plans/specs).

## Review Focus

1. Sibling-prefix path escape in `lh_fs_sync`: with data dir `/x/LearnHarness`, a path `/x/LearnHarness-evil/a.json` must be rejected (prefix match on the string is not containment).
2. Symlink escape in `lh_fs_sync`: a symlink inside the data dir pointing outside it must not allow writes through it.
3. OAuth listener second start: a second `lh_oauth_listen_start` while one is pending must fail rather than leak the first socket; an unsolicited path must get `404` and not consume the pending callback.
4. `getPathForFile` for a `File` with no dropped OS path must return `""`, never `file.name`.
5. Updater `downloaded` stickiness: a later `checking`/`error` event must not overwrite a staged `downloaded` state.

---

### Task 1: Rust host (`src-tauri/`)

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/fs_bridge.rs`, `src-tauri/src/http_bridge.rs`, `src-tauri/src/oauth.rs`, `src-tauri/src/exec.rs`, `src-tauri/src/window.rs`, `src-tauri/src/updater.rs`
- Modify: `.gitignore` (add `src-tauri/target/`, `src-tauri/gen/`)
- Test: inline `#[cfg(test)]` modules in each `src-tauri/src/*.rs` file

**Interfaces:**
- Consumes: the `FsMutationOp` and `HydratedFsSnapshot` JSON shapes from `src/worker/host-bridge.ts` (camelCase fields: `type`, `path`, `dataBase64`, `oldPath`, `newPath`, `recursive`, `force`, `mode`; snapshot `root`, `dataDir`, `authFile`, `files`, `dirs`).
- Produces (Tauri commands, exact names, arguments serialized camelCase):
  - `lh_fs_hydrate() -> HydratedFsSnapshot`
  - `lh_fs_sync(op: FsMutationOp) -> ()`
  - `lh_fs_read_external(path: String) -> Vec<u8>`
  - `lh_http_fetch(req: HttpRequest) -> HttpResponse` with `HttpRequest { url, method, headers: Vec<(String,String)>, body_base64: Option<String> }` and `HttpResponse { status: u16, headers: Vec<(String,String)>, body_base64: String }`
  - `lh_open_external(url: String) -> ()`
  - `lh_oauth_listen_start() -> u16`, `lh_oauth_listen_close() -> ()`, event `lh://oauth-request` with payload `{ method, url, headers }`, command `lh_oauth_respond(status: u16, headers: Vec<(String,String)>, body: String)`
  - `lh_exec_command(cmd: String, args: Vec<String>, env: Option<Vec<(String,String)>>, timeout_ms: Option<u64>) -> ExecResult { code: Option<i32>, stdout: String, stderr: String }` (desktop only)
  - `lh_expand_window() -> ()`, `lh_set_zoom(factor: f64) -> f64` (returns the clamped factor, emits `lh://zoom`)
  - `lh_update_get() -> UpdateState`, `lh_update_check() -> ()`, `lh_update_install() -> ()`; event `lh://update-status` with `UpdateState { status: String, version: Option<String>, revision: u64 }`
- Pure functions (unit-tested without Tauri): `fs_bridge::resolve_allowed(path: &str, data_dir: &Path, auth_file: &Path, user_data_dir: &Path) -> Result<PathBuf, String>`, `fs_bridge::apply_op(op: &FsMutationOp, data_dir: &Path, auth_file: &Path, user_data_dir: &Path) -> Result<(), String>`, `window::clamp_zoom(f: f64) -> f64`, `http_bridge::validate_external_url(url: &str) -> Result<(), String>`, `updater::UpdateMachine` with `fn on_event(&mut self, ev: UpdateEvent) -> UpdateState`.

- [ ] **Step 1: Scaffold the crate and write failing Rust tests**

Create `Cargo.toml` (Tauri v2, `serde`, `serde_json`, `base64`, `reqwest` with `stream`, `tokio`, `tauri-plugin-updater`), `build.rs`, and the module files with the signatures above and tests only. Required tests (names exact):
- `fs_bridge::tests::allows_path_inside_data_dir`, `rejects_dotdot_escape`, `rejects_sibling_prefix_dir` (`/x/LearnHarness-evil/a.json` vs `/x/LearnHarness`), `rejects_symlink_escape` (create a symlink in a temp data dir pointing to another temp dir; `apply_op` writeFile through it returns `Err`), `allows_auth_json_and_credentials_files`, `rejects_other_files_in_user_data_dir`, `credentials_written_with_mode_0600` (unix), `rename_overwrites_atomically`.
- `window::tests::clamp_zoom_bounds` (`0.1 -> 0.75`, `5.0 -> 2.0`, `1.25 -> 1.25`, `f64::NAN -> 1.0`).
- `http_bridge::tests::external_url_https_only` (`https://a.com/x` ok; `http://a.com`, `file:///etc/passwd`, `https://u:p@a.com` rejected).
- `updater::tests::downloaded_is_sticky` (after `Downloaded`, events `Checking` and `Error` leave status `downloaded`), `disabled_when_unpackaged`, `revision_increments_per_change`.
- `oauth::tests::second_start_fails_while_pending`, `unsolicited_path_gets_404_without_consuming` (drive the listener over a real `TcpStream` on `127.0.0.1`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL (unimplemented / `todo!()` panics), not a compile error.

- [ ] **Step 3: Implement the pure modules**

Implement `resolve_allowed` by canonicalizing the existing parent directory of the target (so symlinks resolve) and checking `Path::starts_with` against the canonicalized data dir (component-wise, not string prefix). `apply_op` writes via temp file in the same directory then `rename`; sets `0o600` on `auth.json` and `*-credentials.json`. Implement `UpdateMachine`, `clamp_zoom`, `validate_external_url`, and the OAuth listener (single pending slot guarded by a mutex; replies exactly the headers/body the Worker supplies through `lh_oauth_respond`, `404` for any path other than `/auth/callback` or non-GET).

- [ ] **Step 4: Implement `lib.rs`, `http_bridge.rs`, `exec.rs`, `tauri.conf.json`, capabilities**

`lib.rs` registers every command listed under Produces, resolves data/auth/user-data dirs (packaged: app data dir; `cfg!(debug_assertions)` or `LH_DEV`: `LearnHarness-dev`; `LH_DATA_DIR`/`LH_AUTH_FILE` override), bundles `src/agent/system-prompt.md`, `src/agent/prompts/**`, `skills/**` as Tauri resources for `lh_fs_hydrate`, builds the app menu (About, Check for Updates…, Hide, Quit; Edit roles; View with Actual Size / Zoom In / Zoom Out accelerators calling the zoom ladder; Window), and starts the 24h background update check, skipped when `settings.json` has `general.autoUpdate === false`. `exec.rs` is wrapped in `#[cfg(not(target_os = "ios"))]`. `tauri.conf.json` uses the Global Constraints values.

- [ ] **Step 5: Run Rust gates**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all pass, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri .gitignore
git commit -m "feat(tauri): add Rust host with fs/http/oauth/exec/window/updater commands"
```

---

### Task 2: TypeScript bridge, `window.lh`, and updater contract

**Files:**
- Modify: `src/worker/host-bridge.ts` (add `createTauriHostBridge`, default selection)
- Modify: `src/worker/shims/node-stubs.ts` (wire `child_process` and `http.createServer` to Tauri commands when present)
- Modify: `src/client/main.tsx` (install `window.lh` before mount)
- Modify: `package.json` (add `@tauri-apps/api`, `@tauri-apps/plugin-updater`, dev `@tauri-apps/cli`; scripts `desktop:dev`, `desktop:dist`)
- Create: `src/client/tauri-preload.ts`
- Create: `src/core/update-state.ts` (pure reducer mirroring Rust `UpdateMachine`)
- Test: `tests/tauri-host-bridge.test.ts`, `tests/desktop-platform.test.ts` (rewrite), `tests/file-path-preload.test.ts` (rewrite), `tests/automatic-updates.test.ts` (rewrite)

**Interfaces:**
- Consumes: Task 1 commands and events (exact names above); `HostBridge`, `FsMutationOp`, `HydratedFsSnapshot` from `src/worker/host-bridge.ts`.
- Produces:
  - `export function createTauriHostBridge(invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): HostBridge` in `src/worker/host-bridge.ts`
  - `export function installTauriPreload(deps: { invoke: InvokeFn; listen: ListenFn; platform: "darwin" | "win32" | "linux"; target?: Window }): void` and `export const ZOOM_LADDER: readonly number[]` in `src/client/tauri-preload.ts`
  - `export type UpdateStatus = "idle" | "checking" | "downloading" | "up-to-date" | "downloaded" | "error" | "disabled"`, `export interface UpdateState { status: UpdateStatus; version: string | null; revision: number }`, `export function reduceUpdate(state: UpdateState, ev: { type: UpdateStatus; version?: string }): UpdateState` in `src/core/update-state.ts`

- [ ] **Step 1: Write failing tests**

`tests/tauri-host-bridge.test.ts`:
- `hydrateFs maps lh_fs_hydrate result unchanged`
- `syncFs invokes lh_fs_sync with the op` (assert `invoke` called with `("lh_fs_sync", { op })`)
- `nativeFetch returns 401 status and body from lh_http_fetch without falling back` (mock returns `{status:401, headers:[["content-type","application/json"]], bodyBase64: base64('{"e":1}')}`; assert `res.status === 401`, `await res.text() === '{"e":1}'`)
- `readExternalFile invokes lh_fs_read_external and returns Uint8Array`
- `default bridge is the Tauri bridge when __TAURI_INTERNALS__ exists, otherwise the dev bridge`

`tests/desktop-platform.test.ts` (rewrite):
- `window.lh has exactly the expected keys` (sorted `Object.keys` equals the 14 keys in Global Constraints)
- `no raw invoke, fs, or webUtils exposed` (`Object.hasOwn` false for `invoke`, `fs`, `webUtils`, `ipcRenderer`, `readFile`, `writeFile`)
- `platform reflects the injected platform`
- `expandWindow invokes lh_expand_window`
- `zoom ladder steps through ZOOM_LADDER and clamps` (from 1: in→1.1; at 2: in→2; at 0.75: out→0.75; reset→1)
- `tauri.conf.json window and identifier` (reads `src-tauri/tauri.conf.json`; asserts the Global Constraints window values, `trafficLightPosition` `{x:16,y:22.5}`, identifier, `frontendDist`)

`tests/file-path-preload.test.ts` (rewrite):
- `getPathForFile returns the OS path for a dropped File` (deliver a drag-drop event with path `/actual/course/notes with \`backticks\`.pdf` matched to the `File`)
- `returns "" for a File with no dropped path and never the file name`
- `never reads file content` (define throwing `text`/`arrayBuffer`/`stream` on the File; count reads === 0)

`tests/automatic-updates.test.ts` (rewrite):
- `reduceUpdate downloaded is sticky` (`downloaded` then `checking`/`error` unchanged)
- `revision increments on each accepted change`
- `disabled stays disabled`
- `lh.checkForUpdates invokes lh_update_check; installUpdate invokes lh_update_install; getUpdateState invokes lh_update_get`
- `onUpdateStatus receives lh://update-status payloads and unsubscribes`

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx tsx --test tests/tauri-host-bridge.test.ts tests/desktop-platform.test.ts tests/file-path-preload.test.ts tests/automatic-updates.test.ts`
Expected: FAIL (missing exports / modules).

- [ ] **Step 3: Implement `createTauriHostBridge`, `update-state.ts`, `tauri-preload.ts`**

`nativeFetch` serializes the request (url, method, headers, base64 body) to `lh_http_fetch` and builds a `Response` from the returned status/headers/body regardless of status. `installTauriPreload` assigns `window.lh` with exactly the 14 keys; `chatgpt`/`subscriptions` are omitted from native IPC by setting `subscriptionTransport: "web"` and providing inert stubs (the components already route to the web bridge when transport is `"web"`); `openSubscriptionBrowser(action)` validates `/^\/api\/subscriptions\/browser\?id=[0-9a-f-]{36}$/`, POSTs it to the Worker, requires a `303` with an `https:` `Location` without credentials, then calls `lh_open_external`. Path resolution listens for Tauri drag-drop events and keeps a map from dropped `File` to path.

- [ ] **Step 4: Wire `main.tsx`, `node-stubs.ts`, `package.json`**

`main.tsx` calls `installTauriPreload` before rendering when `window.__TAURI_INTERNALS__` exists. `node-stubs.ts` `child_process.execFile/execSync/spawn` call `lh_exec_command` when Tauri is present, else throw the existing unavailable error; `http.createServer` uses `lh_oauth_listen_start` / `lh://oauth-request` / `lh_oauth_respond`. Add the dependencies and scripts `"desktop:dev": "tauri dev"`, `"desktop:dist": "tauri build"`.

- [ ] **Step 5: Run tests, typecheck, lint, build**

Run: `NODE_ENV=test npx tsx --test tests/tauri-host-bridge.test.ts tests/desktop-platform.test.ts tests/file-path-preload.test.ts tests/automatic-updates.test.ts && npm run typecheck && npm run lint && npx vite build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/worker/host-bridge.ts src/worker/shims/node-stubs.ts src/client/main.tsx src/client/tauri-preload.ts src/core/update-state.ts package.json package-lock.json tests/tauri-host-bridge.test.ts tests/desktop-platform.test.ts tests/file-path-preload.test.ts tests/automatic-updates.test.ts
git commit -m "feat(tauri): add Tauri host bridge, window.lh preload, and updater contract"
```

---

### Task 3: Retire Electron

**Files:**
- Delete: `electron/main.cjs`, `electron/preload.cjs`, `electron/server-title-guard.cjs`, `electron/browser-service-readiness.cjs`, `electron/desktop-api.cjs`, `electron-builder.yml`, `scripts/after-pack.cjs`, `scripts/build-server.mjs`, `scripts/verify-release.ts`
- Delete (only the ones that cannot run without Electron or the standalone Next server; list each decision in the report): `scripts/smoke-server.mjs`, `scripts/smoke-provider-runtime.mjs`, `scripts/smoke-file-paths.mjs`, `scripts/smoke-demo-runtime.mjs`, `scripts/smoke-image-runtime.mjs`, `scripts/smoke-web-subscriptions.mjs`
- Delete tests: `tests/browser-service-lifetime.test.ts`, `tests/browser-service-readiness.test.ts`, `tests/server-title-guard.test.ts`, `tests/desktop-payload.test.ts`, `tests/mac-signing-toolchain.test.ts`, `tests/verify-release.test.ts`, `tests/desktop-api.test.ts`
- Modify: `tests/chatgpt-file-store.test.ts` (remove the last test that reads `electron/main.cjs`; keep a test asserting `electron/chatgpt.cjs` has no `safeStorage|encryptedStore|chatgpt-credentials\.enc\.json`)
- Modify: `package.json` (remove `main`, `desktopName`, `electron`, `electron-builder`, `electron-updater`; remove the `desktop:dist` Electron chain if still present)
- Modify: `docs/architecture.md`, `docs/development.md`, `docs/desktop-release.md`, `README.md` (replace Electron wording with Tauri; mark release/signing as not yet ported)
- Conditionally delete: `proxy.ts` and `src/server/desktop-access.ts` plus their tests, only if `grep -rn "desktop-access\|desktopAPIAuthorized" src app tests components` shows no remaining importer other than themselves and their tests; otherwise leave untouched. Report which.
- Also check and fix: `src/agent/subagents/headless.ts` still references `browserServiceBinary`/`electron`; leave behavior untouched (the Worker overrides `HeadlessApi`), but `tests/` that assert on it must still pass.

**Interfaces:**
- Consumes: Tasks 1 and 2 (everything the deleted files did must already have a replacement and passing tests).
- Produces: a tree with no `require("electron")` outside `node_modules`, and a green full suite.

- [ ] **Step 1: Write the failing guard test**

Create `tests/no-electron.test.ts` with `no source file requires electron` (walk `electron/`, `src/`, `app/`, `components/`, `scripts/`; assert none matches `/require\(["']electron["']\)|from ["']electron["']/`) and `package.json has no electron dependencies` (assert `electron`, `electron-builder`, `electron-updater` absent from `dependencies` and `devDependencies`, and no `main` field).

- [ ] **Step 2: Run it to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/no-electron.test.ts`
Expected: FAIL (Electron files and dependencies still present).

- [ ] **Step 3: Delete, edit, and update docs per the Files list**

Run `npm uninstall electron electron-builder electron-updater` to update `package-lock.json`.

- [ ] **Step 4: Run the full gates**

Run: `npm test && npm run typecheck && npm run lint && npx vite build && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all pass. Any pre-existing failure unrelated to this wave is reported in the report file with evidence it also fails on the previous commit (`git stash`-free: run on `git worktree` of `HEAD~`), not fixed here.

- [ ] **Step 5: Debug bundle smoke**

Run: `npm run desktop:dist -- --debug --no-bundle`
Expected: exits 0 and produces `src-tauri/target/debug/learnharness` (or the product binary name). If the toolchain cannot build here, report the exact error; do not mark this step passed.

- [ ] **Step 6: Commit**

Stage only the paths this task touched (never `git add -A` on `tests/` or `src/server/`: `tests/render-teach-soft-cap.test.tsx` and `src/server/chat-handler.ts` are unrelated dirty files). Use `git status --short` to list this task's deletions/edits, then `git add`/`git rm` each explicitly:

```bash
git rm -r electron/main.cjs electron/preload.cjs electron/server-title-guard.cjs electron/browser-service-readiness.cjs electron/desktop-api.cjs electron-builder.yml
# plus each other file deleted in this task, by exact path
git add tests/no-electron.test.ts tests/chatgpt-file-store.test.ts package.json package-lock.json docs/architecture.md docs/development.md docs/desktop-release.md README.md
git commit -m "chore(tauri): retire Electron shell, packaging, and shell-only tests"
```
