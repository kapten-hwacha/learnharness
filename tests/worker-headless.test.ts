import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { buildDemoVerifySrcDoc, createWorkerHeadless } from "../src/worker/headless-worker.ts";
import { loadPhotonWasm } from "../src/worker/shims/photon-wasm.ts";

const PDF_FIXTURE = path.resolve("tests/fixtures/sample-3page.pdf");

describe("src/worker/headless-worker.ts & photon-wasm.ts", () => {
	it("rasterizes SVG via @resvg/resvg-wasm into a canonical single-IDAT PNG", async () => {
		const headless = createWorkerHeadless();
		const png = await headless.renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2563eb"/></svg>');
		assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
		assert.equal(png.readUInt32BE(16), 120);
		assert.equal(png.readUInt32BE(20), 60);
	});

	it("renders PDF pages through the pluggable 2D canvas factory and canonicalizes PNG output", async () => {
		const headless = createWorkerHeadless({
			createCanvas2D(width, height) {
				const c = createCanvas(width, height);
				return {
					canvas: c,
					context: c.getContext("2d"),
					async toPng() {
						return new Uint8Array(c.toBuffer("image/png"));
					},
				};
			},
		});
		const pages = await headless.renderPdfPages(PDF_FIXTURE, [1], { dpi: 72 });
		assert.equal(pages.length, 1);
		assert.equal(pages[0]!.page, 1);
		assert.equal(pages[0]!.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	});

	it("injects the demo verification script into srcdoc and loads Photon WASM via WebAssembly.instantiate", async () => {
		const srcDoc = buildDemoVerifySrcDoc("<!doctype html><html><body><h1>Demo</h1></body></html>", "req-1", 500, "1 + 1");
		assert.match(srcDoc, /lh:demo-probe-done/);
		assert.match(srcDoc, /req-1/);

		const photon = await loadPhotonWasm();
		assert.equal(typeof photon.PhotonImage.new_from_byteslice, "function");
	});
});
