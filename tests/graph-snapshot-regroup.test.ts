import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ChatSummary,
	GraphChain,
	GraphNode,
	GraphRegroup,
	NotesSource,
} from "../src/core/contracts.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import { graphSnapshot, type GraphDeps } from "../src/core/graph.ts";

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });

const node = (
	id: string,
	name: string,
	provenance: Array<{ chatId: string; messageId: string }> = [],
): GraphNode => ({
	id,
	name,
	statement: `${name} statement`,
	aliases: [],
	createdAt: "2026-11-02T00:00:00.000Z",
	provenance,
});

const chain = (
	id: string,
	premises: string[],
	conclusion: string,
	provenance: Array<{ chatId: string; messageId: string }> = [],
): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance,
	createdAt: "2026-11-02T00:00:00.000Z",
});

function fakeDeps(opts: {
	nodes: GraphNode[];
	chains?: GraphChain[];
	chats?: Array<Pick<ChatSummary, "id" | "title">>;
	sources?: Array<Pick<NotesSource, "id" | "filePath">>;
	regroups?: GraphRegroup[];
}): GraphDeps {
	const graphStore: GraphStore = {
		readNodes: () => opts.nodes,
		readChains: () => opts.chains ?? [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readSources: () =>
			(opts.sources ?? []).map(
				(s) =>
					({
						...s,
						importedAt: "2026-11-02T00:00:00.000Z",
						extractions: [],
					}) as unknown as NotesSource,
			),
		readPositions: () => ({}),
		writePositions: () => {},
		appendRegroup: () => {},
		readRegroups: () => opts.regroups ?? [],
	} as unknown as GraphStore;

	const chatStore: ChatStore = {
		listChats: () =>
			(opts.chats ?? []).map(
				(c) =>
					({
						...c,
						createdAt: "2026-11-02T00:00:00.000Z",
						updatedAt: "2026-11-02T00:00:00.000Z",
						messageCount: 1,
					}) as unknown as ChatSummary,
			),
		getChat: (id: string) => {
			const found = (opts.chats ?? []).find((c) => c.id === id);
			if (!found) return null;
			return {
				...found,
				createdAt: "2026-11-02T00:00:00.000Z",
				updatedAt: "2026-11-02T00:00:00.000Z",
				messageCount: 1,
			} as unknown as ChatSummary;
		},
	} as unknown as ChatStore;

	return { graphStore, chatStore };
}

describe("graphSnapshot regrouping", () => {
	it("omits regroups field when store has no regroup entries", () => {
		const nodes = [
			node("n1", "A", [pt("chat_1")]),
			node("n2", "B", [pt("chat_1")]),
			node("n3", "C", [pt("chat_1")]),
		];
		const deps = fakeDeps({
			nodes,
			chats: [{ id: "chat_1", title: "Chat One" }],
			regroups: [],
		});

		const snapshot = graphSnapshot(deps);
		assert.equal(snapshot.regroups, undefined);
		assert.equal(snapshot.clusters.length, 1);
		assert.equal(snapshot.clusters[0]?.id, "chat_1");
		assert.deepEqual(snapshot.clusters[0]?.members, ["n1", "n2", "n3"]);
	});

	it("assembles snapshot with active regroups, overriding earlier entries for same node", () => {
		// chat_1 birthed n1, n2, n3, n4 (size 4)
		// chat_2 birthed n5, n6, n7 (size 3)
		// chat_3 has no births originally
		const nodes = [
			node("n1", "N1", [pt("chat_1")]),
			node("n2", "N2", [pt("chat_1")]),
			node("n3", "N3", [pt("chat_1")]),
			node("n4", "N4", [pt("chat_1")]),
			node("n5", "N5", [pt("chat_2")]),
			node("n6", "N6", [pt("chat_2")]),
			node("n7", "N7", [pt("chat_2")]),
		];

		const regroups: GraphRegroup[] = [
			{
				id: "rg_1",
				nodeId: "n1",
				targetSessionId: "chat_2",
				reason: "Moved to chat 2 first",
				regroupedAt: "2026-11-02T10:00:00.000Z",
			},
			{
				id: "rg_2",
				nodeId: "n1",
				targetSessionId: "chat_3",
				reason: "Override: moved to chat 3 instead",
				regroupedAt: "2026-11-02T11:00:00.000Z",
			},
			{
				id: "rg_3",
				nodeId: "n2",
				targetSessionId: "chat_3",
				reason: "Moved n2 to chat 3",
				regroupedAt: "2026-11-02T11:05:00.000Z",
			},
			{
				id: "rg_4",
				nodeId: "n3",
				targetSessionId: "chat_3",
				reason: "Moved n3 to chat 3",
				regroupedAt: "2026-11-02T11:10:00.000Z",
			},
		];

		const deps = fakeDeps({
			nodes,
			chats: [
				{ id: "chat_1", title: "Original Topic" },
				{ id: "chat_2", title: "Second Topic" },
				{ id: "chat_3", title: "New Advanced Topic" },
			],
			regroups,
		});

		const snapshot = graphSnapshot(deps);

		// 1. snapshot.regroups mapping reflects latest entries
		assert.deepEqual(snapshot.regroups, {
			n1: "chat_3",
			n2: "chat_3",
			n3: "chat_3",
		});

		// 2. Target session is resolved in sessions even though it had no births
		assert.equal(snapshot.sessions.chat_3, "New Advanced Topic");

		// 3. nodeSessions includes targetSessionId for regrouped nodes
		assert.ok(snapshot.nodeSessions.n1?.includes("chat_3"));
		assert.ok(snapshot.nodeSessions.n1?.includes("chat_1")); // keeps original provenance session

		// 4. Clusters reflect effective sessions (MIN_CLUSTER_SIZE >= 3 rule):
		// chat_3 has n1, n2, n3 (3 members -> cluster exists)
		// chat_2 has n5, n6, n7 (3 members -> cluster exists)
		// chat_1 now only has n4 (1 member -> filtered out by MIN_CLUSTER_SIZE < 3)
		assert.equal(snapshot.clusters.length, 2);
		const c3 = snapshot.clusters.find((c) => c.id === "chat_3");
		assert.ok(c3);
		assert.equal(c3.label, "New Advanced Topic");
		assert.deepEqual(c3.members, ["n1", "n2", "n3"]);

		const c2 = snapshot.clusters.find((c) => c.id === "chat_2");
		assert.ok(c2);
		assert.equal(c2.label, "Second Topic");
		assert.deepEqual(c2.members, ["n5", "n6", "n7"]);
	});

	it("resolves targetSessionId to fileSources when regrouped to notes source", () => {
		const nodes = [
			node("n1", "N1", [pt("chat_1")]),
			node("n2", "N2", [pt("chat_1")]),
			node("n3", "N3", [pt("chat_1")]),
		];

		const regroups: GraphRegroup[] = [
			{
				id: "rg_notes",
				nodeId: "n1",
				targetSessionId: "src_notes_1",
				reason: "Group under imported notes",
				regroupedAt: "2026-11-02T10:00:00.000Z",
			},
			{
				id: "rg_notes2",
				nodeId: "n2",
				targetSessionId: "src_notes_1",
				reason: "Group under imported notes",
				regroupedAt: "2026-11-02T10:01:00.000Z",
			},
			{
				id: "rg_notes3",
				nodeId: "n3",
				targetSessionId: "src_notes_1",
				reason: "Group under imported notes",
				regroupedAt: "2026-11-02T10:02:00.000Z",
			},
		];

		const deps = fakeDeps({
			nodes,
			chats: [{ id: "chat_1", title: "Chat One" }],
			sources: [{ id: "src_notes_1", filePath: "/docs/linalg.md" }],
			regroups,
		});

		const snapshot = graphSnapshot(deps);

		assert.equal(snapshot.fileSources.src_notes_1, "/docs/linalg.md");
		const cNotes = snapshot.clusters.find((c) => c.id === "src_notes_1");
		assert.ok(cNotes);
		assert.equal(cNotes.label, "linalg");
		assert.deepEqual(cNotes.members, ["n1", "n2", "n3"]);
	});

	it("attaches derived implication nodes to regrouped cluster according to premises' effective sessions", () => {
		const nodes = [
			node("p1", "Premise 1", [pt("chat_orig")]),
			node("p2", "Premise 2", [pt("chat_orig")]),
			node("p3", "Premise 3", [pt("chat_orig")]),
			node("c1", "Conclusion 1", [pt("chat_orig")]),
		];

		// multi-premise chain
		const chains = [
			chain("arg_imp", ["p1", "p2"], "c1", [pt("chat_orig")]),
		];

		// Regroup p1, p2, p3 to chat_dest
		const regroups: GraphRegroup[] = [
			{ id: "rg_1", nodeId: "p1", targetSessionId: "chat_dest", reason: "regroup", regroupedAt: "2026-11-02T10:00:00Z" },
			{ id: "rg_2", nodeId: "p2", targetSessionId: "chat_dest", reason: "regroup", regroupedAt: "2026-11-02T10:00:00Z" },
			{ id: "rg_3", nodeId: "p3", targetSessionId: "chat_dest", reason: "regroup", regroupedAt: "2026-11-02T10:00:00Z" },
		];

		const deps = fakeDeps({
			nodes,
			chains,
			chats: [
				{ id: "chat_orig", title: "Original Chat" },
				{ id: "chat_dest", title: "Destination Chat" },
			],
			regroups,
		});

		const snapshot = graphSnapshot(deps);

		// chat_dest has p1, p2, p3 (3 propositions -> qualifies for hull).
		// arg_imp should be attached to chat_dest because both premises are in chat_dest.
		const cDest = snapshot.clusters.find((c) => c.id === "chat_dest");
		assert.ok(cDest);
		assert.ok(cDest.members.includes("arg_imp"));
		assert.deepEqual(cDest.members, ["arg_imp", "p1", "p2", "p3"]);
	});
});
