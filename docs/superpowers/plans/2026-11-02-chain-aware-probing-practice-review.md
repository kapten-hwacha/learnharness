# Chain-Aware Probing, Practice Context, and FSRS Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Prober, Practice, and FSRS to reason over stored reasoning chains (`chains.jsonl`) by surfacing chains in `list_propositions` and `search_propositions`, auto-including supporting chains and missing direct premises when creating Practice sessions, and ordering FSRS `dueReviews` topologically within each lane.

**Architecture:** `src/core/chains.ts` gains three pure, browser-safe helpers (`practiceContextForSelection`, `sessionChainLines`, `nodeChainLines`) consumed by `app/api/chats/route.ts` and `src/agent/tools/graph.ts`. `dueReviews` in `src/core/review.ts` orders each lane (`"review"` first, then `"new"`) via a cycle-safe Kahn topological priority queue keyed by intrinsic FSRS priority (`retrievability ↑`, `serves ↓`, `createdAt ↑`, `id ↑`). Prompt segments in `src/agent/prompts/` document the new chain lines and `supporting premise` context tags.

**Tech Stack:** TypeScript, Node.js (`node:test`), Next.js App Router (`app/api/chats/route.ts`).

**Spec:** `docs/superpowers/specs/2026-11-02-chain-aware-probing-practice-review-design.md`

## Global Constraints

- `chainsForSelection` in `src/core/chains.ts` must remain unchanged so the Chain Table's UI selection bar and Teach session `graphContext` keep their exact current behavior.
- `list_propositions` in `src/agent/tools/graph.ts` must never include proposition `statement` prose—only proposition names, FSRS status, and formatted `Premise A, Premise B → Conclusion` chain lines.
- `src/core/chains.ts` and `src/core/review.ts` are re-exported through `src/core/index.ts` and must remain browser-safe (no Node built-ins or `fs`).
- Every modified file must pass `npm run typecheck` (`npx tsc --noEmit`) and `npm run lint`.

## Review Focus

1. Dangling chains referencing deleted or unknown node IDs: `practiceContextForSelection`, `sessionChainLines`, and `nodeChainLines` must skip any chain whose conclusion or any premise is missing from `allNodes`.
2. Teach vs. Practice `graphContext` in `POST /api/chats`: Auto-pulling missing direct premises (`supporting premise · ...`) must only happen when `kind === "practice"`, leaving Teach sessions (`kind === undefined`) with only the explicitly picked propositions.
3. Cross-session premises in `list_propositions`: When a conclusion born in session `c2` is derived from a premise born in session `c1`, `sessionChainLines` must resolve the premise's display name from `allNodes` rather than printing a raw `n_...` ID.
4. Multi-premise chains with duplicate premises or self-loops in `dueReviews`: `serves` count and `inDegree` in `dueReviews` must deduplicate premises per chain and ignore `premise === conclusion` so no node ever deadlocks itself.
5. Cyclic chains in `dueReviews`: If `chains` ever contains a cycle among due items, the Kahn queue fallback must still emit all due items in deterministic intrinsic priority order without dropping any.

---

### Task 1: Pure Chain Helpers (`src/core/chains.ts`) & Practice `graphContext` Expansion (`app/api/chats/route.ts`)

**Files:**
- Modify: `src/core/chains.ts:1-93`
- Modify: `app/api/chats/route.ts:49-77`
- Test: `tests/graph-context.test.ts`

**Interfaces:**
- Consumes: `GraphNode` from `./contracts/graph.ts`; `readReview` from `@/src/server`
- Produces:
  - `export interface PracticeSelectionContext { supportingNodes: GraphNode[]; chains: ReasoningChain[] }` in `src/core/chains.ts`
  - `export function practiceContextForSelection(pickedNodes: ReadonlyArray<GraphNode>, allNodes: ReadonlyArray<GraphNode>, chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>): PracticeSelectionContext` in `src/core/chains.ts`
  - `export function sessionChainLines(sessionNodeIds: ReadonlySet<string>, allNodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>, chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>): string[]` in `src/core/chains.ts`
  - `export function nodeChainLines(nodeId: string, allNodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>, chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>): { incoming: string[]; outgoing: string[] }` in `src/core/chains.ts`

- [ ] **Step 1: Write failing tests in `tests/graph-context.test.ts`**

Add imports `practiceContextForSelection, sessionChainLines, nodeChainLines` from `"../src/core/chains.ts"` and append tests to `tests/graph-context.test.ts`:

```ts
describe("practiceContextForSelection & chain line helpers", () => {
	const allNodes = [
		{ id: "n_p1", name: "Premise 1", statement: "S1", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] },
		{ id: "n_p2", name: "Premise 2", statement: "S2", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] },
		{ id: "n_c", name: "Conclusion", statement: "SC", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] },
		{ id: "n_solo", name: "Solo", statement: "SS", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] },
	];
	const chains = [
		{ id: "arg_1", premises: ["n_p2", "n_p1"], conclusion: "n_c" },
		{ id: "arg_dangling", premises: ["n_missing"], conclusion: "n_c" },
	];

	it("auto-pulls missing direct premises for picked conclusions, skips dangling chains, and keeps unchained picks as singletons", () => {
		const ctx = practiceContextForSelection([allNodes[2]!, allNodes[3]!], allNodes, chains);
		assert.deepEqual(ctx.supportingNodes.map((n) => n.id), ["n_p1", "n_p2"]);
		assert.deepEqual(ctx.chains, [
			{ id: "arg_1", premises: ["n_p1", "n_p2"], conclusion: "n_c" },
			{ id: "n_solo", premises: [], conclusion: "n_solo" },
		]);
	});

	it("sessionChainLines and nodeChainLines format live chains deterministically and skip dangling endpoints", () => {
		assert.deepEqual(
			sessionChainLines(new Set(["n_c"]), allNodes, chains),
			["Premise 1, Premise 2 → Conclusion"],
		);
		assert.deepEqual(
			nodeChainLines("n_p1", allNodes, chains),
			{ incoming: [], outgoing: ["Premise 1, Premise 2 → Conclusion"] },
		);
		assert.deepEqual(
			nodeChainLines("n_c", allNodes, chains),
			{ incoming: ["Premise 1, Premise 2 → Conclusion"], outgoing: [] },
		);
	});
});
```

And inside `describe("POST /api/chats — graphContext becomes message[0]", ...)` in `tests/graph-context.test.ts`, add:

```ts
	it("auto-pulls missing direct premises tagged as 'supporting premise' for practice sessions only, not teach sessions", async () => {
		const node = (id: string, name: string, statement: string) => ({
			id, name, statement, aliases: [] as string[], createdAt: "2026-10-01T00:00:00.000Z", provenance: [],
		});
		graphStore.appendNode(node("n_prem", "Cauchy-Schwarz", "Inner product bound."));
		graphStore.appendNode(node("n_conc", "Triangle inequality", "Norm of sum bound."));
		graphStore.appendChain({
			id: "arg_tri", premises: ["n_prem"], conclusion: "n_conc",
			provenance: [], createdAt: "2026-10-01T00:00:00.000Z",
		});

		const onlyConclusion = [{ id: "n_conc", name: "Triangle inequality", statement: "Norm of sum bound." }];

		const pracRes = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "practice norms", kind: "practice", graphContext: { propositions: onlyConclusion } }),
		}));
		const { id: pracId } = (await pracRes.json()) as { id: string };
		const pracMsg = chatStore.getChat(pracId)!.messages[0] as { content: string };
		assert.ok(pracMsg.content.includes("- [n_conc] Triangle inequality (new): Norm of sum bound."));
		assert.ok(pracMsg.content.includes("- [n_prem] Cauchy-Schwarz (supporting premise · new): Inner product bound."));
		assert.ok(pracMsg.content.includes("- Cauchy-Schwarz → Triangle inequality"));

		const teachRes = await POST(new Request("http://test/api/chats", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "teach norms", graphContext: { propositions: onlyConclusion } }),
		}));
		const { id: teachId } = (await teachRes.json()) as { id: string };
		const teachMsg = chatStore.getChat(teachId)!.messages[0] as { content: string };
		assert.ok(teachMsg.content.includes("- [n_conc] Triangle inequality: Norm of sum bound."));
		assert.ok(!teachMsg.content.includes("n_prem"));
		assert.ok(teachMsg.content.includes("- Triangle inequality (no premises)"));
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/graph-context.test.ts`
Expected: FAIL (`practiceContextForSelection` is not exported from `../src/core/chains.ts`).

- [ ] **Step 3: Implement `practiceContextForSelection`, `sessionChainLines`, and `nodeChainLines` in `src/core/chains.ts` and wire `app/api/chats/route.ts`**

In `src/core/chains.ts`:
- Implement `practiceContextForSelection`, `sessionChainLines`, and `nodeChainLines` per Spec §3.1.
- Ensure `sessionChainLines` and `nodeChainLines` build a `{ [id]: { name } }` lookup map from `allNodes`, verify all chain endpoints exist in `allNodes`, sort matching chains by `chain.id` ascending, and format each via `formatChainLine`.

In `app/api/chats/route.ts`:
- Import `practiceContextForSelection` from `@/src/core`.
- When `picks.length > 0`:
  - Read `allNodes = stores.graphStore.readNodes()`, `allChains = stores.graphStore.readChains()`, and `byId = new Map(allNodes.map((n) => [n.id, n]))`.
  - When `kind === "practice"`, tag primary `picks`, call `practiceContextForSelection(pickedNodes, allNodes, allChains)`, build `supportingPicks` with tag `supporting premise · new` or `supporting premise · review · ${item.stage} · last practised ${days} days ago`, and pass `[...picks, ...supportingPicks]` and `chainLines` to `newGraphContextMessage`.
  - When `kind !== "practice"`, keep `chainsForSelection(pickedNodes, allChains)` and `newGraphContextMessage(picks, chainLines)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/graph-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/chains.ts app/api/chats/route.ts tests/graph-context.test.ts
git commit -m "feat(practice): auto-include supporting chains and direct premises in practice graphContext"
```

---

### Task 2: Chain-Aware Prober & Practice Graph Tools (`src/agent/tools/graph.ts`)

**Files:**
- Modify: `src/agent/tools/graph.ts:103-168`
- Test: `tests/graph-tools.test.ts`
- Test: `tests/prober-regroup-tools.test.ts`

**Interfaces:**
- Consumes: `sessionChainLines`, `nodeChainLines` from `../../core/chains.ts`; `getGraph` from `../../core/graph.ts`
- Produces:
  - Updated `list_propositions` tool output in `src/agent/tools/graph.ts` appending `Reasoning chains (premises → conclusion):` when session chains exist
  - Updated `search_propositions` tool output in `src/agent/tools/graph.ts` appending indented `derived from:` and `used to derive:` lines beneath each candidate

- [ ] **Step 1: Write failing tests in `tests/graph-tools.test.ts` and `tests/prober-regroup-tools.test.ts`**

In `tests/graph-tools.test.ts`:
- Update `fakeStores` to accept `chains?: GraphChain[]` in `over` (`const chains: GraphChain[] = over.chains ?? [];`).
- Inside `describe("list_propositions", ...)`, add:

```ts
	it("appends reasoning chains for the session, resolving cross-session premise names without leaking statement prose", async () => {
		const { chatStore, graphStore } = fakeStores(
			[
				node("n_other", "Solar radiation", [pt("c_other")]),
				node("n1", "Evaporation", [pt("c1")]),
				node("n2", "Precipitation", [pt("c1")]),
			],
			{
				chains: [
					{
						id: "arg_1",
						premises: ["n_other", "n1"],
						conclusion: "n2",
						createdAt: "2026-09-23T00:00:00.000Z",
						provenance: [pt("c1")],
					},
				],
			},
		);
		const tools = createProberTools({ ...baseCtx, chatStore, graphStore });
		const out = (await tools.list_propositions!.execute!("tc", { session: "c1" })).details as string;
		assert.match(out, /2 proposition\(s\) covered in this session:/);
		assert.match(out, /Reasoning chains \(premises → conclusion\):\n- Solar radiation, Evaporation → Precipitation/);
		assert.ok(!out.includes("statement of"));
	});
```

In `tests/prober-regroup-tools.test.ts`:
- Update `fakeStores` to accept `chains?: GraphChain[]` in `over` (`const chains = [...(over.chains ?? [])];`).
- Inside `describe("search_propositions tool", ...)`, add:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/graph-tools.test.ts tests/prober-regroup-tools.test.ts`
Expected: FAIL (`Reasoning chains` and `derived from:` are absent from tool outputs).

- [ ] **Step 3: Update `list_propositions` and `search_propositions` in `src/agent/tools/graph.ts`**

In `src/agent/tools/graph.ts`:
- Import `nodeChainLines, sessionChainLines` from `"../../core/chains.ts"`.
- In `list_propositions`:
  - Read `const graph = getGraph(deps.graphStore)`.
  - Compute `const chainLines = sessionChainLines(new Set(propositions.map((p) => p.nodeId)), graph.nodes, graph.chains)`.
  - Append `\n\nReasoning chains (premises → conclusion):\n${chainLines.map((c) => `- ${c}`).join("\n")}` when `chainLines.length > 0`.
  - Update `list_propositions.description` to note that it also lists the reasoning chains (`premises → conclusion`) derived in that session.
- In `search_propositions`:
  - Read `const graph = getGraph(deps.graphStore)` and use `graph.nodes` and `graph.chains`.
  - For each candidate `c`, call `nodeChainLines(c.node.id, graph.nodes, graph.chains)` and append indented lines `   derived from: ${line}` for each item in `incoming` and `   used to derive: ${line}` for each item in `outgoing`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/graph-tools.test.ts tests/prober-regroup-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/graph.ts tests/graph-tools.test.ts tests/prober-regroup-tools.test.ts
git commit -m "feat(graph-tools): surface reasoning chains in list_propositions and search_propositions"
```

---

### Task 3: Topological `dueReviews` Queue (`src/core/review.ts`) & Prompt Doctrine (`src/agent/prompts/`)

**Files:**
- Modify: `src/core/review.ts:142-157`
- Modify: `src/agent/prompts/prober/10-probe-doctrine.md:7-16`
- Modify: `src/agent/prompts/practice/00-base.md:5-13`
- Test: `tests/review.test.ts`
- Test: `tests/prompt-overrides.test.ts`

**Interfaces:**
- Consumes: `PropositionReviewState`, `GraphNode`, `GraphChain` from `./contracts.ts`
- Produces:
  - Updated `dueReviews(state, nodes, chains, now)` in `src/core/review.ts` implementing per-lane Kahn topological priority ordering and `serves`-first tie-breaking in the `"new"` lane
  - Updated prompt instructions in `src/agent/prompts/prober/10-probe-doctrine.md` and `src/agent/prompts/practice/00-base.md`

- [ ] **Step 1: Write failing tests in `tests/review.test.ts`**

Inside `describe("due reviews and calibration", ...)` in `tests/review.test.ts`, add:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/review.test.ts`
Expected: FAIL (`dueReviews` puts `n_conc` before `n_prem` and `n_new_leaf` before `n_new_root`).

- [ ] **Step 3: Implement topological `dueReviews` in `src/core/review.ts` and update prompts in `src/agent/prompts/`**

In `src/core/review.ts`:
- Update `dueReviews` per Spec §3.4:
  - Deduplicate premises per chain when computing `serves`.
  - Split due entries into `reviewEntries` and `newEntries`.
  - Order each lane via Kahn's algorithm (`orderLane`) using `compareEntry` (in `"review"`: `retrievability ↑`, `serves ↓`, `createdAt ↑`, `id ↑`; in `"new"`: `serves ↓`, `createdAt ↑`, `id ↑`) with cycle fallback.

In `src/agent/prompts/prober/10-probe-doctrine.md` (`§1. Read his persistent map`):
- Note that `list_propositions` and `search_propositions` also surface the reasoning chains (`Premises → Conclusion`) so the prober can see which propositions are foundational premises vs. derived conclusions when bracketing a strand.

In `src/agent/prompts/practice/00-base.md` (`## The opening — straight to problems`):
- Under `Picked propositions`, note that propositions tagged `supporting premise` in the session context are included to complete the reasoning chains of the picked targets; focus primary recall/discrimination demands on the picked targets, and use supporting premises freely in composition, reverse, or premise-probing demands (tagging them in `target` whenever a problem requires retrieving them at a decision point).

- [ ] **Step 4: Run tests, typecheck, and lint to verify everything passes**

Run: `npx tsx --test tests/review.test.ts tests/prompt-overrides.test.ts tests/prober-doctrine.test.ts tests/graph-context.test.ts tests/graph-tools.test.ts tests/prober-regroup-tools.test.ts && npm run typecheck && npm run lint`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/review.ts src/agent/prompts/prober/10-probe-doctrine.md src/agent/prompts/practice/00-base.md tests/review.test.ts
git commit -m "feat(review): order dueReviews topologically and document chain context in prompts"
```
