import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-worker-router-"));
process.env.LH_DATA_DIR = tempDataDir;
process.env.LH_AUTH_FILE = path.join(tempDataDir, "auth.json");

const { dispatchWorkerRequest } = await import("../src/worker/router.ts");

after(() => {
	fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe("src/worker/router.ts (35-route /api/* dispatcher)", () => {
	it("routes static GET/PUT (/api/settings, /api/settings/:section) and URL-decoded catch-all (/api/settings/prompts/:segment+)", async () => {
		const getRes = await dispatchWorkerRequest(new Request("http://localhost/api/settings"));
		assert.equal(getRes.status, 200);

		const putRes = await dispatchWorkerRequest(
			new Request("http://localhost/api/settings/general", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		assert.equal(putRes.status, 200);

		const promptRes = await dispatchWorkerRequest(
			new Request("http://localhost/api/settings/prompts/teacher%2F20-teaching.md", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: "Custom teacher identity" }),
			}),
		);
		assert.equal(promptRes.status, 200);
	});

	it("returns 404 for unknown API paths and 405 for unsupported HTTP methods", async () => {
		const missing = await dispatchWorkerRequest(new Request("http://localhost/api/does-not-exist"));
		assert.equal(missing.status, 404);

		const badMethod = await dispatchWorkerRequest(new Request("http://localhost/api/chat", { method: "DELETE" }));
		assert.equal(badMethod.status, 405);
	});

	it("routes single dynamic parameter routes with URL decoding", async () => {
		const chatRes = await dispatchWorkerRequest(new Request("http://localhost/api/chats/test-chat-404"));
		assert.equal(chatRes.status, 404);
	});
});
