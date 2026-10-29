"use client";

import { useEffect, useState } from "react";
import {
	DEFAULT_PROFILER_INTERVAL_SESSIONS,
	LEARNER_PROFILE_SEGMENT_PATH,
	PROFILER_INTERVAL_SESSIONS_MIN,
	PROFILER_INTERVAL_SESSIONS_MAX,
	type AgentSettings,
	type ProfilerStatusResponse,
} from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { SettingsGroup, SettingsRow, Toggle, CommitInput } from "./controls.tsx";

/**
 * Compose: update profiler interval sessions. Pure for unit/render tests.
 */
export function composeProfilerInterval(
	agent: AgentSettings | undefined,
	sessions: number | undefined,
): AgentSettings {
	return { ...agent, profilerIntervalSessions: sessions };
}

/**
 * Compose: update profiler auto-apply preference. Pure for unit/render tests.
 */
export function composeProfilerAutoApply(
	agent: AgentSettings | undefined,
	autoApply: boolean,
): AgentSettings {
	return { ...agent, profilerAutoApply: autoApply };
}

export interface MetacognitiveProfilerCardProps {
	agent: AgentSettings | undefined;
	onSectionChange: (next: AgentSettings) => void;
	initialStatus?: ProfilerStatusResponse | null;
}

export function MetacognitiveProfilerCard({
	agent,
	onSectionChange,
	initialStatus,
}: MetacognitiveProfilerCardProps) {
	const [status, setStatus] = useState<ProfilerStatusResponse | null>(
		initialStatus !== undefined ? initialStatus : null,
	);
	const [analyzing, setAnalyzing] = useState(false);
	const [submittingAction, setSubmittingAction] = useState<"approve" | "dismiss" | null>(null);
	const [draftText, setDraftText] = useState(
		initialStatus?.state.pendingProposal?.proposedText ?? "",
	);

	useEffect(() => {
		if (initialStatus !== undefined) {
			setStatus(initialStatus);
			return;
		}

		let cancelled = false;
		fetch("/api/profiler")
			.then(async (res) => {
				if (!res.ok) return null;
				return (await res.json()) as ProfilerStatusResponse;
			})
			.then((data) => {
				if (!cancelled && data) {
					setStatus(data);
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	}, [initialStatus]);

	useEffect(() => {
		if (status?.state.pendingProposal?.proposedText !== undefined) {
			setDraftText(status.state.pendingProposal.proposedText);
		}
	}, [status?.state.pendingProposal?.proposedText]);

	const handleAnalyze = async () => {
		setAnalyzing(true);
		try {
			const res = await fetch("/api/profiler", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "analyze" }),
			});
			if (res.ok) {
				const updated = (await res.json()) as ProfilerStatusResponse;
				setStatus(updated);
				if (agent?.profilerAutoApply === true || updated.autoApply === true) {
					notifySettingsSaved("agent");
				}
			}
		} catch {
			// Ignore network errors in UI
		} finally {
			setAnalyzing(false);
		}
	};

	const handleApprove = async () => {
		setSubmittingAction("approve");
		try {
			const res = await fetch("/api/profiler", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "approve", text: draftText }),
			});
			if (res.ok) {
				const updated = (await res.json()) as ProfilerStatusResponse;
				setStatus(updated);
				notifySettingsSaved("agent");
			}
		} catch {
			// Ignore network errors in UI
		} finally {
			setSubmittingAction(null);
		}
	};

	const handleDismiss = async () => {
		setSubmittingAction("dismiss");
		try {
			const res = await fetch("/api/profiler", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "dismiss" }),
			});
			if (res.ok) {
				const updated = (await res.json()) as ProfilerStatusResponse;
				setStatus(updated);
			}
		} catch {
			// Ignore network errors in UI
		} finally {
			setSubmittingAction(null);
		}
	};

	return (
		<SettingsGroup label="Metacognitive profiler" testid="group-profiler">
			<SettingsRow
				label="Profile every N sessions"
				hint="0 disables automatic profiling (default 5)"
				testid="profiler-row-interval"
			>
				<CommitInput
					type="number"
					testid="input-profiler-interval"
					value={String(agent?.profilerIntervalSessions ?? "")}
					placeholder={String(DEFAULT_PROFILER_INTERVAL_SESSIONS)}
					ariaLabel="profiler session interval"
					onCommit={(v) => {
						if (v === "") {
							onSectionChange(composeProfilerInterval(agent, undefined));
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						const clamped = Math.min(
							PROFILER_INTERVAL_SESSIONS_MAX,
							Math.max(PROFILER_INTERVAL_SESSIONS_MIN, Math.round(n)),
						);
						onSectionChange(composeProfilerInterval(agent, clamped));
					}}
				/>
			</SettingsRow>

			<SettingsRow
				label="Auto-apply profile updates"
				hint="Automatically activate shared/90-learner-profile.md without waiting for review"
				testid="profiler-row-auto-apply"
			>
				<Toggle
					checked={agent?.profilerAutoApply === true}
					label="auto-apply learner profile"
					onChange={(on) => onSectionChange(composeProfilerAutoApply(agent, on))}
				/>
			</SettingsRow>

			<SettingsRow
				label="Study style analysis"
				hint="Analyzes confidence calibration, shorthand notes, and review history"
				testid="profiler-row-analyze"
			>
				<div className="flex flex-wrap items-center justify-end gap-2">
					{status?.metrics && (
						<div
							data-testid="profiler-metrics-summary"
							className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
						>
							<span className="rounded bg-muted/60 px-2 py-0.5">
								Sessions: {status.metrics.eligibleSessions}
							</span>
							<span className="rounded bg-muted/60 px-2 py-0.5">
								Accuracy:{" "}
								{status.metrics.accuracyRate !== null
									? `${Math.round(status.metrics.accuracyRate * 100)}%`
									: "—"}
							</span>
							<span className="rounded bg-muted/60 px-2 py-0.5">
								Brier:{" "}
								{status.metrics.brierScore !== null
									? status.metrics.brierScore.toFixed(2)
									: "—"}
							</span>
							<span className="rounded bg-muted/60 px-2 py-0.5">
								Shorthand:{" "}
								{status.metrics.terseThinkingRatio !== null
									? `${Math.round(status.metrics.terseThinkingRatio * 100)}%`
									: "—"}
							</span>
						</div>
					)}
					<button
						type="button"
						data-testid="profiler-analyze-button"
						disabled={analyzing}
						onClick={handleAnalyze}
						className="h-7 shrink-0 rounded-md border border-border bg-background px-3 font-ui text-xs font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
					>
						{analyzing ? "Analyzing..." : "Analyze Study Style"}
					</button>
				</div>
			</SettingsRow>

			{status?.state.pendingProposal && (
				<div
					data-testid="profiler-proposal-card"
					className="mt-3 flex flex-col gap-3 rounded-xl border border-border/80 bg-muted/20 p-4"
				>
					<div className="flex items-center justify-between gap-2">
						<h4 className="font-ui text-xs font-medium tracking-wide uppercase text-foreground">
							Proposed Learner Profile ({LEARNER_PROFILE_SEGMENT_PATH})
						</h4>
						{status.state.pendingProposal.basedOnSessions > 0 && (
							<span className="text-[11px] text-muted-foreground">
								Based on {status.state.pendingProposal.basedOnSessions} sessions
							</span>
						)}
					</div>

					<p
						data-testid="profiler-proposal-summary"
						className="text-xs text-muted-foreground"
					>
						{status.state.pendingProposal.summary}
					</p>

					{status.state.pendingProposal.currentText && (
						<div className="flex flex-col gap-1">
							<span className="text-[11px] font-medium text-muted-foreground">Current Profile</span>
							<pre className="max-h-24 overflow-y-auto rounded border border-border/60 bg-muted/40 p-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap">
								{status.state.pendingProposal.currentText}
							</pre>
						</div>
					)}

					<div className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-muted-foreground">Proposed Directive (Editable)</span>
						<textarea
							data-testid="profiler-proposal-textarea"
							value={draftText}
							onChange={(e) => setDraftText(e.target.value)}
							onInput={(e) => setDraftText(e.currentTarget.value)}
							rows={6}
							aria-label="Proposed learner profile directive"
							className="w-full rounded-md border border-border bg-background p-2.5 font-mono text-xs text-foreground outline-none focus:border-ring resize-y"
						/>
					</div>

					<div className="flex items-center justify-end gap-2 pt-1">
						<button
							type="button"
							data-testid="profiler-dismiss-button"
							disabled={submittingAction !== null}
							onClick={handleDismiss}
							className="h-7 rounded-md border border-border px-3 font-ui text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
						>
							Dismiss
						</button>
						<button
							type="button"
							data-testid="profiler-approve-button"
							disabled={submittingAction !== null}
							onClick={handleApprove}
							className="h-7 rounded-md bg-foreground px-3 font-ui text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
						>
							{submittingAction === "approve" ? "Activating..." : "Approve & Activate"}
						</button>
					</div>
				</div>
			)}
		</SettingsGroup>
	);
}
