import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { after, beforeEach, it } from "node:test";
import { resetMemoryStores, getMemoryKv, setMemoryKv, setRawMemoryKv } from "../src/store/memory-backend.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-organization-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { GET, POST } = await import("../app/api/graph/sources/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const change = (action: unknown) => POST(new Request("http://localhost/api/graph/sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) }));
const sourceId = (filePath: string) => `src_${createHash("sha256").update(filePath).digest("hex").slice(0, 12)}`;

it("GET is a non-writing read and inventories all sessions, imported records and missing provenance", async () => {
	const before = await GET(); assert.equal(before.status, 200);
	assert.deepEqual((await before.json()).sources, []);
	const chat = await stores.chatStore.createChat("Unextracted session");
	await stores.graphStore.upsertSource({ id: sourceId("Root/empty.md"), filePath: "Root/empty.md", importedAt: "2026-10-30T00:00:00Z" });
	await stores.graphStore.appendNode({ id: "n_orphan", name: "Orphan", statement: "A record is missing.", aliases: [], createdAt: "2026-10-30T00:00:00Z", provenance: [{ chatId: "gone", messageId: "m1" }] });
	const { sources } = await (await GET()).json();
	assert.equal(sources.find((s: { id: string }) => s.id === chat.id).label, "Unextracted session");
	assert.equal(sources.find((s: { id: string }) => s.id === chat.id).chatKind, "teach", "absent persisted kind still means teaching");
	assert.equal(sources.find((s: { kind: string }) => s.kind === "notes").label, "empty");
	assert.equal(sources.find((s: { id: string }) => s.id === "gone").kind, "missing");
});

it("GET projects practice kind without removing or rewriting sessions, historical graph contributions or folder placements", async () => {
	const practice = await stores.chatStore.createChat("Practice source", "practice");
	await stores.graphStore.appendNode({ id: "n_practice", name: "Historical", statement: "Historical practice contribution.", aliases: [], createdAt: "2026-10-30", provenance: [{ chatId: practice.id, messageId: "m" }] });
	const created = await (await change({ action: "create-folder", name: "Practice folder", parentId: null })).json();
	assert.equal((await change({ action: "move", kind: "source", id: practice.id, parentId: created.createdFolderId })).status, 200);
	const directory = await (await GET()).json();
	assert.deepEqual(directory.sources.find((s: { id: string }) => s.id === practice.id), { id: practice.id, kind: "chat", chatKind: "practice", label: practice.title, createdAt: practice.createdAt });
	assert.equal(directory.organization.placements[practice.id].folderId, created.createdFolderId);
});

it("rename/move operations persist independently without changing source IDs, paths, graph ledgers or usage", async () => {
	const filePath = "Course/Sub/My_Notes.v2.pdf", id = sourceId(filePath);
	await sourceDirectory.registerImport(filePath);
	await stores.graphStore.upsertSource({ id, filePath, importedAt: "2026-10-30T00:00:00Z", extractions: [] });
	const before = { nodes: await stores.graphStore.readNodes(), chains: await stores.graphStore.readChains(), source: (await stores.graphStore.readSources()).find((s) => s.id === id) };
	let directory = await (await GET()).json();
	const sub = directory.organization.folders.find((f: { importPath?: string }) => f.importPath === "Course/Sub");
	for (const action of [{ action: "rename-folder", id: sub.id, name: "Renamed directory" }, { action: "move", kind: "folder", id: sub.id, parentId: null }, { action: "rename-source", id, name: "Renamed book" }]) assert.equal((await change(action)).status, 200);
	await sourceDirectory.registerImport(filePath);
	await sourceDirectory.registerImport("Course/Sub/new.txt");
	directory = await (await GET()).json();
	assert.equal(directory.sources.find((s: { id: string }) => s.id === id).label, "Renamed book");
	assert.equal(directory.organization.placements[sourceId("Course/Sub/new.txt")].folderId, sub.id);
	assert.equal(directory.organization.folders.find((f: { id: string }) => f.id === sub.id).parentId, null);
	assert.deepEqual(await stores.graphStore.readNodes(), before.nodes); assert.deepEqual(await stores.graphStore.readChains(), before.chains);
	assert.deepEqual((await stores.graphStore.readSources()).find((s) => s.id === id), before.source);
});

it("session rename uses its existing title without activity churn; existing root source placement survives reimport", async () => {
	const chat = await stores.chatStore.createChat("Original session");
	const response = await change({ action: "rename-source", id: chat.id, name: "Edited session" }); assert.equal(response.status, 200);
	assert.equal((await stores.chatStore.getChat(chat.id))?.title, "Edited session");
	assert.equal((await stores.chatStore.getChat(chat.id))?.updatedAt, chat.updatedAt);
	const id = sourceId("Root/empty.md");
	await sourceDirectory.registerImport("Root/empty.md");
	assert.equal((await stores.sourceOrganizationStore.read()).placements[id]?.folderId, null);
	assert.ok(!(await stores.sourceOrganizationStore.read()).folders.some((f) => f.importPath === "Root"));
});

it("server validates cycles, stale sources/parents and nonempty folders, including zero-node files", async () => {
	const created = await (await change({ action: "create-folder", name: "Empty", parentId: null })).json();
	const folder = created.organization.folders.find((f: { name: string }) => f.name === "Empty");
	assert.equal(created.createdFolderId, folder.id, "creation identifies the exact new row, even with duplicate folder names");
	assert.equal((await change({ action: "move", kind: "folder", id: folder.id, parentId: folder.id })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: "unknown", parentId: folder.id })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: sourceId("Root/empty.md"), parentId: folder.id })).status, 200);
	assert.equal((await change({ action: "delete-folder", id: folder.id })).status, 400);
	assert.equal((await change({ action: "move", kind: "source", id: sourceId("Root/empty.md"), parentId: null })).status, 200);
	assert.equal((await change({ action: "delete-folder", id: folder.id })).status, 200);
});

it("malformed, oversized and failed streams refuse before metadata writes", async () => {
	const before = await getMemoryKv("source_organization");
	for (const request of [new Request("http://localhost/api/graph/sources", { method: "POST", body: "{" }), new Request("http://localhost/api/graph/sources", { method: "POST", body: "x".repeat(65537) }), new Request("http://localhost/api/graph/sources", { method: "POST", body: new ReadableStream({ start(c) { c.error(new Error("synthetic broken stream")); } }), duplex: "half" } as RequestInit)]) assert.equal((await POST(request)).status, 400);
	assert.deepEqual(await getMemoryKv("source_organization"), before);
});

it("newer/corrupt data refuses reads and writes without overwriting its bytes", async () => {
	const before = await getMemoryKv("source_organization");
	try {
		for (const value of ["{", '{"version":2,"folders":[],"placements":{}}']) {
			setRawMemoryKv("source_organization", value);
			assert.equal((await GET()).status, 500);
			assert.equal((await change({ action: "create-folder", name: "Do not overwrite", parentId: null })).status, 500);
		}
	} finally {
		if (before) await setMemoryKv("source_organization", before);
		else resetMemoryStores();
	}
});
