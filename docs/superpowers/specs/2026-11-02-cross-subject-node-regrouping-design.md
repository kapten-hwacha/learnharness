# Cross-Subject Node Review & Regrouping — Design Specification

**Date:** 2026-11-02  
**Status:** Approved  
**Topic:** Reviewing and regrouping knowledge graph nodes across subjects when learning a new subject

---

## 1. Problem & Context

In LearnHarness, propositions learned during teaching sessions are stored as nodes in a global knowledge graph (`nodes.jsonl`). Historically, nodes are clustered into domains using "birth-session clustering" (`src/core/session-clusters.ts`), where a node belongs permanently to the session (chat or notes file) that created it (`provenance[0].chatId`).

When a user begins learning a new subject (e.g. *Linear Algebra*), certain nodes created under earlier subjects (e.g. *Matrix Multiplication* or *Dot Product* born under *Machine Learning Foundations*) often align more genuinely with the new subject. Currently, the system has no mechanism for the agent to review existing nodes across other subjects or regroup them under the new topic, leaving the graph organization rigid and chronologically anchored rather than epistemically cohesive.

---

## 2. Goals & User Experience

1. **Autonomous Alignment Check**: Early in a new teaching session (during the prober phase, once the topic/goal is clarified), the agent reviews existing knowledge graph nodes from other subjects to check if any align better with the current subject.
2. **Autonomous Regrouping with Learner Notification**: If relevant nodes are identified, the prober automatically reassigns them to the current session and mentions the regrouping naturally in its conversational response (e.g., *"I noticed we previously covered Matrix Multiplication under Machine Learning — I've regrouped it under this Linear Algebra topic as a core foundation"*).
3. **Global Knowledge Graph Reflection**: Regrouped nodes visually move into the new subject's cluster on the Knowledge Graph canvas (updating hulls and centroid attraction) and under the new subject's folder in the Chain Table overlay.
4. **Historical Provenance Preservation**: The original birth provenance (`nodes.jsonl` provenance array) remains immutable. Regrouping is stored as append-only reassignments in a dedicated ledger.

---

## 3. Architecture & Data Contracts

### 3.1 Data Contracts (`src/core/contracts/graph.ts`)

A new interface defines regroup records:

```ts
export interface GraphRegroup {
  /** Stable unique ID: "rg_" + 12 hex chars (store-assigned). */
  id: string;
  /** The graph node ID being reassigned ("n_..."). */
  nodeId: string;
  /** Destination session ID (chatId or notes source id) where the node is now grouped. */
  targetSessionId: string;
  /** Justification from the agent for moving this node. */
  reason: string;
  /** ISO timestamp when the regroup was recorded. */
  regroupedAt: string;
}
```

The snapshot contract (`GraphSnapshot`) includes an optional mapping of active regroups:

```ts
export interface GraphSnapshot {
  // ... existing fields ...
  /** Active node regroupings: nodeId -> latest targetSessionId. */
  regroups?: Record<string, string>;
}
```

### 3.2 Storage Ledger (`config.ts`, `src/store/graph.ts`, `src/core/ports.ts`)

- **Configuration**:
  ```ts
  // config.ts
  export const LEDGER_FILES = {
    // ...
    regroups: path.join(PATHS.graph, "regroups.jsonl"),
  } as const;
  ```
- **Port Interface** (`src/core/ports.ts`):
  ```ts
  export interface GraphStore {
    // ... existing methods ...
    appendRegroup(regroup: GraphRegroup): void;
    readRegroups(): readonly GraphRegroup[];
  }
  ```
- **Implementation** (`src/store/graph.ts`):
  - `appendRegroup`: appends a line to `LEDGER_FILES.regroups`.
  - `readRegroups`: reads all lines, validates against `isGraphRegroup`, returns array (empty if file does not exist).

---

## 4. Graph Derivation & UI Updates

### 4.1 Cluster Derivation (`src/core/session-clusters.ts`)

1. **Effective Session**:
   ```ts
   export function effectiveSessionOf(
     node: Pick<GraphNode, "id" | "provenance">,
     regroupMap?: ReadonlyMap<string, string>,
   ): string | null {
     return regroupMap?.get(node.id) ?? node.provenance[0]?.chatId ?? null;
   }
   ```
2. **Community Partitioning**:
   - `birthSessionPartition(nodes, regroupMap)` groups nodes by `effectiveSessionOf(node, regroupMap)` instead of only `birthSessionOf(node)`.
3. **Implication Nodes Assignment**:
   - `attachImpToCommunities(clusters, nodes, chains, regroupMap)` uses `effectiveSessionOf` to determine majority premise cluster keys.

### 4.2 Snapshot Assembly (`src/core/graph.ts`)

In `graphSnapshot(deps, sourceNames)`:
- Calls `deps.graphStore.readRegroups()`.
- Computes `regroupMap: Map<string, string>` where later lines in `regroups.jsonl` override earlier ones for the same `nodeId`.
- Registers each regrouped node's `targetSessionId` into `nodeChats` and `nodeSessions` so that the target session's title or file path is properly loaded into `sessions`.
- Supplies `regroupMap` to `birthSessionPartition` and `attachImpToCommunities`.
- Sets `regroups: Object.fromEntries(regroupMap)` in the returned `GraphSnapshot`.

### 4.3 UI Surfaces

1. **Graph Canvas & Hulls** (`components/graph-view.tsx`, `components/graph-canvas.ts`):
   - Derives cluster hulls and labels from `snapshot.clusters`. Regrouped nodes automatically participate in their new cluster hull and centroid pull.
2. **Chain Table** (`components/chain-table.tsx`):
   - Resolves a chain conclusion's cluster via `snapshot.regroups?.[chain.conclusion] ?? conclusion?.provenance[0]?.chatId`.
   - Regrouped chains and their underlying proposition statements display grouped under the destination session's folder.

---

## 5. Prober Agent Tools & Prompt Doctrine

### 5.1 Tool Definitions (`src/agent/tools/graph.ts`)

Added to `proberGraphTools(ctx: GraphToolContext)` when `graphTools` are enabled:

1. **`search_propositions`**:
   - **Input:**
     ```ts
     {
       query: string; // keywords to match
       limit?: number; // max candidates, default 10
     }
     ```
   - **Logic:**
     - Uses `createPropositionCandidateSearch(getGraph(deps.graphStore).nodes)`.
     - Excludes propositions whose current effective session matches `ctx.chatId`.
     - Resolves the current subject name of each candidate.
     - Returns formatted list: `[id] name: statement (Current subject: title)`.

2. **`regroup_propositions`**:
   - **Input:**
     ```ts
     {
       nodeIds: string[]; // proposition IDs (n_...)
       reason: string; // justification for moving
     }
     ```
   - **Logic:**
     - Validates that each node ID exists in the graph.
     - Filters out nodes already belonging to `ctx.chatId`.
     - Calls `deps.graphStore.appendRegroup` for each node with `targetSessionId: ctx.chatId`.
     - Returns a summary of regrouped nodes and the target session title.

### 5.2 Context Plumbing (`src/agent/tools.ts`)

- `GraphToolContext` receives `chatId?: string`.
- When constructing `proberGraphTools`, `chatId` is passed from the session/turn context.

### 5.3 Prober Prompt Doctrine (`src/agent/prompts/prober/10-probe-doctrine.md`)

Instructions added to Section 1 ("Read his persistent map"):
- Once the learner's topic or goal is concrete, use `search_propositions` with relevant domain terms.
- Review if any existing propositions under other subjects align better with this new subject.
- If matches are found, call `regroup_propositions` with the node IDs and reason.
- Mention the regrouped concepts to the learner in your next conversational response before moving to probing questions.

---

## 6. Verification & Testing Plan

1. **Unit Tests**:
   - `tests/regroups-store.test.ts`: Test appending and reading regroups in `GraphStore`. Ensure later regroup entries override earlier ones.
   - `tests/session-clusters-regroup.test.ts`: Verify `effectiveSessionOf` and `birthSessionPartition` with and without regroup mappings. Verify that implication nodes reassign accordingly.
   - `tests/graph-snapshot-regroup.test.ts`: Test that `graphSnapshot` correctly assigns regrouped nodes to the new session cluster and outputs `regroups` in the payload.
   - `tests/prober-regroup-tools.test.ts`: Test `search_propositions` and `regroup_propositions` tools directly, checking output format, exclusion of current session nodes, and ledger append.
2. **Integration Tests**:
   - Verify chain table grouping with regrouped nodes.
   - Verify prober agent flow in a simulated turn where candidates are discovered and regrouped.
3. **Linting & Code Quality**:
   - Run `npm run lint` and TypeScript checks (`npx tsc --noEmit`) to verify zero type regressions.
