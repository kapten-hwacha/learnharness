function createProcessPolyfill() {
	const listeners = new Map<string, Array<(...args: any[]) => void>>();
	const proc = {
		env: { NODE_ENV: "production" } as Record<string, string | undefined>,
		platform: typeof navigator !== "undefined" && navigator.userAgent.includes("Win") ? "win32" : "darwin",
		arch: "arm64",
		title: "learnharness",
		pid: 1,
		versions: { node: "20.0.0", v8: "11.0.0" },
		cwd: () => "/",
		nextTick: (fn: (...args: any[]) => void, ...args: any[]) => setTimeout(() => fn(...args), 0),
		on(event: string, fn: (...args: any[]) => void) {
			const list = listeners.get(event) || [];
			list.push(fn);
			listeners.set(event, list);
			return proc;
		},
		addListener(event: string, fn: (...args: any[]) => void) {
			return proc.on(event, fn);
		},
		once(event: string, fn: (...args: any[]) => void) {
			const wrapper = (...args: any[]) => {
				proc.removeListener(event, wrapper);
				fn(...args);
			};
			return proc.on(event, wrapper);
		},
		removeListener(event: string, fn: (...args: any[]) => void) {
			const list = listeners.get(event);
			if (list) {
				const idx = list.indexOf(fn);
				if (idx !== -1) list.splice(idx, 1);
			}
			return proc;
		},
		off(event: string, fn: (...args: any[]) => void) {
			return proc.removeListener(event, fn);
		},
		removeAllListeners(event?: string) {
			if (event) listeners.delete(event);
			else listeners.clear();
			return proc;
		},
		emit(event: string, ...args: any[]) {
			const list = listeners.get(event);
			if (!list || list.length === 0) return false;
			for (const fn of [...list]) {
				try { fn(...args); } catch (e) { console.error(e); }
			}
			return true;
		},
		listeners(event: string) {
			return [...(listeners.get(event) || [])];
		},
		rawListeners(event: string) {
			return proc.listeners(event);
		},
		listenerCount(event: string) {
			return (listeners.get(event) || []).length;
		},
		hrtime(prev?: [number, number]): [number, number] {
			const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) * 1e-3;
			let s = Math.floor(now);
			let ns = Math.floor((now % 1) * 1e9);
			if (prev) {
				s -= prev[0];
				ns -= prev[1];
				if (ns < 0) { s--; ns += 1e9; }
			}
			return [s, ns];
		},
		uptime: () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000,
		memoryUsage: () => ({ heapTotal: 0, heapUsed: 0, rss: 0, external: 0, arrayBuffers: 0 }),
		exit: () => {},
		abort: () => {},
		stdout: { write: () => {}, on: () => {}, once: () => {}, emit: () => {} },
		stderr: { write: () => {}, on: () => {}, once: () => {}, emit: () => {} },
		stdin: { read: () => null, on: () => {}, once: () => {}, emit: () => {} },
	};
	(proc.hrtime as any).bigint = () => BigInt(Math.floor((typeof performance !== "undefined" ? performance.now() : Date.now()) * 1e6));
	return proc;
}

if (typeof globalThis !== "undefined") {
	if (typeof (globalThis as any).global === "undefined") {
		(globalThis as any).global = globalThis;
	}
	const polyfill = createProcessPolyfill();
	if (typeof (globalThis as any).process === "undefined") {
		(globalThis as any).process = polyfill;
	} else {
		for (const [key, val] of Object.entries(polyfill)) {
			if (typeof (globalThis as any).process[key] === "undefined") {
				(globalThis as any).process[key] = val;
			}
		}
	}
}

if (typeof window !== "undefined") {
	(window as any).global = window;
}
