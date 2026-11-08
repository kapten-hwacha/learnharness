/**
 * Study-time persistence: intervals and open timers.
 *
 * Implements core/ports.ts StudyStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands.
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import type { OpenStudyTimers, StudyInterval } from "../core/contracts/study.ts";
import type { StudyStore } from "../core/ports.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import {
	getMemoryKv,
	memoryAppendIntervals,
	memoryReadIntervals,
	setMemoryKv,
} from "./memory-backend.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const END_REASONS = ["stop", "idle", "shutdown"];

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

export function isValidInterval(v: unknown): v is StudyInterval {
	const item = parseIfString(v);
	if (item === null || typeof item !== "object") return false;
	const r = item as Record<string, unknown>;
	return (
		r.v === 1 &&
		typeof r.chatId === "string" &&
		ID_PATTERN.test(r.chatId) &&
		typeof r.start === "string" &&
		!Number.isNaN(Date.parse(r.start)) &&
		typeof r.end === "string" &&
		!Number.isNaN(Date.parse(r.end)) &&
		typeof r.endReason === "string" &&
		END_REASONS.includes(r.endReason)
	);
}

async function readIntervals(): Promise<StudyInterval[]> {
	const invoke = getTauriInvoke();
	const raw = invoke ? await invoke<unknown[]>("lh_study_read_intervals") : await memoryReadIntervals();
	const out: StudyInterval[] = [];
	for (const line of raw ?? []) {
		const parsed = parseIfString(line);
		if (isValidInterval(parsed)) {
			out.push({
				v: 1,
				chatId: parsed.chatId,
				start: parsed.start,
				end: parsed.end,
				endReason: parsed.endReason,
			});
		}
	}
	return out;
}

async function appendIntervals(list: StudyInterval[]): Promise<void> {
	const valid = list.filter(isValidInterval);
	if (!valid.length) return;
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_study_append_intervals", { intervals: valid });
	} else {
		await memoryAppendIntervals(valid);
	}
}

async function readOpen(): Promise<OpenStudyTimers> {
	const empty: OpenStudyTimers = { v: 1, timers: {} };
	let parsed: unknown = null;
	try {
		const invoke = getTauriInvoke();
		if (invoke) {
			parsed = await invoke<unknown | null>("lh_kv_get", { key: "study_open" });
		} else {
			parsed = await getMemoryKv("study_open");
		}
	} catch {
		return empty;
	}
	if (parsed === null || typeof parsed !== "object") return empty;
	const r = parsed as { v?: unknown; timers?: unknown };
	if (r.v !== 1 || r.timers === null || typeof r.timers !== "object" || Array.isArray(r.timers)) return empty;
	const timers: OpenStudyTimers["timers"] = {};
	for (const [chatId, entry] of Object.entries(r.timers as Record<string, unknown>)) {
		if (!ID_PATTERN.test(chatId) || entry === null || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (
			typeof e.start !== "string" ||
			Number.isNaN(Date.parse(e.start)) ||
			typeof e.lastPing !== "string" ||
			Number.isNaN(Date.parse(e.lastPing)) ||
			typeof e.windowId !== "string" ||
			!ID_PATTERN.test(e.windowId)
		) {
			continue;
		}
		timers[chatId] = { start: e.start, lastPing: e.lastPing, windowId: e.windowId };
	}
	return { v: 1, timers };
}

async function writeOpen(open: OpenStudyTimers): Promise<void> {
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_kv_set", { key: "study_open", value: open });
	} else {
		await setMemoryKv("study_open", open);
	}
}

export const studyStore: StudyStore = { readIntervals, appendIntervals, readOpen, writeOpen };
