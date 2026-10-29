import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// LH_DATA_DIR seam before importing any config-dependent code
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-profiler-test-"));
process.env.LH_DATA_DIR = TMP_DATA;

const {
	computeMetacognitiveMetrics,
	shouldAutoTriggerProfiler,
	buildDeterministicLearnerProfile,
	buildProfilerPrompt,
	PROFILER_SYSTEM_PROMPT,
	emptyProfilerState,
	DEFAULT_PROFILER_INTERVAL_SESSIONS,
	LEARNER_PROFILE_SEGMENT_PATH,
} = await import("../src/core/profiler.ts");

const {
	getProfilerStatus,
	runMetacognitiveProfiler,
	approveProfilerProposal,
	dismissProfilerProposal,
	maybeAutoRunProfiler,
	readProfilerState,
	writeProfilerState,
} = await import("../src/server/profiler.ts");

const { stores } = await import("../src/server/stores.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { GET: getProfilerRoute, POST: postProfilerRoute } = await import("../app/api/profiler/route.ts");

import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { ReviewCard } from "../src/core/profiler.ts";

after(() => {
	try {
		fs.rmSync(TMP_DATA, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("Metacognitive Profiler Analytics", () => {
	it("returns zero counts and null rates for empty data", () => {
		const metrics = computeMetacognitiveMetrics([], []);
		assert.equal(metrics.totalSessions, 0);
		assert.equal(metrics.eligibleSessions, 0);
		assert.equal(metrics.gradedQuizCount, 0);
		assert.equal(metrics.correctQuizCount, 0);
		assert.equal(metrics.accuracyRate, null);
		assert.equal(metrics.confidenceSampleCount, 0);
		assert.equal(metrics.meanConfidence, null);
		assert.equal(metrics.brierScore, null);
		assert.equal(metrics.calibrationBias, null);
		assert.equal(metrics.thinkingSampleCount, 0);
		assert.equal(metrics.meanThinkingChars, 0);
		assert.equal(metrics.terseThinkingRatio, null);
		assert.equal(metrics.clarifyCount, 0);
		assert.equal(metrics.dontKnowCount, 0);
		assert.equal(metrics.strategyCount, 0);
		assert.equal(metrics.transferCount, 0);
		assert.equal(metrics.pdfAttachmentCount, 0);
		assert.equal(metrics.fsrsReviewCount, 0);
		assert.equal(metrics.fsrsLapseRate, null);
	});

	it("identifies eligible sessions correctly", () => {
		const chat1: ChatRecord = {
			id: "c1",
			title: "Chat 1",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				{
					role: "toolResult",
					toolCallId: "q1",
					details: { answeredAt: "2026-10-29T00:01:00Z", correct: true },
				} as any,
			],
		};
		const chat2: ChatRecord = {
			id: "c2",
			title: "Chat 2",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				{
					role: "toolResult",
					toolCallId: "p1",
					toolName: "conclude",
					isError: false,
				} as any,
			],
		};
		const chat3: ChatRecord = {
			id: "c3",
			title: "Chat 3",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				{ role: "user", content: "hello" } as any,
				{ role: "assistant", content: [{ type: "text", text: "hi" }] } as any,
			],
		};

		const metrics = computeMetacognitiveMetrics([chat1, chat2, chat3]);
		assert.equal(metrics.totalSessions, 3);
		assert.equal(metrics.eligibleSessions, 2);
	});

	it("computes quiz accuracy, confidence, Brier score, and overconfidence calibration bias", () => {
		const chat: ChatRecord = {
			id: "c1",
			title: "Quiz Chat",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				// Q1: confidence 90, correct true: error -0.1, brier 0.01, bias -0.1
				{
					role: "toolResult",
					toolCallId: "q1",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:01:00Z",
						correct: true,
						confidence: 90,
						questionType: "check",
					},
				} as any,
				// Q2: confidence 80, correct false: error +0.8, brier 0.64, bias +0.8
				{
					role: "toolResult",
					toolCallId: "q2",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:02:00Z",
						correct: false,
						confidence: 80,
						questionType: "check",
					},
				} as any,
				// Q3: confidence 70, correct true: error -0.3, brier 0.09, bias -0.3
				{
					role: "toolResult",
					toolCallId: "q3",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:03:00Z",
						correct: true,
						confidence: 70,
						questionType: "strategy",
					},
				} as any,
				// Q4: dontKnow true (should NOT be graded as quiz)
				{
					role: "toolResult",
					toolCallId: "q4",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:04:00Z",
						dontKnow: true,
						questionType: "transfer",
					},
				} as any,
			],
		};

		const metrics = computeMetacognitiveMetrics([chat]);
		assert.equal(metrics.gradedQuizCount, 3);
		assert.equal(metrics.correctQuizCount, 2);
		assert.equal(metrics.accuracyRate, 0.6667);
		assert.equal(metrics.confidenceSampleCount, 3);
		assert.equal(metrics.meanConfidence, 80);
		// Brier: (0.01 + 0.64 + 0.09) / 3 = 0.74 / 3 = 0.2467
		assert.equal(metrics.brierScore, 0.2467);
		// Bias: (-0.1 + 0.8 - 0.3) / 3 = 0.4 / 3 = +0.1333 (overconfident)
		assert.equal(metrics.calibrationBias, 0.1333);
		assert.equal(metrics.strategyCount, 1);
		assert.equal(metrics.transferCount, 1);
		assert.equal(metrics.dontKnowCount, 1);
	});

	it("computes underconfidence calibration bias", () => {
		const chat: ChatRecord = {
			id: "c1",
			title: "Underconfidence Chat",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				// confidence 20, correct true: error -0.8, bias -0.8
				{
					role: "toolResult",
					toolCallId: "q1",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:01:00Z",
						correct: true,
						confidence: 20,
					},
				} as any,
			],
		};

		const metrics = computeMetacognitiveMetrics([chat]);
		assert.equal(metrics.calibrationBias, -0.8);
		assert.ok(metrics.calibrationBias < -0.1);
	});

	it("computes thinking trace lengths and terse thinking ratio", () => {
		const chat: ChatRecord = {
			id: "c1",
			title: "Thinking Chat",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				// trace 1 (in details.thinking): 18 chars <= 80 (terse)
				{
					role: "toolResult",
					toolCallId: "q1",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:01:00Z",
						thinking: "A is SPD -> eig > 0",
					},
				} as any,
				// trace 2 (in details.readingThinking): 187 chars > 80 (not terse)
				{
					role: "toolResult",
					toolCallId: "q2",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:02:00Z",
						readingThinking:
							"Let's check the eigenvalues of A. If all eigenvalues are strictly positive, then the quadratic form x^T A x is strictly positive for all non-zero vectors x, which proves positive definiteness.",
					},
				} as any,
				// trace 3 (in custom practice-thinking): 7 chars <= 80 (terse)
				{
					role: "custom",
					customType: "practice-thinking",
					details: {
						text: "x = 5.0",
					},
				} as any,
			],
		};

		const metrics = computeMetacognitiveMetrics([chat]);
		assert.equal(metrics.thinkingSampleCount, 3);
		// mean chars: (19 + 194 + 7) / 3 = 220 / 3 = 73
		assert.equal(metrics.meanThinkingChars, 73);
		// terse ratio: 2 / 3 = 0.6667
		assert.equal(metrics.terseThinkingRatio, 0.6667);
	});

	it("tracks clarifyCount, PDF attachments from question answers and user messages", () => {
		const chat: ChatRecord = {
			id: "c1",
			title: "Attachments & Clarify",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			clarifications: {
				q1: [
					{ asked: "What is A?", reply: "A matrix", at: "t1" },
					{ asked: "Is it symmetric?", reply: "Yes", at: "t2" },
				],
				q2: [{ asked: "What is B?", reply: "Another matrix", at: "t3" }],
			},
			messages: [
				// PDF in question answer
				{
					role: "toolResult",
					toolCallId: "q1",
					details: {
						kind: "quiz",
						answeredAt: "2026-10-29T00:01:00Z",
						attachments: [{ name: "derivation.pdf", mimeType: "application/pdf", data: "base64" }],
					},
				} as any,
				// PDF in user message
				{
					role: "user",
					content: "Here is my handwritten scratchpad",
					attachments: [{ name: "quaderno.pdf", mimeType: "application/pdf", data: "base64" }],
				} as any,
				// Non-PDF image (should not count as PDF)
				{
					role: "user",
					content: "Image",
					attachments: [{ name: "photo.png", mimeType: "image/png", data: "base64" }],
				} as any,
			],
		};

		const metrics = computeMetacognitiveMetrics([chat]);
		assert.equal(metrics.clarifyCount, 3);
		assert.equal(metrics.pdfAttachmentCount, 2);
	});

	it("computes FSRS review counts and lapse rates", () => {
		const reviews: ReviewCard[] = [
			{
				id: "card1",
				history: [{ rating: 3 }, { rating: 4 }, { rating: 3 }],
			},
			{
				id: "card2",
				history: [{ rating: 1 }, { rating: 2 }, { rating: 4 }],
			},
		];

		const metrics = computeMetacognitiveMetrics([], reviews);
		assert.equal(metrics.fsrsReviewCount, 6);
		// 2 lapses (ratings 1 and 2) out of 6 reviews: 2 / 6 = 0.3333
		assert.equal(metrics.fsrsLapseRate, 0.3333);
	});
});

describe("Auto-Trigger Logic", () => {
	it("checks interval threshold correctly and disables when interval <= 0", () => {
		const metrics = { ...emptyProfilerState().metrics!, eligibleSessions: 5 } as any;
		const state = emptyProfilerState(); // lastAnalyzedSessionCount: 0

		// Threshold reached: 5 >= 0 + 5
		assert.equal(shouldAutoTriggerProfiler(metrics, state, 5), true);

		// Threshold not reached: 4 < 0 + 5
		assert.equal(shouldAutoTriggerProfiler({ ...metrics, eligibleSessions: 4 }, state, 5), false);

		// With previous analyzed sessions
		state.lastAnalyzedSessionCount = 5;
		assert.equal(shouldAutoTriggerProfiler({ ...metrics, eligibleSessions: 9 }, state, 5), false);
		assert.equal(shouldAutoTriggerProfiler({ ...metrics, eligibleSessions: 10 }, state, 5), true);

		// Disabled (0)
		assert.equal(shouldAutoTriggerProfiler(metrics, state, 0), false);
		assert.equal(shouldAutoTriggerProfiler(metrics, state, -1), false);
	});
});

describe("Deterministic Learner Profile Generation", () => {
	it("builds a profile respecting calibration bias, terse thinking, and macro navigation", () => {
		const metrics = computeMetacognitiveMetrics([
			{
				id: "c1",
				title: "C1",
				createdAt: "2026-10-29T00:00:00Z",
				updatedAt: "2026-10-29T00:00:00Z",
				messages: [
					{
						role: "toolResult",
						toolCallId: "q1",
						details: {
							kind: "quiz",
							answeredAt: "2026-10-29T00:01:00Z",
							correct: false,
							confidence: 90,
							thinking: "A is SPD -> eig > 0",
							questionType: "strategy",
							attachments: [{ mimeType: "application/pdf" }],
						},
					} as any,
				],
			},
		]);

		const { proposedText, summary } = buildDeterministicLearnerProfile(metrics);
		assert.ok(proposedText.startsWith("## Learner Profile & Studying Style"));
		assert.ok(proposedText.includes("Calibration & Scaffolding"));
		assert.ok(proposedText.includes("Reasoning & Expression Style"));
		assert.ok(proposedText.includes("Macro-Navigation & Spaced Retrieval"));
		assert.ok(proposedText.includes("A is SPD -> eig > 0"));
		assert.ok(summary.includes("1 learning session"));

		// Must NOT match forbidden substrings
		assert.doesNotMatch(proposedText, /install understanding/i);
		assert.doesNotMatch(proposedText, /predict/i);
		assert.doesNotMatch(PROFILER_SYSTEM_PROMPT, /install understanding/i);
		assert.doesNotMatch(PROFILER_SYSTEM_PROMPT, /predict/i);

		const prompt = buildProfilerPrompt(metrics, "");
		assert.ok(prompt.includes("## Learner Profile & Studying Style"));
	});
});

describe("Server Profiler Service", () => {
	beforeEach(() => {
		writeProfilerState(emptyProfilerState());
		promptOverrides.deleteOverride(LEARNER_PROFILE_SEGMENT_PATH);
	});

	it("getProfilerStatus returns baseline defaults", async () => {
		const status = await getProfilerStatus();
		assert.equal(status.state.lastAnalyzedSessionCount, 0);
		assert.equal(status.state.pendingProposal, null);
		assert.equal(status.autoApply, false);
		assert.equal(status.overrideEnabled, false);
		assert.equal(typeof status.intervalSessions, "number");
		assert.equal(typeof status.currentSegmentText, "string");
	});

	it("runMetacognitiveProfiler creates pending proposal when autoApply is false", async () => {
		const chat: ChatRecord = {
			id: "c1",
			title: "C1",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				{
					role: "toolResult",
					toolCallId: "q1",
					details: { answeredAt: "2026-10-29T00:01:00Z", correct: true },
				} as any,
			],
		};

		const status = await runMetacognitiveProfiler({
			chats: [chat],
			reviews: [],
			settings: { agent: { profilerAutoApply: false } } as any,
		});

		assert.equal(status.state.lastAnalyzedSessionCount, 1);
		assert.ok(status.state.pendingProposal);
		assert.equal(status.state.pendingProposal?.basedOnSessions, 1);
		assert.ok(status.state.pendingProposal?.proposedText.includes("## Learner Profile & Studying Style"));
		assert.equal(status.overrideEnabled, false);
	});

	it("runMetacognitiveProfiler auto-applies when autoApply is true", async () => {
		const chat: ChatRecord = {
			id: "c1",
			title: "C1",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				{
					role: "toolResult",
					toolCallId: "q1",
					details: { answeredAt: "2026-10-29T00:01:00Z", correct: true },
				} as any,
			],
		};

		const status = await runMetacognitiveProfiler({
			chats: [chat],
			reviews: [],
			settings: { agent: { profilerAutoApply: true } } as any,
		});

		assert.equal(status.state.pendingProposal, null);
		assert.equal(status.overrideEnabled, true);
		assert.ok(status.overrideText?.includes("## Learner Profile & Studying Style"));
		assert.equal(status.currentSegmentText, status.overrideText);
	});

	it("approveProfilerProposal applies text, enables settings switch, and clears proposal", async () => {
		// First generate a pending proposal
		const chat: ChatRecord = {
			id: "c1",
			title: "C1",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				{
					role: "toolResult",
					toolCallId: "q1",
					details: { answeredAt: "2026-10-29T00:01:00Z", correct: true },
				} as any,
			],
		};
		await runMetacognitiveProfiler({
			chats: [chat],
			reviews: [],
			settings: { agent: { profilerAutoApply: false } } as any,
		});

		const status = await approveProfilerProposal();
		assert.equal(status.state.pendingProposal, null);
		assert.equal(status.overrideEnabled, true);
		assert.ok(status.overrideText?.includes("## Learner Profile & Studying Style"));

		// Approve with custom text
		const custom = "## Learner Profile & Studying Style\n- Custom override";
		const customStatus = await approveProfilerProposal(custom);
		assert.equal(customStatus.overrideText, custom);
	});

	it("dismissProfilerProposal clears proposal without applying override", async () => {
		const chat: ChatRecord = {
			id: "c1",
			title: "C1",
			createdAt: "2026-10-29T00:00:00Z",
			updatedAt: "2026-10-29T00:00:00Z",
			messages: [
				{
					role: "toolResult",
					toolCallId: "q1",
					details: { answeredAt: "2026-10-29T00:01:00Z", correct: true },
				} as any,
			],
		};
		await runMetacognitiveProfiler({
			chats: [chat],
			reviews: [],
			settings: { agent: { profilerAutoApply: false } } as any,
		});

		const dismissed = await dismissProfilerProposal();
		assert.equal(dismissed.state.pendingProposal, null);
		assert.equal(dismissed.overrideEnabled, false);
	});
});

describe("Profiler API Route Handlers", () => {
	beforeEach(() => {
		writeProfilerState(emptyProfilerState());
		promptOverrides.deleteOverride(LEARNER_PROFILE_SEGMENT_PATH);
	});

	it("GET /api/profiler returns status JSON", async () => {
		const res = await getProfilerRoute();
		assert.equal(res.status, 200);
		const json = await res.json();
		assert.ok(json.state);
		assert.ok(json.metrics);
	});

	it("POST /api/profiler handles analyze, approve, dismiss, and invalid actions", async () => {
		// analyze
		const reqAnalyze = new Request("http://localhost/api/profiler", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "analyze" }),
		});
		const resAnalyze = await postProfilerRoute(reqAnalyze);
		assert.equal(resAnalyze.status, 200);
		const jsonAnalyze = await resAnalyze.json();
		assert.ok(jsonAnalyze.state);

		// approve
		const reqApprove = new Request("http://localhost/api/profiler", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "approve", text: "## Learner Profile\n- Approved" }),
		});
		const resApprove = await postProfilerRoute(reqApprove);
		assert.equal(resApprove.status, 200);
		const jsonApprove = await resApprove.json();
		assert.equal(jsonApprove.overrideText, "## Learner Profile\n- Approved");

		// dismiss
		const reqDismiss = new Request("http://localhost/api/profiler", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "dismiss" }),
		});
		const resDismiss = await postProfilerRoute(reqDismiss);
		assert.equal(resDismiss.status, 200);
		const jsonDismiss = await resDismiss.json();
		assert.equal(jsonDismiss.state.pendingProposal, null);

		// invalid action
		const reqInvalid = new Request("http://localhost/api/profiler", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "unknown" }),
		});
		const resInvalid = await postProfilerRoute(reqInvalid);
		assert.equal(resInvalid.status, 400);

		// invalid body
		const reqBadJson = new Request("http://localhost/api/profiler", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "invalid-json",
		});
		const resBadJson = await postProfilerRoute(reqBadJson);
		assert.equal(resBadJson.status, 400);
	});
});
