import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { realSourcePath, resolvePolicy } from "../agent/tools/file-access.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { fileAccessPolicy } from "../server/file-access.ts";

export function isAuthorizedDevBridgeRequest(req: IncomingMessage): boolean {
	if (req.headers["x-lh-dev-bridge"] !== "1") {
		return false;
	}
	const secFetchSite = req.headers["sec-fetch-site"];
	if (typeof secFetchSite === "string") {
		if (secFetchSite !== "same-origin" && secFetchSite !== "none") {
			return false;
		}
	}
	const origin = req.headers["origin"];
	const host = req.headers["host"];
	if (typeof origin === "string" && typeof host === "string") {
		try {
			const parsed = new URL(origin);
			if (parsed.host !== host) {
				return false;
			}
		} catch {
			return false;
		}
	}
	if (req.method === "POST") {
		const contentType = req.headers["content-type"];
		if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
			return false;
		}
	}
	return true;
}

export function isAllowedSyncPath(targetPath: string, dataDir: string, authFile: string): boolean {
	if (!targetPath || !targetPath.startsWith("/")) return false;
	const normTarget = path.posix.normalize(targetPath);
	const normDataDir = path.posix.normalize(dataDir);
	const normAuth = path.posix.normalize(authFile);

	const dataDirPrefix = normDataDir.endsWith("/") ? normDataDir : normDataDir + "/";
	const lexicalAllowed = normTarget === normAuth || normTarget === normDataDir || normTarget.startsWith(dataDirPrefix);
	if (!lexicalAllowed) return false;

	if (fs.existsSync(dataDir) || fs.existsSync(path.dirname(authFile))) {
		try {
			const realTarget = realSourcePath(targetPath);
			const realDataDir = realSourcePath(dataDir);
			const realAuthFile = realSourcePath(authFile);
			const dataDirRealPrefix = realDataDir.endsWith(path.sep) ? realDataDir : realDataDir + path.sep;
			return realTarget === realAuthFile || realTarget === realDataDir || realTarget.startsWith(dataDirRealPrefix);
		} catch {
			return false;
		}
	}

	return true;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

const FS_MODULE_IDS = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"]);
const VIRTUAL_FS_ID = "\0virtual:lh-fs-stub";

const VIRTUAL_FS_CODE = `
export const existsSync = () => false;
export const readdirSync = () => [];
export const readFileSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const writeFileSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const mkdirSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const rmSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const unlinkSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const statSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const lstatSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const realpathSync = (p) => p;
realpathSync.native = realpathSync;
export const openSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const readSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const closeSync = () => {};
export const chmodSync = () => {};
export const renameSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const accessSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const appendFileSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };
export const mkdtempSync = () => { throw new Error("fs is not supported in browser/worker runtime"); };

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export const readFile = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const writeFile = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const mkdir = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const rm = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const stat = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const readdir = async () => [];
export const open = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const unlink = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const rename = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const appendFile = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const access = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const realpath = async (p) => p;
export const lstat = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };
export const chmod = async () => {};
export const mkdtemp = async () => { throw new Error("fs/promises is not supported in browser/worker runtime"); };

export const promises = {
	readFile,
	writeFile,
	mkdir,
	rm,
	stat,
	readdir,
	open,
	unlink,
	rename,
	appendFile,
	access,
	realpath,
	lstat,
	chmod,
	mkdtemp,
};

const defaultExport = {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	unlinkSync,
	readdirSync,
	statSync,
	lstatSync,
	realpathSync,
	openSync,
	readSync,
	closeSync,
	chmodSync,
	renameSync,
	accessSync,
	appendFileSync,
	mkdtempSync,
	constants,
	promises,
	readFile,
	writeFile,
	mkdir,
	rm,
	stat,
	readdir,
	open,
	unlink,
	rename,
	appendFile,
	access,
	realpath,
	lstat,
	chmod,
	mkdtemp,
};

export default defaultExport;
`;

export function lhViteDevBridgePlugin(): Plugin {
	return {
		name: "lh-vite-dev-bridge",
		enforce: "pre",
		resolveId(id) {
			if (FS_MODULE_IDS.has(id)) {
				return VIRTUAL_FS_ID;
			}
		},
		load(id) {
			if (id === VIRTUAL_FS_ID) {
				return VIRTUAL_FS_CODE;
			}
		},
		configureServer(server) {
			server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
				const url = req.url?.split("?")[0];

				if (url?.startsWith("/__lh_dev/")) {
					if (!isAuthorizedDevBridgeRequest(req)) {
						res.statusCode = 403;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Forbidden dev bridge request" }));
						return;
					}
				}

				if (url === "/__lh_dev/fs-read-external" && req.method === "POST") {
					try {
						const bodyStr = await readBody(req);
						const { path: filePath } = JSON.parse(bodyStr) as { path: string };
						let resolved: string;
						try {
							resolved = resolveSourcePath(filePath, resolvePolicy(fileAccessPolicy()));
							if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
								res.statusCode = 403;
								res.setHeader("Content-Type", "application/json");
								res.end(JSON.stringify({ error: `Path is not a valid file: ${filePath}` }));
								return;
							}
						} catch (valErr) {
							res.statusCode = 403;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ error: String(valErr) }));
							return;
						}

						const data = fs.readFileSync(resolved);
						res.setHeader("Content-Type", "application/octet-stream");
						res.statusCode = 200;
						res.end(data);
					} catch (err) {
						res.statusCode = 500;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: String(err) }));
					}
					return;
				}

				if (url === "/__lh_dev/fetch" && req.method === "POST") {
					try {
						const bodyStr = await readBody(req);
						const { url: targetUrl, method, headers, body } = JSON.parse(bodyStr) as {
							url: string;
							method?: string;
							headers?: Record<string, string>;
							body?: string;
						};

						let parsed: URL;
						try {
							parsed = new URL(targetUrl);
						} catch {
							res.statusCode = 400;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ error: "Invalid URL" }));
							return;
						}

						if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
							res.statusCode = 403;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ error: `Forbidden protocol: ${parsed.protocol}` }));
							return;
						}

						const hostname = parsed.hostname.toLowerCase();
						if (
							hostname === "169.254.169.254" ||
							hostname === "metadata.google.internal" ||
							hostname === "0.0.0.0" ||
							hostname.startsWith("169.254.") ||
							hostname === "[::]" ||
							hostname.startsWith("[fe80:")
						) {
							res.statusCode = 403;
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ error: `Forbidden host: ${hostname}` }));
							return;
						}

						const response = await fetch(targetUrl, {
							method: method || "GET",
							headers,
							body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
						});

						res.statusCode = response.status;
						response.headers.forEach((value, key) => {
							res.setHeader(key, value);
						});
						res.setHeader("x-lh-dev-proxied", "1");

						if (response.body) {
							const reader = response.body.getReader();
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								res.write(value);
							}
							res.end();
						} else {
							res.end();
						}
					} catch (err) {
						res.statusCode = 502;
						res.end(String(err));
					}
					return;
				}

				next();
			});
		},
	};
}

export const viteDevBridge = lhViteDevBridgePlugin;
