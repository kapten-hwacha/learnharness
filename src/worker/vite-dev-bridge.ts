import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { FsMutationOp, HydratedFsSnapshot } from "./host-bridge.ts";

export function isAllowedSyncPath(targetPath: string, dataDir: string, authFile: string): boolean {
	const normTarget = path.posix.normalize(targetPath);
	const normDataDir = path.posix.normalize(dataDir);
	const normAuth = path.posix.normalize(authFile);

	if (normTarget === normAuth) return true;
	const dataDirPrefix = normDataDir.endsWith("/") ? normDataDir : normDataDir + "/";
	return normTarget.startsWith(dataDirPrefix);
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
						if (!fs.existsSync(filePath)) {
							res.statusCode = 404;
							res.end("Not Found");
							return;
						}
						const data = fs.readFileSync(filePath);
						res.setHeader("Content-Type", "application/octet-stream");
						res.statusCode = 200;
						res.end(data);
					} catch (err) {
						res.statusCode = 500;
						res.end(String(err));
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

						const response = await fetch(targetUrl, {
							method: method || "GET",
							headers,
							body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
						});

						res.statusCode = response.status;
						response.headers.forEach((value, key) => {
							res.setHeader(key, value);
						});

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
