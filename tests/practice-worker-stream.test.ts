import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";
import { createPortFetch } from "../src/client/worker-client.ts";
import { createWorkerMessageHandler } from "../src/worker/entry.ts";
import { SessionModel } from "../components/session-core.ts";
import { activeProblemOf } from "../src/core/native-messages.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const POSE_1 = {
	statement: "Problem 1: Prove that 1 + 1 = 2.",
	mode: "recall",
	target: ["p1"],
	modelSolution: "Proof 1",
} as const;

const POSE_2 = {
	statement: "Problem 2: Prove that 2 + 2 = 4.",
	mode: "recall",
	target: ["p2"],
	modelSolution: "Proof 2",
} as const;

const CONCLUDE = {
	outcome: "solved",
	verdict: "Good.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {}
	}
});

function scripted(steps: FauxResponseStep[]): { engine: PiEngine } {
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) =>
		async (context: TranscriptContext): Promise<AssistantMessage> => {
			return typeof step === "function"
				? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never)
				: step;
		};
	faux.setResponses(steps.map(wrap));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
}

describe("Practice next problem flow over real worker transport", () => {
	it("Turn 1 (pose) -> Turn 2 (conclude) -> Turn 3 (next problem pose) flips to ready and activates problem", async () => {
		const chat = chatStore.createChat("Test: practice next loop", "practice");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		createdChats.push(chat.id);

		const { engine } = scripted([
			// Turn 1: pose problem 1
			() => fauxAssistantMessage([fauxToolCall("problem", POSE_1, { id: "call-p1" })], { stopReason: "toolUse" }),
			// Turn 2: conclude problem 1
			() => fauxAssistantMessage([fauxToolCall("conclude", CONCLUDE, { id: "call-c1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Concluded problem 1. Click next when ready.")]),
			// Turn 3: pose problem 2
			() => fauxAssistantMessage([fauxToolCall("problem", POSE_2, { id: "call-p2" })], { stopReason: "toolUse" }),
		]);

		const factory = (opts: { chatId?: string; messages?: any[] }) =>
			createPracticeAgent({ chatId: chat.id, chatStore }, { engine, messages: opts.messages });

		// Wire up worker message handler with the real Next.js API routes / handleChatRequest
		const streamRoute = await import("../app/api/chats/[id]/stream/route.ts");
		const chatRoute = await import("../app/api/chats/[id]/route.ts");

		const handleWorkerMsg = createWorkerMessageHandler(async (req) => {
			const url = new URL(req.url);
			if (req.method === "POST" && url.pathname === "/api/chat") {
				return handleChatRequest(req, factory);
			}
			if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}`) {
				return chatRoute.GET(req, { params: Promise.resolve({ id: chat.id }) });
			}
			if (req.method === "GET" && url.pathname === `/api/chats/${chat.id}/stream`) {
				return streamRoute.GET(req, { params: Promise.resolve({ id: chat.id }) });
			}
			return new Response("Not Found", { status: 404 });
		});

		const portFetch = createPortFetch((data, transfer) => {
			handleWorkerMsg({
				data,
				ports: transfer.filter((t): t is MessagePort => t instanceof MessagePort),
			} as unknown as MessageEvent);
		});

		const model = new SessionModel({
			chatId: chat.id,
			initialMessages: [],
			fetch: portFetch,
		});

		// ── Turn 1: Pose problem 1 ──
		const sent1 = await model.send({ type: "text", text: "start practice" });
		assert.equal(sent1, true);
		assert.equal(model.status, "ready", "Turn 1 must settle to ready");
		assert.equal(activeProblemOf(model.getState().nativeMessages)?.toolCallId, "call-p1", "Problem 1 must be active");

		// ── Turn 2: Submit thinking to conclude problem 1 ──
		const sent2 = await model.send({ type: "thinking", problemCallId: "call-p1", text: "solution 1" });
		assert.equal(sent2, true);
		assert.equal(model.status, "ready", "Turn 2 must settle to ready");
		assert.equal(activeProblemOf(model.getState().nativeMessages), null, "Problem 1 must be concluded");

		// ── Turn 3: Prompt for next problem ──
		const sent3 = await model.send({ type: "next" });
		assert.equal(sent3, true);
		assert.equal(model.status, "ready", "Turn 3 must settle to ready automatically without manual stop");
		assert.equal(activeProblemOf(model.getState().nativeMessages)?.toolCallId, "call-p2", "Problem 2 must be active");
	});

	it("simulates client turn-started and turn-settled event loop for practice pose turn", async () => {
		let turnInFlight = false;
		const localStreamRef = { current: false };
		let synced = false;

		const syncFromServer = async () => {
			synced = true;
		};

		// 1. sendNext is clicked
		const onSendNext = () => {
			localStreamRef.current = true;
		};
		onSendNext();
		assert.equal(localStreamRef.current, true, "localStreamRef must synchronously flip to true upon sendNext");

		// 2. turn-started event arrives while turn is running
		const handleTurnStarted = () => {
			if (localStreamRef.current) return; // our OWN turn
			if (turnInFlight) return;
			turnInFlight = true;
		};
		handleTurnStarted();
		assert.equal(turnInFlight, false, "turn-started must not set turnInFlight for our own turn");

		// 3. Even if turnInFlight was true (e.g. from background discovery or mount reattach)
		turnInFlight = true;
		const handleTurnSettled = () => {
			if (localStreamRef.current) {
				return;
			}
			turnInFlight = false;
			void syncFromServer();
		};

		// When turn completes, localStream settles to false
		localStreamRef.current = false;
		handleTurnSettled();
		assert.equal(turnInFlight, false, "turn-settled must clear turnInFlight");
		assert.equal(synced, true, "turn-settled must trigger syncFromServer");
	});
});
