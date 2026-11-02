import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dueReviews, fsrsInterval, fsrsRetrievability, fsrsUpdate, practiceRecordsFromChat, reviewCalibration, reviewRating, reviewState, teachSessionSeedRating } from "../src/core/review.ts";
import type { GraphNode, PracticeRecord } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const DAY = 86_400_000;
const baseRecord = (over: Partial<PracticeRecord> = {}): PracticeRecord => ({ chatId: "p1", at: 0, targets: ["n1"], outcome: "solved", rung: null, missClass: null, ...over });
const node: GraphNode = { id: "n1", name: "N", statement: "statement", aliases: [], createdAt: new Date(0).toISOString(), provenance: [{ chatId: "teach", messageId: "m" }] };

describe("FSRS-6", () => {
	it("computes retrievability and intervals", () => {
		assert.equal(fsrsRetrievability(1, 0), 1);
		assert.ok(fsrsRetrievability(1, 1) < 1);
		assert.ok(fsrsInterval(1, 0.9) > 0);
	});
	it("initializes and updates every grade, with Hard penalty and Easy bonus", () => {
		for (const rating of [1, 2, 3, 4] as const) {
			const initial = fsrsUpdate(null, rating);
			assert.ok(initial.stability > 0 && initial.difficulty >= 1 && initial.difficulty <= 10);
			const next = fsrsUpdate({ stability: 2, difficulty: 5 }, rating, 2);
			assert.ok(next.stability > 0);
		}
		const hard = fsrsUpdate({ stability: 2, difficulty: 5 }, 2, 2).stability;
		const good = fsrsUpdate({ stability: 2, difficulty: 5 }, 3, 2).stability;
		const easy = fsrsUpdate({ stability: 2, difficulty: 5 }, 4, 2).stability;
		assert.ok(hard < good);
		assert.ok(easy > good);
	});
});

describe("teaching seed rating", () => {
	it("averages check/transfer accuracy and confidence with explicit prior ratings, ignoring predict quizzes", () => {
		const messages = [
			{ role: "assistant", timestamp: 0, content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { priorRating: 4 } }] },
			{ role: "toolResult", toolCallId: "a0", details: { kind: "quiz", questionType: "predict", correct: false, dontKnow: false, confidence: 95 }, timestamp: 0.5 },
			{ role: "toolResult", toolCallId: "a1", details: { kind: "quiz", questionType: "check", correct: true, dontKnow: false, confidence: 60 }, timestamp: 1 },
			{ role: "toolResult", toolCallId: "a2", details: { kind: "quiz", questionType: "transfer", correct: true, dontKnow: false, confidence: 95 }, timestamp: 2 },
		] as unknown as LhMessage[];
		assert.equal(teachSessionSeedRating(messages), 3);
		assert.equal(teachSessionSeedRating([]), 3);
	});
});

describe("practice records", () => {
	it("maps outcomes, rung, miss class, missed targets, and effortless rating", () => {
		assert.equal(reviewRating(baseRecord({ missed: ["n1"], missClass: "execution" }), "n1"), 2);
		assert.equal(reviewRating(baseRecord({ missed: ["n1"], outcome: "surrendered" }), "n1"), 1);
		assert.equal(reviewRating(baseRecord({ missed: ["n2"], outcome: "movedOn" }), "n1"), 3);
		assert.equal(reviewRating(baseRecord({ rung: "R3" }), "n1"), 1);
		assert.equal(reviewRating(baseRecord({ outcome: "solved", rating: 4 }), "n1"), 4);
		assert.equal(reviewRating(baseRecord({ outcome: "dismissed" }), "n1"), null);
	});
	it("extracts successful problem/conclude tool-call pairs", () => {
		const messages = [
			{ role: "assistant", timestamp: 10, content: [{ type: "toolCall", id: "problem1", name: "problem", arguments: { target: ["n1"] } }] },
			{ role: "toolResult", toolCallId: "problem1", isError: false, timestamp: 11 },
			{ role: "assistant", timestamp: 20, content: [{ type: "toolCall", id: "conclude1", name: "conclude", arguments: { outcome: "solved", rung: null, missClass: null, rating: 4 } }] },
			{ role: "toolResult", toolCallId: "conclude1", isError: false, timestamp: 21 },
		] as unknown as LhMessage[];
		assert.deepEqual(practiceRecordsFromChat("p", messages), [{ chatId: "p", at: 20, targets: ["n1"], outcome: "solved", rung: null, missClass: null, rating: 4 }]);
	});
});

describe("delayed epistemic gate", () => {
	function state(records: PracticeRecord[], now: number) { return reviewState({ records, teachChatIds: new Set(["teach"]) }, [node], now).get("n1")!; }
	it("starts practiced, waits 24h, demonstrates after an unassisted pass, retains after seven days from demonstration, and lapses reset", () => {
		assert.equal(state([], 0).stage, "practiced");
		assert.equal(state([baseRecord({ chatId: "p1", at: DAY / 2, rating: 3 })], DAY).stage, "practiced");
		const demonstrated = baseRecord({ chatId: "p2", at: DAY, rating: 3 });
		assert.equal(state([demonstrated], DAY).stage, "demonstrated");
		// Reviewing 6 days after demonstration (7 days after birth) must remain demonstrated, not prematurely retained
		const tooSoonForRetained = baseRecord({ chatId: "p2b", at: 7 * DAY, rating: 3 });
		assert.equal(state([demonstrated, tooSoonForRetained], 7 * DAY).stage, "demonstrated");
		const retained = baseRecord({ chatId: "p3", at: 8 * DAY, rating: 3 });
		assert.equal(state([demonstrated, retained], 8 * DAY).stage, "retained");
		const lapse = baseRecord({ chatId: "p4", at: 9 * DAY, outcome: "movedOn" });
		assert.equal(state([demonstrated, retained, lapse], 9 * DAY).stage, "practiced");
	});
});

describe("due reviews and calibration", () => {
	it("orders review lane first, then new, and computes next due without spread", () => {
		const nodes = [node, { ...node, id: "n2", createdAt: new Date(DAY).toISOString() }];
		const items = new Map([
			["n1", { stability: 1, difficulty: 5, lastReview: 0, reviews: 1, retrievability: 0.4, dueAt: 0, lane: "review" as const, seedRating: 3 as const, stage: "practiced" as const }],
			["n2", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
		]);
		assert.deepEqual(dueReviews(items, nodes, [], DAY), { due: ["n1", "n2"], nextDueAt: null });
	});
	it("orders due premises before due conclusions within each lane, then releases conclusions to compete by retrievability and serves count", () => {
		const t0 = new Date(0).toISOString();
		const nodes: GraphNode[] = [
			{ ...node, id: "n_conc", name: "Conclusion", createdAt: t0 },
			{ ...node, id: "n_prem", name: "Premise", createdAt: t0 },
			{ ...node, id: "n_mid", name: "Unrelated Mid", createdAt: t0 },
			{ ...node, id: "n_new_leaf", name: "New Leaf", createdAt: t0 },
			{ ...node, id: "n_new_root", name: "New Root", createdAt: t0 },
		];
		const chains = [
			{ id: "arg_rev", premises: ["n_prem"], conclusion: "n_conc", createdAt: t0, provenance: [] },
			{ id: "arg_new", premises: ["n_new_root"], conclusion: "n_new_leaf", createdAt: t0, provenance: [] },
		];
		const items = new Map([
			// n_conc has lower retrievability (0.3) than n_prem (0.5) and n_mid (0.6), but depends on n_prem
			["n_conc", { stability: 1, difficulty: 5, lastReview: 0, reviews: 1, retrievability: 0.3, dueAt: 0, lane: "review" as const, seedRating: 3 as const, stage: "practiced" as const }],
			["n_prem", { stability: 1, difficulty: 5, lastReview: 0, reviews: 1, retrievability: 0.5, dueAt: 0, lane: "review" as const, seedRating: 3 as const, stage: "practiced" as const }],
			["n_mid", { stability: 1, difficulty: 5, lastReview: 0, reviews: 1, retrievability: 0.6, dueAt: 0, lane: "review" as const, seedRating: 3 as const, stage: "practiced" as const }],
			// In 'new', n_new_leaf ('n_new_leaf' < 'n_new_root' lexicographically) depends on n_new_root
			["n_new_leaf", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
			["n_new_root", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
		]);
		// In review: n_prem (0.5, ready) beats n_mid (0.6, ready); once n_prem is queued, n_conc (0.3) unlocks and beats n_mid (0.6).
		// In new: n_new_root precedes n_new_leaf despite 'n_new_leaf' < 'n_new_root'.
		assert.deepEqual(dueReviews(items, nodes, chains, DAY), {
			due: ["n_prem", "n_conc", "n_mid", "n_new_root", "n_new_leaf"],
			nextDueAt: null,
		});
	});
	it("handles cyclic chains gracefully without dropping due items", () => {
		const t0 = new Date(0).toISOString();
		const nodes: GraphNode[] = [
			{ ...node, id: "n_b", name: "B", createdAt: t0 },
			{ ...node, id: "n_a", name: "A", createdAt: t0 },
		];
		const chains = [
			{ id: "c1", premises: ["n_a"], conclusion: "n_b", createdAt: t0, provenance: [] },
			{ id: "c2", premises: ["n_b"], conclusion: "n_a", createdAt: t0, provenance: [] },
		];
		const items = new Map([
			["n_b", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
			["n_a", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
		]);
		assert.deepEqual(dueReviews(items, nodes, chains, DAY).due, ["n_a", "n_b"]);
	});
	it("ignores self-loops in serves count and handles duplicate premises without corrupting inDegree or deadlocking", () => {
		const t0 = new Date(0).toISOString();
		const nodes: GraphNode[] = [
			{ ...node, id: "n_0", name: "Zero", createdAt: t0 },
			{ ...node, id: "n_a", name: "A", createdAt: t0 },
			{ ...node, id: "n_b", name: "B", createdAt: t0 },
		];
		const chains = [
			// Self-loop: premise === conclusion. Must not count towards serves.
			{ id: "c_self", premises: ["n_0"], conclusion: "n_0", createdAt: t0, provenance: [] },
			// Duplicate premises: ["n_a", "n_a"]. Must count as 1 edge/serves and not deadlock inDegree.
			{ id: "c_dup", premises: ["n_a", "n_a"], conclusion: "n_b", createdAt: t0, provenance: [] },
		];
		const items = new Map([
			["n_0", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
			["n_a", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
			["n_b", { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: 0, lane: "new" as const, seedRating: 3 as const, stage: "practiced" as const }],
		]);
		// n_a serves n_b (serves: 1). n_0 has a self loop (serves: 0).
		// Because n_a has serves: 1 > n_0's serves: 0, n_a must precede n_0 despite 'n_0' < 'n_a'.
		assert.deepEqual(dueReviews(items, nodes, chains, DAY).due, ["n_a", "n_0", "n_b"]);
	});
	it("calibrates subsequent review outcomes", () => {
		const records = [baseRecord({ chatId: "p1", at: 0, rating: 4 }), baseRecord({ chatId: "p2", at: DAY, outcome: "solved" })];
		const result = reviewCalibration(records, [node]);
		assert.equal(result.n, 1);
		assert.ok(result.brier !== null && result.logLoss !== null);
	});
});
