import { getTauriInvoke, listenTauriEvent } from "./host-bridge.ts";
import type { AdmissionScope } from "../agent/chatgpt-request-cycle.ts";

/** The native owner supplies authorization. No token is returned to this worker. */
export async function nativeChatGPTFetch(scope: AdmissionScope, background: boolean, init?: RequestInit, beforeDispatch: () => void = () => {}): Promise<Response> {
	const invoke = getTauriInvoke();
	if (!invoke) throw new Error("Native ChatGPT transport unavailable");
	if (typeof init?.body !== "string") throw new Error("Invalid ChatGPT request body");
	const payload = JSON.parse(init.body);
	const id = crypto.randomUUID();
	const signal = init.signal;
	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	return new Promise<Response>((resolve, reject) => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let settled = false;
		let finished = false;
		const cleanup = () => { off(); signal?.removeEventListener("abort", abort); };
		const fail = (error: Error) => { if (finished) return; finished = true; cleanup(); if (controller) controller.error(error); else if (!settled) { settled = true; reject(error); } };
		const abort = () => { void invoke("lh_chatgpt_stream_cancel", { id }).catch(() => {}); fail(new DOMException("Aborted", "AbortError")); };
		const off = listenTauriEvent("lh://chatgpt-stream", ({ payload: event }) => {
			if (!event || event.id !== id || finished) return;
			if (event.type === "response") {
				if (!Number.isInteger(event.status) || event.status < 200 || event.status > 599 || [204, 205, 304].includes(event.status)) { fail(new Error("Invalid ChatGPT response status")); return; }
				const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel: abort });
				settled = true;
				resolve(new Response(stream, { status: event.status, headers: { "content-type": "text/event-stream" } }));
			} else if (event.type === "chunk" && controller) {
				const bytes = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
				controller.enqueue(bytes);
			} else if (event.type === "end") { if (!controller) { fail(new Error("ChatGPT stream ended before response")); return; } finished = true; cleanup(); controller.close(); }
			else if (event.type === "error") fail(new Error(event.error || "ChatGPT stream failed"));
		});
		signal?.addEventListener("abort", abort, { once: true });
		void invoke("lh_chatgpt_stream_prepare", { id, scope, background, payload }).then(async () => {
			if (signal?.aborted || finished) { await invoke("lh_chatgpt_stream_cancel", { id }); return; }
			try { beforeDispatch(); } catch (error) { await invoke("lh_chatgpt_stream_cancel", { id }); throw error; }
			await invoke("lh_chatgpt_stream_start", { id });
			if (signal?.aborted) await invoke("lh_chatgpt_stream_cancel", { id });
		}).catch((error) => fail(error instanceof Error ? error : new Error("ChatGPT request failed")));
	});
}
