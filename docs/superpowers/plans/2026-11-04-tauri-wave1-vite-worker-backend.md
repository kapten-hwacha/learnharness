# Tauri v2 Migration (Wave 1): Vite SPA, In-Browser Backend Worker, and WASM/Canvas Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Vite SPA shell, Dedicated Backend Web Worker (`node:*` shims, write-through `memfs`, 35-route `/api/*` dispatcher, and Vite dev bridge), and WASM/OffscreenCanvas/iframe `HeadlessApi` so LearnHarness runs its full backend in-browser while keeping 100% of existing `tests/*.test.ts(x)` passing.

**Architecture:** `vite.config.ts` bundles `src/client/main.tsx` (React SPA with `next/navigation` and `next/link` aliased to `src/client/router.tsx`) alongside `src/worker/entry.ts` (Dedicated Web Worker with `node:*` aliased to `src/worker/shims/*`). `src/client/worker-client.ts` intercepts same-origin `/api/*` `fetch` and `EventSource` calls and streams them over `MessageChannel` to `src/worker/router.ts`, which dispatches directly to the existing `app/api/**/route.ts` modules. `src/worker/headless-worker.ts` implements `HeadlessApi` using `@resvg/resvg-wasm`, `pdfjs-dist` + `OffscreenCanvas`, and a main-thread sandboxed `<iframe>` probe runner.

**Tech Stack:** TypeScript, React 19, Vite, `@resvg/resvg-wasm`, `@silvia-odwyer/photon-node` (WASM), `pdfjs-dist`, Node.js (`node:test`).

**Spec:** `docs/superpowers/specs/2026-11-04-tauri-wave1-vite-worker-backend-design.md`

## Global Constraints

- Do not delete or break any of the 35 `app/api/**/route.ts` files; all existing unit tests in `tests/*.test.ts` and `tests/*.test.tsx` must continue to pass under `npm test` (`NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx`).
- Do not modify `components/` imports for `next/navigation` or `next/link`; provide compatibility exports via `src/client/router.tsx` aliased in `vite.config.ts`.
- `src/worker/vite-dev-bridge.ts` must reject any `syncFs` write/append/rename/unlink/rm whose resolved path falls outside `PATHS.data` (`data/`) and `AUTH_FILE` (`auth.json`).
- All PNG buffers returned by `workerHeadless.renderSvg` and `workerHeadless.renderPdfPages` must pass through `providerSafePng()` from `src/agent/subagents/headless.ts`.
- Every modified or created file must pass `npm run typecheck` (`tsc --noEmit`) and `npm run lint` (`eslint .`).

## Review Focus

1. Relative and `..` segments in `memfs` paths (`src/worker/shims/fs.ts`): `writeFileSync("/data/chats/../settings.json", ...)` must normalize to `/data/settings.json` before indexing `memfs` or emitting `FsMutationOp`.
2. `renameSync` overwrite semantics in `memfs`: renaming `foo.json.tmp` to an existing `foo.json` must atomically replace `foo.json`'s bytes and delete `foo.json.tmp` without leaving a ghost directory entry in `readdirSync`.
3. URL-encoded dynamic route parameters in `src/worker/router.ts`: `/api/settings/prompts/teacher%2Fcore.md` and `/api/keys/openai%3Adefault` must `decodeURIComponent` each extracted parameter segment before passing `params` to the route handler.
4. Aborting a streaming `/api/chat` or `/api/events` request from the client (`src/client/worker-client.ts`): aborting the caller's `AbortSignal` or calling `EventSource.close()` must trigger the Worker `Request.signal` abort so active turn streams and event listeners detach immediately.
5. Path-traversal protection in `src/worker/vite-dev-bridge.ts`: a `syncFs` request with `path: "/Users/.../package.json"` or `path: "<dataDir>/../package.json"` must be rejected with HTTP `403` before touching disk.

---

### Task 1: Client Router Alias (`src/client/router.tsx`)

**Files:**
- Create: `src/client/router.tsx`
- Test: `tests/client-router.test.tsx`

**Interfaces:**
- Consumes: React 19 (`useSyncExternalStore`, `createElement`), `linkedom` (in test)
- Produces:
  - `export interface RouterInstance { push(href: string, opts?: { scroll?: boolean }): void; replace(href: string, opts?: { scroll?: boolean }): void; back(): void; forward(): void; refresh(): void; prefetch(href: string): void }`
  - `export function useRouter(): RouterInstance`
  - `export function usePathname(): string`
  - `export function useSearchParams(): URLSearchParams`
  - `export function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T`
  - `export function redirect(href: string): never`
  - `export function notFound(): never`
  - `export function resetClientRouterForTest(initialHref: string, routePattern?: string): void`
  - `export default function Link(props: LinkProps): React.JSX.Element`

- [ ] **Step 1: Write failing tests in `tests/client-router.test.tsx`**

```tsx
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link, {
	resetClientRouterForTest,
	useParams,
	usePathname,
	useRouter,
	useSearchParams,
} from "../src/client/router.tsx";

describe("src/client/router.tsx (next/navigation + next/link compatibility)", () => {
	it("resolves pathname, searchParams, and route params from current location and updates on router.push / replace", () => {
		resetClientRouterForTest("/chat/abc-123?prompt=hello", "/chat/:id");
		let pathname = "";
		let prompt: string | null = null;
		let params: Record<string, string> = {};
		let router!: ReturnType<typeof useRouter>;

		function Probe() {
			pathname = usePathname();
			prompt = useSearchParams().get("prompt");
			params = useParams();
			router = useRouter();
			return <Link href="/chat/new?mode=practice">New Practice</Link>;
		}

		const html = renderToStaticMarkup(<Probe />);
		assert.equal(pathname, "/chat/abc-123");
		assert.equal(prompt, "hello");
		assert.deepEqual(params, { id: "abc-123" });
		assert.match(html, /href="\/chat\/new\?mode=practice"/);

		router.push("/?settings=general");
		renderToStaticMarkup(<Probe />);
		assert.equal(pathname, "/");
		assert.equal(prompt, null);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/client-router.test.tsx`
Expected: FAIL with `Cannot find module '../src/client/router.tsx'`

- [ ] **Step 3: Implement `src/client/router.tsx`**

Implement the History API external store (`useSyncExternalStore` with server snapshot fallback to the in-memory `currentUrl` so SSR/`renderToStaticMarkup` tests and DOM tests both work), `matchRouteParams(pathname, pattern)` for `/chat/:id`, and `<Link>` intercepting plain left-clicks (`button === 0 && !metaKey && !ctrlKey && !shiftKey && !altKey && !target`) to call `router.push` / `router.replace`.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/client-router.test.tsx`
Expected: PASS

---

### Task 2: Host Bridge, Write-Through `memfs`, and Worker `node:*` Shims (`src/worker/host-bridge.ts`, `src/worker/shims/*`)

**Files:**
- Create: `src/worker/host-bridge.ts`
- Create: `src/worker/shims/path.ts`
- Create: `src/worker/shims/fs.ts`
- Create: `src/worker/shims/fs-promises.ts`
- Create: `src/worker/shims/crypto.ts`
- Create: `src/worker/shims/async_hooks.ts`
- Create: `src/worker/shims/node-stubs.ts`
- Test: `tests/worker-fs.test.ts`

**Interfaces:**
- Consumes: Web `crypto`, `TextEncoder`, `TextDecoder`
- Produces:
  - `HostBridge`, `FsMutationOp`, `HydratedFsSnapshot`, `setHostBridge(bridge: HostBridge): void`, `getHostBridge(): HostBridge` in `src/worker/host-bridge.ts`
  - `hydrateMemfs(snapshot: HydratedFsSnapshot): void`, `flushFsQueue(): Promise<void>`, plus Node `fs` sync API and `.promises` in `src/worker/shims/fs.ts`
  - `randomUUID`, `randomBytes`, `timingSafeEqual`, `createHash`, `createHmac` in `src/worker/shims/crypto.ts`
  - `AsyncLocalStorage` in `src/worker/shims/async_hooks.ts`

- [ ] **Step 1: Write failing tests in `tests/worker-fs.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setHostBridge, type FsMutationOp } from "../src/worker/host-bridge.ts";
import * as memfs from "../src/worker/shims/fs.ts";
import * as memfsPromises from "../src/worker/shims/fs-promises.ts";
import * as shimCrypto from "../src/worker/shims/crypto.ts";
import { AsyncLocalStorage } from "../src/worker/shims/async_hooks.ts";

describe("Worker write-through memfs & node:* shims", () => {
	it("normalizes '..' paths, supports atomic renameSync overwrite, lists Dirents, and flushes ordered FsMutationOps", async () => {
		const ops: FsMutationOp[] = [];
		setHostBridge({
			hydrateFs: async () => ({ root: "/app", dataDir: "/app/data", authFile: "/app/auth.json", files: {}, dirs: ["/app/data"] }),
			syncFs: async (op) => { ops.push(op); },
			readExternalFile: async (p) => new TextEncoder().encode(`external:${p}`),
			nativeFetch: (input, init) => fetch(input, init),
		});
		memfs.hydrateMemfs({
			root: "/app",
			dataDir: "/app/data",
			authFile: "/app/auth.json",
			files: { "/app/data/settings.json": Buffer.from('{"v":1}').toString("base64") },
			dirs: ["/app/data", "/app/data/chats"],
		});

		assert.equal(memfs.readFileSync("/app/data/chats/../settings.json", "utf8"), '{"v":1}');
		memfs.writeFileSync("/app/data/settings.json.tmp", '{"v":2}');
		memfs.renameSync("/app/data/settings.json.tmp", "/app/data/settings.json");
		assert.equal(memfs.existsSync("/app/data/settings.json.tmp"), false);
		assert.equal(memfs.readFileSync("/app/data/settings.json", "utf8"), '{"v":2}');

		const entries = memfs.readdirSync("/app/data", { withFileTypes: true });
		assert.deepEqual(
			entries.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() })),
			[
				{ name: "chats", dir: true, file: false },
				{ name: "settings.json", dir: false, file: true },
			],
		);

		await memfs.flushFsQueue();
		assert.deepEqual(ops.map((o) => o.type), ["writeFile", "rename"]);

		const ext = await memfsPromises.readFile("/Users/demo/notes.pdf");
		assert.equal(new TextDecoder().decode(ext), "external:/Users/demo/notes.pdf");
	});

	it("provides synchronous SHA-256 createHash/createHmac and AsyncLocalStorage context propagation", async () => {
		const digest = shimCrypto.createHash("sha256").update("learnharness").digest("hex");
		assert.equal(digest, "b5b5f2592c3e9a507f4772971b68913a0e9214bc3b972748112b9dc77a86b385");

		const als = new AsyncLocalStorage<string>();
		const seen = await als.run("run-42", async () => {
			await Promise.resolve();
			return als.getStore();
		});
		assert.equal(seen, "run-42");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/worker-fs.test.ts`
Expected: FAIL with `Cannot find module '../src/worker/host-bridge.ts'`

- [ ] **Step 3: Implement `src/worker/host-bridge.ts` and `src/worker/shims/*`**

Implement:
- `src/worker/host-bridge.ts`: `HostBridge` registry + default browser bridge calling `/__lh_dev/*` (or `window.__TAURI_INTERNALS__` when present).
- `src/worker/shims/path.ts`: Pure POSIX path operations (`normalize`, `resolve`, `join`, `dirname`, `basename`, `extname`, `relative`, `isAbsolute`, `sep: "/"`).
- `src/worker/shims/fs.ts` & `src/worker/shims/fs-promises.ts`: In-memory POSIX tree (`files: Map<string, Uint8Array>`, `dirs: Set<string>`) with parent-dir auto-registration, `Dirent` support, `flushFsQueue()`, and `readExternalFile` fallback on `fs.promises.readFile`.
- `src/worker/shims/crypto.ts`: Pure-JS synchronous SHA-256 + HMAC-SHA256 (`createHash`, `createHmac`), `randomUUID`, `randomBytes` (returning a `Buffer`), and `timingSafeEqual`.
- `src/worker/shims/async_hooks.ts`: `AsyncLocalStorage<T>`.
- `src/worker/shims/node-stubs.ts`: Minimal browser-safe exports for `os`, `url`, `util`, `module`, `worker_threads`, `child_process`, `http`, `net`, `readline`.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/worker-fs.test.ts`
Expected: PASS

---

### Task 3: Worker API Router (`src/worker/router.ts`)

**Files:**
- Create: `src/worker/router.ts`
- Test: `tests/worker-router.test.ts`

**Interfaces:**
- Consumes: All 35 `app/api/**/route.ts` modules
- Produces:
  - `export function dispatchWorkerRequest(req: Request): Promise<Response>` in `src/worker/router.ts`

- [ ] **Step 1: Write failing tests in `tests/worker-router.test.ts`**

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-worker-router-"));
process.env.LH_DATA_DIR = tempDataDir;
process.env.LH_AUTH_FILE = path.join(tempDataDir, "auth.json");

const { dispatchWorkerRequest } = await import("../src/worker/router.ts");

after(() => {
	fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe("src/worker/router.ts (35-route /api/* dispatcher)", () => {
	it("routes static GET/PUT (/api/settings, /api/settings/:section) and URL-decoded catch-all (/api/settings/prompts/:segment+)", async () => {
		const getRes = await dispatchWorkerRequest(new Request("http://localhost/api/settings"));
		assert.equal(getRes.status, 200);

		const putRes = await dispatchWorkerRequest(
			new Request("http://localhost/api/settings/general", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ autoUpdate: false }),
			}),
		);
		assert.equal(putRes.status, 200);

		const promptRes = await dispatchWorkerRequest(
			new Request("http://localhost/api/settings/prompts/teacher%2F00-identity.md", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "Custom teacher identity" }),
			}),
		);
		assert.equal(promptRes.status, 200);
	});

	it("returns 404 for unknown API paths and 405 for unsupported HTTP methods", async () => {
		const missing = await dispatchWorkerRequest(new Request("http://localhost/api/does-not-exist"));
		assert.equal(missing.status, 404);

		const badMethod = await dispatchWorkerRequest(new Request("http://localhost/api/chat", { method: "DELETE" }));
		assert.equal(badMethod.status, 405);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/worker-router.test.ts`
Expected: FAIL with `Cannot find module '../src/worker/router.ts'`

- [ ] **Step 3: Implement `src/worker/router.ts`**

Register all 35 `app/api/**/route.ts` modules in a declarative route table supporting static paths, single dynamic segments (`:id`, `:section`), and catch-all segments (`:segment+`), calling `decodeURIComponent` on each matched param segment and passing `{ params: Promise.resolve(params) }` as the second argument matching Next 16's Route Handler signature.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/worker-router.test.ts`
Expected: PASS

---

### Task 4: Browser/Worker `HeadlessApi` & Photon WASM Loader (`src/worker/headless-worker.ts`, `src/worker/shims/photon-wasm.ts`)

**Files:**
- Modify: `package.json` (add `@resvg/resvg-wasm`)
- Create: `src/worker/headless-worker.ts`
- Create: `src/worker/shims/photon-wasm.ts`
- Test: `tests/worker-headless.test.ts`

**Interfaces:**
- Consumes: `HeadlessApi`, `DemoRunResult`, `RunDemoOptions`, `RenderSvgOptions`, `RenderPdfOptions`, `RenderedPdfPage`, `pdfCanvasGeometry`, `providerSafePng` from `../agent/subagents/headless.ts`
- Produces:
  - `export function createWorkerHeadless(opts?: { runDemoViaHost?: (html: string, opts?: RunDemoOptions) => Promise<DemoRunResult>; createCanvas2D?: (width: number, height: number) => { canvas: unknown; context: unknown; toPng(): Promise<Uint8Array> } }): HeadlessApi` in `src/worker/headless-worker.ts`
  - `export function buildDemoVerifySrcDoc(html: string, requestId: string, settleMs: number, probe?: string): string` in `src/worker/headless-worker.ts`
  - `export function loadPhotonWasm(): Promise<typeof import("@silvia-odwyer/photon-node")>` in `src/worker/shims/photon-wasm.ts`

- [ ] **Step 1: Install `@resvg/resvg-wasm` and write failing tests in `tests/worker-headless.test.ts`**

Run: `npm install @resvg/resvg-wasm`

Create `tests/worker-headless.test.ts`:

```ts
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { buildDemoVerifySrcDoc, createWorkerHeadless } from "../src/worker/headless-worker.ts";
import { loadPhotonWasm } from "../src/worker/shims/photon-wasm.ts";

const PDF_FIXTURE = path.resolve("tests/fixtures/sample.pdf");

describe("src/worker/headless-worker.ts & photon-wasm.ts", () => {
	it("rasterizes SVG via @resvg/resvg-wasm into a canonical single-IDAT PNG", async () => {
		const headless = createWorkerHeadless();
		const png = await headless.renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2563eb"/></svg>');
		assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
		assert.equal(png.readUInt32BE(16), 120);
		assert.equal(png.readUInt32BE(20), 60);
	});

	it("renders PDF pages through the pluggable 2D canvas factory and canonicalizes PNG output", async () => {
		const headless = createWorkerHeadless({
			createCanvas2D(width, height) {
				const c = createCanvas(width, height);
				return {
					canvas: c,
					context: c.getContext("2d"),
					async toPng() {
						return new Uint8Array(c.toBuffer("image/png"));
					},
				};
			},
		});
		const pages = await headless.renderPdfPages(PDF_FIXTURE, [1], { dpi: 72 });
		assert.equal(pages.length, 1);
		assert.equal(pages[0]!.page, 1);
		assert.equal(pages[0]!.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	});

	it("injects the demo verification script into srcdoc and loads Photon WASM via WebAssembly.instantiate", async () => {
		const srcDoc = buildDemoVerifySrcDoc("<!doctype html><html><body><h1>Demo</h1></body></html>", "req-1", 500, "1 + 1");
		assert.match(srcDoc, /lh:demo-probe-done/);
		assert.match(srcDoc, /req-1/);

		const photon = await loadPhotonWasm();
		assert.equal(typeof photon.PhotonImage.new_from_byteslice, "function");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/worker-headless.test.ts`
Expected: FAIL with `Cannot find module '../src/worker/headless-worker.ts'`

- [ ] **Step 3: Implement `src/worker/headless-worker.ts` and `src/worker/shims/photon-wasm.ts`**

Implement `@resvg/resvg-wasm` initialization (loading `index_bg.wasm` bytes once), `renderPdfPages` using `OffscreenCanvas` by default or `opts.createCanvas2D` in Node tests, `buildDemoVerifySrcDoc` for main-thread sandboxed `<iframe>` verification, and `src/worker/shims/photon-wasm.ts` loading `photon_rs_bg.wasm` via `WebAssembly.instantiate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test npx tsx --test tests/worker-headless.test.ts`
Expected: PASS

---

### Task 5: Worker Entry, Main-Thread Transport, Vite Dev Bridge, and Vite SPA Build (`src/worker/entry.ts`, `src/client/worker-client.ts`, `src/client/main.tsx`, `src/worker/vite-dev-bridge.ts`, `index.html`, `vite.config.ts`)

**Files:**
- Modify: `package.json` (add `vite`, `@vitejs/plugin-react`, `@fontsource-variable/source-sans-3`, `@fontsource-variable/jetbrains-mono`, and `vite:dev` / `vite:build` scripts)
- Create: `src/worker/entry.ts`
- Create: `src/client/worker-client.ts`
- Create: `src/client/main.tsx`
- Create: `src/worker/vite-dev-bridge.ts`
- Create: `index.html`
- Create: `vite.config.ts`
- Test: `tests/worker-transport.test.ts`

**Interfaces:**
- Consumes: `src/client/router.tsx`, `src/worker/host-bridge.ts`, `src/worker/shims/*`, `src/worker/router.ts`, `src/worker/headless-worker.ts`
- Produces:
  - `export function createWorkerMessageHandler(dispatch: (req: Request) => Promise<Response>): (event: MessageEvent) => void` in `src/worker/entry.ts`
  - `export function createPortFetch(postToWorker: (msg: unknown, transfer: Transferable[]) => void): typeof fetch` in `src/client/worker-client.ts`
  - `export function isAllowedSyncPath(targetPath: string, dataDir: string, authFile: string): boolean` and `export function lhViteDevBridgePlugin(): import("vite").Plugin` in `src/worker/vite-dev-bridge.ts`

- [ ] **Step 1: Install Vite & font packages and write failing tests in `tests/worker-transport.test.ts`**

Run: `npm install -D vite @vitejs/plugin-react && npm install @fontsource-variable/source-sans-3 @fontsource-variable/jetbrains-mono`

Create `tests/worker-transport.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPortFetch } from "../src/client/worker-client.ts";
import { createWorkerMessageHandler } from "../src/worker/entry.ts";
import { isAllowedSyncPath } from "../src/worker/vite-dev-bridge.ts";

describe("Worker MessageChannel transport & Vite dev bridge security", () => {
	it("streams chunked SSE responses over MessageChannel and propagates caller AbortSignal to the Worker Request", async () => {
		let workerRequestAborted = false;
		const handleWorkerMsg = createWorkerMessageHandler(async (req) => {
			req.signal.addEventListener("abort", () => {
				workerRequestAborted = true;
			});
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: first\n\n"));
					controller.enqueue(new TextEncoder().encode("data: second\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});

		const portFetch = createPortFetch((data, transfer) => {
			handleWorkerMsg({ data, ports: transfer.filter((t): t is MessagePort => t instanceof MessagePort) } as unknown as MessageEvent);
		});

		const ac = new AbortController();
		const res = await portFetch("http://localhost/api/events", { signal: ac.signal });
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "data: first\n\ndata: second\n\n");

		ac.abort();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(workerRequestAborted, true);
	});

	it("rejects syncFs paths outside dataDir and authFile, including '..' traversal", () => {
		assert.equal(isAllowedSyncPath("/repo/data/chats/c1.json", "/repo/data", "/repo/auth.json"), true);
		assert.equal(isAllowedSyncPath("/repo/auth.json", "/repo/data", "/repo/auth.json"), true);
		assert.equal(isAllowedSyncPath("/repo/data/../package.json", "/repo/data", "/repo/auth.json"), false);
		assert.equal(isAllowedSyncPath("/etc/passwd", "/repo/data", "/repo/auth.json"), false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test npx tsx --test tests/worker-transport.test.ts`
Expected: FAIL with `Cannot find module '../src/client/worker-client.ts'`

- [ ] **Step 3: Implement `src/worker/entry.ts`, `src/client/worker-client.ts`, `src/client/main.tsx`, `src/worker/vite-dev-bridge.ts`, `index.html`, and `vite.config.ts`**

Implement:
- `src/worker/entry.ts`: Hydrates `memfs` via `getHostBridge().hydrateFs()`, sets `headlessOverride.current = createWorkerHeadless(...)`, installs `getHostBridge().nativeFetch`, and handles `lh:api-request` / `lh:api-abort` messages over `MessagePort`.
- `src/client/worker-client.ts`: Implements `createPortFetch`, `ReadableStream`-backed `EventSource` wrapper for `/api/*`, and main-thread `lh:run-demo` sandboxed `<iframe>` execution.
- `src/client/main.tsx`: Mounts the React SPA with `<ThemeProvider>`, `<StudyTracker />`, `<SidebarShell>`, and route switching (`/`, `/chat/new`, `/chat/:id`, `/settings`).
- `src/worker/vite-dev-bridge.ts`: Implements `/__lh_dev/fs-hydrate`, `/__lh_dev/fs-sync` (guarded by `isAllowedSyncPath`), `/__lh_dev/fs-read-external`, and `/__lh_dev/fetch`.
- `index.html` & `vite.config.ts`: Configures React plugin, `@/` path alias, `next/navigation` and `next/link` aliases to `src/client/router.tsx`, and Worker bundle `node:*` aliases to `src/worker/shims/*` emitting to `dist-web/`.

- [ ] **Step 4: Run tests, typecheck, lint, and Vite production build**

Run:
- `NODE_ENV=test npx tsx --test tests/worker-transport.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npx vite build`
- `npm test`

Expected: All tests pass, `tsc --noEmit` and `eslint .` report 0 errors, and `npx vite build` outputs the static SPA + Worker bundle into `dist-web/`.
