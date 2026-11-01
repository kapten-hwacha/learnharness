import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { CLIPROXY_PROVIDER } from "../src/core/contracts/cliproxy.ts";
import { parseCliProxySettingsBody } from "../src/server/settings-body.ts";
import { settingsStore } from "../src/store/settings.ts";
import { piModels, piEngineForSpec } from "../src/agent/models.ts";
import { modelCatalog } from "../src/server/model-catalog.ts";
import { ensureCliProxyRunning, isPortListening } from "../src/server/cliproxy-process.ts";

describe("CLIProxyAPI first-class provider", () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cliproxy-first-class-test-"));
	const originalEnv = { ...process.env };

	before(() => {
		process.env.LH_DATA_DIR = scratch;
		process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
		fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
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

	it("provider registration in piModels() reflects enabled vs disabled", () => {
		// When disabled
		settingsStore.writeSettings({ version: 1, cliproxy: { enabled: false } });
		let models = piModels();
		assert.equal(models.getProvider(CLIPROXY_PROVIDER), undefined);

		// When enabled
		settingsStore.writeSettings({ version: 1, cliproxy: { enabled: true } });
		models = piModels();
		const provider = models.getProvider(CLIPROXY_PROVIDER);
		assert.ok(provider, "cliproxy provider must be registered when enabled");
		assert.equal(provider.id, CLIPROXY_PROVIDER);

		const flash = models.getModel(CLIPROXY_PROVIDER, "gemini-3.8-flash");
		const argon = models.getModel(CLIPROXY_PROVIDER, "gemini-4-argon");
		assert.ok(flash, "gemini-3.8-flash model must exist");
		assert.ok(argon, "gemini-4-argon model must exist");

		// When disabled again
		settingsStore.writeSettings({ version: 1, cliproxy: { enabled: false } });
		models = piModels();
		assert.equal(models.getProvider(CLIPROXY_PROVIDER), undefined);
	});

	it("model catalog lists gemini-3.8-flash and gemini-4-argon when enabled", () => {
		settingsStore.writeSettings({ version: 1, cliproxy: { enabled: true } });
		const catalog = modelCatalog();

		const providerKey = catalog.providers.find((p) => p.id === CLIPROXY_PROVIDER);
		assert.ok(providerKey, "cliproxy must be listed in catalog providers");
		assert.equal(providerKey.keyPresent, true);

		const cliproxyModels = catalog.models.filter((m) => m.provider === CLIPROXY_PROVIDER);
		const ids = cliproxyModels.map((m) => m.id).sort();
		assert.deepEqual(ids, ["gemini-3.8-flash", "gemini-4-argon"]);
	});

	it("streams a completion using piEngineForSpec with cliproxy provider", async () => {
		settingsStore.writeSettings({ version: 1, cliproxy: { enabled: true } });
		const running = await ensureCliProxyRunning();
		if (!running.ok || !(await isPortListening())) {
			console.warn("Skipping live stream test: CLIProxyAPI service is not listening on port 8317");
			return;
		}

		const engine = piEngineForSpec({
			provider: CLIPROXY_PROVIDER,
			id: "gemini-3.8-flash",
			thinkingLevel: "high",
		});

		const messages: Message[] = [
			{ role: "user", content: "What is 15 + 27? Answer with only the number.", timestamp: Date.now() },
		];
		const context = normalizeContext({ messages });

		const stream = engine.streamFn(engine.model, context, {});
		let responseText = "";
		let thinkingText = "";

		for await (const event of stream) {
			if (event.type === "thinking_delta") {
				thinkingText += (event as { delta?: string }).delta ?? "";
			} else if (event.type === "text_delta") {
				responseText += (event as { delta?: string }).delta ?? "";
			}
		}

		const result = await stream.result();
		console.log("Stop reason:", result.stopReason);
		console.log("Response text:", responseText);
		console.log("Thinking text:", thinkingText);

		assert.equal(result.stopReason, "stop");
		assert.match(responseText, /42/);
	});
});
