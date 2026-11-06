import { buildDemoVerifySrcDoc } from "../worker/headless-worker.ts";

export type WorkerMessageSubscriber = (handler: (event: MessageEvent) => void) => () => void;

export function createPortFetch(
	postToWorker: (msg: unknown, transfer: Transferable[]) => void,
	subscribeWorkerMessages?: WorkerMessageSubscriber,
): typeof fetch {
	const directInflight = new Map<
		string,
		{
			onResponse: (data: { status: number; statusText: string; headers: [string, string][]; hasBody: boolean }) => void;
			onChunk: (chunk: Uint8Array) => void;
			onEnd: () => void;
			onError: (err: Error) => void;
		}
	>();

	if (subscribeWorkerMessages) {
		subscribeWorkerMessages((event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== "object" || !("id" in data) || typeof data.id !== "string") return;
			const entry = directInflight.get(data.id);
			if (!entry) return;

			if (data.type === "lh:api-response") {
				entry.onResponse(data);
			} else if (data.type === "lh:api-chunk") {
				const uint8 = data.chunk instanceof Uint8Array ? data.chunk : new Uint8Array(data.chunk);
				entry.onChunk(uint8);
			} else if (data.type === "lh:api-end") {
				directInflight.delete(data.id);
				entry.onEnd();
			} else if (data.type === "lh:api-error") {
				directInflight.delete(data.id);
				entry.onError(new Error(data.message));
			}
		});
	}

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (init?.method ?? (typeof input === "object" && "method" in input && input.method ? input.method : "GET")).toUpperCase();

		const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
		const id = Math.random().toString(36).slice(2) + Date.now().toString(36);

		let bodyBuffer: ArrayBuffer | undefined;
		if (init?.body && method !== "GET" && method !== "HEAD") {
			if (typeof init.body === "string") {
				bodyBuffer = new TextEncoder().encode(init.body).buffer;
			} else if (init.body instanceof ArrayBuffer) {
				bodyBuffer = init.body;
			} else if (ArrayBuffer.isView(init.body)) {
				bodyBuffer = init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength);
			}
		}

		if (subscribeWorkerMessages) {
			const transfer: Transferable[] = [];
			if (bodyBuffer) {
				transfer.push(bodyBuffer);
			}

			const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
			if (signal) {
				if (signal.aborted) {
					postToWorker({ type: "lh:api-abort", id }, []);
				} else {
					signal.addEventListener("abort", () => {
						directInflight.delete(id);
						postToWorker({ type: "lh:api-abort", id }, []);
					});
				}
			}

			return new Promise<Response>((resolve, reject) => {
				let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

				directInflight.set(id, {
					onResponse: (data) => {
						const responseHeaders = new Headers(data.headers);
						if (!data.hasBody) {
							directInflight.delete(id);
							resolve(
								new Response(null, {
									status: data.status,
									statusText: data.statusText,
									headers: responseHeaders,
								}),
							);
							return;
						}

						const stream = new ReadableStream<Uint8Array>({
							start(controller) {
								streamController = controller;
							},
							cancel() {
								directInflight.delete(id);
								postToWorker({ type: "lh:api-abort", id }, []);
							},
						});

						resolve(
							new Response(stream, {
								status: data.status,
								statusText: data.statusText,
								headers: responseHeaders,
							}),
						);
					},
					onChunk: (chunk) => {
						try {
							streamController?.enqueue(chunk);
						} catch {}
					},
					onEnd: () => {
						try {
							streamController?.close();
						} catch {}
					},
					onError: (err) => {
						if (streamController) {
							try {
								streamController.error(err);
							} catch {}
						} else {
							reject(err);
						}
					},
				});

				postToWorker(
					{
						type: "lh:api-request",
						id,
						url,
						method,
						headers: Array.from(headers.entries()),
						body: bodyBuffer,
					},
					transfer,
				);
			});
		}

		const channel = new MessageChannel();
		const port1 = channel.port1;
		const port2 = channel.port2;

		const transfer: Transferable[] = [port2];
		if (bodyBuffer) {
			transfer.push(bodyBuffer);
		}

		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		if (signal) {
			if (signal.aborted) {
				postToWorker({ type: "lh:api-abort", id }, []);
			} else {
				signal.addEventListener("abort", () => {
					postToWorker({ type: "lh:api-abort", id }, []);
				});
			}
		}

		return new Promise<Response>((resolve, reject) => {
			port1.onmessage = (event: MessageEvent) => {
				const data = event.data;
				if (data.type === "lh:api-response") {
					const responseHeaders = new Headers(data.headers);
					if (!data.hasBody) {
						port1.close();
						resolve(
							new Response(null, {
								status: data.status,
								statusText: data.statusText,
								headers: responseHeaders,
							}),
						);
						return;
					}

					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							port1.onmessage = (e: MessageEvent) => {
								const chunkData = e.data;
								if (chunkData.type === "lh:api-chunk") {
									try {
										controller.enqueue(
											chunkData.chunk instanceof Uint8Array
												? chunkData.chunk
												: new Uint8Array(chunkData.chunk),
										);
									} catch {}
								} else if (chunkData.type === "lh:api-end") {
									try {
										controller.close();
									} catch {}
									port1.close();
								} else if (chunkData.type === "lh:api-error") {
									try {
										controller.error(new Error(chunkData.message));
									} catch {}
									port1.close();
								}
							};
						},
						cancel() {
							postToWorker({ type: "lh:api-abort", id }, []);
							port1.close();
						},
					});

					resolve(
						new Response(stream, {
							status: data.status,
							statusText: data.statusText,
							headers: responseHeaders,
						}),
					);
				} else if (data.type === "lh:api-error") {
					port1.close();
					reject(new Error(data.message));
				}
			};

			postToWorker(
				{
					type: "lh:api-request",
					id,
					url,
					method,
					headers: Array.from(headers.entries()),
					body: bodyBuffer,
				},
				transfer,
			);
		});
	}) as typeof fetch;
}

export function isApiUrl(url: string | URL): boolean {
	const str = typeof url === "string" ? url : url.toString();
	if (str.startsWith("/api/")) return true;
	try {
		const parsed = new URL(str, typeof window !== "undefined" ? window.location.origin : "http://localhost");
		if (typeof window !== "undefined" && parsed.origin === window.location.origin) {
			return parsed.pathname.startsWith("/api/");
		}
		return parsed.pathname.startsWith("/api/");
	} catch {
		return false;
	}
}

let activeWorker: Worker | null = null;
let workerFetch: typeof fetch | null = null;

export function getWorker(): Worker | null {
	return activeWorker;
}

export function initWorkerClient(): { worker: Worker; portFetch: typeof fetch } {
	if (activeWorker && workerFetch) {
		return { worker: activeWorker, portFetch: workerFetch };
	}

	const isTauri = typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__?.invoke);
	const worker = new Worker(new URL("../worker/entry.ts", import.meta.url), { type: "module" });
	activeWorker = worker;
	if (typeof window !== "undefined") {
		(window as any).__LH_WORKER__ = worker;
	}

	worker.onerror = (err) => {
		err.preventDefault?.();
		const msg = err.message || "Unknown worker error";
		console.error("[LH Worker onerror]", msg, err.filename, err.lineno);
		const el = document.getElementById("lh-boot-error-overlay") || document.createElement("div");
		el.id = "lh-boot-error-overlay";
		el.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:#1e1e1e;color:#ff5555;z-index:999999;padding:24px;font-family:monospace;white-space:pre-wrap;overflow:auto;font-size:14px;line-height:1.4;";
		el.textContent = "LearnHarness Worker Error:\n\n" + msg + (err.filename ? "\n\nAt: " + err.filename + ":" + err.lineno : "");
		(document.body || document.documentElement).appendChild(el);
	};

	worker.addEventListener("message", (event: MessageEvent) => {
		if (event.data?.type === "lh:worker-boot-error") {
			console.error("[LH Worker Boot Error]", event.data.message);
			const el = document.getElementById("lh-boot-error-overlay") || document.createElement("div");
			el.id = "lh-boot-error-overlay";
			el.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:#1e1e1e;color:#ff5555;z-index:999999;padding:24px;font-family:monospace;white-space:pre-wrap;overflow:auto;font-size:14px;line-height:1.4;";
			el.textContent = "LearnHarness Backend Worker Failed To Boot:\n\n" + event.data.message;
			(document.body || document.documentElement).appendChild(el);
		}
	});

	if (isTauri) {
		const tauri = (window as any).__TAURI_INTERNALS__;
		worker.postMessage({ type: "lh:tauri-init" });

		worker.addEventListener("message", async (event: MessageEvent) => {
			if (event.data?.type === "lh:tauri-invoke") {
				const { id, cmd, args } = event.data;
				try {
					const result = await tauri.invoke(cmd, args);
					worker.postMessage({ type: "lh:tauri-invoke-result", id, result });
				} catch (err) {
					worker.postMessage({
						type: "lh:tauri-invoke-result",
						id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		});

		if (typeof tauri.listen === "function") {
			void Promise.resolve(
				tauri.listen("lh://oauth-request", (event: any) => {
					worker.postMessage({
						type: "lh:tauri-event",
						event: "lh://oauth-request",
						payload: event?.payload,
					});
				})
			);
		}
	}

	const portFetch = createPortFetch(
		(msg, transfer) => {
			worker.postMessage(msg, transfer);
		},
		(handler) => {
			worker.addEventListener("message", handler);
			return () => worker.removeEventListener("message", handler);
		},
	);
	workerFetch = portFetch;

	if (typeof window !== "undefined") {
		const originalFetch = window.fetch.bind(window);
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (isApiUrl(url)) {
				return portFetch(input, init);
			}
			return originalFetch(input, init);
		};

		// Main-thread sandboxed iframe runner for lh:run-demo
		window.addEventListener("message", (event: MessageEvent) => {
			if (event.data?.type === "lh:run-demo") {
				const { requestId, html, settleMs, probe } = event.data;
				const iframe = document.createElement("iframe");
				iframe.setAttribute("sandbox", "allow-scripts");
				iframe.style.position = "fixed";
				iframe.style.left = "-9999px";
				iframe.style.top = "-9999px";
				iframe.style.width = "900px";
				iframe.style.height = "700px";
				iframe.style.visibility = "hidden";

				const onDone = (doneEvent: MessageEvent) => {
					if (doneEvent.data?.type === "lh:demo-probe-done" && doneEvent.data?.requestId === requestId) {
						window.removeEventListener("message", onDone);
						worker.postMessage(doneEvent.data);
						iframe.remove();
					}
				};

				window.addEventListener("message", onDone);
				iframe.srcdoc = buildDemoVerifySrcDoc(html, requestId, settleMs, probe);
				document.body.appendChild(iframe);
			}
		});

		window.EventSource = WorkerEventSource as unknown as typeof EventSource;
	}

	return { worker, portFetch };
}

export interface ParsedSseBlock {
	event: string;
	data: string;
}

export function parseSseBlock(block: string): ParsedSseBlock | null {
	if (!block.trim()) return null;
	let eventType = "message";
	const dataLines: string[] = [];

	for (const rawLine of block.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("event: ")) {
			eventType = line.slice(7).trim();
		} else if (line.startsWith("event:")) {
			eventType = line.slice(6).trim();
		} else if (line.startsWith("data: ")) {
			dataLines.push(line.slice(6));
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice(5));
		}
	}

	if (dataLines.length === 0) return null;
	return {
		event: eventType || "message",
		data: dataLines.join("\n"),
	};
}

export class WorkerEventSource extends EventTarget {
	url: string;
	readyState: number = 0; // CONNECTING
	CONNECTING = 0;
	OPEN = 1;
	CLOSED = 2;
	onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
	onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
	onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
	private abortController = new AbortController();
	private fetchImpl: typeof fetch;

	constructor(url: string | URL, fetchImpl?: typeof fetch) {
		super();
		this.url = typeof url === "string" ? url : url.toString();
		this.fetchImpl = fetchImpl ?? workerFetch ?? (typeof window !== "undefined" ? window.fetch.bind(window) : fetch);

		if (!fetchImpl && !isApiUrl(this.url) && typeof window !== "undefined" && window.EventSource && window.EventSource !== (WorkerEventSource as unknown)) {
			return new (window.EventSource as unknown as new (url: string | URL) => WorkerEventSource)(url);
		}

		this.connect();
	}

	private async connect() {
		try {
			const res = await this.fetchImpl(this.url, {
				signal: this.abortController.signal,
				headers: { Accept: "text/event-stream" },
			});

			if (!res.ok || !res.body) {
				throw new Error(`SSE failed with status ${res.status}`);
			}

			this.readyState = 1; // OPEN
			const openEv = new Event("open");
			this.onopen?.call(this as unknown as EventSource, openEv);
			this.dispatchEvent(openEv);

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n\n");
				buffer = lines.pop() ?? "";

				for (const block of lines) {
					const parsed = parseSseBlock(block);
					if (!parsed) continue;
					const msgEv = new MessageEvent(parsed.event, { data: parsed.data });
					if (parsed.event === "message") {
						this.onmessage?.call(this as unknown as EventSource, msgEv);
					}
					this.dispatchEvent(msgEv);
				}
			}

			this.close();
		} catch (err) {
			this.readyState = 2; // CLOSED
			const errEv = new Event("error");
			this.onerror?.call(this as unknown as EventSource, errEv);
			this.dispatchEvent(errEv);
		}
	}

	close() {
		this.readyState = 2; // CLOSED
		this.abortController.abort();
	}
}
