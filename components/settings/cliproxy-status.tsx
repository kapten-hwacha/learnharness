"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type CliProxyStatus, type UserSettings } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

export function cliproxyStatusLabel(status: CliProxyStatus | null): string {
	switch (status?.state) {
		case "ready": {
			const count = status.models.length;
			const modelLabel = count === 1 ? "1 model" : `${count} models`;
			return status.version ? `Ready (v${status.version} · ${modelLabel})` : `Ready (${modelLabel})`;
		}
		case "not-found": return "Binary not found";
		case "offline": return "Service offline";
		case "disabled": return "Disabled";
		default: return "Service offline";
	}
}

export function CliProxyStatus() {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<CliProxyStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
	const settingsRead = useRef<AbortController | null>(null);
	const settingsWrite = useRef<AbortController | null>(null);

	const read = useCallback(async () => {
		settingsRead.current?.abort();
		const controller = new AbortController();
		settingsRead.current = controller;
		setLoaded(false);
		try {
			const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("settings unavailable");
			const body = await response.json() as { settings: UserSettings | null };
			if (!controller.signal.aborted) {
				setEnabled(body.settings?.cliproxy?.enabled === true);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load CLIProxyAPI settings.");
		}
	}, []);

	useEffect(() => {
		void read();
		return () => { settingsRead.current?.abort(); settingsWrite.current?.abort(); };
	}, [read]);

	useSettingsSaved((section) => { if (section === "cliproxy") void read(); });

	const save = async (next: boolean) => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/settings/cliproxy", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }),
				signal: controller.signal,
			});
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			if (typeof body.settings?.cliproxy?.enabled !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				setEnabled(body.settings.cliproxy.enabled);
				notifySettingsSaved("cliproxy");
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not save CLIProxyAPI settings.");
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

	const refresh = useCallback(async () => {
		if (!enabled) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch("/api/cliproxy", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as CliProxyStatus;
			if (!["ready", "not-found", "offline", "disabled"].includes(value.state)) throw new Error("invalid status");
			if (!controller.signal.aborted) setStatus(value);
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [enabled]);

	useEffect(() => {
		if (enabled) void refresh();
		else { request.current?.abort(); setStatus(null); setBusy(false); }
		return () => request.current?.abort();
	}, [enabled, refresh]);

	return (
		<div className="space-y-2" data-testid="cliproxy-installation">
			<div className="flex items-center gap-3">
				<span className="font-prose text-(length:--lh-prose-size) text-foreground">CLIProxyAPI</span>
				<Toggle label="CLIProxyAPI" checked={enabled} disabled={!loaded || saving} onChange={(next) => void save(next)} />
			</div>
			{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
			{enabled && (
				<>
					<div className="flex flex-wrap items-center gap-3">
						<span role="status" className="text-xs text-muted-foreground">
							{busy ? "Checking…" : cliproxyStatusLabel(status)}
						</span>
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="cursor-pointer disabled:cursor-not-allowed"
							disabled={busy}
							onClick={() => void refresh()}
							data-testid="cliproxy-check-again"
						>
							Check again
						</Button>
					</div>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Route to Gemini 3.8 Flash and Gemini 4 Argon using your local CLIProxyAPI service.
					</p>
				</>
			)}
		</div>
	);
}
