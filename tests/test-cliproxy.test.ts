import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildOpenAiCompatibleProvider,
	discoverModels,
	installCustomProviderSource,
} from "../src/server/custom-provider.ts";
import { customProviderGet, customProviderMutation } from "../src/server/custom-provider-http.ts";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { CUSTOM_PROVIDER } from "../src/core/auth-keys.ts";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";

describe("CLIProxyAPI integration", () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cliproxy-test-"));
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;

	before(() => {
		process.env.LH_DATA_DIR = scratch;
		process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
		fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
		installCustomProviderSource();

		globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/models")) {
				return new Response(JSON.stringify({
					object: "list",
					data: [
						{ id: "gemini-3.8-flash", object: "model" },
						{ id: "gemini-4-argon", object: "model" },
					],
				}), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("/chat/completions")) {
				const chunks = [
					"data: " + JSON.stringify({ id: "chunk-1", choices: [{ delta: { reasoning_content: "Calculating 17 * 4..." }, finish_reason: null }] }) + "\n\n",
					"data: " + JSON.stringify({ id: "chunk-2", choices: [{ delta: { content: "68" }, finish_reason: null }] }) + "\n\n",
					"data: " + JSON.stringify({
						id: "chunk-3",
						choices: [{ delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } },
					}) + "\n\n",
					"data: [DONE]\n\n",
				];
				const encoder = new TextEncoder();
				const stream = new ReadableStream({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return originalFetch(input, init);
		};
	});

	after(() => {
		globalThis.fetch = originalFetch;
		piModels().deleteProvider(CUSTOM_PROVIDER.id);
		fs.rmSync(scratch, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it("discovers models from local CLIProxyAPI", async () => {
		const res = await discoverModels("http://127.0.0.1:8317/v1", "lh-proxy-key");
		assert.equal(res.ok, true);
		if (!res.ok) return;

		const ids = res.models.map((m) => m.id);
		console.log("Discovered models:", ids);
		assert.deepEqual(ids.sort(), ["gemini-3.8-flash", "gemini-4-argon"].sort());
	});

	it("connects via server API (customProviderMutation) to http://127.0.0.1:8317/v1 with key", async () => {
		const getReq = new Request("http://localhost:3000/api/custom-provider", {
			headers: { origin: "http://localhost:3000", host: "localhost:3000" },
		});
		const getRes = customProviderGet(getReq);
		assert.equal(getRes.status, 200);
		const etag = getRes.headers.get("etag")!;
		assert.ok(etag, "GET must return an etag");

		const postReq = new Request("http://localhost:3000/api/custom-provider", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				host: "localhost:3000",
				"if-match": etag,
			},
			body: JSON.stringify({
				baseUrl: "http://127.0.0.1:8317/v1",
				authMode: "apiKey",
				key: "lh-proxy-key",
			}),
		});

		const postRes = await customProviderMutation(postReq);
		const body = await postRes.json();
		console.log("POST /api/custom-provider response status:", postRes.status, body);
		assert.equal(postRes.status, 200);
		assert.equal(body.ok, true);
		assert.ok(Array.isArray(body.models));
		assert.ok(body.models.some((m: any) => m.id === "gemini-3.8-flash"));

		// Verify GET returns updated configuration
		const getAfterReq = new Request("http://localhost:3000/api/custom-provider", {
			headers: { origin: "http://localhost:3000", host: "localhost:3000" },
		});
		const getAfterRes = customProviderGet(getAfterReq);
		const afterBody = await getAfterRes.json();
		assert.equal(afterBody.baseUrl, "http://127.0.0.1:8317/v1");
		assert.equal(afterBody.authMode, "apiKey");
		assert.equal(afterBody.keyPresent, true);

		// Verify custom provider was automatically registered into piModels
		const customProvider = piModels().getProvider(CUSTOM_PROVIDER.id);
		assert.ok(customProvider, "custom provider must be registered in piModels()");
		const registeredModel = piModels().getModel(CUSTOM_PROVIDER.id, "gemini-3.8-flash");
		assert.ok(registeredModel, "gemini-3.8-flash must be available in piModels()");
	});

	it("streams a completion for gemini-3.8-flash via the server-configured custom provider", async () => {
		// Set pin for reasoning on gemini-3.8-flash via PATCH
		const getReq = new Request("http://localhost:3000/api/custom-provider", {
			headers: { origin: "http://localhost:3000", host: "localhost:3000" },
		});
		const etag = customProviderGet(getReq).headers.get("etag")!;

		const patchReq = new Request("http://localhost:3000/api/custom-provider", {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				host: "localhost:3000",
				"if-match": etag,
			},
			body: JSON.stringify({
				overrides: {
					"gemini-3.8-flash": { reasoning: true },
				},
			}),
		});
		const patchRes = await customProviderMutation(patchReq);
		assert.equal(patchRes.status, 200);

		// Now stream through piEngineForSpec using the live custom provider
		const engine = piEngineForSpec({
			provider: CUSTOM_PROVIDER.id,
			id: "gemini-3.8-flash",
			thinkingLevel: "high",
		});

		const messages: Message[] = [
			{ role: "user", content: "What is 17 * 4? Give only the number.", timestamp: Date.now() },
		];
		const context = normalizeContext({ messages });

		const stream = engine.streamFn(engine.model, context, {});
		let responseText = "";
		let thinkingText = "";

		for await (const event of stream) {
			if (event.type === "thinking_delta") {
				thinkingText += (event as any).delta ?? "";
			} else if (event.type === "text_delta") {
				responseText += (event as any).delta ?? "";
			}
		}

		const result = await stream.result();
		console.log("Live stream stopReason:", result.stopReason);
		console.log("Live stream text:", responseText || result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
		console.log("Live stream thinking:", thinkingText || result.content?.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join(""));
		console.log("Live stream usage:", result.usage);

		assert.equal(result.stopReason, "stop");
		assert.ok(result.usage && result.usage.totalTokens > 0);
		assert.ok(result.usage?.reasoning && result.usage.reasoning > 0);
	});
});
