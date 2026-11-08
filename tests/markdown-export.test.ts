/**
 * The markdown-export route (GET /api/chats/:id/markdown) — an anchorless,
 * cleanly formatted transcript suitable for sharing or reading outside the
 * harness (owner, 2026-09-22).
 *
 * Pins:
 *   - The title is a level-1 markdown header.
 *   - User and assistant messages alternate under level-3 role headers.
 *   - No internal LH anchors: message ids, tool call payloads, and the
 *     internal phase state are omitted.
 *   - Content-Disposition attachment with the slugified title as the filename.
 *   - Unknown chat returns 404.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { resetMemoryStores } from "../src/store/memory-backend.ts";

/** The route handler + the store seam, loaded AFTER the env is set. */
type Get = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let GET: Get;
let createChat: (title: string, kind?: "practice") => Promise<{ id: string; title: string }>;
let saveMessages: (id: string, messages: unknown[]) => Promise<void>;

before(async () => {
	const route = await import("../app/api/chats/[id]/markdown/route.ts");
	GET = route.GET;
	const server = await import("../src/server/chats.ts");
	createChat = server.createChat;
	const { chatStore } = await import("../src/store/chats.ts");
	saveMessages = (id, messages) => chatStore.saveMessages(id, messages as never);
});

beforeEach(() => {
	resetMemoryStores();
});

describe("GET /api/chats/:id/markdown", () => {
	it("404s an unknown chat", async () => {
		const res = await GET(new Request("http://x/api/chats/nope/markdown"), { params: Promise.resolve({ id: "nope" }) });
		assert.equal(res.status, 404);
	});

	it("exports the session as an anchorless markdown attachment, filename from the title", async () => {
		const chat = await createChat("Relational Databases — Joins & Normal Forms");
		await saveMessages(chat.id, [
			{ id: "m1", role: "user", content: "Teach me joins" },
			{ id: "m2", role: "assistant", content: "A join combines rows." },
		]);
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
		const disposition = res.headers.get("content-disposition") ?? "";
		assert.ok(disposition.startsWith("attachment;"), "it is a download");
		assert.ok(disposition.includes('filename="relational-databases-joins-normal-forms.md"'), "slugified title names the file");
		const body = await res.text();
		assert.ok(body.startsWith("# Relational Databases"), "the title mints the document header");
		assert.ok(body.includes("### Learner"), "learner blocks render");
		assert.ok(body.includes("### Teacher"), "teacher blocks render");
		assert.ok(!body.includes("m1"), "anchorless — no message-id provenance in the user-facing export");
	});

	it("an unsalvageable title falls back to 'session'", async () => {
		const chat = await createChat("日本語"); // no ascii alphanumerics survive the slug
		await saveMessages(chat.id, [{ id: "m1", role: "user", content: "hello" }]);
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 200);
		assert.ok((res.headers.get("content-disposition") ?? "").includes('filename="session.md"'));
	});

	it("an empty session exports the bare header document", async () => {
		const chat = await createChat("Quiet one");
		const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: chat.id }) });
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.equal(body, "# Quiet one");
	});
});
