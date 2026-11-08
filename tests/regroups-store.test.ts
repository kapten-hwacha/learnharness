/**
 * GraphStore: regroups ledger test.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GraphRegroup } from "../src/core/contracts/graph.ts";
import { graphStore } from "../src/store/graph.ts";
import { appendRawMemoryRegroup, resetMemoryStores } from "../src/store/memory-backend.ts";

beforeEach(() => {
	resetMemoryStores();
});

const r1: GraphRegroup = {
	id: "rg_0123456789ab",
	nodeId: "n_matrix_mult",
	targetSessionId: "chat_linear_algebra",
	reason: "Matrix multiplication is fundamental to Linear Algebra",
	regroupedAt: "2026-11-02T10:00:00.000Z",
};

const r2: GraphRegroup = {
	id: "rg_cdef01234567",
	nodeId: "n_dot_product",
	targetSessionId: "src_notes_linalg",
	reason: "Vector dot product regrouped under linear algebra notes",
	regroupedAt: "2026-11-02T11:00:00.000Z",
};

describe("graphStore: regroups", () => {
	it("returns empty array when ledger does not exist", async () => {
		const records = await graphStore.readRegroups();
		assert.deepEqual(records, []);
	});

	it("appends and reads back regroup records in append order", async () => {
		await graphStore.appendRegroup(r1);
		assert.deepEqual(await graphStore.readRegroups(), [r1]);

		await graphStore.appendRegroup(r2);
		assert.deepEqual(await graphStore.readRegroups(), [r1, r2]);
	});

	it("skips corrupt and malformed lines when reading", async () => {
		await graphStore.appendRegroup(r1);

		// Append broken JSON
		appendRawMemoryRegroup("{broken json\n");

		// Append missing fields
		appendRawMemoryRegroup(JSON.stringify({ id: "rg_1", nodeId: "n_1" }) + "\n");

		// Append wrong types
		appendRawMemoryRegroup(
			JSON.stringify({
				id: "rg_bad",
				nodeId: 123,
				targetSessionId: "chat_1",
				reason: "wrong type",
				regroupedAt: "2026-11-02T10:00:00.000Z",
			}) + "\n",
		);

		// Append valid r2
		await graphStore.appendRegroup(r2);

		const records = await graphStore.readRegroups();
		assert.deepEqual(records, [r1, r2]);
	});

	it("rewrites regroups via rewriteLedgers", async () => {
		await graphStore.appendRegroup(r1);
		await graphStore.appendRegroup(r2);
		assert.equal((await graphStore.readRegroups()).length, 2);

		// Rewrite with only r2
		await graphStore.rewriteLedgers({ regroups: [r2] });
		assert.deepEqual(await graphStore.readRegroups(), [r2]);

		// Rewrite with empty array clears the ledger
		await graphStore.rewriteLedgers({ regroups: [] });
		assert.deepEqual(await graphStore.readRegroups(), []);
	});
});
