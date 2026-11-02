import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { GraphRegroup } from "../src/core/contracts/graph.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-regroups-store-"));
process.env.LH_DATA_DIR = dir;
const { LEDGER_FILES } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(dir, "graph"), { recursive: true, force: true }));

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

describe("graphStore: regroups.jsonl", () => {
	it("points to regroups.jsonl under graph directory in LEDGER_FILES", () => {
		assert.equal(LEDGER_FILES.regroups, path.join(dir, "graph", "regroups.jsonl"));
	});

	it("returns empty array when ledger file does not exist", () => {
		assert.equal(fs.existsSync(LEDGER_FILES.regroups), false);
		const records = graphStore.readRegroups();
		assert.deepEqual(records, []);
	});

	it("appends and reads back regroup records in append order", () => {
		graphStore.appendRegroup(r1);
		assert.equal(fs.existsSync(LEDGER_FILES.regroups), true);
		assert.deepEqual(graphStore.readRegroups(), [r1]);

		graphStore.appendRegroup(r2);
		assert.deepEqual(graphStore.readRegroups(), [r1, r2]);
	});

	it("skips corrupt and malformed lines when reading", () => {
		graphStore.appendRegroup(r1);

		// Append broken JSON
		fs.appendFileSync(LEDGER_FILES.regroups, "{broken json\n", "utf-8");

		// Append missing fields
		fs.appendFileSync(LEDGER_FILES.regroups, JSON.stringify({ id: "rg_1", nodeId: "n_1" }) + "\n", "utf-8");

		// Append wrong types
		fs.appendFileSync(
			LEDGER_FILES.regroups,
			JSON.stringify({
				id: "rg_bad",
				nodeId: 123,
				targetSessionId: "chat_1",
				reason: "wrong type",
				regroupedAt: "2026-11-02T10:00:00.000Z",
			}) + "\n",
			"utf-8",
		);

		// Append valid r2
		graphStore.appendRegroup(r2);

		const records = graphStore.readRegroups();
		assert.deepEqual(records, [r1, r2]);
	});

	it("rewrites regroups via rewriteLedgers", () => {
		graphStore.appendRegroup(r1);
		graphStore.appendRegroup(r2);
		assert.equal(graphStore.readRegroups().length, 2);

		// Rewrite with only r2
		graphStore.rewriteLedgers({ regroups: [r2] });
		assert.deepEqual(graphStore.readRegroups(), [r2]);

		// Rewrite with empty array clears the ledger
		graphStore.rewriteLedgers({ regroups: [] });
		assert.deepEqual(graphStore.readRegroups(), []);
	});
});
