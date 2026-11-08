/**
 * In-memory storage backend for Node.js test environments.
 * Used automatically by all src/store/*.ts adapters when getTauriInvoke() is null.
 * Provides deterministic in-memory state and test simulation helpers.
 */

import type {
	ChatRecord,
	ChatSearchHit,
	ChatSummary,
	CoverageEntry,
	ExtractionRunUsage,
	FsrsCardRow,
	GraphChain,
	GraphNode,
	GraphRegroup,
	ImageSnapshot,
	JobRecord,
	NodeSearchHit,
	NotesSource,
	Position,
	PracticeHistory,
	PracticeRecord,
	ReviewRating,
	SessionCheckpoint,
	StudyInterval,
} from "../core/contracts.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { practiceRecordsFromChat, teachSessionSeedRating } from "../core/review.ts";

// ── In-Memory State ──────────────────────────────────────────────────────────

const memoryChats = new Map<string, ChatRecord>();
const memoryChatImages = new Map<string, Map<string, ImageSnapshot>>();

const memoryNodes: GraphNode[] = [];
const memoryChains: GraphChain[] = [];
const memoryCheckpoints: SessionCheckpoint[] = [];
const memoryCoverage: CoverageEntry[] = [];
const memoryRegroups: unknown[] = [];
const memorySources = new Map<string, NotesSource>();
let memoryPositions: Record<string, Position> = {};
const memoryFsrsCards = new Map<string, FsrsCardRow>();
let memoryGraphRevision = 0;

const memoryJobs = new Map<string, JobRecord>();
const memoryKv = new Map<string, unknown>();
const memoryRawKv = new Map<string, string>();
const memoryIntervals: unknown[] = [];
const memoryPromptOverrides = new Map<string, string>();
let memoryAuthContent: string | null = null;

export function resetMemoryStores(): void {
	memoryChats.clear();
	memoryChatImages.clear();

	memoryNodes.length = 0;
	memoryChains.length = 0;
	memoryCheckpoints.length = 0;
	memoryCoverage.length = 0;
	memoryRegroups.length = 0;
	memorySources.clear();
	memoryPositions = {};
	memoryFsrsCards.clear();
	memoryGraphRevision = 0;

	memoryJobs.clear();
	memoryKv.clear();
	memoryRawKv.clear();
	memoryIntervals.length = 0;
	memoryPromptOverrides.clear();
	memoryAuthContent = null;

	(globalThis as any).__LH_PROMPT_OVERRIDE_CACHE__?.clear();
}

// ── Chats ────────────────────────────────────────────────────────────────────

export async function memorySaveChat(record: ChatRecord): Promise<void> {
	memoryChats.set(record.id, structuredClone(record));
}

export async function memoryGetChat(id: string): Promise<ChatRecord | null> {
	const record = memoryChats.get(id);
	return record ? structuredClone(record) : null;
}

export async function memoryListChats(): Promise<ChatSummary[]> {
	const summaries: ChatSummary[] = [];
	for (const record of memoryChats.values()) {
		try {
			const { messages, tree: _tree, turns: _turns, extractions: _extractions, imageSnapshots: _img, ...summary } = record;
			summaries.push({
				...summary,
				kind: summary.kind ?? "teach",
				messageCount: messages.length,
				phase: phaseAt3Lh(messages),
				pendingQuestion: danglingQuestionOf(messages) !== null,
				pendingProblem: activeProblemOf(messages) !== null,
				...(record.settings ? { settings: record.settings } : {}),
			});
		} catch (err) {
			console.error(`[chat ${record.id}] summary projection failed:`, err);
		}
	}
	return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function memoryDeleteChat(id: string): Promise<boolean> {
	const existed = memoryChats.delete(id);
	memoryChatImages.delete(id);
	return existed;
}

export async function memorySearchChats(query: string, limit = 20): Promise<ChatSearchHit[]> {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: ChatSearchHit[] = [];

	for (const chat of memoryChats.values()) {
		if (hits.length >= limit) break;
		let snippet: string | null = null;
		if (chat.title.toLowerCase().includes(q)) {
			snippet = chat.title;
		} else {
			for (const msg of chat.messages) {
				const text = typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content
							.map((part) => (typeof part === "object" && part && "text" in part && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
							.join(" ")
						: "";
				const idx = text.toLowerCase().indexOf(q);
				if (idx !== -1) {
					const start = Math.max(0, idx - 40);
					const end = Math.min(text.length, idx + q.length + 40);
					snippet = (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
					break;
				}
			}
		}
		if (snippet) {
			hits.push({
				chatId: chat.id,
				title: chat.title,
				snippet,
			});
		}
	}
	return hits;
}

export async function memorySaveImageSnapshot(chatId: string, snapshotId: string, image: ImageSnapshot): Promise<void> {
	let map = memoryChatImages.get(chatId);
	if (!map) {
		map = new Map();
		memoryChatImages.set(chatId, map);
	}
	if (!map.has(snapshotId)) {
		map.set(snapshotId, structuredClone(image));
	}
	const chat = memoryChats.get(chatId);
	if (chat) {
		chat.imageSnapshots = {
			...chat.imageSnapshots,
			[snapshotId]: structuredClone(image),
		};
	}
}

export async function memoryGetImageSnapshot(chatId: string, snapshotId: string): Promise<ImageSnapshot | null> {
	const img = memoryChatImages.get(chatId)?.get(snapshotId);
	return img ? structuredClone(img) : null;
}

// ── Graph ────────────────────────────────────────────────────────────────────

export async function memoryAppendNode(node: GraphNode): Promise<void> {
	memoryNodes.push(structuredClone(node));
	memoryGraphRevision++;
}

export async function memoryReadNodes(): Promise<GraphNode[]> {
	return memoryNodes.map((n) => structuredClone(n));
}

export async function memoryAppendChain(chain: GraphChain): Promise<void> {
	memoryChains.push(structuredClone(chain));
	memoryGraphRevision++;
}

export async function memoryReadChains(): Promise<GraphChain[]> {
	return memoryChains.map((c) => structuredClone(c));
}

export async function memoryAppendCheckpoint(checkpoint: SessionCheckpoint): Promise<void> {
	memoryCheckpoints.push(structuredClone(checkpoint));
	memoryGraphRevision++;
}

export async function memoryReadCheckpoints(): Promise<SessionCheckpoint[]> {
	return memoryCheckpoints.map((cp) => structuredClone(cp));
}

export async function memoryAppendCoverage(entry: CoverageEntry): Promise<void> {
	memoryCoverage.push(structuredClone(entry));
	memoryGraphRevision++;
}

export async function memoryReadCoverage(): Promise<CoverageEntry[]> {
	return memoryCoverage.map((c) => structuredClone(c));
}

export async function memoryAppendRegroup(regroup: GraphRegroup): Promise<void> {
	memoryRegroups.push(structuredClone(regroup));
	memoryGraphRevision++;
}

export async function memoryReadRegroups(): Promise<unknown[]> {
	return [...memoryRegroups];
}

export function appendRawMemoryRegroup(raw: unknown): void {
	memoryRegroups.push(raw);
}

export async function memoryUpsertSource(source: NotesSource): Promise<void> {
	const prev = memorySources.get(source.id);
	const next = prev ? { ...source, extractions: prev.extractions } : source;
	memorySources.set(source.id, structuredClone(next));
	memoryGraphRevision++;
}

export async function memoryReadSources(): Promise<NotesSource[]> {
	return Array.from(memorySources.values()).map((s) => structuredClone(s));
}

export async function memoryDeleteSources(ids: ReadonlySet<string>): Promise<number> {
	let removed = 0;
	for (const id of ids) {
		if (memorySources.delete(id)) {
			removed++;
		}
	}
	if (removed > 0) {
		memoryGraphRevision++;
	}
	return removed;
}

export async function memoryAppendSourceUsage(id: string, entry: ExtractionRunUsage): Promise<void> {
	const source = memorySources.get(id);
	if (!source) return;
	source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
		? source.extractions
		: [...(source.extractions ?? []), structuredClone(entry)];
	memoryGraphRevision++;
}

export async function memoryReadPositions(): Promise<Record<string, Position>> {
	return structuredClone(memoryPositions);
}

export async function memoryWritePositions(positions: Record<string, Position>): Promise<void> {
	memoryPositions = structuredClone(positions);
	memoryGraphRevision++;
}

export async function memoryRewriteLedgers(next: {
	nodes?: GraphNode[];
	chains?: GraphChain[];
	coverage?: CoverageEntry[];
	checkpoints?: SessionCheckpoint[];
	regroups?: GraphRegroup[];
}): Promise<void> {
	if (next.nodes !== undefined) {
		memoryNodes.length = 0;
		memoryNodes.push(...next.nodes.map((n) => structuredClone(n)));
	}
	if (next.chains !== undefined) {
		memoryChains.length = 0;
		memoryChains.push(...next.chains.map((c) => structuredClone(c)));
	}
	if (next.coverage !== undefined) {
		memoryCoverage.length = 0;
		memoryCoverage.push(...next.coverage.map((c) => structuredClone(c)));
	}
	if (next.checkpoints !== undefined) {
		memoryCheckpoints.length = 0;
		memoryCheckpoints.push(...next.checkpoints.map((cp) => structuredClone(cp)));
	}
	if (next.regroups !== undefined) {
		memoryRegroups.length = 0;
		memoryRegroups.push(...next.regroups.map((r) => structuredClone(r)));
	}
	memoryGraphRevision++;
}

export async function memorySearchNodes(query: string, limit = 20): Promise<NodeSearchHit[]> {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: NodeSearchHit[] = [];

	for (const node of memoryNodes) {
		if (hits.length >= limit) break;
		const nameMatch = node.name.toLowerCase().includes(q);
		const statementMatch = node.statement.toLowerCase().includes(q);
		const aliasMatch = node.aliases?.some((a) => a.toLowerCase().includes(q));

		if (nameMatch || statementMatch || aliasMatch) {
			hits.push({
				nodeId: node.id,
				name: node.name,
				statement: node.statement,
				snippet: statementMatch ? node.statement : node.name,
			});
		}
	}
	return hits;
}

export async function memoryReadPracticeHistory(): Promise<PracticeHistory> {
	const records: PracticeRecord[] = [];
	const teachChatIds = new Set<string>();
	const teachRatings = new Map<string, ReviewRating>();

	for (const chat of memoryChats.values()) {
		if (chat.kind === "practice") {
			records.push(...practiceRecordsFromChat(chat.id, chat.messages));
		} else {
			teachChatIds.add(chat.id);
			teachRatings.set(chat.id, teachSessionSeedRating(chat.messages));
		}
	}

	return {
		records,
		teachChatIds,
		teachRatings,
	};
}

export async function memorySyncFsrsCards(cards: FsrsCardRow[]): Promise<void> {
	for (const card of cards) {
		memoryFsrsCards.set(card.nodeId, structuredClone(card));
	}
}

export async function memoryReadFsrsCards(dueBeforeMs?: number): Promise<FsrsCardRow[]> {
	const list: FsrsCardRow[] = [];
	for (const card of memoryFsrsCards.values()) {
		if (dueBeforeMs === undefined || card.dueAtMs <= dueBeforeMs) {
			list.push(structuredClone(card));
		}
	}
	return list.sort((a, b) => a.dueAtMs - b.dueAtMs);
}

export async function memoryGetGraphRevision(): Promise<number> {
	return memoryGraphRevision;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export async function memorySaveJob(job: JobRecord): Promise<void> {
	memoryJobs.set(job.id, structuredClone(job));
}

export async function memoryGetJob(id: string): Promise<JobRecord | null> {
	const j = memoryJobs.get(id);
	return j ? structuredClone(j) : null;
}

export async function memoryListJobs(chatId: string): Promise<JobRecord[]> {
	const list: JobRecord[] = [];
	for (const j of memoryJobs.values()) {
		if (j.chatId === chatId) {
			list.push(structuredClone(j));
		}
	}
	return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function memoryFindJobByToolCallId(chatId: string, toolCallId: string): Promise<JobRecord | null> {
	for (const j of memoryJobs.values()) {
		if (j.chatId === chatId && j.toolCallId === toolCallId) {
			return structuredClone(j);
		}
	}
	return null;
}

export async function memoryDeleteJobsForChat(chatId: string): Promise<number> {
	let removed = 0;
	for (const [id, j] of Array.from(memoryJobs.entries())) {
		if (j.chatId === chatId) {
			memoryJobs.delete(id);
			removed++;
		}
	}
	return removed;
}

// ── KV ───────────────────────────────────────────────────────────────────────

export async function getMemoryKv(key: string): Promise<unknown | null> {
	if (memoryRawKv.has(key)) {
		const raw = memoryRawKv.get(key)!;
		return JSON.parse(raw);
	}
	if (memoryKv.has(key)) {
		return structuredClone(memoryKv.get(key));
	}
	return null;
}

export async function setMemoryKv(key: string, value: unknown): Promise<void> {
	memoryRawKv.delete(key);
	memoryKv.set(key, structuredClone(value));
}

export function setRawMemoryKv(key: string, raw: string): void {
	memoryKv.delete(key);
	memoryRawKv.set(key, raw);
}

export function setCorruptMemoryKv(key: string): void {
	setRawMemoryKv(key, "{not json");
}

// ── Study ────────────────────────────────────────────────────────────────────

export async function memoryReadIntervals(): Promise<unknown[]> {
	return [...memoryIntervals];
}

export async function memoryAppendIntervals(list: StudyInterval[]): Promise<void> {
	for (const i of list) {
		memoryIntervals.push(structuredClone(i));
	}
}

export function appendRawMemoryInterval(raw: unknown): void {
	memoryIntervals.push(raw);
}

// ── Prompt Overrides ─────────────────────────────────────────────────────────

export async function listMemoryPromptOverrides(): Promise<string[]> {
	return Array.from(memoryPromptOverrides.keys()).sort();
}

export async function readMemoryPromptOverride(segmentPath: string): Promise<string | null> {
	return memoryPromptOverrides.get(segmentPath) ?? null;
}

export async function writeMemoryPromptOverride(segmentPath: string, text: string): Promise<void> {
	memoryPromptOverrides.set(segmentPath, text);
}

export async function deleteMemoryPromptOverride(segmentPath: string): Promise<void> {
	memoryPromptOverrides.delete(segmentPath);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export function getMemoryAuthContent(): string | null {
	return memoryAuthContent;
}

export function setMemoryAuthContent(content: string | null): void {
	memoryAuthContent = content;
}

export function setRawMemoryAuth(content: string): void {
	memoryAuthContent = content;
}
