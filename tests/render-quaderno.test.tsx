/**
 * Render and interaction tests for Quaderno controls in QuestionDock and PracticeDock.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

import { QuadernoRoundTripBar } from "../components/quaderno-controls.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

describe("Quaderno SSR Render", () => {
	it("QuadernoRoundTripBar renders send, attach, and upload buttons", () => {
		const html = renderToStaticMarkup(
			<QuadernoRoundTripBar
				title="Test Title"
				markdown="# Test Markdown"
				docTitle="test-title"
				onAttach={() => {}}
			/>,
		);

		assert.ok(html.includes('data-testid="quaderno-round-trip-bar"'));
		assert.ok(html.includes('data-testid="quaderno-send-button"'));
		assert.ok(html.includes('data-testid="quaderno-attach-button"'));
		assert.ok(html.includes('data-testid="quaderno-upload-button"'));
		assert.ok(html.includes('data-testid="quaderno-file-input"'));
	});

	it("QuadernoRoundTripBar renders chips for attached files", () => {
		const html = renderToStaticMarkup(
			<QuadernoRoundTripBar
				title="Test Title"
				markdown="# Test Markdown"
				docTitle="test-title"
				attachedFiles={[
					{ name: "derivation-page-1.pdf", mimeType: "application/pdf", data: "base64data" },
				]}
				onAttach={() => {}}
				onRemoveAttachment={() => {}}
			/>,
		);

		assert.ok(html.includes('data-testid="quaderno-attached-chip"'));
		assert.ok(html.includes("derivation-page-1.pdf"));
	});

	it("QuestionDock renders Quaderno controls bar when expanded", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="call_q1"
				input={{
					question: "Explain the Fourier transform.",
					options: [{ label: "Option A" }, { label: "Option B" }],
					correctAnswer: "Option A",
					explanation: "Because A.",
				}}
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);

		assert.ok(html.includes('data-testid="quaderno-round-trip-bar"'));
		assert.ok(html.includes('data-testid="quaderno-send-button"'));
		assert.ok(html.includes('data-testid="quaderno-attach-button"'));
	});

	it("PracticeDock renders Quaderno controls bar when expanded", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="call_p1"
				input={{ statement: "Prove that sqrt(2) is irrational." }}
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);

		assert.ok(html.includes('data-testid="quaderno-round-trip-bar"'));
		assert.ok(html.includes('data-testid="quaderno-send-button"'));
		assert.ok(html.includes('data-testid="quaderno-attach-button"'));
	});
});

describe("Quaderno DOM Interactions & Submission", () => {
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
	dom.window.HTMLElement.prototype.scrollIntoView = () => {};

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

	it("QuestionDock: text-mode question can submit when PDF is attached even if text is empty", async () => {
		let submittedAnswer: QuestionAnswerData | null = null;

		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		// Mock fetch for /api/quaderno pullPdf
		globalThis.fetch = async (input, init) => {
			const body = JSON.parse(String(init?.body));
			assert.equal(body.action, "pullPdf");
			return Response.json({
				ok: true,
				mode: "daemon",
				message: "Attached solution.pdf from learn-harness/",
				attachment: {
					name: "solution.pdf",
					mimeType: "application/pdf",
					data: "JVBERi0xLjQK...",
				},
			});
		};

		await act(async () => {
			root!.render(
				<QuestionDock
					toolName="explain"
					toolCallId="call_explain_01"
					input={{
						question: "Write out the derivation of the heat equation.",
						correctAnswer: "Standard diffusion equation derivation",
					}}
					expanded={true}
					onExpand={() => {}}
					onSubmit={(ans) => {
						submittedAnswer = ans;
					}}
				/>,
			);
		});

		// Submit button should initially be disabled because text is empty and no attachments
		const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
		assert.ok(submitBtn, "submit button must exist");
		assert.equal(submitBtn.disabled, true);

		// Click "Attach from Quaderno"
		const attachBtn = host.querySelector('[data-testid="quaderno-attach-button"]') as HTMLButtonElement;
		assert.ok(attachBtn, "attach button must exist");

		await act(async () => {
			attachBtn.click();
		});

		// Now submit button should be enabled
		assert.equal(submitBtn.disabled, false);

		// Submit form
		await act(async () => {
			submitBtn.click();
		});

		assert.ok(submittedAnswer !== null, "Answer must be submitted");
		assert.equal((submittedAnswer as QuestionAnswerData).text, "[See attached Quaderno PDF]");
		assert.ok((submittedAnswer as QuestionAnswerData).attachments?.length === 1);
		assert.equal((submittedAnswer as QuestionAnswerData).attachments?.[0]?.name, "solution.pdf");
	});

	it("PracticeDock: allows submitting when Quaderno PDF is attached", async () => {
		let submittedText = "";
		let submittedAttachments: unknown = null;

		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		globalThis.fetch = async () => {
			return Response.json({
				ok: true,
				mode: "daemon",
				attachment: {
					name: "practice-sol.pdf",
					mimeType: "application/pdf",
					data: "JVBERi0xLjQK...",
				},
			});
		};

		await act(async () => {
			root!.render(
				<PracticeDock
					problemCallId="call_practice_01"
					input={{ statement: "Find all primes p such that p^2 + 2 is also prime." }}
					expanded={true}
					onExpand={() => {}}
					onSubmit={(text, atts) => {
						submittedText = text;
						submittedAttachments = atts;
					}}
				/>,
			);
		});

		const sendBtn = host.querySelector('[data-testid="practice-send"]') as HTMLButtonElement;
		assert.ok(sendBtn);
		assert.equal(sendBtn.disabled, true);

		const attachBtn = host.querySelector('[data-testid="quaderno-attach-button"]') as HTMLButtonElement;
		assert.ok(attachBtn);

		await act(async () => {
			attachBtn.click();
		});

		assert.equal(sendBtn.disabled, false);

		await act(async () => {
			sendBtn.click();
		});

		assert.equal(submittedText, "[See attached Quaderno PDF]");
		assert.ok(Array.isArray(submittedAttachments));
		assert.equal((submittedAttachments as Array<{ name: string }>)[0]?.name, "practice-sol.pdf");
	});

	it("QuestionDock: populates transcribed derivation into answer field and appends to existing text", async () => {
		let submittedAnswer: unknown = null;

		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		globalThis.fetch = async () => {
			return Response.json({
				ok: true,
				mode: "daemon",
				attachment: {
					name: "transcribed-derivation.pdf",
					mimeType: "application/pdf",
					data: "JVBERi0xLjQK...",
				},
				transcription: "Derivation: $x^2 = 2 \\implies x = \\sqrt{2} \\notin \\mathbb{Q}$",
			});
		};

		await act(async () => {
			root!.render(
				<QuestionDock
					toolName="explain"
					toolCallId="call_explain_transcribe"
					input={{
						question: "Prove that sqrt(2) is irrational.",
						correctAnswer: "Standard contradiction proof using divisibility by 2.",
					}}
					initialDraft={{
						selection: { selected: new Set(), otherSelected: false, dontKnow: false },
						thinking: "",
						other: "",
						text: "My starting assumption: assume sqrt(2) = a/b in lowest terms.",
						confidenceIndex: 2,
					}}
					expanded={true}
					onExpand={() => {}}
					onSubmit={(ans) => {
						submittedAnswer = ans;
					}}
				/>,
			);
		});

		const attachBtn = host.querySelector('[data-testid="quaderno-attach-button"]') as HTMLButtonElement;
		assert.ok(attachBtn, "attach button must exist");

		await act(async () => {
			attachBtn.click();
		});

		const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
		assert.ok(submitBtn);
		assert.equal(submitBtn.disabled, false);

		await act(async () => {
			submitBtn.click();
		});

		assert.ok(submittedAnswer !== null);
		assert.equal(
			(submittedAnswer as QuestionAnswerData).text,
			"My starting assumption: assume sqrt(2) = a/b in lowest terms.\n\nDerivation: $x^2 = 2 \\implies x = \\sqrt{2} \\notin \\mathbb{Q}$",
		);
		assert.equal(
			(submittedAnswer as QuestionAnswerData).attachments?.[0]?.name,
			"transcribed-derivation.pdf",
		);
	});

	it("PracticeDock: populates transcribed notes into thinking field", async () => {
		let submittedText = "";
		let submittedAttachments: unknown = null;

		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		globalThis.fetch = async () => {
			return Response.json({
				ok: true,
				mode: "daemon",
				attachment: {
					name: "primes-solution.pdf",
					mimeType: "application/pdf",
					data: "JVBERi0xLjQK...",
				},
				transcription: "Let $p = 3$: $3^2 + 2 = 11$, which is prime.",
			});
		};

		await act(async () => {
			root!.render(
				<PracticeDock
					problemCallId="call_practice_transcribe"
					input={{ statement: "Find all primes p such that p^2 + 2 is also prime." }}
					expanded={true}
					onExpand={() => {}}
					onSubmit={(text, atts) => {
						submittedText = text;
						submittedAttachments = atts;
					}}
				/>,
			);
		});

		const attachBtn = host.querySelector('[data-testid="quaderno-attach-button"]') as HTMLButtonElement;
		assert.ok(attachBtn, "attach button must exist");

		await act(async () => {
			attachBtn.click();
		});

		const sendBtn = host.querySelector('[data-testid="practice-send"]') as HTMLButtonElement;
		assert.ok(sendBtn);
		assert.equal(sendBtn.disabled, false);

		await act(async () => {
			sendBtn.click();
		});

		assert.equal(submittedText, "Let $p = 3$: $3^2 + 2 = 11$, which is prime.");
		assert.ok(Array.isArray(submittedAttachments));
		assert.equal((submittedAttachments as Array<{ name: string }>)[0]?.name, "primes-solution.pdf");
	});

	it("QuadernoRoundTripBar: fires onTranscribed callback when pullPdf response contains transcription", async () => {
		let attachedName = "";
		let receivedTranscription = "";

		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		globalThis.fetch = async () => {
			return Response.json({
				ok: true,
				mode: "daemon",
				message: "Attached and transcribed math-notes.pdf",
				attachment: {
					name: "math-notes.pdf",
					mimeType: "application/pdf",
					data: "JVBERi0xLjQK...",
				},
				transcription: "Euler formula: $e^{i\\pi} + 1 = 0$",
			});
		};

		await act(async () => {
			root!.render(
				<QuadernoRoundTripBar
					title="Math Problem"
					markdown="# Problem"
					docTitle="math-notes"
					onAttach={(att) => {
						attachedName = att.name;
					}}
					onTranscribed={(t) => {
						receivedTranscription = t;
					}}
				/>,
			);
		});

		const attachBtn = host.querySelector('[data-testid="quaderno-attach-button"]') as HTMLButtonElement;
		assert.ok(attachBtn);

		await act(async () => {
			attachBtn.click();
		});

		assert.equal(attachedName, "math-notes.pdf");
		assert.equal(receivedTranscription, "Euler formula: $e^{i\\pi} + 1 = 0$");
	});
});
