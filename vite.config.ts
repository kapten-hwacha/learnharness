import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { lhViteDevBridgePlugin } from "./src/worker/vite-dev-bridge.ts";

export default defineConfig({
	define: {
		"process.env": {},
	},
	plugins: [
		react(),
		lhViteDevBridgePlugin(),
		{
			name: "profiler-review-compat",
			transform(code, id) {
				if (id.includes("src/server/profiler.ts")) {
					return code.replace(/\.readReviewLedger\b/g, '["readReviewLedger"]');
				}
			},
		},
	],
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve(__dirname, "./") },
			{ find: "next/navigation", replacement: path.resolve(__dirname, "src/client/router.tsx") },
			{ find: "next/link", replacement: path.resolve(__dirname, "src/client/router.tsx") },
			{ find: /^node:path$/, replacement: path.resolve(__dirname, "src/worker/shims/path.ts") },
			{ find: /^path$/, replacement: path.resolve(__dirname, "src/worker/shims/path.ts") },
			{ find: /^node:fs\/promises$/, replacement: path.resolve(__dirname, "src/worker/shims/fs-promises.ts") },
			{ find: /^fs\/promises$/, replacement: path.resolve(__dirname, "src/worker/shims/fs-promises.ts") },
			{ find: /^node:fs$/, replacement: path.resolve(__dirname, "src/worker/shims/fs.ts") },
			{ find: /^fs$/, replacement: path.resolve(__dirname, "src/worker/shims/fs.ts") },
			{ find: /^node:crypto$/, replacement: path.resolve(__dirname, "src/worker/shims/crypto.ts") },
			{ find: /^crypto$/, replacement: path.resolve(__dirname, "src/worker/shims/crypto.ts") },
			{ find: /^node:async_hooks$/, replacement: path.resolve(__dirname, "src/worker/shims/async_hooks.ts") },
			{ find: /^async_hooks$/, replacement: path.resolve(__dirname, "src/worker/shims/async_hooks.ts") },
			{ find: /^node:os$/, replacement: path.resolve(__dirname, "src/worker/shims/os.ts") },
			{ find: /^os$/, replacement: path.resolve(__dirname, "src/worker/shims/os.ts") },
			{ find: /^node:url$/, replacement: path.resolve(__dirname, "src/worker/shims/url.ts") },
			{ find: /^url$/, replacement: path.resolve(__dirname, "src/worker/shims/url.ts") },
			{ find: /^node:util$/, replacement: path.resolve(__dirname, "src/worker/shims/util.ts") },
			{ find: /^util$/, replacement: path.resolve(__dirname, "src/worker/shims/util.ts") },
			{ find: /^node:module$/, replacement: path.resolve(__dirname, "src/worker/shims/module.ts") },
			{ find: /^module$/, replacement: path.resolve(__dirname, "src/worker/shims/module.ts") },
			{ find: /^node:worker_threads$/, replacement: path.resolve(__dirname, "src/worker/shims/worker_threads.ts") },
			{ find: /^worker_threads$/, replacement: path.resolve(__dirname, "src/worker/shims/worker_threads.ts") },
			{ find: /^node:child_process$/, replacement: path.resolve(__dirname, "src/worker/shims/child_process.ts") },
			{ find: /^child_process$/, replacement: path.resolve(__dirname, "src/worker/shims/child_process.ts") },
			{ find: /^node:http$/, replacement: path.resolve(__dirname, "src/worker/shims/http.ts") },
			{ find: /^http$/, replacement: path.resolve(__dirname, "src/worker/shims/http.ts") },
			{ find: /^node:https$/, replacement: path.resolve(__dirname, "src/worker/shims/https.ts") },
			{ find: /^https$/, replacement: path.resolve(__dirname, "src/worker/shims/https.ts") },
			{ find: /^node:http2$/, replacement: path.resolve(__dirname, "src/worker/shims/http2.ts") },
			{ find: /^http2$/, replacement: path.resolve(__dirname, "src/worker/shims/http2.ts") },
			{ find: /^node:tls$/, replacement: path.resolve(__dirname, "src/worker/shims/tls.ts") },
			{ find: /^tls$/, replacement: path.resolve(__dirname, "src/worker/shims/tls.ts") },
			{ find: /^node:events$/, replacement: path.resolve(__dirname, "src/worker/shims/events.ts") },
			{ find: /^events$/, replacement: path.resolve(__dirname, "src/worker/shims/events.ts") },
			{ find: /^node:stream$/, replacement: path.resolve(__dirname, "src/worker/shims/stream.ts") },
			{ find: /^stream$/, replacement: path.resolve(__dirname, "src/worker/shims/stream.ts") },
			{ find: /^node:net$/, replacement: path.resolve(__dirname, "src/worker/shims/net.ts") },
			{ find: /^net$/, replacement: path.resolve(__dirname, "src/worker/shims/net.ts") },
			{ find: /^node:readline$/, replacement: path.resolve(__dirname, "src/worker/shims/readline.ts") },
			{ find: /^readline$/, replacement: path.resolve(__dirname, "src/worker/shims/readline.ts") },
			{ find: "@silvia-odwyer/photon-node", replacement: path.resolve(__dirname, "src/worker/shims/photon-wasm.ts") },
			{ find: "@resvg/resvg-js", replacement: path.resolve(__dirname, "src/worker/shims/node-stubs.ts") },
			{ find: "@napi-rs/canvas", replacement: path.resolve(__dirname, "src/worker/shims/node-stubs.ts") },
			{ find: "puppeteer-core", replacement: path.resolve(__dirname, "src/worker/shims/node-stubs.ts") },
		],
	},
	worker: {
		format: "es",
	},
	build: {
		outDir: "dist-web",
		emptyOutDir: true,
	},
});
