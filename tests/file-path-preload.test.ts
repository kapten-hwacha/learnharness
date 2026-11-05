import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installTauriPreload } from "../src/client/tauri-preload.ts";

describe("Tauri file-path preload bridge", () => {
	it("getPathForFile returns the OS path for a dropped File", () => {
		let dropCallback: ((event: { payload: { paths: string[] } }) => void) | undefined;
		const target = {
			listeners: new Map<string, (event: any) => void>(),
			addEventListener(type: string, fn: (event: any) => void) {
				this.listeners.set(type, fn);
			},
			removeEventListener() {},
		} as any;

		installTauriPreload({
			invoke: async <T>() => undefined as unknown as T,
			listen: async (event, cb) => {
				if (event === "tauri://drag-drop") {
					dropCallback = cb as any;
				}
				return () => {};
			},
			platform: "darwin",
			target,
		});

		const fullPath = "/actual/course/notes with `backticks`.pdf";
		const file = new File(["synthetic fixture"], "display-name.pdf", { type: "application/pdf" });

		// Deliver tauri drag-drop event
		assert.ok(dropCallback, "tauri://drag-drop listener must be registered");
		dropCallback({ payload: { paths: [fullPath] } });

		// Deliver DOM drop event on target
		const dropHandler = target.listeners.get("drop");
		assert.ok(dropHandler, "DOM drop handler must be registered");
		dropHandler({ dataTransfer: { files: [file] } });

		assert.equal(target.lh.getPathForFile(file), fullPath);
	});

	it("returns \"\" for a File with no dropped path and never the file name", () => {
		const target = {
			addEventListener() {},
			removeEventListener() {},
		} as any;

		installTauriPreload({
			invoke: async <T>() => undefined as unknown as T,
			listen: async () => () => {},
			platform: "darwin",
			target,
		});

		const virtual = new File(["virtual"], "/misleading/full/path.pdf");
		assert.equal(target.lh.getPathForFile(virtual), "");
		assert.notEqual(target.lh.getPathForFile(virtual), virtual.name);
	});

	it("never reads file content", () => {
		let dropCallback: ((event: { payload: { paths: string[] } }) => void) | undefined;
		const target = {
			listeners: new Map<string, (event: any) => void>(),
			addEventListener(type: string, fn: (event: any) => void) {
				this.listeners.set(type, fn);
			},
			removeEventListener() {},
		} as any;

		installTauriPreload({
			invoke: async <T>() => undefined as unknown as T,
			listen: async (event, cb) => {
				if (event === "tauri://drag-drop") {
					dropCallback = cb as any;
				}
				return () => {};
			},
			platform: "darwin",
			target,
		});

		const file = new File(["synthetic fixture"], "doc.pdf", { type: "application/pdf" });
		let reads = 0;
		for (const method of ["text", "arrayBuffer", "stream"] as const) {
			Object.defineProperty(file, method, {
				value: () => {
					reads++;
					throw new Error("Must not read file content");
				},
			});
		}

		dropCallback!({ payload: { paths: ["/path/to/doc.pdf"] } });
		target.listeners.get("drop")!({ dataTransfer: { files: [file] } });

		assert.equal(target.lh.getPathForFile(file), "/path/to/doc.pdf");
		assert.equal(reads, 0);
	});

	it("resolves file path even when a child component calls stopPropagation", () => {
		let dropCallback: ((event: { payload: { paths: string[] } }) => void) | undefined;
		const captureListeners: ((event: any) => void)[] = [];
		const bubbleListeners: ((event: any) => void)[] = [];

		const target = {
			addEventListener(type: string, fn: (event: any) => void, options?: boolean | { capture?: boolean }) {
				const isCapture = typeof options === "boolean" ? options : Boolean(options?.capture);
				if (type === "drop") {
					if (isCapture) {
						captureListeners.push(fn);
					} else {
						bubbleListeners.push(fn);
					}
				}
			},
			removeEventListener() {},
		} as any;

		installTauriPreload({
			invoke: async <T>() => undefined as unknown as T,
			listen: async (event, cb) => {
				if (event === "tauri://drag-drop") {
					dropCallback = cb as any;
				}
				return () => {};
			},
			platform: "darwin",
			target,
		});

		assert.equal(captureListeners.length, 1, "drop listener must be registered in capture phase");

		const fullPath = "/users/test/notes.pdf";
		const file = new File(["test data"], "notes.pdf", { type: "application/pdf" });

		dropCallback!({ payload: { paths: [fullPath] } });

		let stopped = false;
		const event = {
			dataTransfer: { files: [file] },
			stopPropagation: () => {
				stopped = true;
			},
		};

		// 1. Capture listeners run first
		for (const listener of captureListeners) {
			listener(event);
		}

		// 2. Child component handler runs next and calls stopPropagation()
		const childHandler = (e: typeof event) => {
			e.stopPropagation();
		};
		childHandler(event);
		assert.ok(stopped, "stopPropagation was called by child component");

		// Verify target.lh.getPathForFile resolves correctly
		assert.equal(target.lh.getPathForFile(file), fullPath);

		// Verify lastDroppedPaths is cleared after use
		const nextFile = new File(["other"], "other.pdf");
		for (const listener of captureListeners) {
			listener({ dataTransfer: { files: [nextFile] } });
		}
		assert.equal(target.lh.getPathForFile(nextFile), "");
	});

	describe("importFile iPadOS preload support", () => {
		it("importFile with Uint8Array returns /imported/<name>", async () => {
			const target = {} as any;
			installTauriPreload({
				invoke: async <T>() => undefined as unknown as T,
				listen: async () => () => {},
				platform: "ios",
				target,
			});

			const bytes = new Uint8Array([1, 2, 3, 4]);
			const res = await target.lh.importFile("sample.pdf", bytes);
			assert.equal(res, "/imported/sample.pdf");
		});

		it("importFile with File object extracts name and data", async () => {
			const target = {} as any;
			installTauriPreload({
				invoke: async <T>() => undefined as unknown as T,
				listen: async () => () => {},
				platform: "ios",
				target,
			});

			const file = new File(["document text"], "lecture-notes.txt", { type: "text/plain" });
			const res = await target.lh.importFile(file);
			assert.equal(res, "/imported/lecture-notes.txt");
		});

		it("importFile posts lh:import-file message to worker if active", async () => {
			const target = {} as any;
			installTauriPreload({
				invoke: async <T>() => undefined as unknown as T,
				listen: async () => () => {},
				platform: "ios",
				target,
			});

			const messages: any[] = [];
			const mockWorker = {
				postMessage(msg: any) {
					messages.push(msg);
				},
			};

			const origWin = (globalThis as any).window;
			(globalThis as any).window = { __LH_WORKER__: mockWorker };

			try {
				const bytes = new Uint8Array([10, 20, 30]);
				const path = await target.lh.importFile("photo.png", bytes);
				assert.equal(path, "/imported/photo.png");
				assert.equal(messages.length, 1);
				assert.equal(messages[0].type, "lh:import-file");
				assert.equal(messages[0].path, "/imported/photo.png");
				assert.deepEqual(messages[0].data, bytes);
			} finally {
				(globalThis as any).window = origWin;
			}
		});

		it("uses custom importFile handler from deps when provided", async () => {
			const target = {} as any;
			let calledWith: { name: string; data: Uint8Array | ArrayBuffer } | undefined;
			installTauriPreload({
				invoke: async <T>() => undefined as unknown as T,
				listen: async () => () => {},
				platform: "ios",
				target,
				importFile: async (name, data) => {
					calledWith = { name, data };
					return `/custom/path/${name}`;
				},
			});

			const bytes = new Uint8Array([5, 6, 7]);
			const result = await target.lh.importFile("override.pdf", bytes);
			assert.equal(result, "/custom/path/override.pdf");
			assert.equal(calledWith?.name, "override.pdf");
			assert.deepEqual(calledWith?.data, bytes);
		});

		it("importFile handles multiple files in sequence producing valid imported paths", async () => {
			const target = {} as any;
			installTauriPreload({
				invoke: async <T>() => undefined as unknown as T,
				listen: async () => () => {},
				platform: "ios",
				target,
			});

			const file1 = new File(["content1"], "doc1.pdf", { type: "application/pdf" });
			const file2 = new File(["content2"], "doc2.txt", { type: "text/plain" });

			const path1 = await target.lh.importFile(file1);
			const path2 = await target.lh.importFile(file2);

			assert.equal(path1, "/imported/doc1.pdf");
			assert.equal(path2, "/imported/doc2.txt");
		});

		it("importFile strips leading slashes and existing /imported/ prefixes", async () => {
			const target = {} as any;
			installTauriPreload({
				invoke: async <T>() => undefined as unknown as T,
				listen: async () => () => {},
				platform: "ios",
				target,
			});

			const path1 = await target.lh.importFile("///deep/path.pdf", new Uint8Array([1]));
			assert.equal(path1, "/imported/deep/path.pdf");

			const path2 = await target.lh.importFile("/imported/existing.pdf", new Uint8Array([2]));
			assert.equal(path2, "/imported/existing.pdf");
		});
	});
});
