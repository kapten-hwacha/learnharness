import { settingsStore } from "../store/settings.ts";
import { getCliproxyBinary } from "./cliproxy-process.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function cliproxyEnabled(): boolean {
	return settingsStore.readSettings()?.cliproxy?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function cliproxyAvailable(): boolean {
	return cliproxyEnabled() && getCliproxyBinary() !== null;
}
