import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer as NodeBuffer } from "node:buffer";
import { mintDictationToken } from "../src/server/stt-token.ts";
import { setHostBridge, createTauriHostBridge } from "../src/worker/host-bridge.ts";
import { dispatchWorkerRequest } from "../src/worker/router.ts";

test("desktop token route sends the grant request through the native bridge", async () => {
	const previous = process.env.DEEPGRAM_API_KEY;
	process.env.DEEPGRAM_API_KEY = "test-key";
	let calls = 0;
	setHostBridge(createTauriHostBridge(async <T>(cmd: string, args?: Record<string, unknown>) => {
		assert.equal(cmd, "lh_http_fetch");
		const req = args?.req as { url: string; method: string; headers: [string, string][]; bodyBase64: string };
		assert.equal(req.url, "https://api.deepgram.com/v1/auth/grant");
		assert.equal(req.method, "POST");
		assert.equal(new Headers(req.headers).get("authorization"), "Token test-key");
		assert.deepEqual(JSON.parse(NodeBuffer.from(req.bodyBase64, "base64").toString()), { ttl_seconds: 300 });
		calls++;
		globalThis.Buffer = NodeBuffer;
		return { status: 200, headers: [["content-type", "application/json"]], bodyBase64: NodeBuffer.from(JSON.stringify({ access_token: "short-token" })).toString("base64") } as T;
	}));
	const request = new Request("http://localhost/api/stt/token");
	const originalBuffer = globalThis.Buffer;
	Reflect.deleteProperty(globalThis, "Buffer");
	try {
		const res = await dispatchWorkerRequest(request);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { token: "short-token" });
		assert.equal(calls, 1);
	} finally {
		globalThis.Buffer = originalBuffer;
		setHostBridge(null);
		if (previous === undefined) delete process.env.DEEPGRAM_API_KEY;
		else process.env.DEEPGRAM_API_KEY = previous;
	}
});

test("native bridge decodes responses without Node Buffer", async () => {
	const originalBuffer = globalThis.Buffer;
	const originalResponse = globalThis.Response;
	const bridge = createTauriHostBridge(async <T>() => ({ status: 200, headers: [], bodyBase64: "aGVsbG8=" }) as T);
	class BrowserResponse {
		constructor(readonly bytes: Uint8Array) {}
	}
	try {
		globalThis.Response = BrowserResponse as unknown as typeof Response;
		Reflect.deleteProperty(globalThis, "Buffer");
		const response = await bridge.nativeFetch("https://example.test") as unknown as BrowserResponse;
		assert.equal(new TextDecoder().decode(response.bytes), "hello");
	} finally {
		globalThis.Buffer = originalBuffer;
		globalThis.Response = originalResponse;
	}
});

test("token helper preserves key and provider error handling", async () => {
	const missing = await mintDictationToken(undefined, async () => { throw new Error("unexpected request"); });
	assert.equal(missing.status, 503);
	const failed = await mintDictationToken("test-key", async () => new Response("denied", { status: 403 }));
	assert.equal(failed.status, 502);
	assert.match((await failed.json()).message, /403/);
});
