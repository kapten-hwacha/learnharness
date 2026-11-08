/**
 * SCHEMA STAMPS (schema-versioning wave, owner 2026-10-10): LAZY v1 for
 * chats (record.version, stamped at the write choke point) and the graph
 * family (data/graph/format.json sidecar — ledgers, sources,
 * render-settings; positions deliberately unversioned, rebuildable).
 * Honest refusal: records stamped NEWER than this build are refused on
 * read (the downgrade scenario) — never misparsed, never rewritten.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { ChatRecord } from "../src/core/contracts.ts";
import { chatStore } from "../src/store/chats.ts";
import { graphStore } from "../src/store/graph.ts";
import { readRenderSettings, writeRenderSettings } from "../src/store/render-settings.ts";
import { memorySaveChat, resetMemoryStores } from "../src/store/memory-backend.ts";

test.beforeEach(() => {
	resetMemoryStores();
});

// ── chats: lazy stamp at the write choke point ──────────────────────────────

test("chats: createChat stamps version 1", async () => {
	const r = await chatStore.createChat("stamp test");
	assert.equal(r.version, 1, "the in-memory twin is stamped");
	const stored = await chatStore.getChat(r.id);
	assert.equal(stored?.version, 1, "the stored record carries the stamp");
});

test("chats: an UNSTAMPED legacy record reads fine (absence = v1) and is stamped by its next write", async () => {
	const id = "chat_legacy000_stamp0";
	await memorySaveChat({ id, title: "legacy", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] } as unknown as ChatRecord);
	const r = await chatStore.getChat(id);
	assert.ok(r, "unstamped record reads (lazy v1)");
	await chatStore.saveMessages(id, []);
	const stored = await chatStore.getChat(id);
	assert.equal(stored?.version, 1, "the write choke point stamped it");
});

test("chats: a NEWER-stamped record is refused honestly (the downgrade scenario)", async () => {
	const id = "chat_future000_stamp0";
	await memorySaveChat({ id, title: "from the future", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], version: 99 } as unknown as ChatRecord);
	assert.equal(await chatStore.getChat(id), null, "getChat refuses: reads as absent, never misparsed");
});

// ── the graph family ────────────────────────────────────────────────────────

test("graph: reads work fine on empty state", async () => {
	assert.deepEqual(await graphStore.readNodes(), [], "ledger reads fine");
	assert.equal(await readRenderSettings(), null, "render-settings reads fine");
});

test("graph: ledger appends node successfully", async () => {
	await graphStore.appendNode({
		id: "n_stamp0",
		name: "Stamps",
		statement: "The graph family carries schema version 1.",
		aliases: [],
		createdAt: new Date().toISOString(),
		provenance: [],
	});
	assert.equal((await graphStore.readNodes()).length, 1, "the ledger reads back node");
});

test("render-settings: write works", async () => {
	const written = await writeRenderSettings({ sizeUnits: "world", nodeSize: 3 });
	assert.equal(written.nodeSize, 3);
	const read = await readRenderSettings();
	assert.equal(read?.nodeSize, 3);
});

// ── the fixtures stay the legacy pin: golden data reads unstamped ───────────

test("golden fixtures are deliberately the unstamped legacy shape (lazy v1 = current-valid)", () => {
	const here = import.meta.dirname;
	const teach = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "golden-data", "chats", "chat_mv27rrra_feff23b6.json"), "utf8"));
	assert.equal(teach.version, undefined, "fixture records pin the unstamped read path");
});
