/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { graphStore, purgeLegacyLedgers } from "../store/graph.ts";
import { sourceOrganizationStore } from "../store/source-organization.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { studyStore } from "../store/study.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import type { UserSettings } from "../core/settings.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { updateClaudeCodeEnabled } from "./claude-code-config.ts";
import { updateCliproxyEnabled } from "./cliproxy-config.ts";
import { refreshFileAccessSettings } from "./file-access.ts";
import { updateCachedSearchEngine } from "./search.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	sourceOrganizationStore,
	jobStore,
	settingsStore: {
		...settingsStore,
		async writeSettings(settings: UserSettings) {
			await settingsStore.writeSettings(settings);
			await effectiveSettings();
		},
	},
	studyStore,
};

export type Stores = typeof stores;

let cachedSettings: UserSettings | null = null;

export function currentSettings(): UserSettings | null {
	return cachedSettings;
}

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export async function effectiveSettings(): Promise<EffectiveSettings> {
	const raw = await settingsStore.readSettings();
	cachedSettings = raw;
	updateClaudeCodeEnabled(raw?.claudeCode?.enabled === true);
	updateCliproxyEnabled(raw?.cliproxy?.enabled === true);
	updateCachedSearchEngine(raw?.agent?.search?.engine);
	void refreshFileAccessSettings();
	return resolveSettings(raw);
}

void settingsStore.readSettings().then((s) => { cachedSettings = s; });

// Boot: register the custom endpoint (when configured) into piModels(); the
// POST /api/custom-provider route re-syncs after every connect.
void syncCustomProvider();
void purgeLegacyLedgers();
