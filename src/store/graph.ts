/**
 * GraphStore — Tauri IPC / in-memory SQLite store adapter.
 *
 * Implements core/ports.ts GraphStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands (lh_*).
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import type {
	CoverageEntry,
	ExtractionRunUsage,
	FsrsCardRow,
	GraphChain,
	GraphNode,
	GraphRegroup,
	NodeSearchHit,
	NotesSource,
	Position,
	PracticeHistory,
	PracticeRecord,
	ProvenancePoint,
	SessionCheckpoint,
} from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import {
	memoryAppendChain,
	memoryAppendCheckpoint,
	memoryAppendCoverage,
	memoryAppendNode,
	memoryAppendRegroup,
	memoryAppendSourceUsage,
	memoryDeleteSources,
	memoryGetGraphRevision,
	memoryReadChains,
	memoryReadCheckpoints,
	memoryReadCoverage,
	memoryReadFsrsCards,
	memoryReadNodes,
	memoryReadPositions,
	memoryReadPracticeHistory,
	memoryReadRegroups,
	memoryReadSources,
	memoryRewriteLedgers,
	memorySearchNodes,
	memorySyncFsrsCards,
	memoryUpsertSource,
	memoryWritePositions,
} from "./memory-backend.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

function parseIfString(item: unknown): unknown {
	if (typeof item === "string") {
		try {
			return JSON.parse(item);
		} catch {
			return null;
		}
	}
	return item;
}

export const isProvenancePoint = (v: unknown): v is ProvenancePoint => {
	const item = parseIfString(v);
	return isRecord(item) && isString(item.chatId) && isString(item.messageId);
};

export const isGraphNode = (v: unknown): v is GraphNode => {
	const item = parseIfString(v);
	return (
		isRecord(item) &&
		isString(item.id) &&
		isString(item.name) &&
		isString(item.statement) &&
		Array.isArray(item.aliases) &&
		item.aliases.every(isString) &&
		isString(item.createdAt) &&
		Array.isArray(item.provenance) &&
		item.provenance.every(isProvenancePoint)
	);
};

export const isGraphChain = (v: unknown): v is GraphChain => {
	const item = parseIfString(v);
	return (
		isRecord(item) &&
		isString(item.id) &&
		Array.isArray(item.premises) &&
		item.premises.length > 0 &&
		item.premises.every(isString) &&
		isString(item.conclusion) &&
		Array.isArray(item.provenance) &&
		item.provenance.every(isProvenancePoint) &&
		isString(item.createdAt)
	);
};

export const isCheckpoint = (v: unknown): v is SessionCheckpoint => {
	const item = parseIfString(v);
	return isRecord(item) && isString(item.chatId) && isString(item.foldedAt);
};

export const isCoverageEntry = (v: unknown): v is CoverageEntry => {
	const item = parseIfString(v);
	return (
		isRecord(item) &&
		isString(item.chatId) &&
		isString(item.fp) &&
		typeof item.tokens === "number" &&
		isString(item.foldedAt)
	);
};

export const isGraphRegroup = (v: unknown): v is GraphRegroup => {
	const item = parseIfString(v);
	return (
		isRecord(item) &&
		isString(item.id) &&
		isString(item.nodeId) &&
		isString(item.targetSessionId) &&
		isString(item.reason) &&
		isString(item.regroupedAt)
	);
};

export const isPosition = (v: unknown): v is Position => {
	const item = parseIfString(v);
	return (
		isRecord(item) &&
		typeof item.x === "number" &&
		Number.isFinite(item.x) &&
		typeof item.y === "number" &&
		Number.isFinite(item.y)
	);
};

export const isNotesSource = (v: unknown): v is NotesSource => {
	const item = parseIfString(v);
	return isRecord(item) && isString(item.id) && isString(item.filePath) && isString(item.importedAt);
};

export const graphStore: GraphStore = {
	async appendNode(node: GraphNode): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_append_node", { node });
		} else {
			await memoryAppendNode(node);
		}
	},

	async readNodes(): Promise<GraphNode[]> {
		const invoke = getTauriInvoke();
		const raw = invoke ? await invoke<unknown[]>("lh_graph_read_nodes") : await memoryReadNodes();
		return (raw ?? []).filter(isGraphNode);
	},

	async appendChain(assertion: GraphChain): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_append_chain", { assertion });
		} else {
			await memoryAppendChain(assertion);
		}
	},

	async readChains(): Promise<GraphChain[]> {
		const invoke = getTauriInvoke();
		const raw = invoke ? await invoke<unknown[]>("lh_graph_read_chains") : await memoryReadChains();
		return (raw ?? []).filter(isGraphChain);
	},

	async appendCheckpoint(checkpoint: SessionCheckpoint): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_append_checkpoint", { checkpoint });
		} else {
			await memoryAppendCheckpoint(checkpoint);
		}
	},

	async readCheckpoints(): Promise<SessionCheckpoint[]> {
		const invoke = getTauriInvoke();
		const raw = invoke ? await invoke<unknown[]>("lh_graph_read_checkpoints") : await memoryReadCheckpoints();
		return (raw ?? []).filter(isCheckpoint);
	},

	async appendCoverage(entry: CoverageEntry): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_append_coverage", { entry });
		} else {
			await memoryAppendCoverage(entry);
		}
	},

	async readCoverage(): Promise<CoverageEntry[]> {
		const invoke = getTauriInvoke();
		const raw = invoke ? await invoke<unknown[]>("lh_graph_read_coverage") : await memoryReadCoverage();
		return (raw ?? []).filter(isCoverageEntry);
	},

	async appendRegroup(regroup: GraphRegroup): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_append_regroup", { regroup });
		} else {
			await memoryAppendRegroup(regroup);
		}
	},

	async readRegroups(): Promise<readonly GraphRegroup[]> {
		const invoke = getTauriInvoke();
		const raw = invoke ? await invoke<unknown[]>("lh_graph_read_regroups") : await memoryReadRegroups();
		return (raw ?? []).filter(isGraphRegroup);
	},

	async upsertSource(source: NotesSource): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_upsert_source", { source });
		} else {
			await memoryUpsertSource(source);
		}
	},

	async readSources(): Promise<NotesSource[]> {
		const invoke = getTauriInvoke();
		const raw = invoke ? await invoke<unknown[]>("lh_graph_read_sources") : await memoryReadSources();
		return (raw ?? []).filter(isNotesSource);
	},

	async deleteSources(ids: ReadonlySet<string>): Promise<number> {
		if (ids.size === 0) return 0;
		const invoke = getTauriInvoke();
		if (invoke) {
			return await invoke<number>("lh_graph_delete_sources", { ids: Array.from(ids) });
		}
		return await memoryDeleteSources(ids);
	},

	async appendSourceUsage(id: string, entry: ExtractionRunUsage): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_append_source_usage", { id, entry });
		} else {
			await memoryAppendSourceUsage(id, entry);
		}
	},

	async readPositions(): Promise<Record<string, Position>> {
		const invoke = getTauriInvoke();
		const raw = invoke ? await invoke<Record<string, unknown>>("lh_graph_read_positions") : await memoryReadPositions();
		const out: Record<string, Position> = {};
		for (const [id, value] of Object.entries(raw ?? {})) {
			if (isPosition(value)) out[id] = { x: value.x, y: value.y };
		}
		return out;
	},

	async writePositions(positions: Record<string, Position>): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_write_positions", { positions });
		} else {
			await memoryWritePositions(positions);
		}
	},

	async rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
		regroups?: GraphRegroup[];
	}): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_graph_rewrite_ledgers", { next });
		} else {
			await memoryRewriteLedgers(next);
		}
	},

	async searchNodes(query: string, limit?: number): Promise<NodeSearchHit[]> {
		const invoke = getTauriInvoke();
		if (invoke) {
			return await invoke<NodeSearchHit[]>("lh_search_nodes", { query, limit });
		}
		return await memorySearchNodes(query, limit);
	},

	async readPracticeHistory(): Promise<PracticeHistory> {
		const invoke = getTauriInvoke();
		if (invoke) {
			const res = await invoke<{
				records?: PracticeRecord[];
				teachChatIds?: string[];
				teachRatings?: Record<string, 1 | 2 | 3 | 4>;
			}>("lh_read_practice_history");
			return {
				records: res?.records ?? [],
				teachChatIds: new Set(res?.teachChatIds ?? []),
				teachRatings: new Map(
					Object.entries(res?.teachRatings ?? {}).map(([k, v]) => [k, v as 1 | 2 | 3 | 4]),
				),
			};
		}
		return await memoryReadPracticeHistory();
	},

	async syncFsrsCards(cards: FsrsCardRow[]): Promise<void> {
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_upsert_fsrs_cards", { cards });
		} else {
			await memorySyncFsrsCards(cards);
		}
	},

	async readFsrsCards(dueBeforeMs?: number): Promise<FsrsCardRow[]> {
		const invoke = getTauriInvoke();
		if (invoke) {
			return await invoke<FsrsCardRow[]>("lh_read_fsrs_cards", { dueBeforeMs });
		}
		return await memoryReadFsrsCards(dueBeforeMs);
	},

	async revision(): Promise<number> {
		const invoke = getTauriInvoke();
		if (invoke) {
			return await invoke<number>("lh_get_graph_revision");
		}
		return await memoryGetGraphRevision();
	},
};

export async function purgeLegacyLedgers(): Promise<void> {}
