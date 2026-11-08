import { initWasm, Resvg } from "@resvg/resvg-wasm";
import {
	type DemoRunResult,
	type HeadlessApi,
	pdfCanvasGeometry,
	providerSafePng,
	type RenderedPdfPage,
	type RenderPdfOptions,
	type RenderSvgOptions,
	type RunDemoOptions,
} from "../agent/subagents/headless.ts";

let wasmInitPromise: Promise<void> | null = null;

async function ensureResvgWasm(): Promise<void> {
	if (!wasmInitPromise) {
		wasmInitPromise = (async () => {
			try {
				if (typeof process !== "undefined" && process.versions?.node) {
					const fs = await import("node:fs");
					const path = await import("node:path");
					const wasmPath = path.resolve(process.cwd(), "node_modules/@resvg/resvg-wasm/index_bg.wasm");
					if (fs.existsSync(wasmPath)) {
						const wasmBytes = fs.readFileSync(wasmPath);
						await initWasm(wasmBytes);
						return;
					}
				}
			} catch {
				// Fall back to fetch in browser/worker
			}

			const wasmUrl = new URL("@resvg/resvg-wasm/index_bg.wasm", import.meta.url);
			const res = await fetch(wasmUrl);
			const bytes = await res.arrayBuffer();
			await initWasm(bytes);
		})();
	}
	return wasmInitPromise;
}

function svgViewport(svg: string, opts: RenderSvgOptions): { width: number; height: number } {
	if (opts.width && opts.height) return { width: opts.width, height: opts.height };
	const width = Number(svg.match(/\bwidth\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	const height = Number(svg.match(/\bheight\s*=\s*"?(\d+(?:\.\d+)?)/)?.[1]);
	return {
		width: Math.ceil(Number.isFinite(width) && width > 0 ? width : 900),
		height: Math.ceil(Number.isFinite(height) && height > 0 ? height : 700),
	};
}

async function renderSvg(svg: string, opts: RenderSvgOptions = {}): Promise<Buffer> {
	const { width, height } = svgViewport(svg, opts);
	try {
		await ensureResvgWasm();
		const resvg = new Resvg(svg, {
			fitTo: { mode: "width", value: width },
			background: "#ffffff",
		});
		const rendered = resvg.render();
		const pngBytes = rendered.asPng();
		return providerSafePng(Buffer.from(pngBytes));
	} catch (resvgErr) {
		if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined" && typeof Blob !== "undefined") {
			try {
				const blob = new Blob([svg], { type: "image/svg+xml" });
				const img = await createImageBitmap(blob);
				const canvas = new OffscreenCanvas(width, height);
				const ctx = canvas.getContext("2d");
				if (ctx) {
					ctx.fillStyle = "#ffffff";
					ctx.fillRect(0, 0, width, height);
					ctx.drawImage(img, 0, 0, width, height);
					const blobOut = await canvas.convertToBlob({ type: "image/png" });
					const arr = new Uint8Array(await blobOut.arrayBuffer());
					return providerSafePng(Buffer.from(arr));
				}
			} catch (canvasErr) {
				throw new Error(`Failed to render SVG with Resvg (${String(resvgErr)}) and OffscreenCanvas (${String(canvasErr)})`);
			}
		}
		throw resvgErr;
	}
}

async function renderPdfPages(
	pdfPath: string,
	pages: number[],
	opts: RenderPdfOptions = {},
	createCanvas2D?: (width: number, height: number) => {
		canvas: unknown;
		context: unknown;
		toPng(): Promise<Uint8Array>;
	},
): Promise<RenderedPdfPage[]> {
	const dpi = opts.dpi ?? 150;
	if (!Number.isFinite(dpi) || dpi <= 0 || dpi / 72 === 0) {
		throw new Error("PDF render DPI must be finite and positive");
	}

	let data: Uint8Array;
	try {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const buf = await fs.readFile(path.resolve(pdfPath));
		data = new Uint8Array(buf);
	} catch {
		try {
			const { readExternalFile } = await import("./host-bridge.ts");
			data = await readExternalFile(pdfPath);
		} catch {
			const res = await fetch(pdfPath);
			data = new Uint8Array(await res.arrayBuffer());
		}
	}

	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
	const doc = await loadingTask.promise;

	try {
		const out: RenderedPdfPage[] = [];
		for (const pageNo of pages) {
			if (pageNo < 1 || pageNo > doc.numPages) continue;
			const pg = await doc.getPage(pageNo);
			const base = pg.getViewport({ scale: 1 });
			const geometry = pdfCanvasGeometry(base.width, base.height, dpi);
			const vp = pg.getViewport({ scale: geometry.scale });

			if (createCanvas2D) {
				const c = createCanvas2D(geometry.width, geometry.height);
				await (pg.render({
					canvasContext: c.context as unknown as CanvasRenderingContext2D,
					canvas: c.canvas as unknown as HTMLCanvasElement,
					viewport: vp,
				}) as unknown as { promise: Promise<void> }).promise;
				const raw = await c.toPng();
				out.push({
					page: pageNo,
					png: providerSafePng(Buffer.from(raw)),
				});
			} else if (typeof OffscreenCanvas !== "undefined") {
				const canvas = new OffscreenCanvas(geometry.width, geometry.height);
				const ctx = canvas.getContext("2d");
				await (pg.render({
					canvasContext: ctx as unknown as CanvasRenderingContext2D,
					canvas: canvas as unknown as HTMLCanvasElement,
					viewport: vp,
				}) as unknown as { promise: Promise<void> }).promise;
				const blob = await canvas.convertToBlob({ type: "image/png" });
				const raw = new Uint8Array(await blob.arrayBuffer());
				out.push({
					page: pageNo,
					png: providerSafePng(Buffer.from(raw)),
				});
			} else {
				throw new Error("No canvas implementation available for PDF rendering");
			}
		}
		return out;
	} finally {
		await loadingTask.destroy().catch(() => {});
	}
}

export function buildDemoVerifySrcDoc(html: string, requestId: string, settleMs: number, probe?: string): string {
	const safeSettleMs = typeof settleMs === "number" && Number.isFinite(settleMs) ? Math.max(0, Math.min(30_000, Math.floor(settleMs))) : 3000;
	const probeExpr = probe ? JSON.stringify(probe) : "null";
	const script = `<script>
(function() {
	var requestId = ${JSON.stringify(requestId)};
	var settleMs = ${safeSettleMs};
	var probe = ${probeExpr};
	var consoleErrors = [];
	var pageErrors = [];
	var failedRequests = [];
	var probed = false;
	var probeResult = undefined;

	var origError = console.error;
	console.error = function() {
		var args = Array.prototype.slice.call(arguments);
		consoleErrors.push(args.map(function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' '));
		if (origError) origError.apply(console, arguments);
	};

	window.addEventListener('error', function(e) {
		if (e.target && (e.target !== window)) {
			var target = e.target;
			var src = target.src || target.href || target.tagName;
			failedRequests.push(src + ' (failed)');
		} else {
			pageErrors.push(e.message || String(e.error || e));
		}
	}, true);

	window.addEventListener('unhandledrejection', function(e) {
		pageErrors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason));
	});

	var finished = false;
	function finish() {
		if (finished) return;
		finished = true;
		clearTimeout(maxTimeout);
		if (probe) {
			try {
				probeResult = window.eval(probe);
				probed = true;
			} catch (err) {
				pageErrors.push('probe failed: ' + (err && err.message ? err.message : String(err)));
				probed = true;
			}
		}
		var result = {
			type: 'lh:demo-probe-done',
			requestId: requestId,
			consoleErrors: consoleErrors,
			pageErrors: pageErrors,
			failedRequests: failedRequests,
			ok: consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
			probeResult: probeResult,
			probed: probed
		};
		window.parent.postMessage(result, '*');
	}

	var maxTimeout = setTimeout(finish, 30000);
	if (document.readyState === 'complete') {
		setTimeout(finish, settleMs);
	} else {
		window.addEventListener('load', function() {
			setTimeout(finish, settleMs);
		});
	}
})();
</script>`;

	if (/<head>/i.test(html)) {
		return html.replace(/<head>/i, (m) => m + script);
	}
	if (/<body[^>]*>/i.test(html)) {
		return html.replace(/<body[^>]*>/i, (m) => m + script);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/<html[^>]*>/i, (m) => m + script);
	}
	return script + html;
}

export function createWorkerHeadless(opts?: {
	runDemoViaHost?: (html: string, opts?: RunDemoOptions) => Promise<DemoRunResult>;
	createCanvas2D?: (width: number, height: number) => {
		canvas: unknown;
		context: unknown;
		toPng(): Promise<Uint8Array>;
	};
}): HeadlessApi {
	return {
		available() {
			return true;
		},
		unavailableReason() {
			return null;
		},
		async runDemo(html: string, runOpts?: RunDemoOptions): Promise<DemoRunResult> {
			if (opts?.runDemoViaHost) {
				return opts.runDemoViaHost(html, runOpts);
			}

			const requestId = `demo-${Math.random().toString(36).slice(2)}`;
			const settleMs = runOpts?.settleMs ?? 2000;
			const probe = runOpts?.probe;

			return new Promise<DemoRunResult>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | undefined;

				const handler = (event: MessageEvent) => {
					if (event.data?.type === "lh:demo-probe-done" && event.data?.requestId === requestId) {
						if (timer) clearTimeout(timer);
						if (typeof self !== "undefined" && self.removeEventListener) {
							self.removeEventListener("message", handler);
						}
						resolve({
							consoleErrors: event.data.consoleErrors ?? [],
							pageErrors: event.data.pageErrors ?? [],
							failedRequests: event.data.failedRequests ?? [],
							probeResult: event.data.probeResult,
							ok: event.data.ok ?? true,
						});
					}
				};

				if (typeof self !== "undefined" && self.addEventListener) {
					timer = setTimeout(() => {
						if (typeof self !== "undefined" && self.removeEventListener) {
							self.removeEventListener("message", handler);
						}
						resolve({
							consoleErrors: [],
							pageErrors: ["Demo verification timed out after 30s"],
							failedRequests: [],
							ok: false,
						});
					}, 35000);
					if (typeof timer === "object" && typeof (timer as { unref?: () => void }).unref === "function") {
						(timer as { unref: () => void }).unref();
					}

					self.addEventListener("message", handler);
					self.postMessage({
						type: "lh:run-demo",
						requestId,
						html,
						settleMs,
						probe,
					});
				} else {
					resolve({
						consoleErrors: [],
						pageErrors: [],
						failedRequests: [],
						ok: true,
					});
				}
			});
		},
		renderSvg(svg: string, renderOpts?: RenderSvgOptions): Promise<Buffer> {
			return renderSvg(svg, renderOpts);
		},
		renderPdfPages(pdfPath: string, pages: number[], renderOpts?: RenderPdfOptions): Promise<RenderedPdfPage[]> {
			return renderPdfPages(pdfPath, pages, renderOpts, opts?.createCanvas2D);
		},
	};
}
