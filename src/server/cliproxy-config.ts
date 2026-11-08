import { settingsStore } from "../store/settings.ts";
import { getCliproxyBinary } from "./cliproxy-process.ts";

let cachedCliproxyEnabled = false;

export function updateCliproxyEnabled(enabled: boolean): void {
	cachedCliproxyEnabled = enabled;
}

export async function refreshCliproxyEnabled(): Promise<boolean> {
	const settings = await settingsStore.readSettings();
	cachedCliproxyEnabled = settings?.cliproxy?.enabled === true;
	return cachedCliproxyEnabled;
}

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function cliproxyEnabled(): boolean {
	return cachedCliproxyEnabled;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function cliproxyAvailable(): boolean {
	return cliproxyEnabled() && getCliproxyBinary() !== null;
}

void refreshCliproxyEnabled();
