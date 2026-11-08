import "../client/shims.ts";
import { headlessOverride } from "../agent/subagents/headless.ts";
import { initAuthEnv } from "../server/keys.ts";
import { installCustomProviderSource } from "../server/custom-provider.ts";
import { waitForInitialBridge } from "./host-bridge.ts";
import { createWorkerHeadless } from "./headless-worker.ts";
import { dispatchWorkerRequest } from "./router.ts";
import { setWorkerHomeDir } from "./shims/node-stubs.ts";

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

export interface WorkerImportFileMessage {
	type: "lh:import-file";
	path: string;
	data: ArrayBuffer | Uint8Array;
}

export type WorkerInboundMessage =
	| WorkerApiRequestMessage
	| WorkerApiAbortMessage
	| WorkerImportFileMessage;

export function createWorkerMessageHandler(
	dispatch: (req: Request) => Promise<Response>,
	ensureReady?: () => Promise<void>,
): (event: MessageEvent) => void {
	const activeRequests = new Map<string, AbortController>();

	return (event: MessageEvent) => {
		const data = event.data as WorkerInboundMessage | undefined;
		if (!data) return;

		if (data.type === "lh:import-file") {
			return;
		}

		if (data.type === "lh:api-abort") {
			const ac = activeRequests.get(data.id);
			if (ac) {
				ac.abort();
			}
			return;
		}

		if (data.type === "lh:api-request") {
			const { id, url, method, headers, body } = data;
			const port = event.ports && event.ports.length > 0 ? event.ports[0] : null;
			const postReply = (msg: unknown, transfer: Transferable[] = []) => {
				if (port) {
					port.postMessage(msg, transfer);
				} else if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function") {
					(self as unknown as Worker).postMessage(msg, transfer);
				}
			};

			const ac = new AbortController();
			activeRequests.set(id, ac);

			const requestHeaders = new Headers(headers);
			const requestBody =
				body && method !== "GET" && method !== "HEAD"
					? body instanceof Uint8Array
						? body
						: new Uint8Array(body)
					: undefined;

			const fullUrl = url.startsWith("/") ? `http://localhost${url}` : url;
			const req = new Request(fullUrl, {
				method,
				headers: requestHeaders,
				body: requestBody as BodyInit | undefined,
				signal: ac.signal,
			});

			(async () => {
				try {
					if (ensureReady) {
						await ensureReady();
					}
					const res = await dispatch(req);
					const hasBody = res.body !== null;
					const resHeaders: [string, string][] = [];
					res.headers.forEach((val, key) => resHeaders.push([key, val]));

					postReply({
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
							if (ac.signal.aborted) {
								try {
									await reader.cancel();
								} catch {}
								break;
							}
							const { done, value } = await reader.read();
							if (done) break;
							postReply({
								type: "lh:api-chunk",
								id,
								chunk: value,
							});
						}
						postReply({
							type: "lh:api-end",
							id,
						});
					}
				} catch (err) {
					postReply({
						type: "lh:api-error",
						id,
						message: err instanceof Error ? err.message : String(err),
					});
				} finally {
					// Retain controller and port briefly so queued messages flush to port1
					// and caller abort signal after completion still finds it
					const t = setTimeout(() => {
						if (port) {
							try {
								port.close();
							} catch {}
						}
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

let bootPromise: Promise<void> | null = null;

export function ensureWorkerBooted(): Promise<void> {
	if (!bootPromise) {
		bootPromise = (async () => {
			const bridge = await waitForInitialBridge();
			const init = await bridge.initRuntime();
			setWorkerHomeDir(init.homeDir);

			await initAuthEnv();
			installCustomProviderSource();

			headlessOverride.current = createWorkerHeadless();

			if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function") {
				self.postMessage({ type: "lh:worker-ready" });
			}
		})();
	}
	return bootPromise;
}

// In dedicated worker scope, self-initialize synchronously
const isWorkerScope = typeof window === "undefined" && typeof self !== "undefined";
if (isWorkerScope) {
	const handler = createWorkerMessageHandler(dispatchWorkerRequest, ensureWorkerBooted);
	self.addEventListener("message", handler);
	ensureWorkerBooted().catch((err) => {
		console.error("[worker/entry] Failed to initialize backend worker:", err);
		try {
			self.postMessage({
				type: "lh:worker-boot-error",
				message: err instanceof Error ? (err.stack || err.message) : String(err),
			});
		} catch {}
	});
}
