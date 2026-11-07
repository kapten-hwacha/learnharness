import "./shims.ts";
import "@fontsource-variable/source-sans-3";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "../../app/globals.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { initWorkerClient } from "./worker-client.ts";
import { installTauriPreload } from "./tauri-preload.ts";
import { getPlatform, isDesktop, isIos } from "./platform.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { prefetchSettings } from "@/components/settings/settings-dialog";
import { prefetchKeys } from "@/components/settings/keys-section";
import { RouteSwitch } from "./route-switch.tsx";

export { RouteSwitch };

if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
	const platform = isIos()
		? "ios"
		: navigator.userAgent.includes("Mac")
			? "darwin"
			: navigator.userAgent.includes("Win")
				? "win32"
				: "linux";
	installTauriPreload({
		invoke,
		listen,
		platform,
	});
}

if (typeof document !== "undefined") {
	const platform = getPlatform();
	if (platform === "ios") {
		document.documentElement.classList.add("lh-ios");
		document.documentElement.dataset.lhPlatform = "ios";
	} else if (isDesktop()) {
		document.documentElement.classList.add("lh-desktop", "lh-electron");
		document.documentElement.dataset.lhPlatform = platform;
	}
}

initWorkerClient();
void prefetchSettings();
void prefetchKeys();

export function App() {
	return (
		<ServerEventsProvider>
			<AppearanceProvider>
				<SidebarProvider>
					<ActivityProvider>
						<AppShell>
							<RouteSwitch />
						</AppShell>
					</ActivityProvider>
				</SidebarProvider>
			</AppearanceProvider>
		</ServerEventsProvider>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) {
	const bootOverlay = document.getElementById("lh-boot-error-overlay");
	if (bootOverlay && bootOverlay.textContent?.includes("Script error.")) {
		bootOverlay.remove();
	}
	createRoot(rootEl).render(<App />);
}
