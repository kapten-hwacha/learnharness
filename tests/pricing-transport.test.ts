import assert from "node:assert/strict";
import test from "node:test";
import { chatStore } from "../src/store/chats.ts";
import { GET } from "../app/api/chats/[id]/route.ts";
import { sessionCost } from "../src/server/pricing.ts";
import { resetMemoryStores } from "../src/store/memory-backend.ts";

test("chat GET supplies derived Pi costs without persisting dollars or changing native history", async () => {
	resetMemoryStores();
	const record = await chatStore.createChat("price projection fixture");
	await chatStore.saveMessages(record.id, [{ id: "fixture-input", role: "user", content: "synthetic", timestamp: 1 }]);
	const step = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 70_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 500 };
	for (const [id, model] of [["api", "openrouter:openai/gpt-6.1-sol"], ["plan", "chatgpt:fixture"], ["unknown", "missing:fixture"]]) {
		await chatStore.appendTurnUsage(record.id, { id: id!, model: model!, messageId: "fixture-input", at: "fixture", steps: [step] });
	}
	const before = await chatStore.getChat(record.id);
	const response = await GET(new Request(`http://localhost/api/chats/${record.id}`), { params: Promise.resolve({ id: record.id }) });
	assert.equal(response.status, 200);
	const body = await response.json();
	const stored = await chatStore.getChat(record.id);
	assert.deepEqual(body.messages, stored!.messages);
	assert.deepEqual(body.pricing, sessionCost(stored!));
	assert.equal(body.pricing.cost, 0.037);
	assert.equal(body.pricing.subscription, 1);
	assert.equal(body.pricing.unpriced, 1);
	assert.deepEqual(body.pricing.turnCosts, { api: 0.037, plan: null, unknown: null });
	assert.deepEqual(stored, before, "read-time estimates must never rewrite the usage log");
});
