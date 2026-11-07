/** General settings UI: version and release notes link. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { UpdateSettings } from "../components/settings/update-settings.tsx";
import { SettingsDialogBody, SettingsDialogProvider, resetSettingsDialogCacheForTests } from "../components/settings/settings-dialog.tsx";
import nextConfig from "../next.config.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
process.env.LH_VERSION = "0.3.7";
process.env.LH_HOMEPAGE = "https://github.com/amosblomqvist/learnharness";
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const props = { version: "0.3.7", homepage: "https://github.com/amosblomqvist/learnharness" };
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

async function mount(element: React.ReactElement) {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(element); });
	return host;
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	delete window.lh;
	globalThis.fetch = originalFetch;
	resetSettingsDialogCacheForTests();
});

describe("version and contextual copy", () => {
	it("build metadata comes from package.json and exposes only public version/homepage values", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.deepEqual(nextConfig.env, { LH_VERSION: pkg.version, LH_HOMEPAGE: pkg.homepage });
	});
});

describe("General settings row", () => {
	it("shows version and installed-version release notes without update controls or toggles", () => {
		const html = renderToStaticMarkup(<UpdateSettings {...props} />);
		assert.ok(html.includes("Version 0.3.7"));
		assert.ok(html.includes(`${props.homepage}/releases/tag/v0.3.7`));
		assert.ok(!html.includes("update-check"));
		assert.ok(!html.includes("update-restart"));
		assert.ok(!html.includes("row-auto-update"));
		assert.ok(!html.includes("update-status"));
	});

	it("mounts version row with release notes link", async () => {
		const host = await mount(<UpdateSettings {...props} />);
		assert.ok(q(host, "row-version"));
		assert.ok(q(host, "release-notes"));
		assert.equal(q(host, "update-check"), null);
		assert.equal(q(host, "row-auto-update"), null);
	});
});

describe("Settings integration", () => {
	it("opening General section in Settings renders version information", async () => {
		const record = { version: 1, general: {} };
		globalThis.fetch = async () => Response.json({ settings: record });
		const host = await mount(<SettingsDialogBody initialSection="general" onClose={() => {}} />);
		assert.ok(q(host, "row-version"));
		assert.ok(q(host, "release-notes"));
		assert.equal(q(host, "update-check"), null);
		assert.equal(q(host, "row-auto-update"), null);
	});

	it("the shell's navigation request opens General", async () => {
		let onOpen: ((section: string) => void) | null = null;
		window.lh = {
			expandWindow() {},
			onOpenSettings: cb => { onOpen = cb; return () => { onOpen = null; }; },
		};
		globalThis.fetch = async () => Response.json({ settings: { version: 1 } });
		const host = await mount(<SettingsDialogProvider><span>app</span></SettingsDialogProvider>);
		assert.equal(q(document, "settings-dialog"), null);
		await act(async () => onOpen?.("general"));
		assert.equal(q(document, "settings-nav-general")!.getAttribute("aria-current"), "true");
		assert.ok(q(document, "row-version"));
		assert.ok(host.textContent!.includes("app"));
	});
});
