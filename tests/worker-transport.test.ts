import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPortFetch } from "../src/client/worker-client.ts";
import { createWorkerMessageHandler } from "../src/worker/entry.ts";
import { isAllowedSyncPath } from "../src/worker/vite-dev-bridge.ts";

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

	it("rejects syncFs paths outside dataDir and authFile, including '..' traversal", () => {
		assert.equal(isAllowedSyncPath("/repo/data/chats/c1.json", "/repo/data", "/repo/auth.json"), true);
		assert.equal(isAllowedSyncPath("/repo/auth.json", "/repo/data", "/repo/auth.json"), true);
		assert.equal(isAllowedSyncPath("/repo/data/../package.json", "/repo/data", "/repo/auth.json"), false);
		assert.equal(isAllowedSyncPath("/etc/passwd", "/repo/data", "/repo/auth.json"), false);
	});
});
