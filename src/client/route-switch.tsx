import React, { useEffect, useState } from "react";
import { Home } from "@/components/home";
import { NewSession } from "@/components/new-session";
import { Chat } from "@/components/chat";
import { resolveSettings, slotsConfigured, type UserSettings } from "@/src/core";
import { usePathname, useRouter, useSearchParams } from "./router.tsx";

export function RouteSwitch() {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const router = useRouter();

	const [settingsRecord, setSettingsRecord] = useState<UserSettings | null>(null);

	const [loadedChat, setLoadedChat] = useState<{
		id: string;
		data: {
			title: string;
			kind?: "teach" | "practice";
			messages?: unknown[];
			turnError?: string | null;
			turnInFlight?: boolean;
			compacting?: boolean;
		};
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
						setLoadedChat({ id: chatId, data });
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
		const isLoadedForCurrentChat = loadedChat !== null && loadedChat.id === chatId;
		if (chatLoading || !isLoadedForCurrentChat) {
			if (chatError && !isLoadedForCurrentChat) {
				return (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-neutral-400">
						<p>{chatError ?? "Session not found"}</p>
					</div>
				);
			}
			return (
				<div className="flex h-full items-center justify-center text-sm text-neutral-400">
					Loading session...
				</div>
			);
		}
		if (chatError) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-neutral-400">
					<p>{chatError ?? "Session not found"}</p>
				</div>
			);
		}
		const prompt = searchParams.get("prompt") ?? undefined;
		const chatData = loadedChat.data;
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
