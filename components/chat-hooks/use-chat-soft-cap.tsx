import { useCallback, useEffect, useState } from "react";
import type { QuestionAnswerData } from "@/src/core";
import { useServerEvent } from "@/components/server-events";

/**
 * Pure visibility gate for the soft-cap pill:
 * 1. Only visible in teach mode (never practice).
 * 2. Only visible when the session has actual messages.
 * 3. Only visible when teachSoftCapMinutes is configured (> 0).
 * 4. Only visible when softCapReached is true OR chatMs >= teachSoftCapMinutes * 60_000.
 */
export function shouldShowTeachSoftCapPill(
	kind: string,
	hasMessages: boolean,
	teachSoftCapMinutes: number | undefined,
	chatMs: number | undefined,
	softCapReached: boolean | undefined,
): boolean {
	return (
		kind !== "practice" &&
		hasMessages &&
		typeof teachSoftCapMinutes === "number" &&
		teachSoftCapMinutes > 0 &&
		(softCapReached === true || (chatMs ?? 0) >= teachSoftCapMinutes * 60_000)
	);
}

export function TeachSoftCapPill({
	chatMs,
	teachSoftCapMinutes,
	onClick,
}: {
	chatMs?: number;
	teachSoftCapMinutes: number;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid="teach-soft-cap-pill"
			onClick={onClick}
			className="lh-no-drag flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
		>
			{Math.floor((chatMs ?? teachSoftCapMinutes * 60_000) / 60_000)}m · Switch to Practice
		</button>
	);
}

/**
 * Detects if a question answer explicitly selected a "Switch to Practice" option.
 */
export function isSwitchToPracticeAnswer(output: QuestionAnswerData): boolean {
	return (
		output.answers?.some(
			(a) =>
				(typeof a.label === "string" && /switch to practice/i.test(a.label)) ||
				(typeof a.value === "string" && /switch to practice/i.test(a.value)),
		) ?? false
	);
}

export interface UseChatSoftCapOptions {
	chatId: string;
	kind?: string;
	hasMessages: boolean;
	router: { push: (href: string) => void };
}

export function useChatSoftCap({
	chatId,
	kind = "teach",
	hasMessages,
	router,
}: UseChatSoftCapOptions) {
	const [softCapData, setSoftCapData] = useState<{
		chatMs?: number;
		teachSoftCapMinutes?: number;
		softCapReached?: boolean;
	} | null>(null);

	const fetchSoftCap = useCallback(async () => {
		if (kind === "practice" || !hasMessages) return;
		try {
			const res = await fetch(`/api/study?chatId=${encodeURIComponent(chatId)}`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				chatMs?: number;
				teachSoftCapMinutes?: number;
				softCapReached?: boolean;
			};
			setSoftCapData({
				chatMs: data.chatMs,
				teachSoftCapMinutes: data.teachSoftCapMinutes,
				softCapReached: data.softCapReached,
			});
		} catch {
			// silent
		}
	}, [chatId, kind, hasMessages]);

	useEffect(() => {
		void fetchSoftCap();
		const interval = setInterval(() => {
			void fetchSoftCap();
		}, 30_000);
		return () => clearInterval(interval);
	}, [fetchSoftCap]);

	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		void fetchSoftCap();
	});

	const teachSoftCapMinutes = softCapData?.teachSoftCapMinutes;
	const softCapChatMs = softCapData?.chatMs;
	const softCapReached = softCapData?.softCapReached;
	const showSoftCapPill = shouldShowTeachSoftCapPill(
		kind,
		hasMessages,
		teachSoftCapMinutes,
		softCapChatMs,
		softCapReached,
	);

	const onSwitchToPractice = useCallback(async () => {
		try {
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Practice session", kind: "practice" }),
			});
			if (!res.ok) return;
			const { id } = (await res.json()) as { id: string };
			router.push(`/chat/${id}?prompt=${encodeURIComponent("Practice session")}`);
		} catch {
			// silent
		}
	}, [router]);

	return {
		softCapData,
		fetchSoftCap,
		teachSoftCapMinutes,
		softCapChatMs,
		softCapReached,
		showSoftCapPill,
		onSwitchToPractice,
	};
}
