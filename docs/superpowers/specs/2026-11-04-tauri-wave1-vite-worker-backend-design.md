# Tauri v2 Migration (Wave 1): Vite SPA, In-Browser Backend Worker, and WASM/Canvas Rendering Seam — Design Specification

**Date:** 2026-11-04  
**Status:** Draft (Pending User Spec Review)  
**Topic:** Replacing Next.js runtime/SSR with a unified Vite SPA + Dedicated Backend Web Worker + WASM/OffscreenCanvas rendering seam as Wave 1 of the Electron → Tauri v2 (macOS + iPadOS) migration

---

## 1. Context & 3-Wave Migration Roadmap

LearnHarness is migrating from its desktop-only Electron + Next.js standalone child-process architecture (`electron/main.cjs` + `.next/standalone/server.js`) to a unified **Tauri v2** architecture supporting both **macOS desktop** and **standalone on-device iPadOS**.

Because iPadOS forbids spawning external child processes (`child_process.spawn`), loading macOS `.node` native addons (`@napi-rs/canvas`, `@resvg/resvg-js`), or enabling JIT/WebAssembly outside WebKit's `WebContent` process, the migration is structured into three sequential waves:

1. **Wave 1 (This Spec — Vite SPA + Backend Web Worker + WASM/Canvas Seam):**
   - Replace Next.js dev/build with **Vite** bundling both the React SPA (`src/client/`) and a **Dedicated Backend Web Worker** (`src/worker/`) that runs `src/server/`, `src/agent/`, `src/store/`, and all 35 `app/api/**/route.ts` handlers in-process inside WebKit/browser.
   - Provide `next/navigation` and `next/link` aliases (`src/client/router.tsx`) so `components/` and existing `tests/` require zero import churn.
   - Provide a write-through in-memory POSIX filesystem (`src/worker/shims/fs.ts`) and a pluggable `HostBridge` (`src/worker/host-bridge.ts`) backed by a Vite dev-server bridge in `npm run dev` (and by Tauri Rust commands in Waves 2–3).
   - Provide a browser/Worker-native `HeadlessApi` (`src/worker/headless-worker.ts`) and Photon WASM image-resize loader so PDF rendering (`pdfjs-dist` + `OffscreenCanvas`), SVG rasterization (`@resvg/resvg-wasm`), and HTML/JS demo verification (sandboxed `<iframe>`) run without native `.node` binaries or Puppeteer.
2. **Wave 2 (Tauri v2 Desktop Shell Replacing Electron):**
   - Add `src-tauri/` (Rust host: `LH_DATA_DIR` / `LH_AUTH_FILE` persistence, `tauri-plugin-http` CORS-free streaming `fetch`, `window.lh` preload bridge, OAuth subscriptions, auto-updater, and desktop CLI bridges for `claude-code`, `cliproxy`, and `quaderno`), and retire `electron/`.
3. **Wave 3 (Tauri v2 iPadOS Target & Touch/Viewport UX):**
   - Initialize the iPadOS Xcode target (`tauri ios`), wire `ASWebAuthenticationSession` for OAuth and `UIDocumentPickerViewController` for PDFs, and adapt layout chrome (safe-area insets, slide-over sidebar, touch graph gestures, keyboard avoidance).

---

## 2. Wave 1 Goals & Non-Goals

### Goals
1. **Single Execution Path in Dev and Production:** `npm run dev` boots Vite and runs the full React UI + Dedicated Backend Web Worker in the browser, syncing `data/` and `auth.json` and proxying CORS-restricted fetches through a lightweight Vite dev-server plugin (`src/worker/vite-dev-bridge.ts`).
2. **Zero Churn to `components/`, `src/core/`, `src/store/`, and `app/api/`:**
   - All 35 `app/api/**/route.ts` handlers remain in place as standard `Request -> Promise<Response>` modules.
   - All existing unit/integration tests in `tests/*.test.ts` and `tests/*.test.tsx` continue to run and pass via `npm test` (`tsx --test`).
3. **Browser/Worker-Native Rendering & Image Resizing:**
   - Inject `workerHeadless` via `headlessOverride.current` inside the Worker so `renderPdfPages`, `renderSvg`, and `runDemo` execute using Web Worker `OffscreenCanvas`, `@resvg/resvg-wasm`, and a hidden sandboxed `<iframe>` on the main thread.
   - Load Photon's existing `photon_rs_bg.wasm` inside the Worker via `WebAssembly.instantiate` so `resizeImage()` works without Node `worker_threads` or CJS `fs` bindings.

### Non-Goals for Wave 1
- Creating the Rust `src-tauri/` crate or deleting `electron/` (scheduled for Wave 2).
- iPadOS touch gesture or safe-area CSS rework (scheduled for Wave 3).

---

## 3. Architecture & Data Contracts

### 3.1 Vite Configuration & Client Router Alias (`vite.config.ts`, `index.html`, `src/client/`)

#### `src/client/router.tsx` (Aliased to `next/navigation` and `next/link`)
Provides drop-in browser History API implementations of the Next.js navigation primitives used across `components/`:

```ts
export interface RouterInstance {
	push(href: string, opts?: { scroll?: boolean }): void;
	replace(href: string, opts?: { scroll?: boolean }): void;
	back(): void;
	forward(): void;
	refresh(): void;
	prefetch(href: string): void;
}

export function useRouter(): RouterInstance;
export function usePathname(): string;
export function useSearchParams(): URLSearchParams;
export function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T;
export function redirect(href: string): never;
export function notFound(): never;

export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
	href: string;
	prefetch?: boolean;
	replace?: boolean;
	scroll?: boolean;
}
export default function Link(props: LinkProps): React.JSX.Element;
```

- Navigating via `router.push()`, `router.replace()`, or `<Link>` updates `window.history.pushState` / `replaceState`, dispatches a synchronous route-change notification to all mounted hooks, and supports browser `popstate` (Back/Forward).

#### `src/client/main.tsx` (SPA Root & Route Switch)
- Loads `@fontsource-variable/source-sans-3`, `@fontsource-variable/jetbrains-mono`, `katex/dist/katex.min.css`, and `app/globals.css`.
- Initializes `worker-client.ts` (which intercepts `/api/*` `fetch` and `EventSource` calls and boots the Backend Worker) before mounting the React tree inside the same `<ThemeProvider>` + `<StudyTracker />` + `<SidebarShell>` structure as `app/layout.tsx`.
- Matches `pathname`:
  - `/`: Fetches `/api/settings` to resolve `initialConfigured = slotsConfigured(record?.models)` and `rendering = resolveSettings(record ?? null).graph.rendering`, then renders `<Home initialConfigured={...} rendering={...} />`.
  - `/chat/new`: Fetches `/api/settings`, reads `?mode=` from `useSearchParams()`, and renders `<NewSession initialConfigured={...} mode={mode === "practice" ? "practice" : "teach"} />`.
  - `/chat/:id`: Fetches `/api/chats/:id` (including active turn/compaction status) and `/api/settings`, and renders `<Chat key={id} ... />`.
  - `/settings`: Redirects to `/?settings=1` (matching `app/settings/page.tsx`).

---

### 3.2 Main-Thread ↔ Worker Transport (`src/client/worker-client.ts`, `src/worker/entry.ts`)

#### Request / Streaming Response Protocol
1. **Main Thread (`src/client/worker-client.ts`):**
   - Replaces `window.fetch` for any request whose URL resolves to same-origin `/api/*` (all other URLs pass through to the native `fetch`).
   - Replaces `window.EventSource` for `/api/*` URLs with a lightweight `ReadableStream`-backed `EventSource` polyfill that parses `data: ...\n\n` frames and dispatches `MessageEvent`s (and aborts the underlying stream on `.close()`).
   - For each `/api/*` request:
     - Allocates a `MessageChannel` (`port1` stays on main thread, `port2` transfers to Worker).
     - Reads any request body as an `ArrayBuffer` (transferred zero-copy) and sends `{ type: "lh:api-request", id, url, method, headers, body }`.
     - Listens on `port1` for `{ type: "lh:api-response", status, statusText, headers, hasBody }` followed by `{ type: "lh:api-chunk", chunk: Uint8Array }` / `{ type: "lh:api-end" }` / `{ type: "lh:api-error", message }` messages, wrapping them into a standard `ReadableStream<Uint8Array>` and returning `new Response(stream, { status, statusText, headers })`.
     - Propagates `Request.signal` abort to the Worker via `{ type: "lh:api-abort", id }`.
2. **Main-Thread Demo Verification Runner (`lh:run-demo`):**
   - When the Worker sends `{ type: "lh:run-demo", requestId, html, settleMs, probe }`, `worker-client.ts` creates a hidden `<iframe sandbox="allow-scripts" style="position:fixed;left:-9999px;top:-9999px;width:900px;height:700px;visibility:hidden">` with `srcdoc` containing an injected head script before the demo HTML:
     - Hooks `console.error`, `window.addEventListener("error", ..., true)` (capturing both uncaught JS errors and `<script>`/`<img>` resource load failures), and `window.addEventListener("unhandledrejection")`.
     - After `load` + `settleMs` (bounded by a 30s timeout), evaluates `opts.probe` via `window.eval` inside the iframe if requested, posts `{ type: "lh:demo-probe-done", requestId, consoleErrors, pageErrors, failedRequests, probeResult, probed }` back to the parent window, and removes the `<iframe>` in `finally`.

---

### 3.3 Host Bridge & Write-Through `memfs` (`src/worker/host-bridge.ts`, `src/worker/shims/fs.ts`)

#### `HostBridge` Interface (`src/worker/host-bridge.ts`)

```ts
export type FsMutationOp =
	| { type: "writeFile"; path: string; dataBase64: string; mode?: number }
	| { type: "appendFile"; path: string; dataBase64: string; mode?: number }
	| { type: "rename"; oldPath: string; newPath: string }
	| { type: "unlink"; path: string }
	| { type: "mkdir"; path: string; recursive?: boolean; mode?: number }
	| { type: "rm"; path: string; recursive?: boolean; force?: boolean };

export interface HydratedFsSnapshot {
	root: string;
	dataDir: string;
	authFile: string;
	/** Map of absolute POSIX path -> base64-encoded file contents. */
	files: Record<string, string>;
	/** Explicit empty directories to preserve. */
	dirs: string[];
}

export interface HostBridge {
	hydrateFs(): Promise<HydratedFsSnapshot>;
	syncFs(op: FsMutationOp): Promise<void>;
	readExternalFile(absPath: string): Promise<Uint8Array>;
	nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
```

- **Vite Dev Server Implementation (`src/worker/vite-dev-bridge.ts`):**
  - `GET /__lh_dev/fs-hydrate`: Reads `PATHS.data` (`data/`), `AUTH_FILE` (`auth.json`), `src/agent/system-prompt.md`, `src/agent/prompts/**`, `skills/**`, and `package.json`, returning `HydratedFsSnapshot`.
  - `POST /__lh_dev/fs-sync`: Validates that the target path is inside `PATHS.data` or equals `AUTH_FILE` (refusing any write outside those mutable roots) and applies `FsMutationOp` to disk.
  - `POST /__lh_dev/fs-read-external`: Reads a local file path requested by `fs.promises.readFile` (used for PDF/notes imports and agent file tools).
  - `POST /__lh_dev/fetch`: Streams outbound HTTP requests (`url`, `method`, `headers`, `body`) via Node `fetch` and streams back status, headers, and body chunks to bypass browser CORS in dev.

#### Write-Through `memfs` (`src/worker/shims/fs.ts`)
- Maintains an in-memory map of normalized POSIX file paths (`Map<string, Uint8Array>`) and directory paths (`Set<string>`).
- Implements synchronous `readFileSync`, `writeFileSync`, `appendFileSync`, `existsSync`, `statSync`, `lstatSync`, `mkdirSync`, `readdirSync` (supporting `{ withFileTypes: true }` returning `Dirent`-compatible objects), `renameSync`, `unlinkSync`, `rmSync`, `mkdtempSync`, `realpathSync`, and `accessSync`.
- Implements `fs/promises` (`readFile`, `writeFile`, `appendFile`, `stat`, `lstat`, `mkdir`, `readdir`, `rename`, `unlink`, `rm`, `mkdtemp`, `realpath`, `open`).
  - When `fs.promises.readFile(targetPath)` or `fs.promises.stat(targetPath)` is called on a path not present in `memfs`, it calls `hostBridge.readExternalFile(targetPath)` on demand, caches the bytes in `memfs`, and returns them.
- Every mutating call updates `memfs` synchronously and appends a `FsMutationOp` to a serialized write-behind promise queue (`flushFsQueue()`), exported so tests can `await flushFsQueue()` deterministically.

#### Other Worker `node:*` Shims (`src/worker/shims/`)
- `path.ts`: Complete POSIX `path` implementation (`join`, `resolve`, `dirname`, `basename`, `extname`, `relative`, `normalize`, `isAbsolute`, `parse`, `format`, `sep: "/"`, `posix`).
- `crypto.ts`: Implements `randomUUID`, `randomBytes`, `timingSafeEqual`, `createHash("sha256")`, and `createHmac("sha256", key)` using pure-JS synchronous SHA-256 + Web Crypto.
- `async_hooks.ts`: Implements `AsyncLocalStorage<T>` (`run`, `getStore`, `enterWith`, `disable`).
- `os.ts`, `url.ts`, `util.ts`, `module.ts`, `worker_threads.ts`, `child_process.ts`, `http.ts`, `net.ts`, `readline.ts`: Browser-safe shims so all transitive imports in `src/server/` and `src/agent/` bundle cleanly without unresolved module warnings.

---

### 3.4 Worker API Router (`src/worker/router.ts`)

Maps incoming `Request` URLs and HTTP methods (`GET`, `POST`, `PUT`, `DELETE`) to the 35 existing route modules under `app/api/**/route.ts`:

- Static routes (e.g., `/api/chat`, `/api/chats`, `/api/events`, `/api/graph`, `/api/graph/costs`, `/api/graph/coverage/extract`, `/api/graph/import`, `/api/graph/positions`, `/api/graph/render-settings`, `/api/graph/sources`, `/api/graph/status`, `/api/jobs`, `/api/keys`, `/api/models`, `/api/profiler`, `/api/quaderno`, `/api/review`, `/api/search`, `/api/settings`, `/api/settings/prompts`, `/api/stt/token`, `/api/study`, `/api/subscriptions`, `/api/subscriptions/browser`, `/api/activity`, `/api/activity/abort`, `/api/claude-code`, `/api/cliproxy`, `/api/custom-provider`).
- Dynamic routes with Next 16 `{ params: Promise<...> }` context signature:
  - `/api/chats/:id` → `app/api/chats/[id]/route.ts` (`params: Promise.resolve({ id })`)
  - `/api/chats/:id/artifact-ui` → `app/api/chats/[id]/artifact-ui/route.ts`
  - `/api/chats/:id/clarify` → `app/api/chats/[id]/clarify/route.ts`
  - `/api/chats/:id/dismiss` → `app/api/chats/[id]/dismiss/route.ts`
  - `/api/chats/:id/markdown` → `app/api/chats/[id]/markdown/route.ts`
  - `/api/chats/:id/settings` → `app/api/chats/[id]/settings/route.ts`
  - `/api/chats/:id/steer` → `app/api/chats/[id]/steer/route.ts`
  - `/api/chats/:id/stream` → `app/api/chats/[id]/stream/route.ts`
  - `/api/graph/nodes/:id` → `app/api/graph/nodes/[id]/route.ts`
  - `/api/keys/:id` → `app/api/keys/[id]/route.ts`
  - `/api/settings/:section` → `app/api/settings/[section]/route.ts`
  - `/api/settings/prompts/:segment+` → `app/api/settings/prompts/[...segment]/route.ts` (`params: Promise.resolve({ segment: segments })`)

---

### 3.5 Browser/Worker `HeadlessApi` & Photon WASM (`src/worker/headless-worker.ts`, `src/worker/shims/photon-wasm.ts`)

1. **`renderSvg(svg, opts)`:**
   - Lazily initializes `@resvg/resvg-wasm` (`initWasm(wasmBytes)`) once per Worker lifetime.
   - Renders with `new Resvg(svg, { fitTo: { mode: "width", value: width }, background: "#ffffff" }).render().asPng()`, wrapped in `providerSafePng()`.
   - Falls back to drawing an `Image` / `createImageBitmap` of `Blob([svg], { type: "image/svg+xml" })` onto `OffscreenCanvas` if `@resvg/resvg-wasm` throws on exotic SVG features.
2. **`renderPdfPages(pdfPath, pages, opts)`:**
   - Reads the PDF bytes via `fs.promises.readFile(pdfPath)` (supporting both in-memory `memfs` files and external disk files via `HostBridge.readExternalFile`).
   - Loads the document with `pdfjs-dist/legacy/build/pdf.mjs` (`isEvalSupported: false`), computes dimensions via `pdfCanvasGeometry(base.width, base.height, dpi)`, renders each page onto `new OffscreenCanvas(geometry.width, geometry.height)` (or a Pluggable Canvas Factory for Node unit tests), converts to PNG bytes via `convertToBlob({ type: "image/png" })`, and passes through `providerSafePng()`.
3. **`runDemo(html, opts)`:**
   - Delegates to the registered demo runner callback (which in the Worker posts `lh:run-demo` to the main thread's hidden sandboxed `<iframe>`, and in unit tests can be injected directly).
4. **Photon WASM Loader (`src/worker/shims/photon-wasm.ts`):**
   - Instantiates `@silvia-odwyer/photon-node/photon_rs_bg.wasm` using standard WebAssembly APIs and exports `PhotonImage`, `SamplingFilter`, and `resize` matching `@silvia-odwyer/photon-node`.

---

## 4. Error Handling & Edge Cases

- **Unconfigured Models (`503 models_not_configured`):** The `/chat/:id` and `/` client shells read `slotsConfigured(record?.models)` from `/api/settings` on mount and re-check on settings updates, preserving the setup CTA banner identically to SSR.
- **Chat Not Found (`404`):** When `/api/chats/:id` returns `404`, the `/chat/:id` client page renders the not-found view or redirects cleanly without crashing the Worker.
- **SSE Disconnect / Abort:** Closing an `EventSource` or aborting a `fetch` `/api/chat` stream posts `lh:api-abort` to the Worker, firing the `AbortController` attached to the synthetic `Request` so turn streams and `/api/events` listeners clean up immediately.
- **Write-Behind Failure:** If `HostBridge.syncFs` fails on disk (e.g. permission error), the error is logged to console without crashing the Worker loop.

---

## 5. Testing & Verification Strategy

1. **Existing Test Suite (`npm test`):**
   - All existing `tests/*.test.ts` and `tests/*.test.tsx` files must pass without regressions.
2. **New Wave 1 Tests:**
   - `tests/worker-fs.test.ts`: Tests `memfs` hydration, synchronous CRUD (`readFileSync`, `writeFileSync`, `appendFileSync`, `renameSync`, `readdirSync` with `withFileTypes`), `flushFsQueue()` ordering, and on-demand `readExternalFile` fallback.
   - `tests/worker-router.test.ts`: Tests URL routing, query strings, dynamic `[id]` and `[...segment]` params, `404` on unknown routes, and streaming `ReadableStream` SSE responses through `dispatchWorkerRequest()`.
   - `tests/worker-headless.test.ts`: Tests `workerHeadless.renderSvg` (via `@resvg/resvg-wasm`), `workerHeadless.renderPdfPages`, and the sandboxed demo verification script/reducer.
   - `tests/client-router.test.tsx`: Tests `useRouter`, `usePathname`, `useSearchParams`, `useParams`, and `<Link>` navigation.
3. **Build & Typecheck Verification:**
   - `npm run typecheck` (`tsc --noEmit`) and `npm run lint` (`eslint .`) pass cleanly.
   - `npx vite build` succeeds and emits the static SPA + bundled Backend Worker into `dist-web/`.
