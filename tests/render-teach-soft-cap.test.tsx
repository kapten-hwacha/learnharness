/**
 * Render and gate tests for the Teach-Mode Soft-Cap Pill in components/chat.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldShowTeachSoftCapPill, TeachSoftCapPill, isSwitchToPracticeAnswer } from "../components/chat.tsx";
import type { QuestionAnswerData } from "../src/core/index.ts";

describe("shouldShowTeachSoftCapPill gate", () => {
	it("shows when soft cap reached in teach mode with messages", () => {
		assert.equal(shouldShowTeachSoftCapPill("teach", true, 20, 25 * 60_000, true), true);
		assert.equal(shouldShowTeachSoftCapPill("teach", true, 20, 20 * 60_000, false), true);
		assert.equal(shouldShowTeachSoftCapPill("teach", true, 20, 10 * 60_000, true), true);
	});

	it("hides when soft cap not reached and chatMs < soft cap", () => {
		assert.equal(shouldShowTeachSoftCapPill("teach", true, 20, 10 * 60_000, false), false);
		assert.equal(shouldShowTeachSoftCapPill("teach", true, 20, undefined, false), false);
	});

	it("hides in practice mode", () => {
		assert.equal(shouldShowTeachSoftCapPill("practice", true, 20, 30 * 60_000, true), false);
	});

	it("hides when chat has no messages", () => {
		assert.equal(shouldShowTeachSoftCapPill("teach", false, 20, 30 * 60_000, true), false);
	});

	it("hides when teachSoftCapMinutes is 0 or undefined", () => {
		assert.equal(shouldShowTeachSoftCapPill("teach", true, 0, 30 * 60_000, true), false);
		assert.equal(shouldShowTeachSoftCapPill("teach", true, undefined, 30 * 60_000, true), false);
	});
});

describe("TeachSoftCapPill rendering", () => {
	it("renders amber pill with calculated minutes and middle dot label", () => {
		let clicked = false;
		const html = renderToStaticMarkup(
			<TeachSoftCapPill
				chatMs={25 * 60_000}
				teachSoftCapMinutes={20}
				onClick={() => {
					clicked = true;
				}}
			/>,
		);
		assert.ok(html.includes('data-testid="teach-soft-cap-pill"'));
		assert.ok(html.includes("25m · Switch to Practice"));
		assert.ok(html.includes("border-amber-500/40"));
		assert.ok(!clicked);
	});

	it("falls back to soft cap minutes if chatMs is undefined", () => {
		const html = renderToStaticMarkup(
			<TeachSoftCapPill
				teachSoftCapMinutes={20}
				onClick={() => {}}
			/>,
		);
		assert.ok(html.includes("20m · Switch to Practice"));
	});
});

describe("isSwitchToPracticeAnswer", () => {
	it("returns true when an answer matches 'Switch to Practice'", () => {
		const base: QuestionAnswerData = {
			kind: "ask",
			questionText: "Do you want to practice?",
			dontKnow: false,
			answeredAt: "2026-11-02T15:00:00.000Z",
			answers: [{ label: "Switch to Practice (Recommended)", value: "Switch to Practice (Recommended)", index: 1 }],
		};
		assert.equal(isSwitchToPracticeAnswer(base), true);

		const plain: QuestionAnswerData = {
			kind: "ask",
			questionText: "Do you want to practice?",
			dontKnow: false,
			answeredAt: "2026-11-02T15:00:00.000Z",
			answers: [{ label: "Switch to practice", value: "Switch to practice", index: 1 }],
		};
		assert.equal(isSwitchToPracticeAnswer(plain), true);
	});

	it("returns false for continue teaching or other answers", () => {
		const continueAns: QuestionAnswerData = {
			kind: "ask",
			questionText: "Do you want to practice?",
			dontKnow: false,
			answeredAt: "2026-11-02T15:00:00.000Z",
			answers: [{ label: "Continue teaching", value: "Continue teaching", index: 2 }],
		};
		assert.equal(isSwitchToPracticeAnswer(continueAns), false);

		const emptyAnswers: QuestionAnswerData = {
			kind: "ask",
			questionText: "Do you want to practice?",
			dontKnow: false,
			answeredAt: "2026-11-02T15:00:00.000Z",
			answers: [],
			other: "I want to review one more thing",
		};
		assert.equal(isSwitchToPracticeAnswer(emptyAnswers), false);
	});
});
