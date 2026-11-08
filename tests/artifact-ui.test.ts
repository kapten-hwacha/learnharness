/**
 * The artifact-ui mutation route (POST /api/chats/:id/artifact-ui) —
 * persists transient per-artifact UI preferences into the chat record so
 * toggling an inversion/zoom/view-mode state survives unmount/remount
 * (owner, 2026-09-24).
 *
 * Pins:
 *   - Unknown chat → 404.
 *   - Malformed body or message-id not found → 400.
 *   - Message-id pointing at a non-artifact message → 400.
 *   - ui.inverted: true writes to the steer message's details.ui dictionary;
 *     a subsequent call with false clears/sets it to false.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { resetMemoryStores } from "../src/store/memory-backend.ts";

type Post = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: Post;
let createChat: (title: string, kind?: "practice") => Promise<{ id: string; title: string }>;
let saveMessages: (id: string, messages: unknown[]) => Promise<void>;
let getChat: (id: string) => Promise<{ messages: unknown[] } | null>;
let buildSubagentSteerFn: typeof import("../src/core/contracts.ts").buildSubagentSteer;

before(async () => {
	const route = await import("../app/api/chats/[id]/artifact-ui/route.ts");
	POST = route.POST;
	const server = await import("../src/server/chats.ts");
	createChat = server.createChat;
	getChat = server.getChat as typeof getChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages as never);
	const contracts = await import("../src/core/contracts.ts");
	buildSubagentSteerFn = contracts.buildSubagentSteer;
});

beforeEach(() => {
	resetMemoryStores();
});

const post = (id: string, body: unknown) =>
	POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }), {
		params: Promise.resolve({ id }),
	});

describe("POST /api/chats/:id/artifact-ui", () => {
	it("404s an unknown chat", async () => {
		const res = await post("nope", { input: { messageId: "x", inverted: true } });
		assert.equal(res.status, 404);
	});

	it("400s a malformed body and a non-artifact message id", async () => {
		const chat = await createChat("Artifact UI guards");
		const steer = buildSubagentSteerFn(
			{ id: "jg", kind: "demo", toolCallId: "cg" },
			{ title: "T", html: "<p>x</p>", tested: true },
		);
		await saveMessages(chat.id, [
			{ id: "m1", role: "user", content: "hi" },
			steer as never,
		]);
		assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: true } })).status, 400);
		assert.equal((await post(chat.id, { input: { messageId: "missing", inverted: true } })).status, 400);
		assert.equal((await post(chat.id, {})).status, 400);
		assert.equal((await post(chat.id, { input: { messageId: "m1", inverted: "yes" } })).status, 400);
	});

	it("persists ui.inverted onto the demo steer and toggles it back", async () => {
		const chat = await createChat("Artifact UI round trip");
		const steer = buildSubagentSteerFn(
			{ id: "jk", kind: "visual", toolCallId: "ck" },
			{ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>' },
		);
		await saveMessages(chat.id, [steer as never]);

		assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: true } })).status, 200);
		let saved = (await getChat(chat.id))!.messages as [{ details: { ui?: { inverted?: boolean } } }];
		assert.equal(saved[0]!.details.ui?.inverted, true, "the flag rides the record");

		assert.equal((await post(chat.id, { input: { messageId: steer.id, inverted: false } })).status, 200);
		saved = (await getChat(chat.id))!.messages as [{ details: { ui?: { inverted?: boolean } } }];
		assert.equal(saved[0]!.details.ui?.inverted, false, "and toggles back off");
	});
});
