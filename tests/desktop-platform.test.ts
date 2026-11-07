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

		assert.equal(config.identifier, "com.hwacha.learnharness");
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

	describe("Touch, Viewport & Safe-Area UX (Wave 3 Task 3)", () => {
		it("index.html specifies viewport-fit=cover and user-scalable=no", () => {
			const indexHtmlPath = fileURLToPath(new URL("../index.html", import.meta.url));
			const indexHtml = readFileSync(indexHtmlPath, "utf8");
			assert.ok(
				indexHtml.includes(
					'name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no"',
				),
				"index.html must have cover viewport and disable user-scaling",
			);
		});

		it("app/globals.css specifies safe area custom properties and .lh-ios rules", () => {
			const cssPath = fileURLToPath(new URL("../app/globals.css", import.meta.url));
			const css = readFileSync(cssPath, "utf8");

			assert.ok(css.includes("--lh-sat: env(safe-area-inset-top, 0px);"), "CSS must declare --lh-sat");
			assert.ok(css.includes("--lh-sab: env(safe-area-inset-bottom, 0px);"), "CSS must declare --lh-sab");
			assert.ok(css.includes("--lh-sal: env(safe-area-inset-left, 0px);"), "CSS must declare --lh-sal");
			assert.ok(css.includes("--lh-sar: env(safe-area-inset-right, 0px);"), "CSS must declare --lh-sar");

			assert.ok(css.includes(".lh-ios body"), ".lh-ios body rule must exist");
			assert.ok(css.includes("overscroll-behavior-y: none;"), "overscroll-behavior-y must be none");
			assert.ok(css.includes("-webkit-touch-callout: none;"), "-webkit-touch-callout must be none");
			assert.ok(
				css.includes("-webkit-tap-highlight-color: transparent;"),
				"-webkit-tap-highlight-color must be transparent",
			);

			assert.ok(css.includes(".lh-ios .lh-wco-gutter"), ".lh-ios .lh-wco-gutter must exist");
			assert.ok(css.includes("--lh-wco-right: 0px !important;"), "WCO gutter must be 0px on iOS");

			assert.ok(css.includes(".lh-ios .lh-top-bar"), ".lh-ios .lh-top-bar rule must exist");
			assert.ok(css.includes("padding-top: var(--lh-sat);"), ".lh-top-bar must have padding-top: var(--lh-sat)");

			assert.ok(css.includes(".lh-ios .lh-drag"), ".lh-ios .lh-drag rule must exist");
			assert.ok(css.includes("app-region: no-drag;"), "app-region must be no-drag on iOS");
		});

		it("components/top-bar.tsx includes lh-top-bar class for iOS safe areas", () => {
			const topBarPath = fileURLToPath(new URL("../components/top-bar.tsx", import.meta.url));
			const topBar = readFileSync(topBarPath, "utf8");
			assert.ok(topBar.includes("lh-top-bar"), "TopBar header must include lh-top-bar class");
		});
	});
});
