/**
 * Server-side persistence for THE user settings record.
 *
 * Implements core/ports.ts SettingsStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands (lh_kv_get / lh_kv_set).
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import path from "node:path";
import {
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";
import { parseFileAccessSettings, type FileAccessSettingsResult } from "../core/file-access.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import { getMemoryKv, setMemoryKv } from "./memory-backend.ts";

const FILE_ACCESS_ERROR =
	"File-access configuration cannot be read reliably. Learner-file access is blocked. Repair File access in Settings → Agent → Tools.";

export function fileAccessFromRecord(raw: unknown): FileAccessSettingsResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: FILE_ACCESS_ERROR };
	const agent = (raw as Record<string, unknown>).agent;
	if (agent === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	if (!agent || typeof agent !== "object" || Array.isArray(agent)) return { ok: false, error: FILE_ACCESS_ERROR };
	const value = (agent as Record<string, unknown>).fileAccess;
	if (value === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	const parsed = parseFileAccessSettings(value);
	if (
		!parsed.ok ||
		parsed.settings.folders.some(
			(folder) => folder !== "~" && !folder.startsWith("~/") && !path.isAbsolute(folder),
		)
	) {
		return { ok: false, error: FILE_ACCESS_ERROR };
	}
	return parsed;
}

export async function readFileAccessSettings(): Promise<FileAccessSettingsResult> {
	let raw: unknown = null;
	try {
		const invoke = getTauriInvoke();
		if (invoke) {
			raw = await invoke<unknown | null>("lh_kv_get", { key: "settings" });
		} else {
			raw = await getMemoryKv("settings");
		}
	} catch {
		return { ok: false, error: FILE_ACCESS_ERROR };
	}
	if (raw === null || raw === undefined) {
		return { ok: true, settings: { restricted: false, folders: [] } };
	}
	return fileAccessFromRecord(raw);
}

export async function readSettings(): Promise<UserSettings | null> {
	let raw: unknown = null;
	try {
		const invoke = getTauriInvoke();
		if (invoke) {
			raw = await invoke<unknown | null>("lh_kv_get", { key: "settings" });
		} else {
			raw = await getMemoryKv("settings");
		}
	} catch {
		return null;
	}
	if (raw === null || raw === undefined) {
		return null;
	}
	const record = sanitizeUserSettings(raw);
	if (!record) return null;
	if (!fileAccessFromRecord(raw).ok) {
		record.agent = { ...record.agent, fileAccess: { restricted: true, folders: [] } };
	}
	return record;
}

export async function writeSettings(raw: unknown): Promise<UserSettings> {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	const fileAccess = await readFileAccessSettings();
	if (!fileAccess.ok && settings.agent?.fileAccess === undefined) {
		settings.agent = { ...settings.agent, fileAccess: { restricted: true, folders: [] } };
	}
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_kv_set", { key: "settings", value: settings });
	} else {
		await setMemoryKv("settings", settings);
	}
	return settings;
}

export const settingsStore: SettingsStore = {
	readSettings,
	async writeSettings(settings) {
		await writeSettings(settings);
	},
};

export { sanitizeUserSettings };
