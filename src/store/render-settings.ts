/**
 * Persistence for graph render settings.
 *
 * When getTauriInvoke() is non-null, calls Rust Tauri commands (lh_kv_get / lh_kv_set).
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import { getMemoryKv, setMemoryKv } from "./memory-backend.ts";

export async function readRenderSettings(): Promise<GraphRenderSettings | null> {
	let raw: unknown = null;
	try {
		const invoke = getTauriInvoke();
		if (invoke) {
			raw = await invoke<unknown | null>("lh_kv_get", { key: "render_settings" });
		} else {
			raw = await getMemoryKv("render_settings");
		}
	} catch {
		return null;
	}
	if (raw === null || raw === undefined) return null;
	try {
		return sanitizeRenderSettings(raw);
	} catch {
		return null;
	}
}

export async function writeRenderSettings(raw: unknown): Promise<GraphRenderSettings> {
	const settings = sanitizeRenderSettings(raw);
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_kv_set", { key: "render_settings", value: settings });
	} else {
		await setMemoryKv("render_settings", settings);
	}
	return settings;
}

export { DEFAULT_RENDER_SETTINGS };
