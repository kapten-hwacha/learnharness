/**
 * JobStore — Tauri IPC / in-memory SQLite store adapter.
 *
 * Implements core/ports.ts JobStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands (lh_*).
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import { emit } from "../core/events.ts";
import type { JobStore, CreateJobInit, JobPatch } from "../core/ports.ts";
import type { JobRecord } from "../core/contracts.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import {
	memoryDeleteJobsForChat,
	memoryFindJobByToolCallId,
	memoryGetJob,
	memoryListJobs,
	memorySaveJob,
} from "./memory-backend.ts";

async function createJob(init: CreateJobInit): Promise<JobRecord> {
	const now = new Date().toISOString();
	const record: JobRecord = {
		id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		kind: init.kind,
		chatId: init.chatId,
		toolCallId: init.toolCallId,
		...(init.input !== undefined ? { input: init.input } : {}),
		status: "running",
		activity: init.activity ?? "starting",
		createdAt: now,
		updatedAt: now,
	};
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_job_save", { record });
	} else {
		await memorySaveJob(record);
	}
	emit("jobs-changed", { chatId: init.chatId });
	return record;
}

async function getJob(id: string): Promise<JobRecord | null> {
	const invoke = getTauriInvoke();
	if (invoke) {
		return await invoke<JobRecord | null>("lh_job_get", { jobId: id });
	}
	return await memoryGetJob(id);
}

async function updateJob(id: string, patch: JobPatch): Promise<JobRecord | null> {
	const record = await getJob(id);
	if (!record) return null;
	const next: JobRecord = {
		...record,
		...patch,
		updatedAt: patch.updatedAt ?? new Date().toISOString(),
	};
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_job_save", { record: next });
	} else {
		await memorySaveJob(next);
	}
	emit("jobs-changed", { chatId: next.chatId });
	return next;
}

async function listJobs(chatId: string): Promise<JobRecord[]> {
	const invoke = getTauriInvoke();
	if (invoke) {
		const raw = await invoke<JobRecord[]>("lh_job_list", { chatId });
		return (raw ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	return await memoryListJobs(chatId);
}

async function findJobByToolCallId(chatId: string, toolCallId: string): Promise<JobRecord | null> {
	const invoke = getTauriInvoke();
	if (invoke) {
		return await invoke<JobRecord | null>("lh_job_find_by_tool_call", { chatId, toolCallId });
	}
	return await memoryFindJobByToolCallId(chatId, toolCallId);
}

async function deleteJobsForChat(chatId: string): Promise<number> {
	let removed = 0;
	const invoke = getTauriInvoke();
	if (invoke) {
		removed = await invoke<number>("lh_job_delete_for_chat", { chatId });
	} else {
		removed = await memoryDeleteJobsForChat(chatId);
	}
	if (removed > 0) {
		emit("jobs-changed", { chatId });
	}
	return removed;
}

export const jobStore: JobStore = {
	createJob,
	getJob,
	updateJob,
	listJobs,
	findJobByToolCallId,
	deleteJobsForChat,
};
