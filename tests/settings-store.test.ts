/**
 * Tests for the settings STORE:
 * src/store/settings.ts — settings adapter with in-memory test backend.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { readSettings, writeSettings } from "../src/store/settings.ts";
import { resetMemoryStores, setCorruptMemoryKv, setRawMemoryKv } from "../src/store/memory-backend.ts";

beforeEach(() => {
	resetMemoryStores();
});

describe("the settings store", () => {
	it("reads null on first boot (no record)", async () => {
		assert.equal(await readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", async () => {
		await writeSettings({ version: 1, graph: { enabled: false } });
		const out = await readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});

	it("a chat section on disk is IGNORED — the field died with per-session models (owner, 2026-09-28)", async () => {
		setRawMemoryKv(
			"settings",
			JSON.stringify({
				version: 1,
				chat: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" },
				graph: { enabled: true },
			}),
		);
		const out = await readSettings();
		assert.ok(out);
		assert.equal("chat" in out, false, "the chat section never surfaces");
		assert.deepEqual(out.graph, { enabled: true });
	});

	it("corrupt settings.json → null (first-boot semantics), never throws", async () => {
		setCorruptMemoryKv("settings");
		assert.equal(await readSettings(), null);
	});
});
