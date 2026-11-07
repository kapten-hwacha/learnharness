import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { createPortFetch, parseSseBlock, WorkerEventSource } from "../src/client/worker-client.ts";
import { createWorkerMessageHandler } from "../src/worker/entry.ts";
import { isAllowedSyncPath, isAuthorizedDevBridgeRequest } from "../src/worker/vite-dev-bridge.ts";

describe("Worker MessageChannel transport & Vite dev bridge security", () => {
	it("streams chunked SSE responses over MessageChannel and propagates caller AbortSignal to the Worker Request", async () => {
		let workerRequestAborted = false;
		const handleWorkerMsg = createWorkerMessageHandler(async (req) => {
			req.signal.addEventListener("abort", () => {
				workerRequestAborted = true;
			});
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: first\n\n"));
					controller.enqueue(new TextEncoder().encode("data: second\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});

		const portFetch = createPortFetch((data, transfer) => {
			handleWorkerMsg({ data, ports: transfer.filter((t): t is MessagePort => t instanceof MessagePort) } as unknown as MessageEvent);
		});

		const ac = new AbortController();
		const res = await portFetch("http://localhost/api/events", { signal: ac.signal });
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "data: first\n\ndata: second\n\n");

		ac.abort();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(workerRequestAborted, true);
	});

	it("propagates AbortSignal when passed via Request object into portFetch", async () => {
		let workerRequestAborted = false;
		const handleWorkerMsg = createWorkerMessageHandler(async (req) => {
			req.signal.addEventListener("abort", () => {
				workerRequestAborted = true;
			});
			return new Response("ok", { status: 200 });
		});

		const portFetch = createPortFetch((data, transfer) => {
			handleWorkerMsg({ data, ports: transfer.filter((t): t is MessagePort => t instanceof MessagePort) } as unknown as MessageEvent);
		});

		const ac = new AbortController();
		const req = new Request("http://localhost/api/test", { signal: ac.signal });
		const resPromise = portFetch(req);
		ac.abort();
		await resPromise;
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(workerRequestAborted, true);
	});

	it("parses SSE blocks correctly for both untyped data and typed events", () => {
		const untyped = parseSseBlock("data: hello world\n");
		assert.deepEqual(untyped, { event: "message", data: "hello world" });

		const typed = parseSseBlock("event: chat_updated\ndata: {\"chatId\":\"123\"}\n");
		assert.deepEqual(typed, { event: "chat_updated", data: "{\"chatId\":\"123\"}" });

		const multiline = parseSseBlock("event: log\ndata: line 1\ndata: line 2\n");
		assert.deepEqual(multiline, { event: "log", data: "line 1\nline 2" });

		assert.equal(parseSseBlock(""), null);
		assert.equal(parseSseBlock("   \n\n"), null);
	});

	it("WorkerEventSource dispatches typed SSE events without firing onmessage", async () => {
		const mockSseFetch: typeof fetch = async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("event: chat_updated\ndata: {\"id\":\"c1\"}\n\n"));
					controller.enqueue(new TextEncoder().encode("data: default message\n\n"));
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const es = new WorkerEventSource("http://localhost/api/events", mockSseFetch);
		const receivedChatUpdates: string[] = [];
		const receivedDefaultMessages: string[] = [];

		es.addEventListener("chat_updated", (e) => {
			receivedChatUpdates.push((e as MessageEvent).data);
		});

		es.onmessage = (e) => {
			receivedDefaultMessages.push(e.data);
		};

		await new Promise((r) => setTimeout(r, 50));
		es.close();

		assert.deepEqual(receivedChatUpdates, ['{"id":"c1"}']);
		assert.deepEqual(receivedDefaultMessages, ["default message"]);
	});

	it("streams chunked SSE responses over direct worker postMessage without MessageChannel", async () => {
		let workerSubscribed = false;
		let replySubscriber: ((ev: MessageEvent) => void) | undefined;
		const handleWorkerMsg = createWorkerMessageHandler(async () => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("hello direct world"));
					controller.close();
				},
			});
			return new Response(stream, { status: 200 });
		});

		// Mock global self.postMessage for worker reply
		const origSelf = (globalThis as any).self;
		(globalThis as any).self = {
			postMessage: (data: unknown) => {
				replySubscriber?.({ data } as MessageEvent);
			},
		};

		try {
			const directFetch = createPortFetch(
				(data) => handleWorkerMsg({ data, ports: [] } as unknown as MessageEvent),
				(handler) => {
					workerSubscribed = true;
					replySubscriber = handler;
					return () => {
						replySubscriber = undefined;
					};
				},
			);

			assert.equal(workerSubscribed, true);
			const res = await directFetch("http://localhost/api/test");
			assert.equal(res.status, 200);
			assert.equal(await res.text(), "hello direct world");
		} finally {
			(globalThis as any).self = origSelf;
		}
	});

	it("rejects syncFs paths outside dataDir and authFile, but allows root dataDir and authFile", () => {
		assert.equal(isAllowedSyncPath("/repo/data/chats/c1.json", "/repo/data", "/repo/auth.json"), true);
		assert.equal(isAllowedSyncPath("/repo/data", "/repo/data", "/repo/auth.json"), true);
		assert.equal(isAllowedSyncPath("/repo/auth.json", "/repo/data", "/repo/auth.json"), true);
		assert.equal(isAllowedSyncPath("/repo/data/../package.json", "/repo/data", "/repo/auth.json"), false);
		assert.equal(isAllowedSyncPath("/etc/passwd", "/repo/data", "/repo/auth.json"), false);
	});

	it("authorizes dev bridge requests only when header, sec-fetch-site, origin, and content-type match", () => {
		// Missing or invalid x-lh-dev-bridge header
		assert.equal(isAuthorizedDevBridgeRequest({ headers: {} } as unknown as IncomingMessage), false);
		assert.equal(isAuthorizedDevBridgeRequest({ headers: { "x-lh-dev-bridge": "0" } } as unknown as IncomingMessage), false);
		assert.equal(isAuthorizedDevBridgeRequest({ headers: { "x-lh-dev-bridge": "true" } } as unknown as IncomingMessage), false);

		// sec-fetch-site check
		assert.equal(
			isAuthorizedDevBridgeRequest({
				headers: { "x-lh-dev-bridge": "1", "sec-fetch-site": "cross-site" },
			} as unknown as IncomingMessage),
			false,
		);
		assert.equal(
			isAuthorizedDevBridgeRequest({
				headers: { "x-lh-dev-bridge": "1", "sec-fetch-site": "same-origin" },
			} as unknown as IncomingMessage),
			true,
		);
		assert.equal(
			isAuthorizedDevBridgeRequest({
				headers: { "x-lh-dev-bridge": "1", "sec-fetch-site": "none" },
			} as unknown as IncomingMessage),
			true,
		);

		// origin and host check
		assert.equal(
			isAuthorizedDevBridgeRequest({
				headers: { "x-lh-dev-bridge": "1", origin: "http://attacker.com", host: "localhost:3000" },
			} as unknown as IncomingMessage),
			false,
		);
		assert.equal(
			isAuthorizedDevBridgeRequest({
				headers: { "x-lh-dev-bridge": "1", origin: "invalid-url", host: "localhost:3000" },
			} as unknown as IncomingMessage),
			false,
		);
		assert.equal(
			isAuthorizedDevBridgeRequest({
				headers: { "x-lh-dev-bridge": "1", origin: "http://localhost:3000", host: "localhost:3000" },
			} as unknown as IncomingMessage),
			true,
		);

		// POST content-type check
		assert.equal(
			isAuthorizedDevBridgeRequest({
				method: "POST",
				headers: { "x-lh-dev-bridge": "1", "content-type": "text/plain" },
			} as unknown as IncomingMessage),
			false,
		);
		assert.equal(
			isAuthorizedDevBridgeRequest({
				method: "POST",
				headers: { "x-lh-dev-bridge": "1" },
			} as unknown as IncomingMessage),
			false,
		);
		assert.equal(
			isAuthorizedDevBridgeRequest({
				method: "POST",
				headers: { "x-lh-dev-bridge": "1", "content-type": "application/json" },
			} as unknown as IncomingMessage),
			true,
		);
		assert.equal(
			isAuthorizedDevBridgeRequest({
				method: "POST",
				headers: { "x-lh-dev-bridge": "1", "content-type": "application/json; charset=utf-8" },
			} as unknown as IncomingMessage),
			true,
		);

		// Valid GET without content-type
		assert.equal(
			isAuthorizedDevBridgeRequest({
				method: "GET",
				headers: { "x-lh-dev-bridge": "1" },
			} as unknown as IncomingMessage),
			true,
		);
	});

	it("rejects symlinks inside dataDir pointing outside dataDir in isAllowedSyncPath", () => {
		const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-test-"));
		try {
			const realBase = fs.realpathSync(tempBase);
			const dataDir = path.join(realBase, "data");
			const outsideDir = path.join(realBase, "outside");
			const authFile = path.join(realBase, "auth.json");

			fs.mkdirSync(dataDir, { recursive: true });
			fs.mkdirSync(outsideDir, { recursive: true });
			fs.writeFileSync(authFile, "{}");

			const secretFile = path.join(outsideDir, "secret.txt");
			fs.writeFileSync(secretFile, "sensitive data");

			const symlinkInside = path.join(dataDir, "escape-link");
			fs.symlinkSync(outsideDir, symlinkInside, "dir");

			const escapedTarget = path.join(symlinkInside, "secret.txt");
			assert.equal(isAllowedSyncPath(escapedTarget, dataDir, authFile), false);

			const normalTarget = path.join(dataDir, "normal.json");
			assert.equal(isAllowedSyncPath(normalTarget, dataDir, authFile), true);
		} finally {
			fs.rmSync(tempBase, { recursive: true, force: true });
		}
	});
});
