import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import {
	attachImpToCommunities,
	birthSessionOf,
	birthSessionPartition,
	effectiveSessionOf,
} from "../src/core/session-clusters.ts";

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

describe("effectiveSessionOf", () => {
	it("returns birth session when no regroupMap provided", () => {
		const n = node("n1", "Node 1", [pt("chat_a")]);
		assert.equal(effectiveSessionOf(n), "chat_a");
	});

	it("returns birth session when node is not present in regroupMap", () => {
		const n = node("n1", "Node 1", [pt("chat_a")]);
		const regroups = new Map([["n2", "chat_b"]]);
		assert.equal(effectiveSessionOf(n, regroups), "chat_a");
	});

	it("returns target session when node is present in regroupMap", () => {
		const n = node("n1", "Node 1", [pt("chat_a")]);
		const regroups = new Map([["n1", "chat_b"]]);
		assert.equal(effectiveSessionOf(n, regroups), "chat_b");
	});

	it("returns null when node has no provenance and is not in regroupMap", () => {
		const n = node("n1", "Node 1", []);
		assert.equal(effectiveSessionOf(n), null);
		assert.equal(effectiveSessionOf(n, new Map()), null);
	});

	it("returns target session when node has no provenance but is in regroupMap", () => {
		const n = node("n1", "Node 1", []);
		const regroups = new Map([["n1", "chat_target"]]);
		assert.equal(effectiveSessionOf(n, regroups), "chat_target");
	});
});

describe("birthSessionPartition with regroups", () => {
	it("reassigns a node to the regrouped target session cluster", () => {
		const nodes = [
			node("n1", "Matrix Mult", [pt("chat_ml")]),
			node("n2", "Gradient Descent", [pt("chat_ml")]),
			node("n3", "Dot Product", [pt("chat_ml")]),
			node("n4", "Eigenvalues", [pt("chat_la")]),
		];

		const regroups = new Map([
			["n1", "chat_la"],
			["n3", "chat_la"],
		]);

		const clusters = birthSessionPartition(nodes, regroups);

		assert.deepEqual(clusters, [
			{ id: "chat_la", members: ["n1", "n3", "n4"] },
			{ id: "chat_ml", members: ["n2"] },
		]);
	});

	it("breaks cluster ties by session id ascending and sorts members ascending", () => {
		const nodes = [
			node("n_b", "B", [pt("chat_2")]),
			node("n_a", "A", [pt("chat_1")]),
		];
		// n_a is regrouped to chat_3. Both chat_2 and chat_3 have 1 member.
		const regroups = new Map([["n_a", "chat_3"]]);
		const clusters = birthSessionPartition(nodes, regroups);

		assert.deepEqual(clusters, [
			{ id: "chat_2", members: ["n_b"] },
			{ id: "chat_3", members: ["n_a"] },
		]);
	});

	it("preserves deduplication when repeated node lines exist with regroups", () => {
		const nodes = [
			node("n1", "First Line", [pt("chat_orig")]),
			node("n1", "Link Append", [pt("chat_other")]),
			node("n2", "Second Node", [pt("chat_orig")]),
		];
		const regroups = new Map([["n1", "chat_new"]]);
		const clusters = birthSessionPartition(nodes, regroups);

		assert.deepEqual(clusters, [
			{ id: "chat_new", members: ["n1"] },
			{ id: "chat_orig", members: ["n2"] },
		]);
	});
});

describe("attachImpToCommunities with regroups", () => {
	it("places implication node in community matching premises' effective sessions", () => {
		const nodes = [
			node("p1", "Premise 1", [pt("chat_orig")]),
			node("p2", "Premise 2", [pt("chat_orig")]),
			node("c1", "Conclusion 1", [pt("chat_orig")]),
		];
		const chains = [
			chain("arg_1", ["p1", "p2"], "c1", [pt("chat_orig")]),
		];

		// Both premises regrouped to chat_dest
		const regroups = new Map([
			["p1", "chat_dest"],
			["p2", "chat_dest"],
		]);

		const communities = [
			{ id: "chat_dest", members: ["p1", "p2"] },
			{ id: "chat_orig", members: ["c1"] },
		];

		attachImpToCommunities(communities, nodes, chains, regroups);

		const destComm = communities.find((c) => c.id === "chat_dest");
		assert.ok(destComm?.members.includes("arg_1"));
		assert.deepEqual(destComm?.members, ["arg_1", "p1", "p2"]);
	});

	it("updates majority premise key when only one of two premises is regrouped with tie breaker", () => {
		const nodes = [
			node("p1", "Premise 1", [pt("chat_1")]),
			node("p2", "Premise 2", [pt("chat_1")]),
			node("c1", "Conclusion 1", [pt("chat_1")]),
		];
		// Chain was asserted in chat_2
		const chains = [
			chain("arg_tie", ["p1", "p2"], "c1", [pt("chat_2")]),
		];

		// Regroup p1 to chat_2. Now premise sessions are chat_2 and chat_1 (1-1 tie).
		// Chain provenance is chat_2, so tie goes to chat_2.
		const regroups = new Map([["p1", "chat_2"]]);

		const communities = [
			{ id: "chat_1", members: ["p2", "c1"] },
			{ id: "chat_2", members: ["p1"] },
		];

		attachImpToCommunities(communities, nodes, chains, regroups);

		const comm2 = communities.find((c) => c.id === "chat_2");
		assert.ok(comm2?.members.includes("arg_tie"));
	});
});
