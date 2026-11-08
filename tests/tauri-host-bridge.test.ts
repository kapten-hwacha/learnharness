import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createTauriHostBridge,
	createWorkerTauriInvoke,
	getHostBridge,
	handleWorkerTauriMessage,
	hasTauriBridge,
	hostInvoke,
	setHostBridge,
	waitForInitialBridge,
	type FsMutationOp,
	type HydratedFsSnapshot,
} from "../src/worker/host-bridge.ts";

describe("Tauri HostBridge", () => {
	it("hydrateFs maps lh_fs_hydrate result unchanged", async () => {
		const mockSnapshot: HydratedFsSnapshot = {
			root: "/app",
			dataDir: "/app/data",
			authFile: "/app/auth.json",
			files: { "/app/data/a.txt": Buffer.from("hello").toString("base64") },
			dirs: ["/app/data"],
		};
		const invoked: [string, unknown][] = [];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			invoked.push([cmd, args]);
			if (cmd === "lh_fs_hydrate") return mockSnapshot as unknown as T;
			throw new Error(`Unexpected command: ${cmd}`);
		});

		const result = await bridge.hydrateFs();
		assert.deepEqual(result, mockSnapshot);
		assert.deepEqual(invoked, [["lh_fs_hydrate", undefined]]);
	});

	it("syncFs invokes lh_fs_sync with the op", async () => {
		const invoked: [string, unknown][] = [];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			invoked.push([cmd, args]);
			return undefined as unknown as T;
		});

		const op: FsMutationOp = {
			type: "writeFile",
			path: "/app/data/test.txt",
			dataBase64: Buffer.from("data").toString("base64"),
		};
		await bridge.syncFs(op);
		assert.deepEqual(invoked, [["lh_fs_sync", { op }]]);
	});

	it("nativeFetch returns 401 status and body from lh_http_fetch without falling back", async () => {
		const invoked: [string, unknown][] = [];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			invoked.push([cmd, args]);
			if (cmd === "lh_http_fetch") {
				return {
					status: 401,
					headers: [["content-type", "application/json"]],
					bodyBase64: Buffer.from('{"e":1}').toString("base64"),
				} as unknown as T;
			}
			throw new Error(`Unexpected command: ${cmd}`);
		});

		const res = await bridge.nativeFetch("https://api.openai.com/v1/models", {
			method: "GET",
			headers: { authorization: "Bearer invalid" },
		});
		assert.equal(res.status, 401);
		assert.equal(await res.text(), '{"e":1}');
		assert.equal(res.headers.get("content-type"), "application/json");
	});

	it("readExternalFile invokes lh_fs_read_external and returns Uint8Array", async () => {
		const invoked: [string, unknown][] = [];
		const testBytes = new Uint8Array([1, 2, 3, 4, 5]);
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			invoked.push([cmd, args]);
			if (cmd === "lh_fs_read_external") {
				return Array.from(testBytes) as unknown as T;
			}
			throw new Error(`Unexpected command: ${cmd}`);
		});

		const result = await bridge.readExternalFile("/Users/test/doc.pdf");
		assert.deepEqual(result, testBytes);
		assert.deepEqual(invoked, [["lh_fs_read_external", { path: "/Users/test/doc.pdf" }]]);
	});

	it("default bridge is the Tauri bridge when __TAURI_INTERNALS__ exists, otherwise the dev bridge", () => {
		// Reset active bridge
		setHostBridge(null as any);
		const globalAny = globalThis as any;
		delete globalAny.__TAURI_INTERNALS__;

		const devBridge = getHostBridge();
		assert.ok(devBridge);

		// With __TAURI_INTERNALS__
		setHostBridge(null as any);
		globalAny.__TAURI_INTERNALS__ = {
			invoke: async () => {},
		};
		try {
			const tauriBridge = getHostBridge();
			assert.ok(tauriBridge);
			assert.notEqual(tauriBridge, devBridge);
		} finally {
			delete globalAny.__TAURI_INTERNALS__;
			setHostBridge(null as any);
		}
	});

	it("worker invoke forwards calls via postMessage and resolves on lh:tauri-invoke-result", async () => {
		const posted: any[] = [];
		const originalSelf = (globalThis as any).self;
		(globalThis as any).self = {
			postMessage: (msg: any) => {
				posted.push(msg);
			},
		};

		try {
			const invoke = createWorkerTauriInvoke();
			const invokePromise = invoke<{ data: string }>("lh_custom_cmd", { foo: "bar" });

			assert.equal(posted.length, 1);
			assert.equal(posted[0].type, "lh:tauri-invoke");
			assert.equal(posted[0].cmd, "lh_custom_cmd");
			assert.deepEqual(posted[0].args, { foo: "bar" });
			const id = posted[0].id;

			handleWorkerTauriMessage({
				data: {
					type: "lh:tauri-invoke-result",
					id,
					result: { data: "success" },
				},
			});

			const res = await invokePromise;
			assert.deepEqual(res, { data: "success" });
		} finally {
			(globalThis as any).self = originalSelf;
		}
	});

	it("worker invoke rejects when lh:tauri-invoke-result contains an error", async () => {
		const posted: any[] = [];
		const originalSelf = (globalThis as any).self;
		(globalThis as any).self = {
			postMessage: (msg: any) => {
				posted.push(msg);
			},
		};

		try {
			const invoke = createWorkerTauriInvoke();
			const invokePromise = invoke("lh_failing_cmd");

			assert.equal(posted.length, 1);
			const id = posted[0].id;

			handleWorkerTauriMessage({
				data: {
					type: "lh:tauri-invoke-result",
					id,
					error: "Command execution failed",
				},
			});

			await assert.rejects(invokePromise, /Command execution failed/);
		} finally {
			(globalThis as any).self = originalSelf;
		}
	});

	it("lh:tauri-init initializes tauri bridge in worker scope", async () => {
		const originalSelf = (globalThis as any).self;
		const globalAny = globalThis as any;
		delete globalAny.__TAURI_INTERNALS__;
		setHostBridge(null as any);

		(globalThis as any).self = {
			postMessage: () => {},
		};

		try {
			handleWorkerTauriMessage({
				data: { type: "lh:tauri-init" },
			});

			const bridge = getHostBridge();
			assert.ok(bridge);
			assert.ok(globalAny.__TAURI_INTERNALS__?.invoke);
		} finally {
			(globalThis as any).self = originalSelf;
			delete globalAny.__TAURI_INTERNALS__;
			setHostBridge(null as any);
		}
	});

	it("waitForInitialBridge resolves to bridge on handshake or timeout", async () => {
		setHostBridge(null as any);
		const bridgePromise = waitForInitialBridge(20);
		const bridge = await bridgePromise;
		assert.ok(bridge);
		assert.equal(typeof bridge.hydrateFs, "function");
	});

	it("childProcess.spawn calls lh_spawn_daemon and kill calls lh_kill_process", async () => {
		const globalAny = globalThis as any;
		const invoked: [string, any][] = [];
		globalAny.__TAURI_INTERNALS__ = {
			invoke: async (cmd: string, args: any) => {
				invoked.push([cmd, args]);
				if (cmd === "lh_spawn_daemon") return 12345;
				if (cmd === "lh_kill_process") return undefined;
				throw new Error(`Unexpected command: ${cmd}`);
			},
		};

		try {
			const { childProcess } = await import("../src/worker/shims/node-stubs.ts");
			const proc = childProcess.spawn("test-daemon", ["--flag"]);
			assert.ok(proc);

			await new Promise((r) => setTimeout(r, 10));
			assert.equal(proc.pid, 12345);
			assert.deepEqual(invoked[0], ["lh_spawn_daemon", { cmd: "test-daemon", args: ["--flag"] }]);

			proc.kill("SIGTERM");
			assert.deepEqual(invoked[1], ["lh_kill_process", { pid: 12345 }]);
		} finally {
			delete globalAny.__TAURI_INTERNALS__;
		}
	});

	it("hasTauriBridge reflects presence of invoke", () => {
		const globalAny = globalThis as any;
		delete globalAny.__TAURI_INTERNALS__;
		delete globalAny.__TAURI_INVOKE__;
		assert.equal(hasTauriBridge(), false);

		globalAny.__TAURI_INTERNALS__ = { invoke: async () => {} };
		assert.equal(hasTauriBridge(), true);
		delete globalAny.__TAURI_INTERNALS__;
	});

	it("hostInvoke delegates to active tauri invoke", async () => {
		const globalAny = globalThis as any;
		const calls: [string, any][] = [];
		globalAny.__TAURI_INTERNALS__ = {
			invoke: async (cmd: string, args: any) => {
				calls.push([cmd, args]);
				return { ok: true };
			},
		};
		try {
			const res = await hostInvoke<{ ok: boolean }>("lh_custom_test", { a: 1 });
			assert.deepEqual(res, { ok: true });
			assert.deepEqual(calls, [["lh_custom_test", { a: 1 }]]);
		} finally {
			delete globalAny.__TAURI_INTERNALS__;
		}
	});

	it("createTauriHostBridge maps initRuntime to lh_get_host_dirs and lh_auth_read", async () => {
		const calls: [string, any][] = [];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			calls.push([cmd, args]);
			if (cmd === "lh_get_host_dirs") {
				return { homeDir: "/Users/alice", dataDir: "/data", userDataDir: "/userData", root: "/app" } as unknown as T;
			}
			if (cmd === "lh_auth_read") {
				return JSON.stringify({ OPENAI_API_KEY: "sk-test" }) as unknown as T;
			}
			throw new Error(`Unexpected: ${cmd}`);
		});

		const init = await bridge.initRuntime();
		assert.equal(init.homeDir, "/Users/alice");
		assert.deepEqual(init.authVars, { OPENAI_API_KEY: "sk-test" });
		assert.deepEqual(calls, [
			["lh_get_host_dirs", undefined],
			["lh_auth_read", { filename: "auth.json" }],
		]);
	});

	it("createTauriHostBridge maps statExternalFile and statExternal to lh_fs_stat_external", async () => {
		const calls: [string, any][] = [];
		const mockStat = { exists: true, isFile: true, isDir: false, size: 1024, mtimeMs: 12345 };
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			calls.push([cmd, args]);
			if (cmd === "lh_fs_stat_external") return mockStat as unknown as T;
			throw new Error(`Unexpected: ${cmd}`);
		});

		const res1 = await bridge.statExternalFile("/path/to/file.txt");
		assert.deepEqual(res1, mockStat);
		assert.deepEqual(calls[0], ["lh_fs_stat_external", { path: "/path/to/file.txt" }]);

		const res2 = await bridge.statExternal!("/path/to/dir");
		assert.deepEqual(res2, mockStat);
		assert.deepEqual(calls[1], ["lh_fs_stat_external", { path: "/path/to/dir" }]);
	});

	it("createTauriHostBridge maps listExternalDir to lh_fs_list_external_dir", async () => {
		const calls: [string, any][] = [];
		const mockEntries = [
			{ name: "docs", path: "/path/to/docs", isDir: true, isFile: false, size: 0 },
			{ name: "file.txt", path: "/path/to/file.txt", isDir: false, isFile: true, size: 42 },
		];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			calls.push([cmd, args]);
			if (cmd === "lh_fs_list_external_dir") return mockEntries as unknown as T;
			throw new Error(`Unexpected: ${cmd}`);
		});

		const res = await bridge.listExternalDir("/path/to");
		assert.deepEqual(res, mockEntries);
		assert.deepEqual(calls, [["lh_fs_list_external_dir", { path: "/path/to" }]]);
	});

	it("createTauriHostBridge maps walkExternalDir and walkExternal to lh_fs_walk_external", async () => {
		const calls: [string, any][] = [];
		const mockWalk = ["/root/a.txt", "/root/sub/b.txt"];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			calls.push([cmd, args]);
			if (cmd === "lh_fs_walk_external") return mockWalk as unknown as T;
			throw new Error(`Unexpected: ${cmd}`);
		});

		const res1 = await bridge.walkExternalDir("/root", 500);
		assert.deepEqual(res1, mockWalk);
		assert.deepEqual(calls[0], ["lh_fs_walk_external", { rootDir: "/root", maxEntries: 500 }]);

		const res2 = await bridge.walkExternal!("/root");
		assert.deepEqual(res2, mockWalk);
		assert.deepEqual(calls[1], ["lh_fs_walk_external", { rootDir: "/root", maxEntries: undefined }]);
	});

	it("createTauriHostBridge maps writeDebugLog to lh_debug_write", async () => {
		const calls: [string, any][] = [];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			calls.push([cmd, args]);
			if (cmd === "lh_debug_write") return undefined as unknown as T;
			throw new Error(`Unexpected: ${cmd}`);
		});

		await bridge.writeDebugLog("provider-events", "chat_123.jsonl", '{"test":1}', true);
		assert.deepEqual(calls, [
			["lh_debug_write", { relPath: "provider-events/chat_123.jsonl", line: '{"test":1}', append: true }],
		]);
	});

	it("createTauriHostBridge maps writeQuadernoPdf and listQuadernoPdfs", async () => {
		const calls: [string, any][] = [];
		const bridge = createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
			calls.push([cmd, args]);
			if (cmd === "lh_quaderno_write_pdf") return "/path/to/saved.pdf" as unknown as T;
			if (cmd === "lh_quaderno_list_pdfs") return ["a.pdf", "b.pdf"] as unknown as T;
			throw new Error(`Unexpected: ${cmd}`);
		});

		const pathResult = await bridge.writeQuadernoPdf!("test.pdf", "base64data");
		assert.equal(pathResult, "/path/to/saved.pdf");
		assert.deepEqual(calls[0], ["lh_quaderno_write_pdf", { filename: "test.pdf", dataBase64: "base64data" }]);

		const pdfs = await bridge.listQuadernoPdfs!();
		assert.deepEqual(pdfs, ["a.pdf", "b.pdf"]);
		assert.deepEqual(calls[1], ["lh_quaderno_list_pdfs", undefined]);
	});
});
