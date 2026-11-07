export const ZOOM_LADDER: readonly number[] = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function stepZoom(current: number, direction: "in" | "out" | "reset"): number {
	if (direction === "reset") return 1;
	if (direction === "in") {
		for (const z of ZOOM_LADDER) {
			if (z > current + 0.001) return z;
		}
		return ZOOM_LADDER[ZOOM_LADDER.length - 1] ?? 2;
	}
	if (direction === "out") {
		for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
			const z = ZOOM_LADDER[i];
			if (z !== undefined && z < current - 0.001) return z;
		}
		return ZOOM_LADDER[0] ?? 0.75;
	}
	return current;
}

export type InvokeFn = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type ListenFn = <T>(
	event: string,
	handler: (event: { event: string; payload: T }) => void
) => Promise<() => void> | (() => void);

export interface TauriPreloadDeps {
	invoke: InvokeFn;
	listen: ListenFn;
	platform: "darwin" | "win32" | "linux" | "ios";
	target?: any;
	importFile?: (name: string, data: Uint8Array | ArrayBuffer) => Promise<string>;
}

export function installTauriPreload(deps: TauriPreloadDeps): void {
	const target = deps.target ?? (typeof window !== "undefined" ? window : globalThis);
	const dropPathMap = new WeakMap<object, string>();
	let lastDroppedPaths: string[] = [];

	let currentZoom = 1;
	const zoomListeners = new Set<(zoom: number) => void>();

	// Listen for tauri drag-drop events
	void Promise.resolve(
		deps.listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
			if (event?.payload?.paths) {
				lastDroppedPaths = event.payload.paths;
			}
		})
	);

	// Listen for DOM drop events to map Files to paths
	if (target?.addEventListener) {
		target.addEventListener(
			"drop",
			(event: any) => {
				const files = event?.dataTransfer?.files;
				if (files && lastDroppedPaths.length > 0) {
					for (let i = 0; i < files.length; i++) {
						const dropped = lastDroppedPaths[i];
						const file = files[i];
						if (dropped && file) {
							dropPathMap.set(file, dropped);
						}
					}
				}
				lastDroppedPaths = [];
			},
			true,
		);
	}

	// Listen for zoom events from host
	void Promise.resolve(
		deps.listen<number>("lh://zoom", (event) => {
			if (typeof event?.payload === "number") {
				currentZoom = event.payload;
				for (const listener of zoomListeners) {
					try {
						listener(currentZoom);
					} catch {}
				}
			}
		})
	);

	const isIos = deps.platform === "ios";
	const isMobile = isIos;

	target.lh = {
		platform: deps.platform,
		isIos,
		isMobile,
		async importFile(nameOrFile: string | File, maybeData?: Uint8Array | ArrayBuffer): Promise<string> {
			let name: string;
			let bytes: Uint8Array;
			if (typeof File !== "undefined" && nameOrFile instanceof File) {
				name = nameOrFile.name;
				const ab = await nameOrFile.arrayBuffer();
				bytes = new Uint8Array(ab);
			} else if (typeof nameOrFile === "string") {
				name = nameOrFile;
				if (!maybeData) {
					throw new TypeError("Expected data for importFile(name, data)");
				}
				bytes = maybeData instanceof Uint8Array ? maybeData : new Uint8Array(maybeData);
			} else {
				throw new TypeError("Invalid argument for importFile");
			}

			if (deps.importFile) {
				return deps.importFile(name, bytes);
			}

			const cleanName = name.startsWith("/imported/")
				? name.slice("/imported/".length)
				: name.replace(/^[/\\]+/, "");
			const importedPath = `/imported/${cleanName}`;

			if (typeof window !== "undefined" && (window as any).__LH_WORKER__) {
				(window as any).__LH_WORKER__.postMessage({
					type: "lh:import-file",
					path: importedPath,
					data: bytes,
				});
			}
			return importedPath;
		},
		getPathForFile(file: unknown): string {
			if (typeof File === "undefined" || !(file instanceof File)) {
				throw new TypeError("Expected a File");
			}
			return dropPathMap.get(file) ?? "";
		},
		subscriptionTransport: "web",
		async openSubscriptionBrowser(action: string): Promise<void> {
			if (!/^\/api\/subscriptions\/browser\?id=[0-9a-f-]{36}$/.test(action)) {
				throw new Error(`Invalid subscription browser action: ${action}`);
			}
			const res = await fetch(action, { method: "POST", redirect: "manual" });
			if (res.status !== 303) {
				throw new Error(`Expected 303 redirect, got ${res.status}`);
			}
			const location = res.headers.get("Location");
			if (!location) {
				throw new Error("Missing Location header in redirect");
			}
			const parsed = new URL(location);
			if (parsed.protocol !== "https:") {
				throw new Error(`Invalid protocol in Location: ${parsed.protocol}`);
			}
			if (parsed.username || parsed.password) {
				throw new Error("Credentials in Location URL not allowed");
			}
			await deps.invoke("lh_open_external", { url: location });
		},
		chatgpt: {
			async status() {
				return { available: false, connected: false, pending: false };
			},
			async start() {
				return { error: "unsupported" };
			},
			async cancel() {},
			async login() {
				return { available: false, connected: false, pending: false };
			},
			async select() {
				return { available: false, connected: false, pending: false };
			},
			async disconnect() {
				return { available: false, connected: false, pending: false };
			},
			async logout() {
				return { available: false, connected: false, pending: false };
			},
			async consent() {
				return { available: false, connected: false, pending: false };
			},
			onChange() {
				return () => {};
			},
			on() {
				return () => {};
			},
		},
		subscriptions: {
			async status() {
				return [];
			},
			async getStatus() {
				return { registrations: [], activeId: null };
			},
			async login() {},
			async cancel() {},
			async respond() {},
			async open() {},
			async retry() {},
			async disconnect() {},
			async consent() {},
			onChange() {
				return () => {};
			},
			on() {
				return () => {};
			},
		},
		async expandWindow(): Promise<void> {
			await deps.invoke("lh_expand_window");
		},
		async getZoom(): Promise<number> {
			return currentZoom;
		},
		onZoom(callback: (zoom: number) => void): () => void {
			zoomListeners.add(callback);
			return () => {
				zoomListeners.delete(callback);
			};
		},
		onOpenSettings(callback: (pane: string) => void): () => void {
			let unlisten: (() => void) | undefined;
			let active = true;
			const res = deps.listen<string>("lh://open-settings", (event) => {
				if (active && event?.payload) {
					callback(event.payload);
				}
			});
			if (typeof res === "function") {
				unlisten = res;
			} else if (res && typeof (res as Promise<any>).then === "function") {
				void (res as Promise<() => void>).then((fn) => {
					if (typeof fn === "function") {
						unlisten = fn;
						if (!active) {
							fn();
						}
					}
				});
			}
			return () => {
				active = false;
				unlisten?.();
			};
		},
	};
}
