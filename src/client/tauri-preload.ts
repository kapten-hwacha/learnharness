import type { UpdateState } from "../core/update-state.ts";

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
	platform: "darwin" | "win32" | "linux";
	target?: any;
}

export function installTauriPreload(deps: {
	invoke: InvokeFn;
	listen: ListenFn;
	platform: "darwin" | "win32" | "linux";
	target?: any;
}): void {
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

	target.lh = {
		platform: deps.platform,
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
			async start() {
				return { error: "unsupported" };
			},
			async cancel() {},
			on() {
				return () => {};
			},
		},
		subscriptions: {
			async getStatus() {
				return { registrations: [], activeId: null };
			},
			on() {
				return () => {};
			},
		},
		async expandWindow(): Promise<void> {
			await deps.invoke("lh_expand_window");
		},
		getZoom(): number {
			return currentZoom;
		},
		onZoom(callback: (zoom: number) => void): () => void {
			zoomListeners.add(callback);
			return () => {
				zoomListeners.delete(callback);
			};
		},
		async checkForUpdates(): Promise<void> {
			await deps.invoke("lh_update_check");
		},
		async installUpdate(): Promise<void> {
			await deps.invoke("lh_update_install");
		},
		async getUpdateState(): Promise<UpdateState> {
			return await deps.invoke<UpdateState>("lh_update_get");
		},
		onUpdateStatus(callback: (status: UpdateState) => void): () => void {
			let unlisten: (() => void) | undefined;
			let active = true;
			const res = deps.listen<UpdateState>("lh://update-status", (event) => {
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
