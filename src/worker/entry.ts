import { headlessOverride } from "../agent/subagents/headless.ts";
import { getHostBridge } from "./host-bridge.ts";
import { createWorkerHeadless } from "./headless-worker.ts";
import { dispatchWorkerRequest } from "./router.ts";
import { hydrateMemfs } from "./shims/fs.ts";

export interface WorkerApiRequestMessage {
	type: "lh:api-request";
	id: string;
	url: string;
	method: string;
	headers: [string, string][];
	body?: ArrayBuffer | Uint8Array;
}

export interface WorkerApiAbortMessage {
	type: "lh:api-abort";
	id: string;
}

export type WorkerInboundMessage = WorkerApiRequestMessage | WorkerApiAbortMessage;

export function createWorkerMessageHandler(dispatch: (req: Request) => Promise<Response>): (event: MessageEvent) => void {
	const activeRequests = new Map<string, AbortController>();

	return (event: MessageEvent) => {
		const data = event.data as WorkerInboundMessage | undefined;
		if (!data) return;

		if (data.type === "lh:api-abort") {
			const ac = activeRequests.get(data.id);
			if (ac) {
				ac.abort();
			}
			return;
		}

		if (data.type === "lh:api-request") {
			const { id, url, method, headers, body } = data;
			const port = event.ports[0];
			if (!port) return;

			const ac = new AbortController();
			activeRequests.set(id, ac);

			const requestHeaders = new Headers(headers);
			const requestBody =
				body && method !== "GET" && method !== "HEAD"
					? body instanceof Uint8Array
						? body
						: new Uint8Array(body)
					: undefined;

			const req = new Request(url, {
				method,
				headers: requestHeaders,
				body: requestBody as BodyInit | undefined,
				signal: ac.signal,
			});

			(async () => {
				try {
					const res = await dispatch(req);
					const hasBody = res.body !== null;
					const resHeaders: [string, string][] = [];
					res.headers.forEach((val, key) => resHeaders.push([key, val]));

					port.postMessage({
						type: "lh:api-response",
						id,
						status: res.status,
						statusText: res.statusText,
						headers: resHeaders,
						hasBody,
					});

					if (hasBody && res.body) {
						const reader = res.body.getReader();
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							port.postMessage(
								{
									type: "lh:api-chunk",
									id,
									chunk: value,
								},
								[value.buffer],
							);
						}
						port.postMessage({
							type: "lh:api-end",
							id,
						});
					}
				} catch (err) {
					port.postMessage({
						type: "lh:api-error",
						id,
						message: err instanceof Error ? err.message : String(err),
					});
				} finally {
					// Retain controller briefly so caller abort signal after completion still finds it
					const t = setTimeout(() => {
						activeRequests.delete(id);
					}, 5000);
					if (typeof t === "object" && typeof (t as { unref?: () => void }).unref === "function") {
						(t as { unref: () => void }).unref();
					}
				}
			})();
		}
	};
}

// In dedicated worker scope, self-initialize
if (typeof self !== "undefined" && typeof (self as unknown as { importScripts?: unknown }).importScripts !== "undefined") {
	(async () => {
		try {
			const bridge = getHostBridge();
			const snapshot = await bridge.hydrateFs();
			hydrateMemfs(snapshot);

			headlessOverride.current = createWorkerHeadless();

			const handler = createWorkerMessageHandler(dispatchWorkerRequest);
			self.addEventListener("message", handler);

			self.postMessage({ type: "lh:worker-ready" });
		} catch (err) {
			console.error("[worker/entry] Failed to initialize backend worker:", err);
		}
	})();
}
