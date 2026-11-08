import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import type { GraphNode, SourceDirectory } from "../src/core/index.ts";
import { resetMemoryStores, getMemoryKv, setRawMemoryKv } from "../src/store/memory-backend.ts";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-deletion-"));
process.env.LH_DATA_DIR = root; process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
const { DELETE } = await import("../app/api/graph/sources/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { sessionCoverage } = await import("../src/server/chats.ts");
const { coverageSlots } = await import("../src/core/coverage.ts");
beforeEach(() => { resetMemoryStores(); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root); fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n"); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const remove = (sourceIds: string[], folderIds: string[] = [], deleteSessions = false) => DELETE(new Request("http://localhost/api/graph/sources", { method: "DELETE", body: JSON.stringify({ sourceIds, folderIds, deleteSessions }) }));
async function book(id: string) { await stores.graphStore.upsertSource({ id, filePath: `${id}.md`, importedAt: "2026-10-30" }); }
function node(id: string, sources: string[], aliases: string[] = []): GraphNode {
	return { id, name: id, statement: `${id} statement`, aliases, createdAt: "2026-10-30", provenance: sources.map((chatId) => ({ chatId, messageId: "m" })) };
}
async function folders(placements: Record<string, { folderId: string }>) {
	await stores.sourceOrganizationStore.write({ version: 1, folders: [
		{ id: "outer", name: "Outer", parentId: null, createdAt: "now" },
		{ id: "inner", name: "Inner", parentId: "outer", createdAt: "now" },
		{ id: "empty", name: "Empty", parentId: "outer", createdAt: "now" },
	], placements });
}
it("removes zero-proposition imports and nested empty containers, leaving original files untouched", async () => {
	await book("zero"); await folders({ zero: { folderId: "inner" } });
	const original = path.join(root, "zero.md"); fs.writeFileSync(original, "original bytes");
	const response = await remove(["zero"], ["outer", "inner", "empty"]); assert.equal(response.status, 200);
	const result = await response.json() as SourceDirectory & { graphRevision: number };
	assert.deepEqual(result.sources, []); assert.deepEqual(result.organization.folders, []); assert.deepEqual(result.organization.placements, {});
	assert.equal(fs.readFileSync(original, "utf8"), "original bytes"); assert.equal(typeof result.graphRevision, "number");
	assert.equal((await remove(["zero"], ["outer", "inner", "empty"])).status, 200, "retry is idempotent");
});
it("purges only selected source contributions; shared identity, foreign aliases and unrelated legacy nodes survive", async () => {
	await book("a"); await book("b");
	await stores.graphStore.appendNode(node("shared", ["a"], ["a phrasing"]));
	await stores.graphStore.appendNode(node("shared", ["b"], ["b phrasing"]));
	await stores.graphStore.appendNode(node("unique", ["a"])); await stores.graphStore.appendNode(node("legacy", []));
	await stores.graphStore.appendNode(node("b_only", ["b"]));
	await stores.graphStore.appendChain({ id: "arg_shared", premises: ["shared"], conclusion: "b_only", createdAt: "now", provenance: [{ chatId: "b", messageId: "m" }] });
	await stores.graphStore.appendChain({ id: "arg_unique", premises: ["shared"], conclusion: "unique", createdAt: "now", provenance: [{ chatId: "a", messageId: "m" }] });
	await stores.graphStore.appendCoverage({ chatId: "a", fp: "a", tokens: 10, foldedAt: "now" });
	await stores.graphStore.appendCheckpoint({ chatId: "a", foldedAt: "now" });
	await stores.graphStore.appendCoverage({ chatId: "b", fp: "b", tokens: 10, foldedAt: "now" });
	await stores.graphStore.writePositions({ unique: { x: 1, y: 1 }, shared: { x: 2, y: 2 }, legacy: { x: 3, y: 3 } });
	assert.equal((await remove(["a"])).status, 200);
	const lines = await stores.graphStore.readNodes();
	assert.equal(lines.some((n) => n.id === "unique"), false); assert.ok(lines.some((n) => n.id === "legacy"));
	assert.deepEqual(lines.find((n) => n.id === "shared")?.aliases, []);
	assert.deepEqual(lines.filter((n) => n.id === "shared").flatMap((n) => n.aliases), ["b phrasing"]);
	assert.ok(lines.every((n) => n.provenance.every((p) => p.chatId !== "a")));
	assert.deepEqual((await stores.graphStore.readChains()).map((c) => c.id), ["arg_shared"]);
	assert.deepEqual((await stores.graphStore.readCoverage()).map((r) => r.chatId), ["b"]); assert.deepEqual(await stores.graphStore.readCheckpoints(), []);
	assert.equal((await stores.graphStore.readPositions()).unique, undefined); assert.ok((await stores.graphStore.readPositions()).legacy);
	assert.deepEqual((await stores.graphStore.readSources()).map((s) => s.id), ["b"]);
	assert.equal((await remove(["b"])).status, 200); assert.deepEqual((await stores.graphStore.readNodes()).map((n) => n.id), ["legacy"]);
});
it("kept conversations retain messages and folder placement but lose contributions and extraction marks", async () => {
	const chat = await stores.chatStore.createChat("Kept session");
	await stores.chatStore.saveMessages(chat.id, [{ id: "m", role: "assistant", content: [{ type: "text", text: "Synthetic teaching prose." }], timestamp: 1 } as never]);
	const before = (await stores.chatStore.getChat(chat.id))!;
	const slot = coverageSlots(before.messages)[0]!;
	await stores.graphStore.appendCoverage({ chatId: chat.id, fp: slot.fp, tokens: slot.tokens, foldedAt: "now" });
	await stores.graphStore.appendCheckpoint({ chatId: chat.id, foldedAt: "now" });
	await stores.graphStore.appendNode(node("chat_unique", [chat.id])); await book("zero");
	await folders({ [chat.id]: { folderId: "inner" }, zero: { folderId: "inner" } });
	assert.equal((await sessionCoverage(chat.id))?.coveredCount, 1);
	assert.equal((await remove([chat.id, "zero"], ["outer", "inner", "empty"])).status, 200);
	assert.deepEqual(await stores.chatStore.getChat(chat.id), before);
	assert.equal((await sessionCoverage(chat.id))?.coveredCount, 0); assert.equal((await sessionCoverage(chat.id))?.uncoveredCount, 1);
	assert.deepEqual(await stores.graphStore.readCheckpoints(), []); assert.deepEqual(await stores.graphStore.readNodes(), []);
	const result = await sourceDirectory.read(); assert.deepEqual(result.organization.folders.map((f) => f.id), ["outer", "inner"]);
	assert.equal(result.organization.placements[chat.id]?.folderId, "inner"); assert.equal(result.sources[0]?.id, chat.id);
});
it("deleting visible entries retains hidden practice conversations, graph contributions, coverage and their folder containers", async () => {
	const practice = await stores.chatStore.createChat("Hidden practice", "practice"); await book("visible");
	await stores.graphStore.appendNode(node("historical", [practice.id]));
	await stores.graphStore.appendCoverage({ chatId: practice.id, fp: "practice", tokens: 10, foldedAt: "now" });
	await stores.graphStore.appendCheckpoint({ chatId: practice.id, foldedAt: "now" });
	await folders({ [practice.id]: { folderId: "inner" }, visible: { folderId: "inner" } });
	const before = { chat: await stores.chatStore.getChat(practice.id), nodes: await stores.graphStore.readNodes(), coverage: await stores.graphStore.readCoverage(), checkpoints: await stores.graphStore.readCheckpoints() };
	assert.equal((await remove(["visible"], ["outer", "inner", "empty"], true)).status, 200);
	assert.deepEqual(await stores.chatStore.getChat(practice.id), before.chat);
	assert.deepEqual(await stores.graphStore.readNodes(), before.nodes);
	assert.deepEqual(await stores.graphStore.readCoverage(), before.coverage); assert.deepEqual(await stores.graphStore.readCheckpoints(), before.checkpoints);
	const directory = await sourceDirectory.read();
	assert.equal(directory.organization.placements[practice.id]?.folderId, "inner");
	assert.deepEqual(directory.organization.folders.map((f) => f.id), ["outer", "inner"]);
});

it("explicit session deletion uses existing cleanup, including jobs, while other sources preserve shared nodes", async () => {
	const chat = await stores.chatStore.createChat("Delete me"); await book("b");
	const job = await stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call" }); await stores.jobStore.updateJob(job.id, { status: "done" });
	await stores.graphStore.appendNode(node("shared", [chat.id, "b"])); await folders({ [chat.id]: { folderId: "inner" } });
	assert.equal((await remove([chat.id], ["outer", "inner", "empty"], true)).status, 200);
	assert.equal(await stores.chatStore.getChat(chat.id), null); assert.equal(await stores.jobStore.getJob(job.id), null);
	assert.deepEqual((await stores.graphStore.readNodes())[0]?.provenance.map((p) => p.chatId), ["b"]);
	assert.deepEqual((await sourceDirectory.read()).organization.folders, []);
});
it("a swallowed session-unlink failure retains placement and folders, reports partial failure, and permits explicit retry", async () => {
	const chat = await stores.chatStore.createChat("Cannot unlink yet");
	await stores.chatStore.saveMessages(chat.id, [{ id: "m", role: "user", content: "Keep these messages on failure.", timestamp: 1 }]);
	const before = await stores.chatStore.getChat(chat.id);
	await stores.graphStore.appendNode(node("chat_unique", [chat.id])); await book("zero");
	await folders({ [chat.id]: { folderId: "inner" }, zero: { folderId: "inner" } });
	const organization = structuredClone(await getMemoryKv("source_organization"));
	const deleteChat = stores.chatStore.deleteChat;
	try {
		stores.chatStore.deleteChat = async () => false; // the store swallows unlink/I/O errors
		const response = await remove([chat.id, "zero"], ["outer", "inner", "empty"], true);
		assert.equal(response.status, 500);
		assert.match((await response.json()).error, /Some entries may already have been removed/);
		assert.deepEqual(await stores.chatStore.getChat(chat.id), before);
		assert.deepEqual(await getMemoryKv("source_organization"), organization, "no placement or selected folder is discarded on failed record removal");
		assert.deepEqual(await stores.graphStore.readNodes(), [], "earlier graph writes are honest partial progress");
		assert.deepEqual(await stores.graphStore.readSources(), [], "earlier imported-record removal is also partial progress");
	} finally { stores.chatStore.deleteChat = deleteChat; }
	assert.equal((await remove([chat.id, "zero"], ["outer", "inner", "empty"], true)).status, 200);
	assert.equal(await stores.chatStore.getChat(chat.id), null);
	assert.deepEqual((await sourceDirectory.read()).organization, { version: 1, folders: [], placements: {} });
});
it("preflights every selected session's running turn/jobs before deleting any selected imports", async () => {
	const chat = await stores.chatStore.createChat("Busy"); await book("a");
	beginTurn(chat.id);
	try { const response = await remove(["a", chat.id], [], true); assert.equal(response.status, 409); assert.equal((await response.json()).code, "turn_in_flight"); assert.equal((await stores.graphStore.readSources()).length, 1); }
	finally { endTurn(chat.id); }
	const job = await stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "busy" });
	try { const response = await remove(["a", chat.id], [], true); assert.equal(response.status, 409); assert.equal((await response.json()).code, "jobs_running"); assert.equal((await stores.graphStore.readSources()).length, 1); }
	finally { await stores.jobStore.deleteJobsForChat(chat.id); }
	assert.ok(job.id);
});
it("refuses contribution deletion during extraction without cancelling it; metadata-only empty folder removal is safe", async () => {
	await book("a"); await folders({});
	const g = globalThis as { __lhExtractionRuns?: unknown }, saved = g.__lhExtractionRuns;
	const controller = new AbortController();
	try {
		g.__lhExtractionRuns = { running: new Map([["other", { chatId: "other", kind: "notes", phase: "extracting", startedAt: 1, usage: {}, controller }]]), inFlight: new Set(), lastStartedAt: 0 };
		const response = await remove(["a"]); assert.equal(response.status, 409); assert.equal((await response.json()).code, "extraction_running");
		assert.equal(controller.signal.aborted, false); assert.equal((await stores.graphStore.readSources()).length, 1);
		assert.equal((await remove([], ["empty"])).status, 200);
	} finally { g.__lhExtractionRuns = saved; }
});
it("invalid and oversized bodies and corrupt organization refuse before destructive writes", async () => {
	await book("a"); await folders({ a: { folderId: "inner" } });
	for (const body of ["{", "x".repeat(65537), JSON.stringify({ sourceIds: ["a"], folderIds: [] }), JSON.stringify({ sourceIds: [3], folderIds: [], deleteSessions: false }), JSON.stringify({ sourceIds: [], folderIds: [], deleteSessions: false })]) {
		assert.equal((await DELETE(new Request("http://localhost/api/graph/sources", { method: "DELETE", body }))).status, 400);
		assert.equal((await stores.graphStore.readSources()).length, 1);
	}
	setRawMemoryKv("source_organization", "{"); assert.equal((await remove(["a"])).status, 500);
	assert.equal((await stores.graphStore.readSources()).length, 1);
});
it("a batch rewrites graph ledgers and source metadata once, including opted-in sessions, with shared support evaluated across the full selection", async () => {
	const ids = Array.from({ length: 40 }, (_, i) => `book_${i}`); for (const id of [...ids, "keeper"]) await book(id);
	const chats = [await stores.chatStore.createChat("First"), await stores.chatStore.createChat("Second")];
	await stores.graphStore.appendNode(node("selected_only", [ids[0]!, chats[0]!.id]));
	await stores.graphStore.appendNode(node("shared", [ids[1]!, chats[1]!.id, "keeper"]));
	await stores.graphStore.appendNode(node("legacy", []));
	const rewrite = stores.graphStore.rewriteLedgers, deleteSources = stores.graphStore.deleteSources;
	let graphWrites = 0, sourceWrites = 0;
	try {
		stores.graphStore.rewriteLedgers = async (batch) => { graphWrites++; await rewrite(batch); };
		stores.graphStore.deleteSources = async (batch) => { sourceWrites++; return await deleteSources(batch); };
		assert.equal((await remove([...ids, ...chats.map((c) => c.id)], [], true)).status, 200);
	} finally { stores.graphStore.rewriteLedgers = rewrite; stores.graphStore.deleteSources = deleteSources; }
	assert.equal(graphWrites, 1); assert.equal(sourceWrites, 1);
	assert.deepEqual((await stores.graphStore.readNodes()).map((n) => n.id), ["shared", "legacy"]);
	assert.deepEqual((await stores.graphStore.readNodes())[0]?.provenance.map((p) => p.chatId), ["keeper"]);
	assert.deepEqual((await stores.graphStore.readSources()).map((s) => s.id), ["keeper"]);
	for (const chat of chats) assert.equal(await stores.chatStore.getChat(chat.id), null);
});
it("partial I/O failure is honest and retry cleans stale placement without touching other entries", async () => {
	await book("a"); await book("b"); await folders({ a: { folderId: "inner" } });
	const write = stores.sourceOrganizationStore.write;
	try {
		stores.sourceOrganizationStore.write = async () => { throw new Error("synthetic disk failure"); };
		const response = await remove(["a"], ["outer", "inner", "empty"]); assert.equal(response.status, 500);
		assert.match((await response.json()).error, /Some entries may already/);
	} finally { stores.sourceOrganizationStore.write = write; }
	assert.deepEqual((await stores.graphStore.readSources()).map((s) => s.id), ["b"]);
	assert.equal((await remove(["a"], ["outer", "inner", "empty"])).status, 200);
	assert.deepEqual((await sourceDirectory.read()).organization.placements, {}); assert.deepEqual((await sourceDirectory.read()).organization.folders, []);
});
