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

export function setHostBridge(bridge: HostBridge): void {
	activeBridge = bridge;
}

export function getHostBridge(): HostBridge {
	if (!activeBridge) {
		activeBridge = createBrowserDevHostBridge();
	}
	return activeBridge;
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
				if (res.ok) return res;
			} catch {
				// Fall back to direct fetch if /__lh_dev/fetch is unavailable
			}
			return fetch(input, init);
		},
	};
}
