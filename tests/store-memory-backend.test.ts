/**
 * Comprehensive tests for src/store/memory-backend.ts and the async store adapters.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { chatStore } from "../src/store/chats.ts";
import { graphStore } from "../src/store/graph.ts";
import { jobStore } from "../src/store/jobs.ts";
import { settingsStore, readFileAccessSettings } from "../src/store/settings.ts";
import { studyStore } from "../src/store/study.ts";
import { sourceOrganizationStore } from "../src/store/source-organization.ts";
import { promptOverrides } from "../src/store/prompt-overrides.ts";
import { authStore, readCustomAuth, writeCustomAuth } from "../src/store/auth.ts";
import { resetMemoryStores, memorySaveChat } from "../src/store/memory-backend.ts";
import { CURRENT_CHAT_VERSION } from "../src/core/contracts.ts";
import type { GraphChain, GraphNode, ImageSnapshot, NotesSource } from "../src/core/contracts.ts";

beforeEach(() => {
	resetMemoryStores();
});

describe("chatStore (memory-backend)", () => {
	it("creates, retrieves, renames, and deletes a chat", async () => {
		const chat = await chatStore.createChat("My Session");
		assert.equal(chat.title, "My Session");
		assert.equal(chat.version, CURRENT_CHAT_VERSION);

		const fetched = await chatStore.getChat(chat.id);
		assert.ok(fetched);
		assert.equal(fetched.title, "My Session");

		const renamed = await chatStore.renameChat(chat.id, "Renamed Session");
		assert.equal(renamed.title, "Renamed Session");

		const list = await chatStore.listChats();
		assert.equal(list.length, 1);
		assert.equal(list[0]!.title, "Renamed Session");

		const deleted = await chatStore.deleteChat(chat.id);
		assert.equal(deleted, true);
		assert.equal(await chatStore.getChat(chat.id), null);
		assert.equal((await chatStore.listChats()).length, 0);
	});

	it("refuses chat records stamped with newer version", async () => {
		const chat = await chatStore.createChat("Future Chat");
		await memorySaveChat({ ...chat, version: CURRENT_CHAT_VERSION + 1 } as any);
		const readBack = await chatStore.getChat(chat.id);
		assert.equal(readBack, null);
	});

	it("throws on invalid chat id", async () => {
		await assert.rejects(async () => {
			await chatStore.saveMessages("invalid/id", []);
		}, /Invalid chat id/);
	});

	it("saves image snapshots with valid SHA-256 identity", async () => {
		const chat = await chatStore.createChat("Image Chat");
		const raw = "hello world";
		const base64 = Buffer.from(raw).toString("base64");
		const sha256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
		const snapshot: ImageSnapshot = {
			mimeType: "image/png",
			data: base64,
			width: 10,
			height: 10,
		};

		await chatStore.saveImageSnapshot(chat.id, sha256, snapshot);
		const loaded = await chatStore.getChat(chat.id);
		assert.ok(loaded?.imageSnapshots?.[sha256]);

		// Rejects mismatched hash
		await assert.rejects(async () => {
			await chatStore.saveImageSnapshot(chat.id, "a".repeat(64), snapshot);
		}, /Invalid image snapshot identity/);

		// Rejects invalid snapshot id format
		await assert.rejects(async () => {
			await chatStore.saveImageSnapshot(chat.id, "invalid_hash", snapshot);
		}, /Invalid image snapshot identity/);
	});

	it("searches chat transcripts and titles", async () => {
		const c1 = await chatStore.createChat("Quantum Computing");
		await chatStore.saveMessages(c1.id, [
			{ id: "m1", role: "user", content: "Explain superposition and entanglement" },
		] as any);

		const hitsTitle = await chatStore.searchChats("quantum");
		assert.equal(hitsTitle.length, 1);
		assert.equal(hitsTitle[0]!.chatId, c1.id);

		const hitsContent = await chatStore.searchChats("entanglement");
		assert.equal(hitsContent.length, 1);
		assert.equal(hitsContent[0]!.chatId, c1.id);
		assert.ok(hitsContent[0]!.snippet.toLowerCase().includes("entanglement"));
	});

	it("stores tree, settings, usage, clarifications", async () => {
		const chat = await chatStore.createChat("Details Chat");
		await chatStore.saveTree(chat.id, { nodes: [], edges: [], version: 1 });
		await chatStore.saveSettings(chat.id, { thinkingLevel: "low" });
		await chatStore.appendTurnUsage(chat.id, {
			id: "turn1",
			messageId: "m1",
			at: "2026-11-08T00:00:00.000Z",
			model: "m",
			steps: [],
		});
		await chatStore.appendExtractionUsage(chat.id, {
			startedAt: 12345,
			at: "2026-11-08T00:00:00.000Z",
			durationMs: 50,
			stages: {
				extractor: { model: "m", steps: [] },
				auditor: { model: "m", steps: [] },
			},
		});
		const thread = await chatStore.appendClarification(chat.id, "tc_1", {
			question: "q",
			answer: "a",
		} as any);
		assert.equal(thread.length, 1);

		const fetched = await chatStore.getChat(chat.id);
		assert.deepEqual(fetched?.tree, { nodes: [], edges: [], version: 1 });
		assert.deepEqual(fetched?.settings, { thinkingLevel: "low" });
		assert.equal(fetched?.turns?.length, 1);
		assert.equal(fetched?.extractions?.length, 1);
		assert.equal(fetched?.clarifications?.["tc_1"]?.length, 1);
	});
});

describe("graphStore (memory-backend)", () => {
	const sampleNode: GraphNode = {
		id: "n_eigen",
		name: "Eigenvalue",
		statement: "An eigenvalue is a scalar associated with a linear system of equations.",
		aliases: ["characteristic value"],
		createdAt: "2026-11-08T00:00:00.000Z",
		provenance: [{ chatId: "chat_1", messageId: "m_1" }],
	};

	const sampleChain: GraphChain = {
		id: "arg_1",
		premises: ["n_eigen"],
		conclusion: "n_det",
		provenance: [{ chatId: "chat_1", messageId: "m_1" }],
		createdAt: "2026-11-08T00:00:00.000Z",
	};

	it("manages nodes, chains, checkpoints, coverage, and bumps revision", async () => {
		assert.equal(await graphStore.revision(), 0);

		await graphStore.appendNode(sampleNode);
		assert.equal(await graphStore.revision(), 1);
		assert.deepEqual(await graphStore.readNodes(), [sampleNode]);

		await graphStore.appendChain(sampleChain);
		assert.equal(await graphStore.revision(), 2);
		assert.deepEqual(await graphStore.readChains(), [sampleChain]);

		const cp = { chatId: "chat_1", foldedAt: "2026-11-08T00:00:00.000Z" };
		await graphStore.appendCheckpoint(cp);
		assert.equal(await graphStore.revision(), 3);
		assert.deepEqual(await graphStore.readCheckpoints(), [cp]);

		const cov = { chatId: "chat_1", fp: "fp1", tokens: 10, foldedAt: "2026-11-08T00:00:00.000Z" };
		await graphStore.appendCoverage(cov);
		assert.equal(await graphStore.revision(), 4);
		assert.deepEqual(await graphStore.readCoverage(), [cov]);

		const hits = await graphStore.searchNodes("scalar");
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.nodeId, "n_eigen");
	});

	it("manages notes sources and positions", async () => {
		const source: NotesSource = {
			id: "src_notes_1",
			filePath: "/path/to/notes.md",
			importedAt: "2026-11-08T00:00:00.000Z",
		};
		await graphStore.upsertSource(source);
		assert.deepEqual(await graphStore.readSources(), [source]);

		await graphStore.appendSourceUsage(source.id, {
			startedAt: 100,
			at: "2026-11-08T00:00:00.000Z",
			durationMs: 20,
			stages: {
				extractor: { model: "m", steps: [] },
				auditor: { model: "m", steps: [] },
			},
		});
		const sources = await graphStore.readSources();
		assert.equal(sources[0]!.extractions?.length, 1);

		await graphStore.writePositions({ n_eigen: { x: 10, y: 20 } });
		assert.deepEqual(await graphStore.readPositions(), { n_eigen: { x: 10, y: 20 } });

		const deletedCount = await graphStore.deleteSources(new Set([source.id]));
		assert.equal(deletedCount, 1);
		assert.deepEqual(await graphStore.readSources(), []);
	});

	it("manages FSRS cards and practice history", async () => {
		// Practice chat
		const practiceChat = await chatStore.createChat("Practice 1", "practice");
		await chatStore.saveMessages(practiceChat.id, [
			{
				id: "m1",
				role: "assistant",
				timestamp: 1000,
				content: [{ type: "toolCall", id: "tc_p", name: "problem", arguments: { target: ["n_eigen"] } }],
			},
			{ id: "m2", role: "toolResult", toolCallId: "tc_p", isError: false, content: "ok" },
			{
				id: "m3",
				role: "assistant",
				timestamp: 2000,
				content: [{ type: "toolCall", id: "tc_c", name: "conclude", arguments: { outcome: "solved", rating: 3 } }],
			},
			{ id: "m4", role: "toolResult", toolCallId: "tc_c", isError: false, content: "ok" },
		] as any);

		const teachChat = await chatStore.createChat("Teach 1");
		await chatStore.saveMessages(teachChat.id, [
			{ id: "m_t1", role: "user", content: "hello" },
		] as any);

		const history = await graphStore.readPracticeHistory();
		assert.equal(history.records.length, 1);
		assert.equal(history.records[0]!.targets[0], "n_eigen");
		assert.ok(history.teachChatIds.has(teachChat.id));
		assert.equal(history.teachRatings?.get(teachChat.id), 3);

		// Sync and read FSRS cards
		await graphStore.syncFsrsCards([
			{
				nodeId: "n_eigen",
				stability: 2.5,
				difficulty: 4.0,
				lastReviewMs: 1000,
				reviews: 1,
				dueAtMs: 5000,
				lane: "review",
				seedRating: 3,
				stage: "practiced",
			},
		]);
		const cards = await graphStore.readFsrsCards(6000);
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.nodeId, "n_eigen");

		const none = await graphStore.readFsrsCards(4000);
		assert.equal(none.length, 0);
	});
});

describe("jobStore (memory-backend)", () => {
	it("creates, updates, lists, and deletes jobs", async () => {
		const job = await jobStore.createJob({
			kind: "research",
			chatId: "chat_123",
			toolCallId: "tc_extract",
			input: { foo: "bar" },
		});
		assert.equal(job.status, "running");
		assert.equal(job.activity, "starting");

		const found = await jobStore.getJob(job.id);
		assert.ok(found);
		assert.equal(found.id, job.id);

		const byTool = await jobStore.findJobByToolCallId("chat_123", "tc_extract");
		assert.ok(byTool);
		assert.equal(byTool.id, job.id);

		const updated = await jobStore.updateJob(job.id, { status: "done", activity: "completed" });
		assert.equal(updated?.status, "done");
		assert.equal(updated?.activity, "completed");

		const list = await jobStore.listJobs("chat_123");
		assert.equal(list.length, 1);

		const deleted = await jobStore.deleteJobsForChat("chat_123");
		assert.equal(deleted, 1);
		assert.equal((await jobStore.listJobs("chat_123")).length, 0);
	});
});

describe("settingsStore & sourceOrganizationStore", () => {
	it("reads and writes file access and user settings", async () => {
		const access = await readFileAccessSettings();
		assert.equal(access.ok, true);

		await settingsStore.writeSettings({
			version: 1,
			agent: { fileAccess: { restricted: true, folders: ["~"] } },
		});
		const read = await settingsStore.readSettings();
		assert.equal(read?.agent?.fileAccess?.restricted, true);
	});

	it("reads and writes source organization", async () => {
		const initial = await sourceOrganizationStore.read();
		assert.deepEqual(initial, { version: 1, folders: [], placements: {} });

		await sourceOrganizationStore.write({
			version: 1,
			folders: [{ id: "f1", name: "Math", parentId: null, createdAt: "2026-11-08T00:00:00.000Z" }],
			placements: { src_1: { folderId: "f1" } },
		});
		const read = await sourceOrganizationStore.read();
		assert.equal(read.folders.length, 1);
		assert.equal(read.folders[0]!.name, "Math");
	});
});

describe("promptOverrides (memory-backend)", () => {
	it("lists, writes, reads, and deletes prompt overrides", async () => {
		assert.deepEqual(await promptOverrides.listOverrides(), []);

		await promptOverrides.writeOverride("teacher/20-teaching.md", "custom teacher prompt");
		assert.equal(await promptOverrides.readOverride("teacher/20-teaching.md"), "custom teacher prompt");
		assert.deepEqual(await promptOverrides.listOverrides(), ["teacher/20-teaching.md"]);

		// Global override cache updated
		const cache = (globalThis as any).__LH_PROMPT_OVERRIDE_CACHE__;
		assert.equal(cache?.get("teacher/20-teaching.md"), "custom teacher prompt");

		await promptOverrides.deleteOverride("teacher/20-teaching.md");
		assert.equal(await promptOverrides.readOverride("teacher/20-teaching.md"), null);
		assert.deepEqual(await promptOverrides.listOverrides(), []);
	});
});

describe("authStore custom auth (memory-backend)", () => {
	it("reads and writes custom auth bindings", async () => {
		const init = await readCustomAuth();
		assert.equal(init.binding, null);

		await writeCustomAuth(
			{
				version: 1,
				id: "a".repeat(32),
				authMode: "apiKey",
				baseUrl: "https://example.com/api",
			},
			"custom-key-123",
		);

		const updated = await readCustomAuth();
		assert.equal(updated.binding?.baseUrl, "https://example.com/api");
		assert.equal(updated.binding?.id, "a".repeat(32));
		assert.equal(updated.fileKey(), "custom-key-123");
	});
});
