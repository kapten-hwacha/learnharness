import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { installTauriPreload, stepZoom, ZOOM_LADDER } from "../src/client/tauri-preload.ts";
import { getPlatform, isDesktop, isIos, isTauri } from "../src/client/platform.ts";

const EXPECTED_LH_KEYS = [
	"checkForUpdates",
	"chatgpt",
	"expandWindow",
	"getPathForFile",
	"getUpdateState",
	"getZoom",
	"importFile",
	"installUpdate",
	"isIos",
	"isMobile",
	"onOpenSettings",
	"onUpdateStatus",
	"onZoom",
	"openSubscriptionBrowser",
	"platform",
	"subscriptions",
	"subscriptionTransport",
].sort();

describe("Tauri desktop platform preload", () => {
	it("window.lh has exactly the expected keys", () => {
		const target = {} as any;
		installTauriPreload({
			invoke: async <T>() => undefined as unknown as T,
			listen: async () => () => {},
			platform: "darwin",
			target,
		});

		assert.ok(target.lh, "target.lh should be defined");
		const actualKeys = Object.keys(target.lh).sort();
		assert.deepEqual(actualKeys, EXPECTED_LH_KEYS);
	});

	it("no raw invoke, fs, or webUtils exposed", () => {
		const target = {} as any;
		installTauriPreload({
			invoke: async <T>() => undefined as unknown as T,
			listen: async () => () => {},
			platform: "darwin",
			target,
		});

		const lh = target.lh;
		for (const key of ["invoke", "fs", "webUtils", "ipcRenderer", "readFile", "writeFile"]) {
			assert.equal(Object.hasOwn(lh, key), false, `Key ${key} should not be exposed on lh`);
		}
	});

	it("platform reflects the injected platform including ios", () => {
		for (const p of ["darwin", "win32", "linux", "ios"] as const) {
			const target = {} as any;
			installTauriPreload({
				invoke: async <T>() => undefined as unknown as T,
				listen: async () => () => {},
				platform: p,
				target,
			});
			assert.equal(target.lh.platform, p);
			if (p === "ios") {
				assert.equal(target.lh.isIos, true);
				assert.equal(target.lh.isMobile, true);
			} else {
				assert.equal(target.lh.isIos, false);
				assert.equal(target.lh.isMobile, false);
			}
		}
	});

	it("expandWindow invokes lh_expand_window", async () => {
		const invoked: string[] = [];
		const target = {} as any;
		installTauriPreload({
			invoke: async <T>(cmd: string) => {
				invoked.push(cmd);
				return undefined as unknown as T;
			},
			listen: async () => () => {},
			platform: "darwin",
			target,
		});

		await target.lh.expandWindow();
		assert.deepEqual(invoked, ["lh_expand_window"]);
	});

	it("zoom ladder steps through ZOOM_LADDER and clamps", () => {
		assert.deepEqual(ZOOM_LADDER, [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
		assert.equal(stepZoom(1, "in"), 1.1);
		assert.equal(stepZoom(2, "in"), 2);
		assert.equal(stepZoom(0.75, "out"), 0.75);
		assert.equal(stepZoom(1.5, "reset"), 1);
	});

	it("tauri.conf.json window and identifier", () => {
		const configPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
		const config = JSON.parse(readFileSync(configPath, "utf8"));

		assert.equal(config.identifier, "com.amosblomqvist.learnharness");
		assert.equal(config.build.frontendDist, "../dist-web");

		const win = config.app.windows[0];
		assert.equal(win.width, 1440);
		assert.equal(win.height, 900);
		assert.equal(win.minWidth, 640);
		assert.equal(win.minHeight, 600);
		assert.equal(win.titleBarStyle, "Overlay");
		assert.equal(win.hiddenTitle, true);
		assert.deepEqual(win.trafficLightPosition, { x: 16, y: 22.5 });
	});

	it("tauri.ios.conf.json window and iOS bundle configuration", () => {
		const iosConfigPath = fileURLToPath(new URL("../src-tauri/tauri.ios.conf.json", import.meta.url));
		const config = JSON.parse(readFileSync(iosConfigPath, "utf8"));

		assert.equal(config.bundle.iOS.developmentTeam, "");
		const win = config.app.windows[0];
		assert.equal(win.title, "LearnHarness");
		assert.equal(win.fullscreen, true);
		assert.equal(win.resizable, false);
	});

	describe("Platform Abstraction helpers", () => {
		const origNav = globalThis.navigator;
		const origWindow = (globalThis as any).window;

		it("detects standard iOS user agents", () => {
			const mockNav = {
				userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
				platform: "iPhone",
				maxTouchPoints: 5,
			};
			Object.defineProperty(globalThis, "navigator", { value: mockNav, configurable: true });
			assert.equal(isIos(), true);
			assert.equal(getPlatform(), "ios");
			Object.defineProperty(globalThis, "navigator", { value: origNav, configurable: true });
		});

		it("detects iPadOS desktop-class Safari user agent (MacIntel + touch points > 1)", () => {
			const mockNav = {
				userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
				platform: "MacIntel",
				maxTouchPoints: 5,
			};
			Object.defineProperty(globalThis, "navigator", { value: mockNav, configurable: true });
			assert.equal(isIos(), true);
			assert.equal(getPlatform(), "ios");
			Object.defineProperty(globalThis, "navigator", { value: origNav, configurable: true });
		});

		it("treats macOS desktop Safari (MacIntel + touch points 0) as desktop darwin", () => {
			const mockNav = {
				userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
				platform: "MacIntel",
				maxTouchPoints: 0,
			};
			const mockWin = {
				__TAURI_INTERNALS__: {},
			};
			Object.defineProperty(globalThis, "navigator", { value: mockNav, configurable: true });
			Object.defineProperty(globalThis, "window", { value: mockWin, configurable: true });

			assert.equal(isIos(), false);
			assert.equal(isTauri(), true);
			assert.equal(isDesktop(), true);
			assert.equal(getPlatform(), "darwin");

			Object.defineProperty(globalThis, "navigator", { value: origNav, configurable: true });
			Object.defineProperty(globalThis, "window", { value: origWindow, configurable: true });
		});

		it("distinguishes plain web from desktop Tauri", () => {
			const mockNav = {
				userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
				platform: "MacIntel",
				maxTouchPoints: 0,
			};
			Object.defineProperty(globalThis, "navigator", { value: mockNav, configurable: true });
			// window without __TAURI_INTERNALS__ or lh
			Object.defineProperty(globalThis, "window", { value: {}, configurable: true });

			assert.equal(isTauri(), false);
			assert.equal(isDesktop(), false);
			assert.equal(getPlatform(), "web");

			Object.defineProperty(globalThis, "navigator", { value: origNav, configurable: true });
			Object.defineProperty(globalThis, "window", { value: origWindow, configurable: true });
		});
	});
});
