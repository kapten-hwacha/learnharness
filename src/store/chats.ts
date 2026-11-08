/**
 * ChatStore — Tauri IPC / in-memory SQLite store adapter.
 *
 * Implements core/ports.ts ChatStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands (lh_*).
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type {
	ChatRecord,
	ChatSearchHit,
	ChatSettings,
	ChatSummary,
	ClarifyExchange,
	ExtractionRunUsage,
	ImageSnapshot,
	PlanTree,
	TurnUsage,
} from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import {
	memoryDeleteChat,
	memoryGetChat,
	memoryListChats,
	memorySaveChat,
	memorySaveImageSnapshot,
	memorySearchChats,
} from "./memory-backend.ts";

function validateChatId(id: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		throw new Error(`Invalid chat id: ${id}`);
	}
}

async function sha256Hex(dataBase64: string): Promise<string> {
	const binary = typeof Buffer !== "undefined"
		? Buffer.from(dataBase64, "base64")
		: Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
	const hashBuf = await crypto.subtle.digest("SHA-256", binary);
	return Array.from(new Uint8Array(hashBuf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function writeChat(record: ChatRecord): Promise<void> {
	validateChatId(record.id);
	const toSave: ChatRecord = { ...record, version: CURRENT_CHAT_VERSION };
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_save_chat", { chatId: record.id, record: toSave });
	} else {
		await memorySaveChat(toSave);
	}
}

async function createChat(title: string, kind?: "practice"): Promise<ChatRecord> {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	await writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION };
}

async function getChat(id: string): Promise<ChatRecord | null> {
	try {
		validateChatId(id);
	} catch {
		return null;
	}
	let record: ChatRecord | null = null;
	const invoke = getTauriInvoke();
	if (invoke) {
		record = await invoke<ChatRecord | null>("lh_load_chat", { chatId: id });
	} else {
		record = await memoryGetChat(id);
	}
	if (!record) return null;
	const v = (record as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — refusing to read it`);
		return null;
	}
	return record;
}

async function listChats(): Promise<ChatSummary[]> {
	const invoke = getTauriInvoke();
	if (invoke) {
		const raw = await invoke<any[]>("lh_list_chats");
		return (raw ?? []).map((item) => ({
			id: item.id,
			title: item.title,
			createdAt: item.createdAt ?? item.created_at,
			updatedAt: item.updatedAt ?? item.updated_at,
			kind: item.kind ?? "teach",
			messageCount: item.messageCount ?? item.message_count ?? 0,
			phase: item.phase ?? "explore",
			pendingQuestion: Boolean(item.pendingQuestion ?? item.pending_question),
			pendingProblem: Boolean(item.pendingProblem ?? item.pending_problem),
			...(item.settings ? { settings: item.settings } : {}),
		})).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	return memoryListChats();
}

async function searchChats(query: string, limit?: number): Promise<ChatSearchHit[]> {
	const invoke = getTauriInvoke();
	if (invoke) {
		return await invoke<ChatSearchHit[]>("lh_search_chats", { query, limit });
	}
	return memorySearchChats(query, limit);
}

async function saveMessages(id: string, messages: LhMessage[]): Promise<void> {
	validateChatId(id);
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	await writeChat(record);
}

async function saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): Promise<void> {
	validateChatId(id);
	if (!/^[a-f0-9]{64}$/.test(snapshotId)) {
		throw new Error("Invalid image snapshot identity");
	}
	const computedHash = await sha256Hex(image.data);
	if (computedHash !== snapshotId) {
		throw new Error("Invalid image snapshot identity");
	}
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_save_image_snapshot", { chatId: id, snapshotId, image });
	} else {
		await memorySaveImageSnapshot(id, snapshotId, image);
	}
}

async function appendTurnUsage(id: string, entry: TurnUsage): Promise<void> {
	validateChatId(id);
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	await writeChat(record);
}

async function appendExtractionUsage(id: string, entry: ExtractionRunUsage): Promise<void> {
	validateChatId(id);
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	await writeChat(record);
}

async function appendClarification(id: string, toolCallId: string, exchange: ClarifyExchange): Promise<ClarifyExchange[]> {
	validateChatId(id);
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	const thread = [...(record.clarifications?.[toolCallId] ?? []), exchange];
	record.clarifications = { ...record.clarifications, [toolCallId]: thread };
	await writeChat(record);
	return thread;
}

async function saveSettings(id: string, settings: ChatSettings): Promise<void> {
	validateChatId(id);
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.settings = settings;
	await writeChat(record);
}

async function renameChat(id: string, title: string): Promise<ChatRecord> {
	validateChatId(id);
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	await writeChat(record);
	emit("chats-changed", {});
	return record;
}

async function deleteChat(id: string): Promise<boolean> {
	try {
		validateChatId(id);
	} catch {
		return false;
	}
	let deleted = false;
	const invoke = getTauriInvoke();
	if (invoke) {
		deleted = await invoke<boolean>("lh_delete_chat", { chatId: id });
	} else {
		deleted = await memoryDeleteChat(id);
	}
	if (deleted) {
		emit("chats-changed", {});
	}
	return deleted;
}

async function saveTree(id: string, tree: PlanTree): Promise<void> {
	validateChatId(id);
	const record = await getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	await writeChat(record);
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	searchChats,
	saveMessages,
	saveImageSnapshot,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
	appendClarification,
};
