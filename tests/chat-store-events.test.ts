/**
 * CHAT STORE EVENT PINS (push-architecture S6, 2026-10-02): the sidebar's
 * 2.5s poll died — list truth now rides chats-changed. The store's law:
 * list-SHAPE writes (create/rename/delete) announce post-write; content
 * writes (messages/usage/settings/tree) are DELIBERATELY silent — the
 * silence law is pinned here so it reads as law, not oversight.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { chatStore } from "../src/store/chats.ts";
import { subscribe } from "../src/core/events.ts";
import { resetMemoryStores } from "../src/store/memory-backend.ts";

beforeEach(() => {
	resetMemoryStores();
});

describe("chat store events (S6: the silence law)", () => {
	it("createChat, renameChat, deleteChat each announce chats-changed", async () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});

		const chat = await chatStore.createChat("Store events fixture");
		assert.equal(announces, 1, "create announces post-write");

		await chatStore.renameChat(chat.id, "Renamed");
		assert.equal(announces, 2, "rename announces (a list-shape write)");

		assert.equal(await chatStore.deleteChat(chat.id), true);
		assert.equal(announces, 3, "a real delete announces");
		off();
	});

	it("deleteChat on a missing id stays silent", async () => {
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});
		assert.equal(await chatStore.deleteChat("chat_never_existed"), false);
		assert.equal(announces, 0, "nothing was written — nothing announced");
		off();
	});

	it("content writes are DELIBERATELY silent (the law)", async () => {
		const chat = await chatStore.createChat("Silent content fixture");
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});

		// saveMessages: fires per turn-persist — would spam the bus during
		// turns; its list-visible effects arrive via turn-started/settled.
		await chatStore.saveMessages(chat.id, [{ id: "m1", role: "user", content: "hello", timestamp: 1 } as never]);
		// usage appends + settings + tree: record CONTENT, not list shape.
		await chatStore.appendTurnUsage(chat.id, { id: "t1", messageId: "m1", at: "2026-10-02T00:00:00.000Z", model: "x:y", steps: [] });
		await chatStore.appendExtractionUsage(chat.id, { startedAt: 1, at: "2026-10-02T00:00:00.000Z", durationMs: 1, stages: { extractor: { model: "x:y", steps: [] }, auditor: { model: "x:y", steps: [] } } });
		await chatStore.saveSettings(chat.id, {});
		await chatStore.saveTree(chat.id, { nodes: [], edges: [], version: 1 });

		assert.equal(announces, 0, "the silence law: content writes never announce");
		off();
		await chatStore.deleteChat(chat.id);
	});
});
