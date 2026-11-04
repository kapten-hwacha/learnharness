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
});
