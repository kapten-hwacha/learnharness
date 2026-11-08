import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { describe, it } from "node:test";
import { getHostBridge } from "../src/worker/host-bridge.ts";
import * as shimCrypto from "../src/worker/shims/crypto.ts";
import * as shimFs from "../src/worker/shims/fs.ts";
import * as shimFsPromises from "../src/worker/shims/fs-promises.ts";
import * as shimPath from "../src/worker/shims/path.ts";
import { AsyncLocalStorage } from "../src/worker/shims/async_hooks.ts";
import {
	childProcess,
	http,
	net,
	os,
	readline,
	setWorkerHomeDir,
	url,
	util,
	workerThreads,
} from "../src/worker/shims/node-stubs.ts";

describe("Worker node:* shims & runtime bridge", () => {
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
		assert.equal(typeof defaultBridge.initRuntime, "function");
	});

	it("provides browser-safe node:fs and node:fs/promises stubs", async () => {
		assert.equal(shimFs.existsSync("/test"), false);
		assert.deepEqual(shimFs.readdirSync(), []);
		assert.equal(shimFs.constants.R_OK, 4);
		assert.equal(shimFs.realpathSync("/var/data"), "/var/data");
		assert.throws(() => shimFs.readFileSync(), /fs is not supported in browser\/worker runtime/);

		assert.deepEqual(await shimFs.promises.readdir(), []);
		assert.deepEqual(await shimFsPromises.readdir(), []);
		assert.equal(await shimFsPromises.realpath("/var/data"), "/var/data");
		await assert.rejects(
			async () => shimFsPromises.readFile(),
			/fs\/promises is not supported in browser\/worker runtime/
		);
	});

	it("updates os.homedir() via setWorkerHomeDir", () => {
		try {
			setWorkerHomeDir("/Users/alice");
			assert.equal(os.homedir(), "/Users/alice");
			assert.equal(os.userInfo().homedir, "/Users/alice");
		} finally {
			setWorkerHomeDir("/home");
			assert.equal(os.homedir(), "/home");
		}
	});
});
