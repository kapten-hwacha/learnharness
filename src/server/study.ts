/**
 * Study-time service (design: docs/designs/study-time.md): applies the pure
 * timer transitions (core/study-time.ts) to the open-timer file and the
 * interval history, and answers the history summary. Every operation starts
 * by closing stale timers, so no background sweeper is needed.
 */

import {
	applyActive,
	applyStop,
	chatHasStarted,
	chatStudyMs,
	closeAllOpen,
	closeAtLastPing,
	closeStale,
	summarizeStudy,
} from "../core/study-time.ts";
import type { OpenStudyTimers, StudyInput, StudyInterval, StudyRangeKey, StudyResult, StudySummary } from "../core/contracts/study.ts";
import { effectiveSettings, stores } from "./stores.ts";

const { studyStore, chatStore } = stores;

/** Append what closed (history first), then rewrite open.json if it changed. */
async function persist(before: OpenStudyTimers, after: OpenStudyTimers, closed: StudyInterval[]): Promise<void> {
	await studyStore.appendIntervals(closed);
	if (after !== before) await studyStore.writeOpen(after);
	for (const i of closed) {
		console.info(`[study] ${i.chatId} ${Math.round((Date.parse(i.end) - Date.parse(i.start)) / 1000)}s ${i.endReason}`);
	}
}

export async function recordStudy(input: StudyInput, now = new Date()): Promise<StudyResult> {
	const eff = await effectiveSettings();
	const idleMs = eff.studyTime.idleMinutes * 60_000;
	const original = await studyStore.readOpen();
	const stale = closeStale(original, now, idleMs);
	let open = stale.open;
	const closed = [...stale.closed];
	let result: StudyResult = { ok: true };

	if (input.type === "closeAll") {
		const step = closeAllOpen(open, now, "stop");
		open = step.open;
		closed.push(...step.closed);
	} else if (input.type === "stop") {
		const step = applyStop(open, input, now);
		open = step.open;
		closed.push(...step.closed);
	} else {
		const existing = Object.hasOwn(open.timers, input.chatId) ? open.timers[input.chatId] : undefined;
		if (existing && existing.windowId === input.windowId) {
			const step = applyActive(open, input, now);
			open = step.open;
			closed.push(...step.closed);
		} else {
			// A different page's timer is closed even if this request is refused.
			const took = closeAtLastPing(open, input.chatId);
			open = took.open;
			closed.push(...took.closed);
			const chat = await chatStore.getChat(input.chatId);
			if (!chat) {
				result = { ok: false, status: 404, error: "chat_not_found" };
			} else if (!chatHasStarted(chat.messages)) {
				result = { ok: false, status: 400, error: "chat_not_started" };
			} else {
				const step = applyActive(open, input, now);
				open = step.open;
				closed.push(...step.closed);
			}
		}
	}

	await persist(original, open, closed);
	if (!result.ok) console.info(`[study] refused ${input.type} ${result.error}`);
	return result;
}

export async function studyHistory(tz: string, range: StudyRangeKey, now = new Date()): Promise<StudySummary> {
	const eff = await effectiveSettings();
	const { idleMinutes, weekStart, teachSoftCapMinutes } = eff.studyTime;
	const original = await studyStore.readOpen();
	const stale = closeStale(original, now, idleMinutes * 60_000);
	await persist(original, stale.open, stale.closed);
	const intervals = await studyStore.readIntervals();
	const summary = summarizeStudy({ intervals, tz, weekStart, range, now, idleMinutes });
	return { ...summary, teachSoftCapMinutes };
}

export async function getChatStudyStatus(
	chatId: string,
	now = new Date(),
): Promise<{ chatMs: number; teachSoftCapMinutes: number; softCapReached: boolean }> {
	const eff = await effectiveSettings();
	const settings = eff.studyTime;
	const idleMinutes = settings.idleMinutes;
	const teachSoftCapMinutes = settings.teachSoftCapMinutes;
	const intervals = await studyStore.readIntervals();
	const open = await studyStore.readOpen();
	const chatMs = chatStudyMs(intervals, open, chatId, now.getTime(), idleMinutes);
	const softCapReached = teachSoftCapMinutes > 0 && chatMs >= teachSoftCapMinutes * 60_000;
	return { chatMs, teachSoftCapMinutes, softCapReached };
}

/** SIGTERM/SIGINT: close every open timer at shutdown time. Never throws. */
export async function closeStudyOnShutdown(now = new Date()): Promise<void> {
	try {
		const eff = await effectiveSettings();
		const idleMs = eff.studyTime.idleMinutes * 60_000;
		const original = await studyStore.readOpen();
		const stale = closeStale(original, now, idleMs);
		const all = closeAllOpen(stale.open, now, "shutdown");
		await persist(original, all.open, [...stale.closed, ...all.closed]);
	} catch (err) {
		console.error("[study] shutdown close failed:", err);
	}
}

/** Once per process: synchronous listeners that finish before Next's own
 *  async cleanup calls process.exit. Never exits the process itself. */
export function registerStudyShutdown(): void {
	const g = globalThis as { __lhStudySignals?: boolean };
	if (process.env.NODE_ENV === "test" || g.__lhStudySignals) return;
	g.__lhStudySignals = true;
	process.on("SIGTERM", () => void closeStudyOnShutdown());
	process.on("SIGINT", () => void closeStudyOnShutdown());
}

registerStudyShutdown();
