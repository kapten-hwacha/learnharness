import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { SessionModel } from "../components/session-core.ts";
import * as streamRoute from "../app/api/chats/[id]/stream/route.ts";
import * as recordRoute from "../app/api/chats/[id]/route.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus" },
		{ label: "Mercury" },
		{ label: "Mars" },
	],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

function scriptedTeacher(steps: (calls: string[][]) => FauxResponseStep[]): {
	engine: PiEngine;
	calls: string[][];
} {
	const calls: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(calls));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

function defaultLesson(calls: string[][]): FauxResponseStep[] {
	return [
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage(
				[fauxThinking("Probe the basics first."), fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText("Right — Mercury it is.")]);
		},
	];
}

function agentFactory(engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

function gradedAnswer(input: typeof QUIZ_INPUT, values: string[]) {
	const options = normalizeOptions(input.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: input.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(input.correctAnswer, options).indices,
		explanation: input.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

async function createConfiguredChat(title: string) {
	const chat = await chatStore.createChat(title);
	await chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	await chatStore.saveTree(chat.id, {
		nodes: [{ id: "planet-order", title: "Planet order" }],
		edges: [],
		version: 1,
	});
	return chat;
}

describe("debug question answering flow", () => {
	it("traces SessionModel status and messages through submitAnswer", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = await createConfiguredChat("Debug: answer thinking loop");
		const chatId = chat.id;

		// 1. Send initial message "quiz me" to pose a quiz
		let turn1Ack = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, input: { type: "text", text: "quiz me" } }),
			}),
			agentFactory(engine),
		);
		assert.equal(turn1Ack.status, 200);

		// Drain turn 1
		const running1 = runningTurn(chatId);
		assert.ok(running1, "turn 1 must be running");
		const streamText1 = await new Response(running1.subscribe()).text();
		assert.ok(streamText1.includes("[DONE]"));

		const saved1 = (await chatStore.getChat(chatId))!;
		const pending1 = danglingQuestionOf(saved1.messages);
		assert.ok(pending1, "quiz must be dangling after turn 1");
		assert.equal(pending1.toolCallId, "call-1");

		// 2. Client mounts with saved1 messages
		const fetchBridge = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const urlStr = String(url);
			if (urlStr === "/api/chat" || urlStr.endsWith("/api/chat")) {
				return handleChatRequest(
					new Request("http://test/api/chat", {
						method: init?.method ?? "POST",
						headers: init?.headers,
						body: init?.body,
					}),
					agentFactory(engine),
				);
			}
			if (urlStr.includes(`/api/chats/${chatId}/stream`)) {
				return streamRoute.GET(new Request("http://test/stream", { signal: init?.signal }), {
					params: Promise.resolve({ id: chatId }),
				});
			}
			if (urlStr.includes(`/api/chats/${chatId}`)) {
				return recordRoute.GET(new Request("http://test/record", { signal: init?.signal }), {
					params: Promise.resolve({ id: chatId }),
				});
			}
			throw new Error(`Unhandled test fetch: ${urlStr}`);
		};

		const statuses: string[] = [];
		const client = new SessionModel({
			chatId,
			initialMessages: saved1.messages,
			fetch: fetchBridge,
		});
		client.onChange = () => {
			statuses.push(client.status);
		};

		assert.equal(client.status, "ready");

		// 3. Submit answer to question
		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);
		console.log("Submitting answer...");
		await client.submitAnswer("quiz", "call-1", answer);

		console.log("Statuses observed:", statuses);
		console.log("Final status:", client.status);
		console.log("Client error:", client.getState().error);
		console.log("Tail length:", client.getState().messages.length);

		// Check if turn finished on server
		assert.equal(isTurnRunning(chatId), false, "turn must not be running on server");
		assert.equal(client.status, "ready", "client status must be ready after turn completes");
	});

	it("reproduces thinking loop when stream terminates without [DONE]", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = await createConfiguredChat("Debug: dropped stream thinking loop");
		const chatId = chat.id;

		// 1. Send initial message "quiz me" to pose a quiz
		await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, input: { type: "text", text: "quiz me" } }),
			}),
			agentFactory(engine),
		);
		const running1 = runningTurn(chatId);
		assert.ok(running1);
		await new Response(running1.subscribe()).text();

		const saved1 = (await chatStore.getChat(chatId))!;

		// Bridge where stream stalls (never emits [DONE]) while server turn finishes
		let stallController: ReadableStreamDefaultController<Uint8Array>;
		const fetchBridge = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const urlStr = String(url);
			if (urlStr === "/api/chat" || urlStr.endsWith("/api/chat")) {
				return handleChatRequest(
					new Request("http://test/api/chat", {
						method: init?.method ?? "POST",
						headers: init?.headers,
						body: init?.body,
					}),
					agentFactory(engine),
				);
			}
			if (urlStr.includes(`/api/chats/${chatId}/stream`)) {
				// Simulate stalled SSE stream that emits events but hangs and never closes with [DONE]
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						stallController = controller;
						const encoder = new TextEncoder();
						controller.enqueue(encoder.encode(`data: {"type":"agent_start"}\n\n`));
						controller.enqueue(encoder.encode(`data: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n`));
					},
				});
				return new Response(stream, {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			if (urlStr.includes(`/api/chats/${chatId}`)) {
				return recordRoute.GET(new Request("http://test/record", { signal: init?.signal }), {
					params: Promise.resolve({ id: chatId }),
				});
			}
			throw new Error(`Unhandled test fetch: ${urlStr}`);
		};

		const client = new SessionModel({
			chatId,
			initialMessages: saved1.messages,
			fetch: fetchBridge,
		});

		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);
		// Submit answer - server processes turn, but stream stalls
		void client.submitAnswer("quiz", "call-1", answer);

		// Wait for server turn to finish
		await new Promise((r) => setTimeout(r, 100));

		// Server turn has completed and is no longer running!
		assert.equal(isTurnRunning(chatId), false, "server turn must be finished");

		// BUT client is stuck in streaming status!
		console.log("Client status while server is finished but stream stalled:", client.status);
		assert.equal(client.status, "streaming", "client is stuck in streaming status");

		// If user tries to submit again, server rejects with 400 because answer was already persisted
		const res2 = await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, input: { type: "answer", toolCallId: "call-1", answer } }),
			}),
			agentFactory(engine),
		);
		assert.equal(res2.status, 400);
		const errJson = await res2.json() as { error: string };
		assert.equal(errJson.error, "answer input targets no pending question call");
		console.log("Re-submission error caught:", errJson.error);

		// Clean up stalled stream
		try { stallController!.close(); } catch {}
	});

	it("recovers from stalled stream via settle() and syncs server state cleanly", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = await createConfiguredChat("Debug: settle recovery test");
		const chatId = chat.id;

		// 1. Send initial message "quiz me" to pose a quiz
		await handleChatRequest(
			new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, input: { type: "text", text: "quiz me" } }),
			}),
			agentFactory(engine),
		);
		const running1 = runningTurn(chatId);
		assert.ok(running1);
		await new Response(running1.subscribe()).text();

		const saved1 = (await chatStore.getChat(chatId))!;

		// Stalled stream
		let stallController: ReadableStreamDefaultController<Uint8Array>;
		const fetchBridge = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const urlStr = String(url);
			if (urlStr === "/api/chat" || urlStr.endsWith("/api/chat")) {
				return handleChatRequest(
					new Request("http://test/api/chat", {
						method: init?.method ?? "POST",
						headers: init?.headers,
						body: init?.body,
					}),
					agentFactory(engine),
				);
			}
			if (urlStr.includes(`/api/chats/${chatId}/stream`)) {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						stallController = controller;
						const encoder = new TextEncoder();
						controller.enqueue(encoder.encode(`data: {"type":"agent_start"}\n\n`));
						controller.enqueue(encoder.encode(`data: {"type":"message_start","message":{"role":"assistant","content":[]}}\n\n`));
					},
				});
				return new Response(stream, {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			if (urlStr.includes(`/api/chats/${chatId}`)) {
				return recordRoute.GET(new Request("http://test/record", { signal: init?.signal }), {
					params: Promise.resolve({ id: chatId }),
				});
			}
			throw new Error(`Unhandled test fetch: ${urlStr}`);
		};

		const client = new SessionModel({
			chatId,
			initialMessages: saved1.messages,
			fetch: fetchBridge,
		});

		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);
		void client.submitAnswer("quiz", "call-1", answer);

		// Wait for server turn to finish
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(isTurnRunning(chatId), false);
		assert.equal(client.status, "streaming");

		// Now invoke fallback settle (as chat.tsx's fallback timer does when turn-settled fires)
		client.settle();
		assert.equal(client.status, "ready", "settle() must immediately transition model to ready");

		// Fetch and sync the authoritative server messages
		const serverChat = (await chatStore.getChat(chatId))!;
		client.adoptRecord(serverChat.messages);

		// Verify the model has adopted the updated messages and no longer has dangling question
		const finalNativeMessages = client.getState().nativeMessages;
		const finalPending = danglingQuestionOf(finalNativeMessages);
		assert.equal(finalPending, null, "no dangling question should remain");
		assert.equal(client.status, "ready", "status remains ready");
		assert.equal(client.getState().error, null, "no error in client state");

		// Clean up stalled stream
		try { stallController!.close(); } catch {}
	});
});
