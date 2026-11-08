/**
 * Study-time store: src/store/study.ts with in-memory test backend.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { StudyInterval } from "../src/core/contracts/study.ts";
import { studyStore } from "../src/store/study.ts";
import { appendRawMemoryInterval, resetMemoryStores, setRawMemoryKv } from "../src/store/memory-backend.ts";

beforeEach(() => {
	resetMemoryStores();
});

const rec = (chatId: string, start: string, end: string, endReason: StudyInterval["endReason"] = "stop"): StudyInterval => ({
	v: 1,
	chatId,
	start,
	end,
	endReason,
});
const A = rec("a", "2026-10-28T10:00:00.000Z", "2026-10-28T10:10:00.000Z");
const B = rec("b", "2026-10-28T11:00:00.000Z", "2026-10-28T11:10:00.000Z", "idle");

describe("study store: intervals", () => {
	it("appends and reads back in order; a missing file reads empty", async () => {
		assert.deepEqual(await studyStore.readIntervals(), []);
		await studyStore.appendIntervals([A]);
		await studyStore.appendIntervals([B]);
		assert.deepEqual(await studyStore.readIntervals(), [A, B]);
	});

	it("an empty append writes nothing", async () => {
		await studyStore.appendIntervals([]);
		assert.deepEqual(await studyStore.readIntervals(), []);
	});

	it("a torn last line is skipped and the next append lands intact", async () => {
		await studyStore.appendIntervals([A]);
		appendRawMemoryInterval('{"v":1,"chatId":"torn","sta');
		await studyStore.appendIntervals([B]);
		assert.deepEqual(await studyStore.readIntervals(), [A, B]);
	});

	it("skips invalid and newer-version lines", async () => {
		appendRawMemoryInterval(JSON.stringify(A));
		appendRawMemoryInterval(JSON.stringify({ ...B, v: 2 }));
		appendRawMemoryInterval(JSON.stringify({ ...B, chatId: "bad id" }));
		appendRawMemoryInterval(JSON.stringify({ ...B, start: "not a date" }));
		appendRawMemoryInterval(JSON.stringify({ ...B, endReason: "crash" }));
		appendRawMemoryInterval("[]");
		appendRawMemoryInterval("null");
		appendRawMemoryInterval("");
		appendRawMemoryInterval(JSON.stringify(B));
		assert.deepEqual(await studyStore.readIntervals(), [A, B]);
	});
});

describe("study store: open timers", () => {
	it("missing or unparseable file means no open timers", async () => {
		assert.deepEqual(await studyStore.readOpen(), { v: 1, timers: {} });
		setRawMemoryKv("study_open", "{not json");
		assert.deepEqual(await studyStore.readOpen(), { v: 1, timers: {} });
		setRawMemoryKv(
			"study_open",
			JSON.stringify({ v: 2, timers: { a: { start: A.start, lastPing: A.end, windowId: "w" } } }),
		);
		assert.deepEqual(await studyStore.readOpen(), { v: 1, timers: {} }, "a newer v reads as empty");
	});

	it("writeOpen round-trips open timers", async () => {
		const open = { v: 1 as const, timers: { a: { start: A.start, lastPing: A.end, windowId: "w1" } } };
		await studyStore.writeOpen(open);
		assert.deepEqual(await studyStore.readOpen(), open);
		await studyStore.writeOpen({ v: 1, timers: {} });
		assert.deepEqual(await studyStore.readOpen(), { v: 1, timers: {} });
	});

	it("drops malformed timer entries and keeps the good ones", async () => {
		const good = { start: A.start, lastPing: A.end, windowId: "w" };
		setRawMemoryKv(
			"study_open",
			JSON.stringify({
				v: 1,
				timers: {
					good,
					"bad id": good,
					noStart: { lastPing: A.end, windowId: "w" },
					badPing: { ...good, lastPing: "nope" },
					badWindow: { ...good, windowId: "a b" },
					notObject: 5,
				},
			}),
		);
		assert.deepEqual(await studyStore.readOpen(), { v: 1, timers: { good } });
	});
});
