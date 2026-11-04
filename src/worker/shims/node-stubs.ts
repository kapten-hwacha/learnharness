// Browser-safe node:* shims for worker execution

export const os = {
	tmpdir: () => "/tmp",
	homedir: () => "/home",
	platform: () => "browser" as NodeJS.Platform,
	arch: () => "x64",
	type: () => "Browser",
	release: () => "1.0.0",
	EOL: "\n",
	cpus: () => [
		{
			model: "Worker Virtual CPU",
			speed: 2400,
			times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
		},
	],
	totalmem: () => 4 * 1024 * 1024 * 1024,
	freemem: () => 2 * 1024 * 1024 * 1024,
	uptime: () => 0,
	networkInterfaces: () => ({}),
	userInfo: () => ({
		username: "user",
		uid: 1000,
		gid: 1000,
		homedir: "/home",
		shell: "/bin/sh",
	}),
};

export const url = {
	fileURLToPath(fileUrl: string | URL): string {
		const str = typeof fileUrl === "string" ? fileUrl : fileUrl.toString();
		if (!str.startsWith("file://")) {
			throw new TypeError(`The URL must be of scheme file: ${str}`);
		}
		let path = decodeURIComponent(str.slice(7));
		if (!path.startsWith("/")) path = "/" + path;
		return path;
	},
	pathToFileURL(filepath: string): URL {
		const abs = filepath.startsWith("/") ? filepath : "/" + filepath;
		return new URL(`file://${encodeURI(abs)}`);
	},
	URL: globalThis.URL,
	URLSearchParams: globalThis.URLSearchParams,
};

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keysA = Object.keys(a as object);
	const keysB = Object.keys(b as object);
	if (keysA.length !== keysB.length) return false;
	for (const key of keysA) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (!isDeepStrictEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
			return false;
		}
	}
	return true;
}

export function promisify<T = unknown>(fn: (...args: unknown[]) => void): (...args: unknown[]) => Promise<T> {
	return (...args: unknown[]) =>
		new Promise<T>((resolve, reject) => {
			fn(...args, (err: unknown, res: T) => {
				if (err) reject(err);
				else resolve(res);
			});
		});
}

export function inspect(obj: unknown, _options?: unknown): string {
	if (typeof obj === "string") return obj;
	try {
		return JSON.stringify(obj, null, 2);
	} catch {
		return String(obj);
	}
}

export function format(fmt: unknown, ...args: unknown[]): string {
	if (typeof fmt !== "string") return [fmt, ...args].map(String).join(" ");
	let i = 0;
	return fmt.replace(/%[sdj%]/g, (match) => {
		if (match === "%%") return "%";
		if (i >= args.length) return match;
		const val = args[i++];
		if (match === "%s") return String(val);
		if (match === "%d") return Number(val).toString();
		if (match === "%j") {
			try {
				return JSON.stringify(val);
			} catch {
				return "[Circular]";
			}
		}
		return String(val);
	});
}

export const util = {
	isDeepStrictEqual,
	promisify,
	inspect,
	format,
	types: {
		isPromise: (v: unknown): v is Promise<unknown> =>
			typeof v === "object" && v !== null && "then" in v && typeof (v as { then: unknown }).then === "function",
	},
};

export const moduleShim = {
	createRequire: () => (id: string) => {
		throw new Error(`createRequire is not supported in Web Worker for "${id}"`);
	},
};

export class WorkerStub {
	constructor(_filename: string | URL, _options?: unknown) {
		throw new Error("worker_threads unavailable in Web Worker");
	}
}

export const workerThreads = {
	Worker: WorkerStub,
	parentPort: null,
	isMainThread: false,
	workerData: undefined,
};

export const childProcess = {
	spawn(..._args: unknown[]) {
		throw new Error("child_process.spawn unavailable in Web Worker");
	},
	execSync(..._args: unknown[]) {
		throw new Error("child_process.execSync unavailable in Web Worker");
	},
	execFile(..._args: unknown[]) {
		throw new Error("child_process.execFile unavailable in Web Worker");
	},
	exec(..._args: unknown[]) {
		throw new Error("child_process.exec unavailable in Web Worker");
	},
	fork(..._args: unknown[]) {
		throw new Error("child_process.fork unavailable in Web Worker");
	},
};

export const http = {
	createServer() {
		return {
			listen(_port?: number, cb?: () => void) {
				cb?.();
				return this;
			},
			close(cb?: () => void) {
				cb?.();
				return this;
			},
			on() {
				return this;
			},
		};
	},
	get() {
		throw new Error("http.get not supported in Web Worker");
	},
	request() {
		throw new Error("http.request not supported in Web Worker");
	},
	STATUS_CODES: {
		200: "OK",
		400: "Bad Request",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		500: "Internal Server Error",
	} as Record<number, string>,
	METHODS: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
};

export class SocketStub {
	connect(_port?: number, _host?: string, cb?: () => void) {
		cb?.();
		return this;
	}
	on() {
		return this;
	}
	once() {
		return this;
	}
	write(_data: unknown, cb?: () => void) {
		cb?.();
		return true;
	}
	end(cb?: () => void) {
		cb?.();
		return this;
	}
	destroy() {
		return this;
	}
	address() {
		return { port: 0, family: "IPv4", address: "127.0.0.1" };
	}
}

export const net = {
	createServer() {
		return {
			listen(_port?: number, cb?: () => void) {
				cb?.();
				return this;
			},
			close(cb?: () => void) {
				cb?.();
				return this;
			},
			on() {
				return this;
			},
			address() {
				return { port: 0, family: "IPv4", address: "127.0.0.1" };
			},
		};
	},
	Socket: SocketStub,
	connect() {
		return new SocketStub();
	},
	createConnection() {
		return new SocketStub();
	},
	isIP: () => 0,
	isIPv4: () => false,
	isIPv6: () => false,
};

export const readline = {
	createInterface() {
		return {
			on() {
				return this;
			},
			close() {},
			question(_query: string, cb: (answer: string) => void) {
				cb("");
			},
			async *[Symbol.asyncIterator]() {},
		};
	},
};
