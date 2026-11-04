import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { describe, it } from "node:test";
import { getHostBridge, setHostBridge, type FsMutationOp } from "../src/worker/host-bridge.ts";
import * as memfs from "../src/worker/shims/fs.ts";
import * as memfsPromises from "../src/worker/shims/fs-promises.ts";
import * as shimCrypto from "../src/worker/shims/crypto.ts";
import * as shimPath from "../src/worker/shims/path.ts";
import { AsyncLocalStorage } from "../src/worker/shims/async_hooks.ts";
import {
	childProcess,
	http,
	net,
	os,
	readline,
	url,
	util,
	workerThreads,
} from "../src/worker/shims/node-stubs.ts";

describe("Worker write-through memfs & node:* shims", () => {
	it("normalizes '..' paths, supports atomic renameSync overwrite, lists Dirents, and flushes ordered FsMutationOps", async () => {
		const ops: FsMutationOp[] = [];
		setHostBridge({
			hydrateFs: async () => ({ root: "/app", dataDir: "/app/data", authFile: "/app/auth.json", files: {}, dirs: ["/app/data"] }),
			syncFs: async (op) => { ops.push(op); },
			readExternalFile: async (p) => new TextEncoder().encode(`external:${p}`),
			nativeFetch: (input, init) => fetch(input, init),
		});
		memfs.hydrateMemfs({
			root: "/app",
			dataDir: "/app/data",
			authFile: "/app/auth.json",
			files: { "/app/data/settings.json": Buffer.from('{"v":1}').toString("base64") },
			dirs: ["/app/data", "/app/data/chats"],
		});

		assert.equal(memfs.readFileSync("/app/data/chats/../settings.json", "utf8"), '{"v":1}');
		memfs.writeFileSync("/app/data/settings.json.tmp", '{"v":2}');
		memfs.renameSync("/app/data/settings.json.tmp", "/app/data/settings.json");
		assert.equal(memfs.existsSync("/app/data/settings.json.tmp"), false);
		assert.equal(memfs.readFileSync("/app/data/settings.json", "utf8"), '{"v":2}');

		const entries = memfs.readdirSync("/app/data", { withFileTypes: true });
		assert.deepEqual(
			entries.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() })),
			[
				{ name: "chats", dir: true, file: false },
				{ name: "settings.json", dir: false, file: true },
			],
		);

		await memfs.flushFsQueue();
		assert.deepEqual(ops.map((o) => o.type), ["writeFile", "rename"]);

		const ext = await memfsPromises.readFile("/Users/demo/notes.pdf");
		assert.equal(new TextDecoder().decode(ext), "external:/Users/demo/notes.pdf");
	});

	it("provides synchronous SHA-256 createHash/createHmac and AsyncLocalStorage context propagation", async () => {
		const digest = shimCrypto.createHash("sha256").update("learnharness").digest("hex");
		const expectedHash = nodeCrypto.createHash("sha256").update("learnharness").digest("hex");
		assert.equal(digest, expectedHash);
		assert.equal(digest, "65093e11f1dd950b15f073de0b03a43a6ed61b4cd2e07b001a3dc8b28ea0bb69");

		// Multi-chunk hashing
		const multiHash = shimCrypto.createHash("sha256").update("learn").update("harness").digest("hex");
		assert.equal(multiHash, expectedHash);

		const hmac = shimCrypto.createHmac("sha256", "secret-key").update("payload").digest("hex");
		const expectedHmac = nodeCrypto.createHmac("sha256", "secret-key").update("payload").digest("hex");
		assert.equal(hmac, expectedHmac);

		const rand = shimCrypto.randomBytes(16);
		assert.equal(rand.length, 16);

		const uuid = shimCrypto.randomUUID();
		assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

		const bufA = new Uint8Array([1, 2, 3]);
		const bufB = new Uint8Array([1, 2, 3]);
		const bufC = new Uint8Array([1, 2, 4]);
		assert.equal(shimCrypto.timingSafeEqual(bufA, bufB), true);
		assert.equal(shimCrypto.timingSafeEqual(bufA, bufC), false);

		const als = new AsyncLocalStorage<string>();
		const seen = await als.run("run-42", async () => {
			await Promise.resolve();
			return als.getStore();
		});
		assert.equal(seen, "run-42");

		// Nested AsyncLocalStorage runs
		const nested = await als.run("outer", async () => {
			const inner = await als.run("inner", async () => als.getStore());
			return { inner, outer: als.getStore() };
		});
		assert.deepEqual(nested, { inner: "inner", outer: "outer" });
		assert.equal(als.getStore(), undefined);
	});

	it("supports fs.promises.open with read() and close(), caching external files", async () => {
		setHostBridge({
			hydrateFs: async () => ({ root: "/app", dataDir: "/app/data", authFile: "/app/auth.json", files: {}, dirs: ["/app/data"] }),
			syncFs: async () => {},
			readExternalFile: async (p) => new TextEncoder().encode(`file-data-for:${p}`),
			nativeFetch: (input, init) => fetch(input, init),
		});
		memfs.hydrateMemfs({
			root: "/app",
			dataDir: "/app/data",
			authFile: "/app/auth.json",
			files: {},
			dirs: ["/app/data"],
		});

		const fh = await memfsPromises.open("/external/file.txt", "r");
		const buf = new Uint8Array(9);
		const { bytesRead } = await fh.read(buf, 0, 9, 0);
		assert.equal(bytesRead, 9);
		assert.equal(new TextDecoder().decode(buf), "file-data");
		await fh.close();
		assert.equal(memfs.existsSync("/external/file.txt"), true);
	});

	it("implements comprehensive POSIX path operations", () => {
		assert.equal(shimPath.join("/a", "b", "c"), "/a/b/c");
		assert.equal(shimPath.join("/a", "../b", "c"), "/b/c");
		assert.equal(shimPath.resolve("a", "b"), "/a/b");
		assert.equal(shimPath.resolve("/x", "y"), "/x/y");
		assert.equal(shimPath.dirname("/a/b/c.txt"), "/a/b");
		assert.equal(shimPath.dirname("/"), "/");
		assert.equal(shimPath.basename("/a/b/c.txt"), "c.txt");
		assert.equal(shimPath.basename("/a/b/c.txt", ".txt"), "c");
		assert.equal(shimPath.extname("file.test.ts"), ".ts");
		assert.equal(shimPath.extname(".gitignore"), "");
		assert.equal(shimPath.isAbsolute("/foo"), true);
		assert.equal(shimPath.isAbsolute("foo"), false);
		assert.equal(shimPath.relative("/a/b", "/a/b/c/d"), "c/d");
		assert.equal(shimPath.relative("/a/b/c", "/a/d"), "../../d");
		const parsed = shimPath.parse("/path/to/file.ext");
		assert.deepEqual(parsed, { root: "/", dir: "/path/to", base: "file.ext", ext: ".ext", name: "file" });
		assert.equal(shimPath.format(parsed), "/path/to/file.ext");
		assert.equal(shimPath.sep, "/");
		assert.equal(shimPath.delimiter, ":");
	});

	it("implements extended memfs operations: append, mkdir, rm, stat, chmod", async () => {
		memfs.hydrateMemfs({
			root: "/app",
			dataDir: "/app/data",
			authFile: "/app/auth.json",
			files: {},
			dirs: ["/app"],
		});

		memfs.mkdirSync("/app/nested/dir", { recursive: true });
		assert.equal(memfs.existsSync("/app/nested/dir"), true);

		memfs.appendFileSync("/app/log.txt", "line 1\n");
		memfs.appendFileSync("/app/log.txt", "line 2\n");
		assert.equal(memfs.readFileSync("/app/log.txt", "utf8"), "line 1\nline 2\n");

		const st = memfs.statSync("/app/log.txt");
		assert.equal(st.isFile(), true);
		assert.equal(st.isDirectory(), false);
		assert.equal(st.size, 14);

		memfs.chmodSync("/app/log.txt", 0o600);
		assert.equal(memfs.realpathSync("/app/log.txt"), "/app/log.txt");

		const tempDir = memfs.mkdtempSync("/app/temp-");
		assert.equal(memfs.existsSync(tempDir), true);

		memfs.rmSync(tempDir, { recursive: true });
		assert.equal(memfs.existsSync(tempDir), false);

		memfs.unlinkSync("/app/log.txt");
		assert.equal(memfs.existsSync("/app/log.txt"), false);
	});

	it("provides browser-safe node:* shims (os, url, util, worker_threads, child_process, http, net, readline)", () => {
		assert.equal(os.tmpdir(), "/tmp");
		assert.equal(os.homedir(), "/home");
		assert.equal(os.platform(), "browser");
		assert.equal(os.EOL, "\n");

		assert.equal(url.fileURLToPath("file:///usr/local/bin"), "/usr/local/bin");
		assert.equal(url.pathToFileURL("/usr/local/bin").href, "file:///usr/local/bin");

		assert.equal(util.isDeepStrictEqual({ a: 1, b: [2] }, { a: 1, b: [2] }), true);
		assert.equal(util.isDeepStrictEqual({ a: 1 }, { a: 2 }), false);
		assert.equal(util.format("Hello %s %d", "world", 42), "Hello world 42");

		assert.throws(() => new workerThreads.Worker("foo.js"), /worker_threads unavailable in Web Worker/);
		assert.throws(() => childProcess.spawn("ls"), /child_process.spawn unavailable in Web Worker/);
		assert.throws(() => childProcess.execSync("ls"), /child_process.execSync unavailable in Web Worker/);

		const server = http.createServer();
		assert.equal(typeof server.listen, "function");

		const netServer = net.createServer();
		assert.equal(typeof netServer.address, "function");

		const rl = readline.createInterface();
		assert.equal(typeof rl.question, "function");

		const defaultBridge = getHostBridge();
		assert.equal(typeof defaultBridge.hydrateFs, "function");
	});
});
