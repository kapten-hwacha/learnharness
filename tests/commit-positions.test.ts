/**
 * The positions-commit sanitizer (PUT /api/graph/positions) — the arg_
 * fix (owner, 2026-10-06): the canvas persists the derived view's whole
 * world (stored propositions + derived arg_ implication nodes), and the
 * commit must KEEP both. Stripping the args purged their ledger entries
 * on every drag-commit, so each mount re-seeded them on a giant ring —
 * the "splattered from the middle" report. Also pins the grew-check:
 * a payload covering the whole view runs NO settle (the file equals the
 * payload exactly); a payload missing a view node (a merge landed
 * mid-drag) triggers exactly one absorbing settle.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { resetMemoryStores } from "../src/store/memory-backend.ts";

let commitPositions: (input: unknown) => Promise<Record<string, { x: number; y: number }>>;
let readPositions: () => Promise<Record<string, { x: number; y: number }>>;
let appendNode: (node: unknown) => Promise<void>;
let appendChain: (assertion: unknown) => Promise<void>;

before(async () => {
	resetMemoryStores();
	({ commitPositions } = await import("../src/server/commit-positions.ts"));
	const { stores } = await import("../src/server/stores.ts");
	readPositions = () => stores.graphStore.readPositions();
	appendNode = (node: unknown) => stores.graphStore.appendNode(node as any);
	appendChain = (assertion: unknown) => stores.graphStore.appendChain(assertion as any);

	// Two propositions + one two-premise chain → the derived view is
	// 2 props + 1 arg_ node.
	const node = (id: string) => ({
		id,
		name: id,
		statement: `${id} statement`,
		aliases: [],
		createdAt: "2026-10-06T00:00:00.000Z",
		provenance: [],
	});
	await appendNode(node("n_a"));
	await appendNode(node("n_b"));
	await appendNode(node("n_c"));
	await appendChain({
		id: "arg_chain1",
		premises: ["n_a", "n_b"],
		conclusion: "n_c",
		provenance: [],
		createdAt: "2026-10-06T00:00:00.000Z",
	});
});

describe("commitPositions (the arg_ fix)", () => {
	it("persists arg_ implication ids alongside propositions — the canvas's whole world", async () => {
		const persisted = await commitPositions({
			n_a: { x: 10, y: 20 },
			n_b: { x: 30, y: 40 },
			n_c: { x: 50, y: 60 },
			arg_chain1: { x: 34.5, y: 44.5 },
			garbage_id: { x: 1, y: 1 },
		});
		assert.deepEqual(Object.keys(persisted).sort(), ["arg_chain1", "n_a", "n_b", "n_c"]);
		const current = await readPositions();
		assert.deepEqual(current.arg_chain1, { x: 34.5, y: 44.5 });
		assert.ok(!("garbage_id" in current), "unknown ids still discarded");
	});

	it("a payload covering the whole view runs NO settle — the file equals the payload exactly", async () => {
		await commitPositions({
			n_a: { x: 100, y: 200 },
			n_b: { x: 300, y: 400 },
			n_c: { x: 500, y: 600 },
			arg_chain1: { x: 350, y: 450 },
		});
		assert.deepEqual(await readPositions(), {
			n_a: { x: 100, y: 200 },
			n_b: { x: 300, y: 400 },
			n_c: { x: 500, y: 600 },
			arg_chain1: { x: 350, y: 450 },
		}, "no settle recomputation — the client's rest state is the ledger");
	});

	it("a payload missing a view node (a merge landed mid-drag) triggers the absorbing settle", async () => {
		// The client never knew arg_chain1 (it merged after the drag began).
		await commitPositions({
			n_a: { x: 1, y: 2 },
			n_b: { x: 3, y: 4 },
			n_c: { x: 5, y: 6 },
		});
		const after = await readPositions();
		assert.ok("arg_chain1" in after, "the settle laid out the node the client missed");
		// The client's anchors are honored (warm start), not clobbered to 0.
		assert.ok(Math.abs(after.n_a!.x - 1) < 50, `anchor n_a near its committed rest (got ${after.n_a!.x})`);
	});

	it("garbage still sanitizes: non-finite drops, absurd clamps, nothing throws", async () => {
		const persisted = await commitPositions({
			n_a: { x: Number.NaN, y: 1 },
			n_b: { x: 5, y: Number.POSITIVE_INFINITY },
			n_c: { x: 1e9, y: 0 },
		});
		assert.ok(!("n_a" in persisted), "NaN drops");
		assert.ok(!("n_b" in persisted), "Infinity drops");
		assert.equal(persisted.n_c!.x, 1e6, "absurd clamps to MAX_COORD");
	});
});
