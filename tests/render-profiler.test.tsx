/**
 * Render and interaction tests for MetacognitiveProfilerCard and AgentSection integration.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

import {
	MetacognitiveProfilerCard,
	composeProfilerInterval,
	composeProfilerAutoApply,
} from "../components/settings/profiler-card.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import type { AgentSettings } from "../src/core/index.ts";
import type { ProfilerStatusResponse } from "../src/core/contracts/profiler.ts";
import { onSettingsSaved } from "../components/settings-signal.ts";

const mockStatusWithProposal: ProfilerStatusResponse = {
	state: {
		lastAnalyzedSessionCount: 5,
		lastRunAt: "2026-10-29T00:00:00.000Z",
		metrics: {
			totalSessions: 6,
			eligibleSessions: 5,
			gradedQuizCount: 10,
			correctQuizCount: 8,
			accuracyRate: 0.8,
			confidenceSampleCount: 10,
			meanConfidence: 85,
			brierScore: 0.12,
			calibrationBias: 0.05,
			thinkingSampleCount: 8,
			meanThinkingChars: 45,
			terseThinkingRatio: 0.75,
			clarifyCount: 1,
			dontKnowCount: 0,
			strategyCount: 2,
			transferCount: 1,
			pdfAttachmentCount: 0,
			fsrsReviewCount: 4,
			fsrsLapseRate: 0.25,
		},
		pendingProposal: {
			proposedText: "## Learner Profile\n- Lean into terse mathematical notation.",
			currentText: "# Baseline Profile",
			summary: "Learner uses concise math shorthand and exhibits high confidence calibration.",
			createdAt: "2026-10-29T00:00:00.000Z",
			basedOnSessions: 5,
		},
	},
	metrics: {
		totalSessions: 6,
		eligibleSessions: 5,
		gradedQuizCount: 10,
		correctQuizCount: 8,
		accuracyRate: 0.8,
		confidenceSampleCount: 10,
		meanConfidence: 85,
		brierScore: 0.12,
		calibrationBias: 0.05,
		thinkingSampleCount: 8,
		meanThinkingChars: 45,
		terseThinkingRatio: 0.75,
		clarifyCount: 1,
		dontKnowCount: 0,
		strategyCount: 2,
		transferCount: 1,
		pdfAttachmentCount: 0,
		fsrsReviewCount: 4,
		fsrsLapseRate: 0.25,
	},
	shouldAutoTrigger: false,
	currentSegmentText: "# Baseline Profile",
	overrideText: null,
	overrideEnabled: false,
	intervalSessions: 5,
	autoApply: false,
};

const mockStatusNoProposal: ProfilerStatusResponse = {
	...mockStatusWithProposal,
	state: {
		...mockStatusWithProposal.state,
		pendingProposal: null,
	},
};

describe("Metacognitive Profiler Settings Composers", () => {
	it("composeProfilerInterval sets or updates intervalSessions", () => {
		const res1 = composeProfilerInterval(undefined, 10);
		assert.equal(res1.profilerIntervalSessions, 10);

		const res2 = composeProfilerInterval({ profilerIntervalSessions: 5, profilerAutoApply: true }, 15);
		assert.equal(res2.profilerIntervalSessions, 15);
		assert.equal(res2.profilerAutoApply, true);

		const res3 = composeProfilerInterval({ profilerIntervalSessions: 5 }, undefined);
		assert.equal(res3.profilerIntervalSessions, undefined);
	});

	it("composeProfilerAutoApply sets or updates profilerAutoApply", () => {
		const res1 = composeProfilerAutoApply(undefined, true);
		assert.equal(res1.profilerAutoApply, true);

		const res2 = composeProfilerAutoApply({ profilerAutoApply: true, profilerIntervalSessions: 5 }, false);
		assert.equal(res2.profilerAutoApply, false);
		assert.equal(res2.profilerIntervalSessions, 5);
	});
});

describe("MetacognitiveProfilerCard SSR", () => {
	it("renders group-profiler, rows, metrics summary, and proposal card when pendingProposal is present", () => {
		const html = renderToStaticMarkup(
			<MetacognitiveProfilerCard
				agent={{ profilerIntervalSessions: 5, profilerAutoApply: false }}
				onSectionChange={() => {}}
				initialStatus={mockStatusWithProposal}
			/>,
		);

		assert.ok(html.includes('data-testid="group-profiler"'));
		assert.ok(html.includes('data-testid="profiler-row-interval"'));
		assert.ok(html.includes('data-testid="input-profiler-interval"'));
		assert.ok(html.includes('data-testid="profiler-row-auto-apply"'));
		assert.ok(html.includes('data-testid="profiler-row-analyze"'));
		assert.ok(html.includes('data-testid="profiler-metrics-summary"'));
		assert.ok(html.includes('data-testid="profiler-analyze-button"'));
		assert.ok(html.includes("Sessions: 5"));
		assert.ok(html.includes("Accuracy: 80%"));
		assert.ok(html.includes("Brier: 0.12"));
		assert.ok(html.includes("Shorthand: 75%"));

		assert.ok(html.includes('data-testid="profiler-proposal-card"'));
		assert.ok(html.includes('data-testid="profiler-proposal-summary"'));
		assert.ok(html.includes(mockStatusWithProposal.state.pendingProposal!.summary));
		assert.ok(html.includes('data-testid="profiler-proposal-textarea"'));
		assert.ok(html.includes('data-testid="profiler-approve-button"'));
		assert.ok(html.includes('data-testid="profiler-dismiss-button"'));
	});

	it("omits proposal card when pendingProposal is null", () => {
		const html = renderToStaticMarkup(
			<MetacognitiveProfilerCard
				agent={{ profilerIntervalSessions: 5 }}
				onSectionChange={() => {}}
				initialStatus={mockStatusNoProposal}
			/>,
		);

		assert.ok(html.includes('data-testid="group-profiler"'));
		assert.ok(html.includes('data-testid="profiler-analyze-button"'));
		assert.ok(!html.includes('data-testid="profiler-proposal-card"'));
	});

	it("AgentSection SSR renders group-profiler right above group-prompts", () => {
		const html = renderToStaticMarkup(
			<AgentSection
				agent={{ profilerIntervalSessions: 5 }}
				models={undefined}
				graph={undefined}
				compaction={undefined}
				onSectionChange={() => {}}
				onModelsChange={() => {}}
				onCompactionChange={() => {}}
			/>,
		);

		const profilerIndex = html.indexOf('data-testid="group-profiler"');
		const promptsIndex = html.indexOf('data-testid="group-prompts"');
		assert.ok(profilerIndex !== -1, "group-profiler found");
		assert.ok(promptsIndex !== -1, "group-prompts found");
		assert.ok(profilerIndex < promptsIndex, "group-profiler is above group-prompts");
	});
});

describe("MetacognitiveProfilerCard DOM Interactions", () => {
	const dom = parseHTML("<html><body></body></html>");
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.document,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		CustomEvent: dom.window.CustomEvent,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
	Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });

	let root: Root | null = null;
	let host: HTMLDivElement | null = null;

	afterEach(async () => {
		await act(async () => {
			root?.unmount();
		});
		root = null;
		host?.remove();
		host = null;
	});

	it("clicking 'Analyze Study Style' calls POST /api/profiler and updates status", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		let postedAction: string | null = null;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/profiler") && init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				postedAction = body.action;
				return new Response(JSON.stringify(mockStatusWithProposal), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		await act(async () => {
			root!.render(
				<MetacognitiveProfilerCard
					agent={{ profilerIntervalSessions: 5, profilerAutoApply: false }}
					onSectionChange={() => {}}
					initialStatus={mockStatusNoProposal}
				/>,
			);
		});

		const analyzeBtn = host.querySelector<HTMLButtonElement>('[data-testid="profiler-analyze-button"]');
		assert.ok(analyzeBtn, "analyze button exists");

		await act(async () => {
			analyzeBtn.click();
		});

		assert.equal(postedAction, "analyze");
		const proposalCard = host.querySelector('[data-testid="profiler-proposal-card"]');
		assert.ok(proposalCard, "proposal card appears after analyze response");
	});

	it("clicking 'Approve & Activate' POSTs action approve with textarea content, clears proposal card, and notifies settings saved", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		let postedPayload: { action: string; text?: string } | null = null;
		let notifiedSection: string | null = null;
		const unsubscribe = onSettingsSaved((section) => {
			notifiedSection = section;
		});

		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/profiler") && init?.method === "POST") {
				postedPayload = JSON.parse(String(init.body));
				return new Response(JSON.stringify(mockStatusNoProposal), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		await act(async () => {
			root!.render(
				<MetacognitiveProfilerCard
					agent={{ profilerIntervalSessions: 5 }}
					onSectionChange={() => {}}
					initialStatus={mockStatusWithProposal}
				/>,
			);
		});

		const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="profiler-proposal-textarea"]');
		assert.ok(textarea, "textarea exists");

		// Edit textarea
		await act(async () => {
			textarea.value = "## Custom Approved Profile Directive";
			textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			textarea.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});

		const approveBtn = host.querySelector<HTMLButtonElement>('[data-testid="profiler-approve-button"]');
		assert.ok(approveBtn, "approve button exists");

		await act(async () => {
			approveBtn.click();
		});

		unsubscribe();
		const payload = postedPayload as { action: string; text?: string } | null;
		assert.ok(payload);
		assert.equal(payload.action, "approve");
		assert.equal(payload.text, "## Custom Approved Profile Directive");
		assert.equal(notifiedSection, "agent");

		// Proposal card is cleared after successful approval
		const proposalCard = host.querySelector('[data-testid="profiler-proposal-card"]');
		assert.equal(proposalCard, null, "proposal card cleared");
	});

	it("clicking 'Dismiss' POSTs action dismiss and clears proposal card", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		let postedPayload: { action: string } | null = null;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/profiler") && init?.method === "POST") {
				postedPayload = JSON.parse(String(init.body));
				return new Response(JSON.stringify(mockStatusNoProposal), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		await act(async () => {
			root!.render(
				<MetacognitiveProfilerCard
					agent={{ profilerIntervalSessions: 5 }}
					onSectionChange={() => {}}
					initialStatus={mockStatusWithProposal}
				/>,
			);
		});

		const dismissBtn = host.querySelector<HTMLButtonElement>('[data-testid="profiler-dismiss-button"]');
		assert.ok(dismissBtn, "dismiss button exists");

		await act(async () => {
			dismissBtn.click();
		});

		const payload = postedPayload as { action: string } | null;
		assert.ok(payload);
		assert.equal(payload.action, "dismiss");

		const proposalCard = host.querySelector('[data-testid="profiler-proposal-card"]');
		assert.equal(proposalCard, null, "proposal card cleared");
	});

	it("auto-apply toggle calls onSectionChange with updated profilerAutoApply", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		let nextAgent: AgentSettings | null = null;

		await act(async () => {
			root!.render(
				<MetacognitiveProfilerCard
					agent={{ profilerIntervalSessions: 5, profilerAutoApply: false }}
					onSectionChange={(next) => {
						nextAgent = next;
					}}
					initialStatus={mockStatusNoProposal}
				/>,
			);
		});

		const toggle = host.querySelector<HTMLButtonElement>('[data-testid="toggle-auto-apply-learner-profile"]');
		assert.ok(toggle, "toggle button exists");
		assert.equal(toggle.getAttribute("aria-checked"), "false");

		await act(async () => {
			toggle.click();
		});

		assert.ok(nextAgent !== null);
		assert.equal((nextAgent as AgentSettings).profilerAutoApply, true);
	});

	it("analyze study style dispatches notifySettingsSaved('agent') when autoApply is true", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		let notifiedSection: string | null = null;
		const unsubscribe = onSettingsSaved((section) => {
			notifiedSection = section;
		});

		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/profiler") && init?.method === "POST") {
				return new Response(JSON.stringify({ ...mockStatusNoProposal, autoApply: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		}) as typeof fetch;

		await act(async () => {
			root!.render(
				<MetacognitiveProfilerCard
					agent={{ profilerIntervalSessions: 5, profilerAutoApply: true }}
					onSectionChange={() => {}}
					initialStatus={mockStatusNoProposal}
				/>,
			);
		});

		const analyzeBtn = host.querySelector<HTMLButtonElement>('[data-testid="profiler-analyze-button"]');
		assert.ok(analyzeBtn);

		await act(async () => {
			analyzeBtn.click();
		});

		unsubscribe();
		assert.equal(notifiedSection, "agent");
	});
});
