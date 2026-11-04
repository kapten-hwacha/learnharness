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

let activeBridge: HostBridge | null = null;

export function setHostBridge(bridge: HostBridge | null): void {
	activeBridge = bridge;
}

export function getHostBridge(): HostBridge {
	if (!activeBridge) {
		const tauriInternals = (globalThis as any).__TAURI_INTERNALS__;
		if (tauriInternals?.invoke) {
			activeBridge = createTauriHostBridge(tauriInternals.invoke);
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
