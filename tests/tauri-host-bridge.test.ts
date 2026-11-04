import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createTauriHostBridge,
	getHostBridge,
	setHostBridge,
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
});
