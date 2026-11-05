# Chain-Aware Probing, Practice Context, and FSRS Review Queue — Design Specification

**Date:** 2026-11-02  
**Status:** Draft (Pending User Spec Review)  
**Topic:** Exposing hypergraph reasoning chains (`chains.jsonl`) to Prober/Practice graph tools, auto-including supporting premises in Practice session context, and ordering FSRS due reviews topologically

---

## 1. Problem & Context

LearnHarness stores knowledge as a directed B-hypergraph: propositions (`nodes.jsonl`) connected by joint-premise reasoning chains (`chains.jsonl`, where `premises[] ⟹ conclusion`). However, three key downstream consumers currently ignore or drop this chain topology:

1. **Prober & Practice Graph Tools Are Chain-Blind (`src/agent/tools/graph.ts`):**
   `list_propositions` and `search_propositions` return flat lists of propositions and FSRS review statuses without surfacing any reasoning chains. When calibrating a new teaching session or exploring the graph in practice, the agent cannot see which propositions are foundational premises vs. derived conclusions, or how propositions in a session derive from one another.
2. **Practice Session Context Drops Supporting Chains When Premises Aren't Simultaneously Selected (`app/api/chats/route.ts`, `src/core/chains.ts`):**
   `POST /api/chats` builds the initial `graph-context` message using `chainsForSelection(pickedNodes, chains)`, which only retains a chain if its conclusion **and every one of its premises** are in `pickedNodes`. In **"Practice what's due"** (or when a learner selects a conclusion node to practice), if conclusion $C$ is due today but premise $P_1$ is not due until next week, the chain $P_1, P_2 \to C$ is dropped and $C$ is presented as `(no premises)`—preventing Composition, Reverse, and Probe-the-Premises demands on $C$.
3. **FSRS `dueReviews` Queue Ignores Prerequisite Topology (`src/core/review.ts`):**
   - In the `"review"` lane, items sort by exact floating-point `retrievability`, so `serves` (how many chains a node feeds as a premise) almost never breaks ties, and a due conclusion $C$ is frequently queued ahead of its own due premise $P$.
   - In the `"new"` lane, items sort by `createdAt` then `id`. Because propositions extracted in the same batch share an identical `createdAt` timestamp, new propositions from a teaching session sort by random hex ID (`n_...`), often scheduling derived conclusions before their foundational premises.

---

## 2. Goals & Scope

1. **Expose Reasoning Chains in `list_propositions` and `search_propositions`:**
   - `list_propositions({ session })` appends a `Reasoning chains (premises → conclusion):` section for live chains whose conclusion belongs to that session, while keeping the proposition list itself strictly names + FSRS status (no statement prose).
   - `search_propositions({ query, limit })` lists each matched candidate's incoming derivations (`derived from: ...`) and outgoing derivations (`used to derive: ...`) indented beneath the candidate line.
2. **Auto-Include Supporting Chains & Direct Premises for Practice Sessions:**
   - When creating a **Practice** session (`kind === "practice"`) in `POST /api/chats` with `graphContext.propositions`, include every live chain whose `conclusion` is in `picks` (even when one or more premises were not in `picks`).
   - Auto-pull any missing direct premises of those chains into the session's `graph-context` propositions list, tagged as `supporting premise · <review status>` so the Practice agent knows which items are primary due/picked targets vs. supporting context and has their IDs and statements available.
   - Keep Teach session `graphContext` and the Chain Table's UI selection bar strictly to what was explicitly selected (`chainsForSelection` unchanged).
3. **Dependency-Respecting Topological Queue in `dueReviews`:**
   - Within each lane (`"review"` first, then `"new"`), order due propositions using Kahn's algorithm with a priority queue so that a due premise $P$ always precedes any due conclusion $C$ that depends on it in the same lane. Once $P$ is queued, $C$ becomes eligible and competes on its own intrinsic priority (`retrievability ↑`, `serves ↓`, `createdAt ↑`, `id ↑`).

---

## 3. Architecture & Data Contracts

### 3.1 Pure Chain Helpers (`src/core/chains.ts`, `src/core/index.ts`)

Keep `chainsForSelection` and `formatChainLine` unchanged, and add three pure, browser-safe helpers in `src/core/chains.ts` (re-exported through `src/core/index.ts`):

```ts
export interface PracticeSelectionContext {
	/** Supporting premise nodes not in the initial picks, in deterministic id order. */
	supportingNodes: GraphNode[];
	/** Reasoning chains whose conclusion is in picks (and all premises exist in allNodes),
	 *  plus singleton chains for picked nodes that participate in no included chain. */
	chains: ReasoningChain[];
}

export function practiceContextForSelection(
	pickedNodes: ReadonlyArray<GraphNode>,
	allNodes: ReadonlyArray<GraphNode>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): PracticeSelectionContext
```

- **Behavior of `practiceContextForSelection`:**
  1. Build `byId = new Map(allNodes.map((n) => [n.id, n]))` and `pickedSet = new Set(pickedNodes.map((n) => n.id))`.
  2. Filter `chains` to live chains where `pickedSet.has(chain.conclusion)` and `chain.premises.every((p) => byId.has(p))`.
  3. For each included chain:
     - Add `{ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion }` to `included`.
     - Mark `chain.conclusion` and every `p` in `chain.premises` in `chained`.
     - For each `p` in `chain.premises`, if `!pickedSet.has(p)`, add `byId.get(p)!` to `supportingMap`.
  4. For each `node` in `pickedNodes`, if `!chained.has(node.id)`, add `{ id: node.id, premises: [], conclusion: node.id }` to `included`.
  5. Sort `included` by `id` ascending and `supportingNodes` by `id` ascending.

```ts
/** Formatted chain lines ("Premise A, Premise B → Conclusion") for all live
 *  chains whose conclusion belongs to sessionNodeIds, sorted by chain id. */
export function sessionChainLines(
	sessionNodeIds: ReadonlySet<string>,
	allNodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): string[]

/** Formatted incoming (conclusion === nodeId) and outgoing (premises includes nodeId)
 *  live chain lines for a single proposition node, sorted by chain id. */
export function nodeChainLines(
	nodeId: string,
	allNodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): { incoming: string[]; outgoing: string[] }
```

### 3.2 Practice `graph-context` Assembly (`app/api/chats/route.ts`)

In `POST /api/chats` when `picks.length > 0`:
- Read `allNodes = stores.graphStore.readNodes()` and `allChains = stores.graphStore.readChains()`, and build `byId = new Map(allNodes.map((n) => [n.id, n]))`.
- Format helper for review tags:
  ```ts
  const formatReviewTag = (item: PropositionReviewState | undefined, now: number, prefix?: string): string => {
  	const base =
  		!item || item.lastReview === null
  			? "new"
  			: `review · ${item.stage} · last practised ${Math.max(0, Math.floor((now - item.lastReview) / 86_400_000))} days ago`;
  	return prefix ? `${prefix} · ${base}` : base;
  };
  ```
- **When `kind === "practice"`:**
  1. Compute `review = readReview()` and `now = Date.now()`.
  2. Tag each `pick` in `picks` with `formatReviewTag(review.state.get(pick.id), now)`.
  3. Compute `const { supportingNodes, chains } = practiceContextForSelection(pickedNodes, allNodes, allChains)`.
  4. Map `supportingNodes` to `supportingPicks: GraphContextPick[]`:
     ```ts
     {
     	id: node.id,
     	name: node.name,
     	statement: node.statement,
     	tag: formatReviewTag(review.state.get(node.id), now, "supporting premise"),
     }
     ```
  5. Format `chainLines = chains.map((c) => formatChainLine(c, Object.fromEntries(byId)))`.
  6. Save `[newGraphContextMessage([...picks, ...supportingPicks], chainLines)]`.
- **When `kind !== "practice"`:**
  - Preserve existing behavior: `chainsForSelection(pickedNodes, allChains)` and `newGraphContextMessage(picks, chainLines)`.

### 3.3 Prober & Practice Graph Tools (`src/agent/tools/graph.ts`)

1. **`list_propositions({ session })`:**
   - Read `const graph = getGraph(deps.graphStore)`.
   - Compute `lines` for each proposition in `propositions` as today (`- ${p.name} · ${formatPropositionReviewSuffix(state.get(p.nodeId), now)}`).
   - Compute `chainLines = sessionChainLines(new Set(propositions.map((p) => p.nodeId)), graph.nodes, graph.chains)`.
   - If `chainLines.length === 0`, return `${propositions.length} proposition(s) covered in this session:\n${lines.join("\n")}`.
   - If `chainLines.length > 0`, append:
     `\n\nReasoning chains (premises → conclusion):\n${chainLines.map((c) => `- ${c}`).join("\n")}`.
2. **`search_propositions({ query, limit })`:**
   - Read `const graph = getGraph(deps.graphStore)` (giving both `graph.nodes` and `graph.chains`).
   - For each candidate `c`, build the headline:
     `${i + 1}. [${c.node.id}] "${c.node.name}": ${c.node.statement} (Current subject: "${subject}" · ${formatPropositionReviewSuffix(state.get(c.node.id), now)})`
   - Compute `const { incoming, outgoing } = nodeChainLines(c.node.id, graph.nodes, graph.chains)`.
   - Append indented sub-lines when present:
     - For each `line` in `incoming`: `   derived from: ${line}`
     - For each `line` in `outgoing`: `   used to derive: ${line}`

### 3.4 Topological Foundation-First `dueReviews` (`src/core/review.ts`)

In `dueReviews(state, nodes, chains, now)`:

1. Compute `byId = new Map(nodes.map((node) => [node.id, node]))` and `serves = new Map<string, number>()` (for each `chain` in `chains`, each unique `premise` in `chain.premises` increments `serves`).
2. Filter `[...state]` to due entries (`value.dueAt <= now`), and split into `reviewEntries` (`value.lane === "review"`) and `newEntries` (`value.lane === "new"`).
3. Define the intrinsic comparator `compareEntry([aId, a], [bId, b])`:
   - If `a.lane === "review"`:
     - If `a.retrievability !== b.retrievability`, return `(a.retrievability ?? 1) - (b.retrievability ?? 1)`.
     - If `(serves.get(aId) ?? 0) !== (serves.get(bId) ?? 0)`, return `(serves.get(bId) ?? 0) - (serves.get(aId) ?? 0)`.
     - Return `parseTimestamp(byId.get(aId)?.createdAt) - parseTimestamp(byId.get(bId)?.createdAt) || aId.localeCompare(bId)`.
   - If `a.lane === "new"`:
     - If `(serves.get(aId) ?? 0) !== (serves.get(bId) ?? 0)`, return `(serves.get(bId) ?? 0) - (serves.get(aId) ?? 0)`.
     - Return `parseTimestamp(byId.get(aId)?.createdAt) - parseTimestamp(byId.get(bId)?.createdAt) || aId.localeCompare(bId)`.
4. Define `orderLane(laneEntries)`:
   - Build `entryById = new Map(laneEntries)` and `laneSet = new Set(entryById.keys())`.
   - Build directed adjacency `dependents = new Map<string, Set<string>>()` and `inDegree = new Map<string, number>()` (initialized to `0` for each `id` in `laneSet`):
     - For each `chain` in `chains`:
       - If `!laneSet.has(chain.conclusion)` continue.
       - For each `premise` in `chain.premises`:
         - If `!laneSet.has(premise) || premise === chain.conclusion` continue.
         - If `!dependents.get(premise)?.has(chain.conclusion)`:
           - Add `chain.conclusion` to `dependents.get(premise)`.
           - Increment `inDegree` of `chain.conclusion`.
   - Seed `ready` with all `[id, val]` in `laneEntries` where `inDegree.get(id) === 0`.
   - While `ready.length > 0`:
     - Sort `ready` with `compareEntry` and shift the first entry `[uId]`.
     - Push `uId` to `ordered` and mark `uId` in `scheduled`.
     - For each `vId` in `dependents.get(uId) ?? []`:
       - Decrement `inDegree` of `vId`; if it reaches `0`, push `[vId, entryById.get(vId)!]` to `ready`.
   - **Cycle fallback:** If `scheduled.size < laneEntries.length`, collect all unscheduled entries from `laneEntries`, sort them by `compareEntry`, and append their IDs to `ordered`.
5. Concatenate `[...orderLane(reviewEntries), ...orderLane(newEntries)]` as `due`, and compute `nextDueAt` as today.

### 3.5 Prompt Doctrine Updates

1. **`src/agent/prompts/prober/10-probe-doctrine.md` (`§1. Read his persistent map`):**
   - Note that `list_propositions` and `search_propositions` also show reasoning chains (`Premises → Conclusion`) so the prober can see which propositions are foundational premises vs. derived conclusions when bracketing a strand.
2. **`src/agent/prompts/practice/00-base.md` (`## The opening — straight to problems`):**
   - Note that propositions tagged `supporting premise` in the session context are included to complete the reasoning chains of the picked targets; focus primary demands on the picked targets and use supporting premises freely in composition, reverse, or premise-probing demands (tagging them in `target` whenever a problem requires retrieving them at a decision point).

---

## 4. Verification & Testing Plan

1. **`tests/chains.test.ts` (or `tests/practice-flow.test.ts`):**
   - Test `practiceContextForSelection`: includes chains whose conclusion is picked, pulls missing direct premises into `supportingNodes` in deterministic order, omits chains with missing graph nodes, and emits singletons only for picked nodes in no included chain.
   - Test `sessionChainLines` and `nodeChainLines`: deterministic ordering, cross-session premise name resolution, and empty-chain behavior.
2. **`tests/graph-tools.test.ts` & `tests/prober-regroup-tools.test.ts`:**
   - Verify `list_propositions` appends `Reasoning chains (premises → conclusion):` when chains exist for the session, omits it when no chains exist, and never leaks statement text.
   - Verify `search_propositions` appends indented `derived from:` and `used to derive:` lines when a candidate participates in chains.
3. **`tests/review.test.ts`:**
   - Verify `dueReviews` orders due premises before their due conclusions in both `"review"` and `"new"` lanes.
   - Verify that once a due premise in `"review"` is scheduled, its due conclusion competes by its own `retrievability` against unrelated due nodes.
   - Verify that in `"new"`, nodes with identical `createdAt` order by topological prerequisite order and `serves` count rather than raw hex ID.
   - Verify cycle fallback never drops due items.
