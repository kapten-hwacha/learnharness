# Cross-Subject Node Regrouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the prober agent to review existing knowledge graph nodes from other subjects when starting a new subject, and automatically regroup matching nodes to the new subject.

**Architecture:** An append-only ledger `regroups.jsonl` tracks node reassignments to sessions without mutating original birth provenance. Graph derivations compute `effectiveSessionOf` to dynamically place regrouped nodes into the active subject's cluster hulls, centroid pulls, and chain-table groups. The prober receives two new tools: `search_propositions` and `regroup_propositions`, guided by prompt doctrine.

**Tech Stack:** TypeScript, Node.js (`node:test`), Next.js / React, TypeBox, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-11-02-cross-subject-node-regrouping-design.md`

## Global Constraints

- Never mutate `nodes.jsonl` provenance lines for regrouping; historical birth session (`provenance[0]`) remains immutable.
- Regroupings are persisted in `regroups.jsonl` (format version 1 compatible, append-only, idempotent per node latest line).
- Browser-safe pure logic in `src/core/` must not import Node built-ins or `fs` (`src/core/session-clusters.ts`).
- Context injection is prohibited; the prober accesses the graph exclusively through tool calls (`search_propositions`, `regroup_propositions`).
- Every modified file must pass `npm run typecheck` and `npm run lint`.

## Review Focus

1. Corrupted or empty `regroups.jsonl`: Reader must tolerate missing file and skip malformed lines without throwing.
2. Multiple reassignments of the same node: Derivation must honor the latest valid line for that `nodeId`.
3. Node assigned to missing/deleted session: Cluster partition must fall back gracefully to unlabeled group or original birth session.
4. Search tool query handling: Empty or whitespace-only queries must fail validation cleanly; Unicode and negation words must be searchable.
5. Chain table rendering: Regrouped chains with multi-premises must render under the conclusion's effective cluster without duplicate cluster groups.

---

### Task 1: Contracts, Ledger Configuration & GraphStore Port

**Files:**
- Modify: `src/core/contracts/graph.ts`
- Modify: `config.ts`
- Modify: `src/core/ports.ts`
- Modify: `src/store/graph.ts`
- Test: `tests/regroups-store.test.ts`

- [ ] **Step 1: Write the failing store test**
  - Create `tests/regroups-store.test.ts` testing `appendRegroup`, `readRegroups`, handling missing file, and filtering invalid lines.
  - Run `npx tsx --test tests/regroups-store.test.ts` and verify it fails due to missing methods/contracts.

- [ ] **Step 2: Add contract and schema definitions**
  - In `src/core/contracts/graph.ts`, add `GraphRegroup` interface.
  - In `config.ts`, add `regroups: path.join(PATHS.graph, "regroups.jsonl")` to `LEDGER_FILES`.
  - In `src/core/ports.ts`, extend `GraphStore` with `appendRegroup(regroup: GraphRegroup): void` and `readRegroups(): readonly GraphRegroup[]`.

- [ ] **Step 3: Implement ledger operations in `src/store/graph.ts`**
  - Add `isGraphRegroup(val: unknown): val is GraphRegroup` validator.
  - Implement `appendRegroup` using `appendLine(LEDGER_FILES.regroups, regroup)`.
  - Implement `readRegroups` using `readValid(LEDGER_FILES.regroups, isGraphRegroup)`.
  - Ensure `clearGraphStore` / test helpers also clean or reset `regroups.jsonl`.

- [ ] **Step 4: Run tests and verify passing**
  - Run `npx tsx --test tests/regroups-store.test.ts`.
  - Run `npm run typecheck`.

- [ ] **Step 5: Commit changes**
  - `git add config.ts src/core/contracts/graph.ts src/core/ports.ts src/store/graph.ts tests/regroups-store.test.ts`
  - `git commit -m "feat(graph): add GraphRegroup contract and ledger store"`

---

### Task 2: Core Derivations (`effectiveSessionOf`, `birthSessionPartition`, `graphSnapshot`)

**Files:**
- Modify: `src/core/session-clusters.ts`
- Modify: `src/core/graph.ts`
- Modify: `src/core/contracts/graph.ts`
- Test: `tests/session-clusters-regroup.test.ts`
- Test: `tests/graph-snapshot-regroup.test.ts`

- [ ] **Step 1: Write failing derivation tests**
  - Create `tests/session-clusters-regroup.test.ts` testing:
    - `effectiveSessionOf` returning birth session when no regroup exists, and regrouped session when regrouped.
    - `birthSessionPartition` placing regrouped nodes in the target session community.
    - `attachImpToCommunities` deriving imp node cluster from majority effective sessions of premises.
  - Create `tests/graph-snapshot-regroup.test.ts` testing:
    - `graphSnapshot` assembling clusters with regrouped nodes and outputting `snapshot.regroups`.
  - Run `npx tsx --test tests/session-clusters-regroup.test.ts tests/graph-snapshot-regroup.test.ts` and verify they fail.

- [ ] **Step 2: Update `src/core/session-clusters.ts`**
  - Export `effectiveSessionOf(node, regroupMap?: ReadonlyMap<string, string>): string | null`.
  - Update `birthSessionPartition(nodes, regroupMap?: ReadonlyMap<string, string>)` to use `effectiveSessionOf`.
  - Update `attachImpToCommunities(clusters, nodes, chains, regroupMap?: ReadonlyMap<string, string>)` to evaluate majority premise clusters with `effectiveSessionOf`.

- [ ] **Step 3: Update `src/core/graph.ts` and `GraphSnapshot` contract**
  - In `src/core/contracts/graph.ts`, add `regroups?: Record<string, string>` to `GraphSnapshot`.
  - In `src/core/graph.ts` `graphSnapshot`:
    - Call `deps.graphStore.readRegroups()`.
    - Build `regroupMap: Map<string, string>` (latest entry per `nodeId`).
    - Register each regrouped node's `targetSessionId` into `nodeChats` / `nodeSessions`.
    - Pass `regroupMap` into `birthSessionPartition` and `attachImpToCommunities`.
    - Return `regroups: Object.fromEntries(regroupMap)` in snapshot.

- [ ] **Step 4: Run tests and verify passing**
  - Run `npx tsx --test tests/session-clusters-regroup.test.ts tests/graph-snapshot-regroup.test.ts`.
  - Run existing `npx tsx --test tests/graph.test.ts` to ensure no regression.
  - Run `npm run typecheck`.

- [ ] **Step 5: Commit changes**
  - `git add src/core/session-clusters.ts src/core/graph.ts src/core/contracts/graph.ts tests/session-clusters-regroup.test.ts tests/graph-snapshot-regroup.test.ts`
  - `git commit -m "feat(graph): derive clusters with effectiveSessionOf and snapshot regroups"`

---

### Task 3: Prober Tools (`search_propositions` & `regroup_propositions`)

**Files:**
- Modify: `src/agent/tools/graph.ts`
- Modify: `src/agent/tools.ts`
- Test: `tests/prober-regroup-tools.test.ts`

- [ ] **Step 1: Write failing tool tests**
  - Create `tests/prober-regroup-tools.test.ts` testing:
    - `search_propositions` returns matching propositions with name, statement, current subject, and excludes current session.
    - `regroup_propositions` validates node IDs, appends to `regroups.jsonl`, returns confirmation summary.
    - Ignores nodes already in current session.
  - Run `npx tsx --test tests/prober-regroup-tools.test.ts` and verify it fails.

- [ ] **Step 2: Add `chatId` to `GraphToolContext`**
  - In `src/agent/tools/graph.ts`, add `chatId?: string` to `GraphToolContext`.
  - In `src/agent/tools.ts`, pass `ctx.chatId` into `proberGraphTools`.

- [ ] **Step 3: Implement `search_propositions` and `regroup_propositions`**
  - In `src/agent/tools/graph.ts`:
    - Define `searchPropositionsInput` and `regroupPropositionsInput` TypeBox schemas.
    - Implement `search_propositions`: use `createPropositionCandidateSearch` over `getGraph(deps.graphStore).nodes`, look up current session titles, format readable output.
    - Implement `regroup_propositions`: validate nodes, append `GraphRegroup` lines to `deps.graphStore`, return readable output.

- [ ] **Step 4: Run tests and verify passing**
  - Run `npx tsx --test tests/prober-regroup-tools.test.ts`.
  - Run `npm run typecheck`.

- [ ] **Step 5: Commit changes**
  - `git add src/agent/tools/graph.ts src/agent/tools.ts tests/prober-regroup-tools.test.ts`
  - `git commit -m "feat(agent): add search_propositions and regroup_propositions prober tools"`

---

### Task 4: UI Surfaces (`components/chain-table.tsx`)

**Files:**
- Modify: `components/chain-table.tsx`
- Test: `tests/chain-table-regroup.test.tsx` (or TS component test)

- [ ] **Step 1: Write test for chain table cluster grouping with regroups**
  - Create `tests/chain-table-regroup.test.tsx` verifying that a chain whose conclusion node was regrouped displays under the target session cluster group instead of its original birth session.
  - Run test and verify it fails.

- [ ] **Step 2: Update `components/chain-table.tsx`**
  - In `components/chain-table.tsx`, update the cluster determination for chains to check `snapshot.regroups?.[chain.conclusion]` before falling back to `conclusion?.provenance[0]?.chatId`.
  - Ensure node membership tracking in `group.nodeIds` correctly attributes regrouped nodes to their target cluster.

- [ ] **Step 3: Run tests and verify passing**
  - Run `npx tsx --test tests/chain-table-regroup.test.tsx`.
  - Run `npm run typecheck`.

- [ ] **Step 4: Commit changes**
  - `git add components/chain-table.tsx tests/chain-table-regroup.test.tsx`
  - `git commit -m "feat(ui): group regrouped chains under target cluster in chain table"`

---

### Task 5: Prober Prompt Doctrine & Full Integration Verification

**Files:**
- Modify: `src/agent/prompts/prober/10-probe-doctrine.md`
- Test: `tests/prober-doctrine.test.ts`

- [ ] **Step 1: Update prober prompt instructions**
  - In `src/agent/prompts/prober/10-probe-doctrine.md`, update Section 1 ("Read his persistent map") to document `search_propositions` and `regroup_propositions`.
  - Explain the doctrine: once the topic is known, search for related propositions from other subjects, evaluate whether any align better with the current subject, regroup them with `regroup_propositions`, and inform the learner in the opening response.

- [ ] **Step 2: Verify prompt composition and tool availability**
  - Add test in `tests/prober-doctrine.test.ts` verifying `composeInstructions("prober")` includes the new guidance and that `createProberTools` exposes `search_propositions` and `regroup_propositions` when `graphToolsEnabled` is true.

- [ ] **Step 3: Run all project checks**
  - Run all tests: `npm test`.
  - Run typecheck: `npm run typecheck`.
  - Run linter: `npm run lint`.

- [ ] **Step 4: Commit changes**
  - `git add src/agent/prompts/prober/10-probe-doctrine.md tests/prober-doctrine.test.ts`
  - `git commit -m "feat(prompt): add cross-subject proposition review and regrouping to prober doctrine"`
