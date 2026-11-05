if (typeof globalThis !== "undefined" && typeof (globalThis as any).process === "undefined") {
	(globalThis as any).process = {
		env: {},
		platform: typeof navigator !== "undefined" && navigator.userAgent.includes("Win") ? "win32" : "darwin",
		versions: {},
		cwd: () => "/",
		nextTick: (fn: () => void) => setTimeout(fn, 0),
	};
}
