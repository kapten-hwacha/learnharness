import "@fontsource-variable/source-sans-3";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "../../app/globals.css";

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { Home } from "@/components/home";
import { NewSession } from "@/components/new-session";
import { Chat } from "@/components/chat";
import { resolveSettings, slotsConfigured, type UserSettings } from "@/src/core";
import { usePathname, useRouter, useSearchParams } from "./router.tsx";
import { initWorkerClient } from "./worker-client.ts";
import { installTauriPreload } from "./tauri-preload.ts";
import { getPlatform, isDesktop, isIos } from "./platform.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

function RouteSwitch() {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const router = useRouter();

	const [settingsRecord, setSettingsRecord] = useState<UserSettings | null>(null);

	const [chatData, setChatData] = useState<{
		title: string;
		kind?: "teach" | "practice";
		messages?: unknown[];
		turnError?: string | null;
		turnInFlight?: boolean;
		compacting?: boolean;
	} | null>(null);
	const [chatLoading, setChatLoading] = useState(false);
	const [chatError, setChatError] = useState<string | null>(null);

	// Load settings
	useEffect(() => {
		let cancelled = false;
		fetch("/api/settings")
			.then((res) => (res.ok ? res.json() : null))
			.then((data: { settings?: UserSettings | null } | null) => {
				if (!cancelled && data) {
					setSettingsRecord(data.settings ?? null);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [pathname]);

	// Route redirect for /settings
	useEffect(() => {
		if (pathname === "/settings") {
			router.replace("/chat/new");
		}
	}, [pathname, router]);

	// /chat/:id
	const chatMatch = /^\/chat\/([^/]+)$/.exec(pathname);
	const chatId = chatMatch ? decodeURIComponent(chatMatch[1]!) : null;

	useEffect(() => {
		if (chatId && chatId !== "new") {
			let cancelled = false;
			setChatLoading(true);
			setChatError(null);
			fetch(`/api/chats/${encodeURIComponent(chatId)}`)
				.then(async (res) => {
					if (!res.ok) {
						if (res.status === 404) {
							throw new Error("Not found");
						}
						throw new Error(`Failed to load chat: ${res.status}`);
					}
					return res.json();
				})
				.then((data) => {
					if (!cancelled) {
						setChatData(data);
						setChatLoading(false);
					}
				})
				.catch((err: Error) => {
					if (!cancelled) {
						setChatError(err.message);
						setChatLoading(false);
					}
				});
			return () => {
				cancelled = true;
			};
		}
	}, [chatId]);

	if (pathname === "/settings") {
		return null;
	}

	const isConfigured = slotsConfigured(settingsRecord?.models);

	if (pathname === "/" || pathname === "") {
		const rendering = resolveSettings(settingsRecord).graph.rendering;
		return <Home initialConfigured={isConfigured} rendering={rendering} />;
	}

	if (pathname === "/chat/new") {
		const mode = searchParams.get("mode") === "practice" ? "practice" : "teach";
		return <NewSession initialConfigured={isConfigured} mode={mode} />;
	}

	if (chatId && chatId !== "new") {
		if (chatLoading && !chatData) {
			return (
				<div className="flex h-full items-center justify-center text-sm text-neutral-400">
					Loading session...
				</div>
			);
		}
		if (chatError || !chatData) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-neutral-400">
					<p>{chatError ?? "Session not found"}</p>
				</div>
			);
		}
		const prompt = searchParams.get("prompt") ?? undefined;
		return (
			<Chat
				key={chatId}
				chatId={chatId}
				title={chatData.title}
				kind={chatData.kind ?? "teach"}
				initialMessages={chatData.messages as never}
				initialError={chatData.turnError ?? undefined}
				initialConfigured={isConfigured}
				initialPrompt={prompt}
				initiallyInFlight={chatData.turnInFlight ?? false}
				initiallyCompacting={chatData.compacting ?? false}
			/>
		);
	}

	return (
		<div className="flex h-full items-center justify-center text-sm text-neutral-400">
			Page not found
		</div>
	);
}

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
			<UpdateBanner />
		</ServerEventsProvider>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) {
	createRoot(rootEl).render(<App />);
}
