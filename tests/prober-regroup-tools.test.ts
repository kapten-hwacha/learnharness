import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProberTools } from "../src/agent/tools.ts";
import { proberGraphTools } from "../src/agent/tools/graph.ts";
import type { ChatStore, GraphStore, JobStore } from "../src/core/ports.ts";
import type { ChatRecord, ChatSummary } from "../src/core/contracts/chat.ts";
import type { GraphChain, GraphNode, GraphRegroup, NotesSource } from "../src/core/contracts/graph.ts";

const pt = (chatId: string, messageId = "m1") => ({ chatId, messageId });

const node = (
	id: string,
	name: string,
	statement: string,
	provenance: Array<{ chatId: string; messageId: string }>,
	aliases: string[] = [],
): GraphNode => ({
	id,
	name,
	statement,
	aliases,
	createdAt: "2026-11-02T00:00:00.000Z",
	provenance,
});

function fakeStores(
	initialNodes: GraphNode[],
	over: {
		chats?: Array<Pick<ChatSummary, "id" | "title" | "createdAt" | "updatedAt">>;
		sources?: NotesSource[];
		regroups?: GraphRegroup[];
		chains?: GraphChain[];
	} = {},
): { chatStore: ChatStore; graphStore: GraphStore } {
	const nodes = [...initialNodes];
	const chains = [...(over.chains ?? [])];
	const regroups = [...(over.regroups ?? [])];
	const sources = [...(over.sources ?? [])];

	const graphStore: GraphStore = {
		readNodes: () => nodes,
		appendNode: (n: GraphNode) => nodes.push(n),
		readChains: () => chains,
		appendChain: (c: GraphChain) => chains.push(c),
		readCheckpoints: () => [],
		appendCheckpoint: () => {},
		readCoverage: () => [],
		appendCoverage: () => {},
		readRegroups: () => regroups,
		appendRegroup: (r: GraphRegroup) => regroups.push(r),
		readSources: () => sources,
		upsertSource: (s: NotesSource) => sources.push(s),
		deleteSources: () => 0,
		appendSourceUsage: () => {},
		readPositions: () => ({}),
		writePositions: () => {},
		rewriteLedgers: () => {},
	} as unknown as GraphStore;

	const chatStore: ChatStore = {
		listChats: () =>
			(over.chats ?? []).map((c) => ({ ...c, messageCount: 0 }) as unknown as ChatSummary),
		getChat: (id: string) =>
			((over.chats ?? []).find((c) => c.id === id) as unknown as ChatRecord) ?? null,
	} as unknown as ChatStore;

	return { chatStore, graphStore };
}

const stubJobStore = {
	createJob: (() => ({})) as never,
	getJob: (() => undefined) as never,
	listJobs: (() => []) as never,
	updateJob: (() => {}) as never,
} as unknown as JobStore;

const baseCtx = {
	chatId: "chat_la",
	deliver: () => {},
	jobStore: stubJobStore,
	spawn: () => {},
};

describe("search_propositions tool", () => {
	it("returns empty graph message when no nodes exist", async () => {
		const { chatStore, graphStore } = fakeStores([]);
		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		assert.ok("search_propositions" in tools);

		const res = (await tools.search_propositions!.execute!("tc1", { query: "matrix" })).details as string;
		assert.equal(res, "The knowledge graph is empty — no propositions exist yet.");
	});

	it("returns matches from other sessions with name, statement, and subject title", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_123",
					"Matrix Multiplication",
					"Matrix multiplication combines two matrices by taking dot products of rows and columns.",
					[pt("chat_ml")],
				),
				node(
					"n_456",
					"Dot Product",
					"Dot product calculates the sum of the products of the corresponding entries of two sequences of numbers.",
					[pt("chat_ml")],
				),
			],
			{
				chats: [
					{ id: "chat_ml", title: "Machine Learning", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.search_propositions!.execute!("tc2", { query: "Matrix Multiplication" })).details as string;

		assert.match(res, /Found \d+ candidate proposition\(s\) from other subjects:/);
		assert.match(res, /1\. \[n_123\] "Matrix Multiplication": Matrix multiplication combines two matrices by taking dot products of rows and columns\. \(Current subject: "Machine Learning" · /);
	});

	it("excludes propositions that are already in the current session", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_la_1",
					"Vector Addition",
					"Vector addition produces a vector whose components are the sum of the respective components.",
					[pt("chat_la")],
				),
				node(
					"n_ml_1",
					"Gradient Vector",
					"The gradient vector points in the direction of greatest rate of increase of a scalar field.",
					[pt("chat_ml")],
				),
			],
			{
				chats: [
					{ id: "chat_ml", title: "Machine Learning", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.search_propositions!.execute!("tc3", { query: "vector" })).details as string;

		assert.match(res, /Found 1 candidate proposition\(s\) from other subjects:/);
		assert.match(res, /n_ml_1/);
		assert.ok(!res.includes("n_la_1"));
	});

	it("excludes propositions whose effective session is the current session via regroups", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_ml_regrouped",
					"Matrix Inversion",
					"Matrix inversion computes the reciprocal matrix.",
					[pt("chat_ml")],
				),
			],
			{
				chats: [
					{ id: "chat_ml", title: "Machine Learning", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
				regroups: [
					{
						id: "rg_001",
						nodeId: "n_ml_regrouped",
						targetSessionId: "chat_la",
						reason: "Linear algebra foundation",
						regroupedAt: "2026-11-02T00:00:00Z",
					},
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.search_propositions!.execute!("tc4", { query: "Matrix Inversion" })).details as string;

		assert.equal(res, 'No propositions matching "Matrix Inversion" found in other subjects.');
	});

	it("resolves source file path for propositions born in imported notes source", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_note",
					"Determinant",
					"The determinant of a square matrix is a scalar value that encodes geometric properties of linear transformations.",
					[pt("src_algebra_notes")],
				),
			],
			{
				chats: [
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
				sources: [
					{
						id: "src_algebra_notes",
						filePath: "notes/algebra.md",
						importedAt: "2026-10-15T00:00:00Z",
					},
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.search_propositions!.execute!("tc5", { query: "Determinant" })).details as string;

		assert.match(res, /Found 1 candidate proposition\(s\) from other subjects:/);
		assert.match(res, /\(Current subject: "notes\/algebra\.md" · practiced · never practised\)/);
	});

	it("returns informative message when no matches are found", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n_1", "Photosynthesis", "Plants convert light into chemical energy.", [pt("chat_bio")]),
			],
			{
				chats: [{ id: "chat_bio", title: "Biology", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.search_propositions!.execute!("tc6", { query: "Quantum Mechanics" })).details as string;

		assert.equal(res, 'No propositions matching "Quantum Mechanics" found in other subjects.');
	});

	it("respects the limit parameter", async () => {
		const nodes = Array.from({ length: 5 }, (_, i) =>
			node(
				`n_${i}`,
				`Eigenvalue Concept ${i}`,
				`Eigenvalue ${i} scaling factor for eigenvector in linear transformation.`,
				[pt("chat_physics")],
			),
		);
		const { chatStore, graphStore } = fakeStores(nodes, {
			chats: [{ id: "chat_physics", title: "Physics", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }],
		});

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.search_propositions!.execute!("tc7", { query: "eigenvalue", limit: 2 })).details as string;

		assert.match(res, /Found 2 candidate proposition\(s\) from other subjects:/);
		const candidateLines = res.split("\n").filter((l) => /^\d+\./.test(l));
		assert.equal(candidateLines.length, 2);
	});

	it("includes FSRS review status (stage, practice recency, and due flag) in search_propositions output", async () => {
		const DAY = 86_400_000;
		const now = Date.parse("2026-11-10T00:00:00.000Z");
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_due",
					"Bayes Rule",
					"Posterior is proportional to likelihood times prior.",
					[pt("chat_prob")],
				),
				node(
					"n_retained",
					"Law of Total Probability",
					"Marginal probability is the sum of joint probabilities over a partition.",
					[pt("chat_prob")],
				),
			],
			{
				chats: [
					{ id: "chat_prob", title: "Probability", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
					{ id: "chat_kalman", title: "Kalman Filters", createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({
			chatStore,
			graphStore,
			chatId: "chat_kalman",
			now: () => now,
			history: () => ({
				teachChatIds: new Set(["chat_prob"]),
				teachRatings: new Map([["chat_prob", 3]]),
				records: [
					{
						chatId: "prac_1",
						at: now - 1 * DAY,
						targets: ["n_retained"],
						outcome: "solved",
						rung: null,
						missClass: null,
						rating: 4,
					},
				],
			}),
		});

		const res = (await tools.search_propositions!.execute!("tc_rev", { query: "probability prior" })).details as string;
		assert.match(res, /\[n_due\] "Bayes Rule".*\(Current subject: "Probability" · practiced · never practised · due\)/);
		assert.match(res, /\[n_retained\] "Law of Total Probability".*\(Current subject: "Probability" · demonstrated · last practised 1d ago\)/);
	});

	it("includes incoming ('derived from') and outgoing ('used to derive') reasoning chains beneath matched candidates", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n_dot", "Dot Product", "Sum of products of components.", [pt("chat_ml")]),
				node("n_mat", "Matrix Multiplication", "Combines matrices via row-column dot products.", [pt("chat_ml")]),
				node("n_comp", "Linear Map Composition", "Matrix product represents composition of linear maps.", [pt("chat_ml")]),
			],
			{
				chats: [
					{ id: "chat_ml", title: "Machine Learning", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
				chains: [
					{ id: "arg_in", premises: ["n_dot"], conclusion: "n_mat", createdAt: "2026-10-01T00:00:00Z", provenance: [pt("chat_ml")] },
					{ id: "arg_out", premises: ["n_mat"], conclusion: "n_comp", createdAt: "2026-10-01T00:00:00Z", provenance: [pt("chat_ml")] },
				],
			},
		);
		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.search_propositions!.execute!("tc_chains", { query: "Matrix Multiplication", limit: 1 })).details as string;
		assert.match(res, /1\. \[n_mat\] "Matrix Multiplication":/);
		assert.match(res, /   derived from: Dot Product → Matrix Multiplication/);
		assert.match(res, /   used to derive: Matrix Multiplication → Linear Map Composition/);
	});
});

describe("regroup_propositions tool", () => {
	it("returns error message when ctx.chatId is missing", async () => {
		const { chatStore, graphStore } = fakeStores([
			node("n_1", "Concept", "Statement", [pt("chat_other")]),
		]);
		const tools = proberGraphTools({ chatStore, graphStore }); // no chatId
		assert.ok("regroup_propositions" in tools);

		const res = (await tools.regroup_propositions!.execute!("tc8", {
			nodeIds: ["n_1"],
			reason: "Belongs here",
		})).details as string;

		assert.equal(res, "Cannot regroup propositions: active session ID is missing.");
	});

	it("appends GraphRegroup to graphStore and formats success message", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_123",
					"Matrix Multiplication",
					"Matrix multiplication statement.",
					[pt("chat_ml")],
				),
				node(
					"n_456",
					"Dot Product",
					"Dot product statement.",
					[pt("chat_ml")],
				),
			],
			{
				chats: [
					{ id: "chat_ml", title: "Machine Learning", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.regroup_propositions!.execute!("tc9", {
			nodeIds: ["n_123", "n_456"],
			reason: "Foundation concepts of vector spaces and linear transformations.",
		})).details as string;

		const expected = [
			'Regrouped 2 proposition(s) to "Linear Algebra":',
			"- Matrix Multiplication (n_123)",
			"- Dot Product (n_456)",
			"Reason: Foundation concepts of vector spaces and linear transformations.",
		].join("\n");

		assert.equal(res, expected);

		const appended = graphStore.readRegroups();
		assert.equal(appended.length, 2);
		assert.equal(appended[0]?.nodeId, "n_123");
		assert.equal(appended[0]?.targetSessionId, "chat_la");
		assert.equal(appended[0]?.reason, "Foundation concepts of vector spaces and linear transformations.");
		assert.match(appended[0]?.id ?? "", /^rg_[0-9a-f]{12}$/);
		assert.equal(appended[1]?.nodeId, "n_456");
		assert.equal(appended[1]?.targetSessionId, "chat_la");
	});

	it("causes subsequent search_propositions to exclude regrouped nodes", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_123",
					"Matrix Multiplication",
					"Matrix multiplication combines matrices.",
					[pt("chat_ml")],
				),
			],
			{
				chats: [
					{ id: "chat_ml", title: "Machine Learning", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });

		// Before regrouping: found in other subjects
		const before = (await tools.search_propositions!.execute!("tc10", { query: "Matrix Multiplication" })).details as string;
		assert.match(before, /Found 1 candidate proposition\(s\) from other subjects:/);

		// Regroup
		await tools.regroup_propositions!.execute!("tc11", {
			nodeIds: ["n_123"],
			reason: "Part of linear algebra",
		});

		// After regrouping: now in current session, so excluded from search
		const after = (await tools.search_propositions!.execute!("tc12", { query: "Matrix Multiplication" })).details as string;
		assert.equal(after, 'No propositions matching "Matrix Multiplication" found in other subjects.');
	});

	it("skips nodes already in current session", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_la_1",
					"Vector Space",
					"A vector space is a collection of vectors.",
					[pt("chat_la")],
				),
			],
			{
				chats: [
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.regroup_propositions!.execute!("tc13", {
			nodeIds: ["n_la_1"],
			reason: "Align with current session",
		})).details as string;

		assert.match(res, /No propositions regrouped\./);
		assert.match(res, /Already in "Linear Algebra": Vector Space \(n_la_1\)/);
		assert.equal(graphStore.readRegroups().length, 0);
	});

	it("reports unknown node IDs gracefully", async () => {
		const { chatStore, graphStore } = fakeStores([]);
		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });

		const res = (await tools.regroup_propositions!.execute!("tc14", {
			nodeIds: ["n_ghost"],
			reason: "Missing node",
		})).details as string;

		assert.match(res, /No propositions regrouped\./);
		assert.match(res, /Unknown proposition ID\(s\): n_ghost/);
		assert.equal(graphStore.readRegroups().length, 0);
	});

	it("handles mixed valid, already-current, and unknown node IDs", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n_valid", "Valid Node", "Statement valid.", [pt("chat_other")]),
				node("n_curr", "Current Node", "Statement current.", [pt("chat_la")]),
			],
			{
				chats: [
					{ id: "chat_other", title: "Other Subject", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({ chatStore, graphStore, chatId: "chat_la" });
		const res = (await tools.regroup_propositions!.execute!("tc15", {
			nodeIds: ["n_valid", "n_curr", "n_missing"],
			reason: "Mixed batch regroup",
		})).details as string;

		assert.match(res, /Regrouped 1 proposition\(s\) to "Linear Algebra":/);
		assert.match(res, /- Valid Node \(n_valid\)/);
		assert.match(res, /Already in "Linear Algebra": Current Node \(n_curr\)/);
		assert.match(res, /Unknown proposition ID\(s\): n_missing/);
		assert.equal(graphStore.readRegroups().length, 1);
	});
});

describe("prober tools plumbing via createProberTools", () => {
	it("registers search_propositions and regroup_propositions with chatId forwarded", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n_ml", "Backprop", "Backpropagation computes gradients.", [pt("chat_ml")]),
			],
			{
				chats: [
					{ id: "chat_ml", title: "Machine Learning", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
					{ id: "chat_la", title: "Linear Algebra", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
				],
			},
		);

		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		assert.ok("search_propositions" in tools);
		assert.ok("regroup_propositions" in tools);

		// Regroup via createProberTools
		const regroupRes = (await tools.regroup_propositions!.execute!("tc16", {
			nodeIds: ["n_ml"],
			reason: "Foundation for optimization in linear systems",
		})).details as string;

		assert.match(regroupRes, /Regrouped 1 proposition\(s\) to "Linear Algebra":/);
		assert.equal(graphStore.readRegroups()[0]?.targetSessionId, "chat_la");
	});
});
