import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { CLIPROXY_PROVIDER } from "../src/core/contracts/cliproxy.ts";
import { parseCliProxySettingsBody } from "../src/server/settings-body.ts";
import { settingsStore } from "../src/store/settings.ts";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { modelCatalog } from "../src/server/model-catalog.ts";
import { isPortListening } from "../src/server/cliproxy-process.ts";
import { resetMemoryStores } from "../src/store/memory-backend.ts";
import { refreshCliproxyEnabled } from "../src/server/cliproxy-config.ts";

describe("CLIProxyAPI first-class provider", () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cliproxy-first-class-test-"));
	const originalEnv = { ...process.env };

	before(() => {
		process.env.LH_DATA_DIR = scratch;
		process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
		fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
	});

	beforeEach(() => {
		resetMemoryStores();
	});

	after(() => {
		fs.rmSync(scratch, { recursive: true, force: true });
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	it("parses cliproxy settings body", () => {
		assert.deepEqual(parseCliProxySettingsBody({ enabled: true }), {
			ok: true,
			settings: { enabled: true },
		});
		assert.deepEqual(parseCliProxySettingsBody({ enabled: false }), {
			ok: true,
			settings: { enabled: false },
		});
		assert.deepEqual(parseCliProxySettingsBody({}), {
			ok: true,
			settings: {},
		});
		assert.equal(parseCliProxySettingsBody({ enabled: "true" }).ok, false);
		assert.equal(parseCliProxySettingsBody(null).ok, false);
	});

	it("provider registration in piModels() reflects enabled vs disabled", async () => {
		// When disabled
		await settingsStore.writeSettings({ version: 1, cliproxy: { enabled: false } });
		await refreshCliproxyEnabled();
		let models = piModels();
		assert.equal(models.getProvider(CLIPROXY_PROVIDER), undefined);

		// When enabled
		await settingsStore.writeSettings({ version: 1, cliproxy: { enabled: true } });
		await refreshCliproxyEnabled();
		models = piModels();
		const provider = models.getProvider(CLIPROXY_PROVIDER);
		assert.ok(provider, "cliproxy provider must be registered when enabled");
		assert.equal(provider.id, CLIPROXY_PROVIDER);

		const flash = models.getModel(CLIPROXY_PROVIDER, "gemini-3.8-flash");
		const argon = models.getModel(CLIPROXY_PROVIDER, "gemini-4-argon");
		assert.ok(flash, "gemini-3.8-flash model must exist");
		assert.ok(argon, "gemini-4-argon model must exist");

		// When disabled again
		await settingsStore.writeSettings({ version: 1, cliproxy: { enabled: false } });
		await refreshCliproxyEnabled();
		models = piModels();
		assert.equal(models.getProvider(CLIPROXY_PROVIDER), undefined);
	});

	it("model catalog lists gemini-3.8-flash and gemini-4-argon when enabled", async () => {
		await settingsStore.writeSettings({ version: 1, cliproxy: { enabled: true } });
		await refreshCliproxyEnabled();
		const catalog = await modelCatalog();

		const providerKey = catalog.providers.find((p) => p.id === CLIPROXY_PROVIDER);
		assert.ok(providerKey, "cliproxy must be listed in catalog providers");
		assert.equal(providerKey.keyPresent, true);

		const cliproxyModels = catalog.models.filter((m) => m.provider === CLIPROXY_PROVIDER);
		const ids = cliproxyModels.map((m) => m.id).sort();
		assert.deepEqual(ids, ["gemini-3.8-flash", "gemini-4-argon"]);
	});

	it("streams a completion using piEngineForSpec with cliproxy provider", async () => {
		await settingsStore.writeSettings({ version: 1, cliproxy: { enabled: true } });
		await refreshCliproxyEnabled();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/chat/completions")) {
				const chunks = [
					"data: " + JSON.stringify({ id: "chunk-1", choices: [{ delta: { reasoning_content: "Thinking..." }, finish_reason: null }] }) + "\n\n",
					"data: " + JSON.stringify({ id: "chunk-2", choices: [{ delta: { content: "42" }, finish_reason: null }] }) + "\n\n",
					"data: " + JSON.stringify({ id: "chunk-3", choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n",
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

		try {
			const engine = piEngineForSpec({
				provider: CLIPROXY_PROVIDER,
				id: "gemini-3.8-flash",
				thinkingLevel: "high",
			});

			const messages: Message[] = [
				{ role: "user", content: "What is 6 * 7?", timestamp: Date.now() },
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
			assert.equal(result.stopReason, "stop");
			assert.equal(responseText, "42");
			assert.equal(thinkingText, "Thinking...");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("isPortListening correctly identifies when port is listening vs not", async () => {
		// Port 0 / invalid should not be listening
		const notListening = await isPortListening(0);
		assert.equal(notListening, false);
	});
});
