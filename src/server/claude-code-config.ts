import { getClaudeBinary } from "../agent/claude-code/binary.ts";
import { settingsStore } from "../store/settings.ts";

let cachedClaudeCodeEnabled = false;

export function updateClaudeCodeEnabled(enabled: boolean): void {
	cachedClaudeCodeEnabled = enabled;
}

export async function refreshClaudeCodeEnabled(): Promise<boolean> {
	const settings = await settingsStore.readSettings();
	cachedClaudeCodeEnabled = settings?.claudeCode?.enabled === true;
	return cachedClaudeCodeEnabled;
}

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function claudeCodeEnabled(): boolean {
	return cachedClaudeCodeEnabled;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function claudeCodeAvailable(): boolean {
	return claudeCodeEnabled() && getClaudeBinary() !== null;
}

void refreshClaudeCodeEnabled();
