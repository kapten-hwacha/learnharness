import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeChatGPTFetch } from "../src/worker/chatgpt-native.ts";
import { handleWorkerTauriMessage } from "../src/worker/host-bridge.ts";
import { configureNativeChatGPTFetch, configureWebSubscriptionRuntime } from "../src/agent/subscription-runtime.ts";
import { refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { normalizeContext } from "@earendil-works/pi-ai";

test("native ChatGPT transport streams response bytes without a token lease", async () => {
	const saved = (globalThis as any).__TAURI_INVOKE__;
	const calls: { cmd: string; args: any }[] = [];
	(globalThis as any).__TAURI_INVOKE__ = async (cmd: string, args: any) => {
		calls.push({ cmd, args });
		if (cmd === "lh_chatgpt_stream_start") {
			for (const payload of [
				{ id: args.id, type: "response", status: 200 },
				{ id: args.id, type: "chunk", data: btoa("data: hello\n\n") },
				{ id: args.id, type: "end" },
			]) handleWorkerTauriMessage({ data: { type: "lh:tauri-event", event: "lh://chatgpt-stream", payload } });
		}
	};
	try {
		const scope = { accountId: "account", epoch: 1, authorityRevision: 2, selectedModelId: "model" };
		const response = await nativeChatGPTFetch(scope, false, { body: JSON.stringify({ model: "model", input: [], stream: true, store: false }) });
		assert.equal(await response.text(), "data: hello\n\n");
		assert.deepEqual(calls.map((c) => c.cmd), ["lh_chatgpt_stream_prepare", "lh_chatgpt_stream_start"]);
		assert.equal(JSON.stringify(calls).includes("accessToken"), false);
	} finally { (globalThis as any).__TAURI_INVOKE__ = saved; }
});

test("abort during native startup cancels the eventual native request", async () => {
	const saved = (globalThis as any).__TAURI_INVOKE__;
	const calls: string[] = [];
	let finishStart!: () => void;
	(globalThis as any).__TAURI_INVOKE__ = (cmd: string) => {
		calls.push(cmd);
		return cmd === "lh_chatgpt_stream_prepare" ? new Promise<void>((resolve) => { finishStart = resolve; }) : Promise.resolve();
	};
	try {
		const controller = new AbortController();
		const request = nativeChatGPTFetch({ accountId: "a", epoch: 1, authorityRevision: 1, selectedModelId: "m" }, true, { body: "{}", signal: controller.signal });
		controller.abort();
		await assert.rejects(request, { name: "AbortError" });
		finishStart();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, ["lh_chatgpt_stream_prepare", "lh_chatgpt_stream_cancel", "lh_chatgpt_stream_cancel"]);
	} finally { (globalThis as any).__TAURI_INVOKE__ = saved; }
});

test("native admission does not commit when preparation is refused", async () => {
	const saved = (globalThis as any).__TAURI_INVOKE__;
	(globalThis as any).__TAURI_INVOKE__ = async () => { throw new Error("permission denied"); };
	let committed = false;
	try {
		await assert.rejects(nativeChatGPTFetch({ accountId: "a", epoch: 1, authorityRevision: 1, selectedModelId: "m" }, true, { body: "{}" }, () => { committed = true; }));
		assert.equal(committed, false);
	} finally { (globalThis as any).__TAURI_INVOKE__ = saved; }
});

test("ChatGPT model dispatch uses native streaming without requesting a lease", async () => {
	const saved = (globalThis as any).__TAURI_INVOKE__;
	const model = piModels().getModel("openai", "gpt-5")!;
	const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "account", accounts: [{ id: "account", email: "test@example.invalid", registration: "client", connected: true, planEnabled: true }], error: null };
	const ops: string[] = [];
	configureWebSubscriptionRuntime(async (_channel, op) => {
		ops.push(op);
		return { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "account", models: [{ id: model.id, name: "Test" }] } as any;
	});
	configureNativeChatGPTFetch(nativeChatGPTFetch);
	(globalThis as any).__TAURI_INVOKE__ = async (cmd: string, args: any) => {
		if (cmd === "lh_chatgpt_stream_prepare") { assert.equal(args.payload.model, model.id); return; }
		assert.equal(cmd, "lh_chatgpt_stream_start");
		const events = [
			{ type: "response.created", response: { id: "test" } },
			{ type: "response.completed", response: { id: "test", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
		];
		for (const payload of [
			{ id: args.id, type: "response", status: 200 },
			{ id: args.id, type: "chunk", data: btoa(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")) },
			{ id: args.id, type: "end" },
		]) handleWorkerTauriMessage({ data: { type: "lh:tauri-event", event: "lh://chatgpt-stream", payload } });
	};
	try {
		await refreshChatGPTModels([model as any]);
		const engine = piEngineForSpec({ provider: "chatgpt", id: model.id }, false);
		const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Test", timestamp: 1 }] })).result();
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(ops, ["models"]);
	} finally { (globalThis as any).__TAURI_INVOKE__ = saved; }
});
