// Browser-safe node:* shims for worker execution

import { getTauriInvoke } from "../host-bridge.ts";

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
		if (str.startsWith("file://")) {
			let path = decodeURIComponent(str.slice(7));
			if (!path.startsWith("/")) path = "/" + path;
			return path;
		}
		try {
			const u = new URL(str);
			let path = decodeURIComponent(u.pathname);
			if (!path.startsWith("/")) path = "/" + path;
			return path;
		} catch {
			return str;
		}
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
	spawn(file: string, ...argsAndOptions: any[]) {
		const invoke = getTauriInvoke();
		if (!invoke) {
			throw new Error("child_process.spawn unavailable in Web Worker");
		}
		let args: string[] = [];
		let options: any = {};
		for (const item of argsAndOptions) {
			if (Array.isArray(item)) args = item;
			else if (typeof item === "object" && item !== null) options = item;
		}

		let pid: number | undefined;

		const listeners = new Map<string, ((...args: any[]) => void)[]>();
		const stdoutListeners = new Map<string, ((...args: any[]) => void)[]>();
		const stderrListeners = new Map<string, ((...args: any[]) => void)[]>();

		const createEmitter = (map: Map<string, ((...args: any[]) => void)[]>) => ({
			on(event: string, fn: (...args: any[]) => void) {
				const list = map.get(event) ?? [];
				list.push(fn);
				map.set(event, list);
				return this;
			},
			once(event: string, fn: (...args: any[]) => void) {
				const wrapper = (...args: any[]) => {
					this.removeListener(event, wrapper);
					fn(...args);
				};
				return this.on(event, wrapper);
			},
			removeListener(event: string, fn: (...args: any[]) => void) {
				const list = map.get(event);
				if (list) map.set(event, list.filter((f) => f !== fn));
				return this;
			},
			emit(event: string, ...args: any[]) {
				const list = map.get(event);
				if (list) {
					for (const fn of list) {
						try { fn(...args); } catch (e) { console.error(e); }
					}
				}
			},
		});

		const stdout = createEmitter(stdoutListeners);
		const stderr = createEmitter(stderrListeners);
		const proc: any = {
			...createEmitter(listeners),
			stdout,
			stderr,
			stdin: { write() {}, end() {} },
			pid: undefined,
			kill(signal?: string | number) {
				if (pid !== undefined) {
					invoke("lh_kill_process", { pid }).catch(() => {});
				}
				proc.emit("exit", null, signal ?? "SIGTERM");
				proc.emit("close", null);
				return true;
			},
		};

		invoke<number>("lh_spawn_daemon", {
			cmd: file,
			args,
		})
			.then((spawnedPid) => {
				pid = spawnedPid;
				proc.pid = spawnedPid;
				proc.emit("spawn");
			})
			.catch((err) => {
				proc.emit("error", err);
			});

		return proc;
	},
	execSync(..._args: unknown[]) {
		throw new Error("child_process.execSync unavailable in Web Worker");
	},
	execFile(file: string, ...argsAndOptions: any[]) {
		const invoke = getTauriInvoke();
		if (!invoke) {
			throw new Error("child_process.execFile unavailable in Web Worker");
		}
		let args: string[] = [];
		let options: any = {};
		let callback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
		for (const item of argsAndOptions) {
			if (Array.isArray(item)) args = item;
			else if (typeof item === "function") callback = item;
			else if (typeof item === "object" && item !== null) options = item;
		}

		const envList: [string, string][] = options.env
			? Object.entries(options.env).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
			: [];

		invoke<{ code: number | null; stdout: string; stderr: string }>("lh_exec_command", {
			cmd: file,
			args,
			env: envList.length > 0 ? envList : undefined,
			timeoutMs: options.timeout,
		})
			.then((res) => {
				if (res.code === 0 || res.code === null) {
					callback?.(null, res.stdout, res.stderr);
				} else {
					const err = new Error(`Command failed with code ${res.code}: ${res.stderr}`);
					(err as any).code = res.code;
					callback?.(err, res.stdout, res.stderr);
				}
			})
			.catch((err) => {
				callback?.(err, "", "");
			});
	},
	exec(..._args: unknown[]) {
		throw new Error("child_process.exec unavailable in Web Worker");
	},
	fork(..._args: unknown[]) {
		throw new Error("child_process.fork unavailable in Web Worker");
	},
};

export const http = {
	createServer(requestListener?: (req: any, res: any) => void) {
		const invoke = getTauriInvoke();
		const listeners = new Map<string, ((...args: any[]) => void)[]>();
		let port = 0;
		let unlisten: (() => void) | undefined;

		const server = {
			on(event: string, fn: (...args: any[]) => void) {
				const list = listeners.get(event) ?? [];
				list.push(fn);
				listeners.set(event, list);
				return this;
			},
			once(event: string, fn: (...args: any[]) => void) {
				const wrapper = (...args: any[]) => {
					this.removeListener(event, wrapper);
					fn(...args);
				};
				return this.on(event, wrapper);
			},
			removeListener(event: string, fn: (...args: any[]) => void) {
				const list = listeners.get(event);
				if (list) {
					listeners.set(event, list.filter((f) => f !== fn));
				}
				return this;
			},
			emit(event: string, ...args: any[]) {
				const list = listeners.get(event);
				if (list) {
					for (const fn of list) {
						try { fn(...args); } catch (e) { console.error(e); }
					}
				}
			},
			address() {
				return { port, family: "IPv4", address: "127.0.0.1" };
			},
			listen(_port?: number, _host?: any, cb?: () => void) {
				const callback = typeof _host === "function" ? _host : cb;
				if (invoke) {
					invoke<number>("lh_oauth_listen_start")
						.then((boundPort) => {
							port = boundPort;
							const tauri = (globalThis as any).__TAURI_INTERNALS__;
							if (typeof tauri?.listen === "function") {
								unlisten = tauri.listen("lh://oauth-request", (event: any) => {
									const payload = event?.payload;
									if (!payload) return;
									const req = {
										method: payload.method,
										url: payload.url,
										headers: Object.fromEntries(payload.headers ?? []),
									};
									let statusCode = 200;
									const responseHeaders: Record<string, string> = {};
									const res = {
										statusCode: 200,
										writeHead(code: number, headers?: Record<string, string>) {
											statusCode = code;
											if (headers) Object.assign(responseHeaders, headers);
											return this;
										},
										setHeader(name: string, value: string) {
											responseHeaders[name.toLowerCase()] = value;
											return this;
										},
										end(body?: string) {
											const bodyStr = body ? String(body) : "";
											invoke("lh_oauth_respond", {
												status: statusCode,
												headers: Object.entries(responseHeaders),
												body: bodyStr,
											}).catch(() => {});
											return this;
										},
									};
									if (requestListener) requestListener(req, res);
									server.emit("request", req, res);
								});
							}
							callback?.();
						})
						.catch((err) => {
							server.emit("error", err);
						});
				} else {
					callback?.();
				}
				return this;
			},
			close(cb?: () => void) {
				unlisten?.();
				if (invoke) {
					invoke("lh_oauth_listen_close")
						.then(() => cb?.())
						.catch(() => cb?.());
				} else {
					cb?.();
				}
				return this;
			},
			closeAllConnections() {
				return this;
			},
		};

		if (requestListener) {
			server.on("request", requestListener);
		}
		return server;
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
