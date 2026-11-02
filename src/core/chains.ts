import type { GraphNode } from "./contracts/graph.ts";
import { stripModelValueDebris } from "./value-debris.ts";

/**
 * Selection-facing chain views — pure + browser-safe (the shell's chain
 * table consumes these; the barrel exports them). Born in the practice
 * contracts (2026-09-29), orphaned onto their own module when the batch
 * practice module was replaced by practice sessions (2026-10-04).
 */

/** One reasoning chain — a selection-facing VIEW of stored follows-edges:
 *  all edges into one conclusion, as premises → that conclusion. Singleton
 *  chains (premises: []) carry edge-less nodes. */
export interface ReasoningChain {
	/** The chain's identity — the CONCLUSION node's id (chains group by
	 *  conclusion, so the two are one). */
	id: string;
	/** Premise node ids — every follows-edge source into the conclusion,
	 *  sorted. Empty = a singleton chain (an edge-less node). */
	premises: string[];
	/** The conclusion node id (=== id; mirrored so renderings read
	 *  "premises → conclusion" without indirection). */
	conclusion: string;
}

/** The stored chains filtered to a selection (chains-primary, owner
 *  2026-09-30): a chain rides along iff its conclusion AND every premise
 *  are selected; a node in no surviving chain is a singleton chain
 *  (premises: []). Premise-only nodes whose chain was excluded are
 *  singletons — the same inclusion law as the pre-chains edge grouping.
 *  Every stored chain keeps its OWN id (arg_…) — two independent
 *  arguments for one conclusion stay distinct. Deterministic: chains
 *  sorted by id, premises sorted. */
export function chainsForSelection(
	nodes: ReadonlyArray<Pick<{ id: string }, "id">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): ReasoningChain[] {
	const selected = new Set(nodes.map((n) => n.id));
	const chained = new Set<string>();
	const included: ReasoningChain[] = [];
	for (const chain of chains) {
		if (!selected.has(chain.conclusion)) continue;
		if (!chain.premises.every((premise) => selected.has(premise))) continue;
		included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
		chained.add(chain.conclusion);
		for (const premise of chain.premises) chained.add(premise);
	}
	for (const node of nodes) {
		if (!chained.has(node.id)) {
			included.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}
	return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

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
): PracticeSelectionContext {
	const byId = new Map(allNodes.map((n) => [n.id, n]));
	const pickedSet = new Set(pickedNodes.map((n) => n.id));
	const chained = new Set<string>();
	const included: ReasoningChain[] = [];
	const supportingMap = new Map<string, GraphNode>();

	for (const chain of chains) {
		if (!pickedSet.has(chain.conclusion)) continue;
		if (!chain.premises.every((p) => byId.has(p))) continue;
		included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
		chained.add(chain.conclusion);
		for (const p of chain.premises) {
			chained.add(p);
			if (!pickedSet.has(p)) {
				const node = byId.get(p);
				if (node) {
					supportingMap.set(p, node);
				}
			}
		}
	}

	for (const node of pickedNodes) {
		if (!chained.has(node.id)) {
			included.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}

	return {
		supportingNodes: Array.from(supportingMap.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
		chains: included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	};
}

/** Formatted chain lines ("Premise A, Premise B → Conclusion") for all live
 *  chains whose conclusion belongs to sessionNodeIds, sorted by chain id. */
export function sessionChainLines(
	sessionNodeIds: ReadonlySet<string>,
	allNodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): string[] {
	const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
	const lookup: Record<string, { name: string }> = Object.fromEntries(
		allNodes.map((n) => [n.id, { name: n.name }]),
	);
	const matching: Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">[] = [];
	for (const chain of chains) {
		if (!sessionNodeIds.has(chain.conclusion)) continue;
		if (!nodeMap.has(chain.conclusion) || !chain.premises.every((p) => nodeMap.has(p))) continue;
		matching.push(chain);
	}
	matching.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return matching.map((c) => formatChainLine(c, lookup));
}

/** Formatted incoming (conclusion === nodeId) and outgoing (premises includes nodeId)
 *  live chain lines for a single proposition node, sorted by chain id. */
export function nodeChainLines(
	nodeId: string,
	allNodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): { incoming: string[]; outgoing: string[] } {
	const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
	const lookup: Record<string, { name: string }> = Object.fromEntries(
		allNodes.map((n) => [n.id, { name: n.name }]),
	);
	const incomingChains: Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">[] = [];
	const outgoingChains: Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">[] = [];

	for (const chain of chains) {
		if (!nodeMap.has(chain.conclusion) || !chain.premises.every((p) => nodeMap.has(p))) continue;
		if (chain.conclusion === nodeId) {
			incomingChains.push(chain);
		}
		if (chain.premises.includes(nodeId)) {
			outgoingChains.push(chain);
		}
	}

	incomingChains.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	outgoingChains.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	return {
		incoming: incomingChains.map((c) => formatChainLine(c, lookup)),
		outgoing: outgoingChains.map((c) => formatChainLine(c, lookup)),
	};
}

/** A chain as one world-facing line — the propositions' NAMES joined
 *  by the derivation arrow: "Premise one, Premise two → Conclusion"; a
 *  singleton shows its "(no premises)" marker. Pure + browser-safe.
 *  Unknown ids fall back to the raw id (honest, never guessed).
 *  Premises sort by id — the same determinism law as chainsForSelection. */
/** Resolve ONE target string to a canonical proposition id (owner round
 *  9, 2026-10-05 — the mastery-trace contract): id first (exact), then
 *  name (case-insensitive, trimmed — names are presentational handles,
 *  not unique; an ambiguous name resolves to the FIRST node in store
 *  order). Returns null when nothing matches — the caller rejects.
 *  Validation set is the WHOLE graph, not the session's picks: pickless
 *  sessions and future graph-tools poses stay valid. The debris strip
 *  (whitehead, 2026-10-09) heals copy-syntax (`:node-id`, quoted ids)
 *  before matching — targets are membership values like correctAnswer. */
export function resolveTargetId(
	target: string,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): string | null {
	const t = stripModelValueDebris(target);
	if (t.length === 0) return null;
	if (nodes.some((n) => n.id === t)) return t;
	const lower = t.toLowerCase();
	for (const n of nodes) {
		if (stripModelValueDebris(n.name).toLowerCase() === lower) return n.id;
	}
	return null;
}

export function formatChainLine(
	chain: Pick<ReasoningChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== ""
		? `${premises} → ${nameOf(chain.conclusion)}`
		: `${nameOf(chain.conclusion)} (no premises)`;
}
