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

export type TauriInvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface PendingRpc {
	resolve: (val: any) => void;
	reject: (err: any) => void;
}

const pendingInvocations = new Map<string, PendingRpc>();
const tauriEventListeners = new Map<string, Set<(event: { payload: any }) => void>>();

let workerTauriInvoke: TauriInvokeFn | null = null;

export function isTauriEnvironment(): boolean {
	if (typeof (globalThis as any).__TAURI_INTERNALS__?.invoke === "function") return true;
	if (typeof (globalThis as any).__TAURI_INVOKE__ === "function") return true;
	if (typeof location !== "undefined") {
		try {
			if (new URL(location.href).searchParams.get("tauri") === "1") return true;
		} catch {}
	}
	return false;
}

export function createWorkerTauriInvoke(): TauriInvokeFn {
	return <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
			pendingInvocations.set(id, { resolve, reject });
			if (typeof self !== "undefined" && typeof (self as any).postMessage === "function") {
				(self as any).postMessage({
					type: "lh:tauri-invoke",
					id,
					cmd,
					args,
				});
			} else {
				pendingInvocations.delete(id);
				reject(new Error("Worker postMessage is unavailable"));
			}
		});
	};
}

export function listenTauriEvent(event: string, handler: (e: { payload: any }) => void): () => void {
	let set = tauriEventListeners.get(event);
	if (!set) {
		set = new Set();
		tauriEventListeners.set(event, set);
	}
	set.add(handler);
	return () => {
		set?.delete(handler);
	};
}

export function handleWorkerTauriMessage(event: { data: any }): void {
	const data = event?.data;
	if (!data) return;

	if (data.type === "lh:tauri-init") {
		const invoke = getTauriInvoke() ?? createWorkerTauriInvoke();
		workerTauriInvoke = invoke;
		if (typeof globalThis !== "undefined") {
			(globalThis as any).__TAURI_INTERNALS__ = {
				invoke,
				listen: listenTauriEvent,
			};
		}
		setHostBridge(createTauriHostBridge(invoke));
	} else if (data.type === "lh:tauri-invoke-result") {
		const { id, result, error } = data;
		const pending = pendingInvocations.get(id);
		if (pending) {
			pendingInvocations.delete(id);
			if (error !== undefined) {
				pending.reject(new Error(error));
			} else {
				pending.resolve(result);
			}
		}
	} else if (data.type === "lh:tauri-event") {
		const { event: evtName, payload } = data;
		const set = tauriEventListeners.get(evtName);
		if (set) {
			for (const handler of set) {
				try {
					handler({ payload });
				} catch (err) {
					console.error(err);
				}
			}
		}
	}
}

if (typeof self !== "undefined" && typeof (self as any).addEventListener === "function") {
	(self as any).addEventListener("message", handleWorkerTauriMessage);
}

export function getTauriInvoke(): TauriInvokeFn | null {
	const tauriInternals = (globalThis as any).__TAURI_INTERNALS__;
	if (typeof tauriInternals?.invoke === "function") {
		return tauriInternals.invoke;
	}
	const tauriInvoke = (globalThis as any).__TAURI_INVOKE__;
	if (typeof tauriInvoke === "function") {
		return tauriInvoke;
	}
	if (isTauriEnvironment() && typeof self !== "undefined" && typeof (self as any).postMessage === "function") {
		if (!workerTauriInvoke) {
			workerTauriInvoke = createWorkerTauriInvoke();
		}
		return workerTauriInvoke;
	}
	return null;
}

if (typeof globalThis !== "undefined" && !(globalThis as any).__TAURI_INTERNALS__ && isTauriEnvironment()) {
	const invoke = getTauriInvoke() ?? createWorkerTauriInvoke();
	workerTauriInvoke = invoke;
	(globalThis as any).__TAURI_INTERNALS__ = {
		invoke,
		listen: listenTauriEvent,
	};
}

let activeBridge: HostBridge | null = null;

export function setHostBridge(bridge: HostBridge | null): void {
	activeBridge = bridge;
}

export function getHostBridge(): HostBridge {
	if (!activeBridge) {
		const invoke = getTauriInvoke();
		if (invoke) {
			activeBridge = createTauriHostBridge(invoke);
		} else {
			activeBridge = createBrowserDevHostBridge();
		}
	}
	return activeBridge;
}

export function createTauriHostBridge(
	invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
): HostBridge {
	return {
		async hydrateFs(): Promise<HydratedFsSnapshot> {
			return await invoke<HydratedFsSnapshot>("lh_fs_hydrate");
		},
		async syncFs(op: FsMutationOp): Promise<void> {
			await invoke("lh_fs_sync", { op });
		},
		async readExternalFile(absPath: string): Promise<Uint8Array> {
			const res = await invoke<number[] | Uint8Array>("lh_fs_read_external", { path: absPath });
			return res instanceof Uint8Array ? res : new Uint8Array(res);
		},
		async nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			const headers: [string, string][] = [];
			if (init?.headers) {
				if (init.headers instanceof Headers) {
					init.headers.forEach((v, k) => headers.push([k, v]));
				} else if (Array.isArray(init.headers)) {
					for (const [k, v] of init.headers) headers.push([k, v]);
				} else {
					for (const [k, v] of Object.entries(init.headers)) {
						if (v !== undefined) headers.push([k, String(v)]);
					}
				}
			} else if (input instanceof Request) {
				input.headers.forEach((v, k) => headers.push([k, v]));
			}

			let bodyBase64: string | undefined;
			if (typeof init?.body === "string") {
				bodyBase64 = Buffer.from(init.body).toString("base64");
			} else if (init?.body instanceof Uint8Array) {
				bodyBase64 = Buffer.from(init.body).toString("base64");
			} else if (init?.body instanceof ArrayBuffer) {
				bodyBase64 = Buffer.from(new Uint8Array(init.body)).toString("base64");
			}

			const res = await invoke<{
				status: number;
				headers: [string, string][];
				bodyBase64: string;
			}>("lh_http_fetch", {
				req: {
					url,
					method,
					headers,
					bodyBase64,
				},
			});

			const bodyBytes = Buffer.from(res.bodyBase64, "base64");
			const responseHeaders = new Headers();
			for (const [k, v] of res.headers) {
				responseHeaders.append(k, v);
			}

			return new Response(bodyBytes, {
				status: res.status,
				headers: responseHeaders,
			});
		},
	};
}

export function createBrowserDevHostBridge(): HostBridge {
	return {
		async hydrateFs(): Promise<HydratedFsSnapshot> {
			const res = await fetch("/__lh_dev/fs-hydrate");
			if (!res.ok) {
				throw new Error(`Failed to hydrate fs: ${res.status} ${res.statusText}`);
			}
			return (await res.json()) as HydratedFsSnapshot;
		},
		async syncFs(op: FsMutationOp): Promise<void> {
			const res = await fetch("/__lh_dev/fs-sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(op),
			});
			if (!res.ok) {
				console.warn(`[host-bridge] syncFs failed: ${res.status} ${res.statusText}`);
			}
		},
		async readExternalFile(absPath: string): Promise<Uint8Array> {
			const res = await fetch("/__lh_dev/fs-read-external", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: absPath }),
			});
			if (!res.ok) {
				throw new Error(`Failed to read external file ${absPath}: ${res.status} ${res.statusText}`);
			}
			const buf = await res.arrayBuffer();
			return new Uint8Array(buf);
		},
		async nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			try {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				const method = init?.method ?? (input instanceof Request ? input.method : "GET");
				let headers: Record<string, string> | undefined;
				if (init?.headers) {
					if (init.headers instanceof Headers) {
						headers = Object.fromEntries(init.headers.entries());
					} else if (Array.isArray(init.headers)) {
						headers = Object.fromEntries(init.headers);
					} else {
						headers = init.headers as Record<string, string>;
					}
				} else if (input instanceof Request) {
					headers = Object.fromEntries(input.headers.entries());
				}
				let body: string | undefined;
				if (typeof init?.body === "string") {
					body = init.body;
				} else if (init?.body instanceof Uint8Array || init?.body instanceof ArrayBuffer) {
					body = new TextDecoder().decode(init.body);
				}

				const res = await fetch("/__lh_dev/fetch", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ url, method, headers, body }),
				});
				if (res.headers.get("x-lh-dev-proxied") === "1") return res;
			} catch {
				// Fall back to direct fetch if /__lh_dev/fetch is unavailable
			}
			return fetch(input, init);
		},
	};
}
