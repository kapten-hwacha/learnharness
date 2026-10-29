"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DumbbellIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { useSettingsSaved } from "@/components/settings-signal";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { strongKeyless } from "@/components/setup-cta";
import type { ModelCatalogResponse } from "@/src/core";

export const REVIEW_PICK_LIMIT = 64;

export function dueIncludedMessage(count: number): string | null {
	return count > REVIEW_PICK_LIMIT ? `${REVIEW_PICK_LIMIT} of ${count} due included` : null;
}

export type DueItem = {
	id: string;
	name: string;
	statement: string;
	stage?: "practiced" | "demonstrated" | "retained";
	retrievability?: number | null;
};

export type DueResponse = {
	due: DueItem[];
	nextDueAt: string | null;
};

export function PracticeDueButton({ className }: { className?: string }) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [review, setReview] = useState<DueResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);

	const count = review?.due.length ?? 0;

	const refreshInFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		if (refreshInFlightRef.current) return;
		refreshInFlightRef.current = true;
		try {
			const res = await fetch("/api/review", { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as {
				due?: unknown;
				nextDueAt?: unknown;
				stages?: Record<string, { stage?: "practiced" | "demonstrated" | "retained"; retrievability?: number | null }>;
			};
			const rawDue = Array.isArray(data.due) ? data.due : [];
			const due: DueItem[] = rawDue.map((item: unknown) => {
				if (typeof item === "string") {
					const stageInfo = data.stages?.[item];
					return {
						id: item,
						name: item,
						statement: "",
						stage: stageInfo?.stage,
						retrievability: stageInfo?.retrievability,
					};
				}
				const obj = item as { id: string; name?: string; statement?: string; stage?: "practiced" | "demonstrated" | "retained"; retrievability?: number | null };
				const stageInfo = data.stages?.[obj.id];
				return {
					id: obj.id,
					name: obj.name ?? obj.id,
					statement: obj.statement ?? "",
					stage: obj.stage ?? stageInfo?.stage,
					retrievability: obj.retrievability ?? stageInfo?.retrievability,
				};
			});
			setReview({
				due,
				nextDueAt: data.nextDueAt !== undefined && data.nextDueAt !== null ? String(data.nextDueAt) : null,
			});
		} catch {
			setReview((prev) => prev ?? { due: [], nextDueAt: null });
		} finally {
			setLoading(false);
			refreshInFlightRef.current = false;
		}
	}, []);

	const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleRefresh = useCallback(() => {
		if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
		refreshDebounceRef.current = setTimeout(() => {
			refreshDebounceRef.current = undefined;
			void refresh();
		}, 250);
	}, [refresh]);

	useServerEvent("turn-settled", scheduleRefresh);
	useServerEvent("chats-changed", scheduleRefresh);
	useServerEvent("activity-changed", scheduleRefresh);
	useServerResync(() => void refresh());
	useSettingsSaved((section) => {
		if (section === "agent") scheduleRefresh();
	});

	useEffect(() => {
		const onRevision = () => scheduleRefresh();
		window.addEventListener("lh:graph-revision", onRevision);
		return () => window.removeEventListener("lh:graph-revision", onRevision);
	}, [scheduleRefresh]);

	useEffect(() => {
		void refresh();
		return () => {
			if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
		};
	}, [refresh]);

	// Schedules a timeout when review?.nextDueAt && count === 0 to refresh when the next item becomes due
	useEffect(() => {
		if (!review?.nextDueAt || count > 0) return;
		const nextMs = typeof review.nextDueAt === "number" ? review.nextDueAt : Date.parse(review.nextDueAt);
		if (!nextMs || isNaN(nextMs)) return;
		const delay = Math.max(0, nextMs - Date.now() + 500);
		if (delay > 2_147_483_647) return;
		const timer = setTimeout(() => {
			void refresh();
		}, delay);
		return () => clearTimeout(timer);
	}, [review?.nextDueAt, count, refresh]);

	const handleClick = async () => {
		if (count === 0 || busy || !review) return;
		setBusy(true);
		try {
			const catRes = await fetch("/api/models");
			const catalog = catRes.ok ? ((await catRes.json()) as ModelCatalogResponse) : undefined;
			const unconfigured = !catalog || !catalog.defaults || !catalog.slots?.strong?.model;
			if (unconfigured || strongKeyless(catalog)) {
				openSettings("agent");
				setBusy(false);
				return;
			}

			const title = "Practice what's due";
			const picks = review.due.slice(0, REVIEW_PICK_LIMIT).map(({ id, name, statement }) => ({ id, name, statement }));
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title,
					kind: "practice",
					graphContext: { propositions: picks },
				}),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const { id } = (await res.json()) as { id: string };
			router.push(`/chat/${id}?prompt=${encodeURIComponent(title)}`);
		} catch (err) {
			console.error("[practice-due] click failed:", err);
			setBusy(false);
		}
	};

	const label = loading
		? "Checking reviews…"
		: count > 0
			? `Practice what's due · ${count}`
			: "Nothing due";

	return (
		<button
			type="button"
			data-testid="practice-due"
			disabled={loading || count === 0 || busy}
			onClick={() => void handleClick()}
			title={dueIncludedMessage(count) ?? undefined}
			className={cn(
				"flex items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
		>
			<DumbbellIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
			<span className="truncate">{label}</span>
		</button>
	);
}
