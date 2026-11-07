import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { FsMutationOp, HydratedFsSnapshot } from "./host-bridge.ts";
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

function collectDirFiles(dir: string, baseDir: string, files: Record<string, string>, dirs: string[]) {
	if (!fs.existsSync(dir)) return;
	dirs.push(path.posix.normalize(dir));
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const posixPath = path.posix.normalize(fullPath);
		if (entry.isDirectory()) {
			collectDirFiles(fullPath, baseDir, files, dirs);
		} else if (entry.isFile()) {
			try {
				const content = fs.readFileSync(fullPath);
				files[posixPath] = content.toString("base64");
			} catch {
				// Ignore unreadable files
			}
		}
	}
}

export function lhViteDevBridgePlugin(): Plugin {
	return {
		name: "lh-vite-dev-bridge",
		configureServer(server) {
			const root = path.posix.normalize(process.cwd());
			const dataDir = path.posix.normalize(process.env.LH_DATA_DIR || path.resolve(root, "data"));
			const authFile = path.posix.normalize(process.env.LH_AUTH_FILE || path.resolve(root, "auth.json"));

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

				if (url === "/__lh_dev/fs-hydrate" && req.method === "GET") {
					try {
						const files: Record<string, string> = {};
						const dirs: string[] = [];

						collectDirFiles(dataDir, dataDir, files, dirs);

						if (fs.existsSync(authFile)) {
							files[authFile] = fs.readFileSync(authFile).toString("base64");
						}

						const candidatePaths = [
							path.resolve(root, "package.json"),
							path.resolve(root, "src/agent/system-prompt.md"),
							path.resolve(root, "src/agent/prompts"),
							path.resolve(root, "skills"),
						];

						for (const p of candidatePaths) {
							if (fs.existsSync(p)) {
								const stat = fs.statSync(p);
								if (stat.isDirectory()) {
									collectDirFiles(p, p, files, dirs);
								} else {
									files[path.posix.normalize(p)] = fs.readFileSync(p).toString("base64");
								}
							}
						}

						const snapshot: HydratedFsSnapshot = {
							root,
							dataDir,
							authFile,
							homeDir: os.homedir(),
							files,
							dirs,
						};

						res.setHeader("Content-Type", "application/json");
						res.statusCode = 200;
						res.end(JSON.stringify(snapshot));
					} catch (err) {
						res.statusCode = 500;
						res.end(JSON.stringify({ error: String(err) }));
					}
					return;
				}

				if (url === "/__lh_dev/fs-sync" && req.method === "POST") {
					try {
						const bodyStr = await readBody(req);
						const op = JSON.parse(bodyStr) as FsMutationOp;

						const pathsToCheck: string[] = [];
						if ("path" in op) pathsToCheck.push(op.path);
						if ("oldPath" in op) pathsToCheck.push(op.oldPath);
						if ("newPath" in op) pathsToCheck.push(op.newPath);

						for (const p of pathsToCheck) {
							if (!isAllowedSyncPath(p, dataDir, authFile)) {
								res.statusCode = 403;
								res.setHeader("Content-Type", "application/json");
								res.end(JSON.stringify({ error: `Forbidden path: ${p}` }));
								return;
							}
						}

						switch (op.type) {
							case "writeFile": {
								fs.mkdirSync(path.dirname(op.path), { recursive: true });
								fs.writeFileSync(op.path, Buffer.from(op.dataBase64, "base64"), { mode: op.mode });
								break;
							}
							case "appendFile": {
								fs.mkdirSync(path.dirname(op.path), { recursive: true });
								fs.appendFileSync(op.path, Buffer.from(op.dataBase64, "base64"), { mode: op.mode });
								break;
							}
							case "rename": {
								fs.mkdirSync(path.dirname(op.newPath), { recursive: true });
								fs.renameSync(op.oldPath, op.newPath);
								break;
							}
							case "unlink": {
								if (fs.existsSync(op.path)) fs.unlinkSync(op.path);
								break;
							}
							case "mkdir": {
								fs.mkdirSync(op.path, { recursive: op.recursive, mode: op.mode });
								break;
							}
							case "rm": {
								if (fs.existsSync(op.path)) fs.rmSync(op.path, { recursive: op.recursive, force: op.force });
								break;
							}
						}

						res.setHeader("Content-Type", "application/json");
						res.statusCode = 200;
						res.end(JSON.stringify({ ok: true }));
					} catch (err) {
						res.statusCode = 500;
						res.end(JSON.stringify({ error: String(err) }));
					}
					return;
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
