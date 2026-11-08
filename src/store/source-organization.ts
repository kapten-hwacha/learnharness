/**
 * Source Organization persistence.
 *
 * Implements core/ports.ts SourceOrganizationStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands (lh_kv_get / lh_kv_set).
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import { emptySourceOrganization, parseSourceOrganization } from "../core/source-organization.ts";
import type { SourceOrganizationStore } from "../core/ports.ts";
import { emit } from "../core/events.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import { getMemoryKv, setMemoryKv } from "./memory-backend.ts";

export const sourceOrganizationStore: SourceOrganizationStore = {
	async read() {
		const invoke = getTauriInvoke();
		let raw: unknown = null;
		if (invoke) {
			raw = await invoke<unknown | null>("lh_kv_get", { key: "source_organization" });
		} else {
			raw = await getMemoryKv("source_organization");
		}
		if (raw === null || raw === undefined) return emptySourceOrganization();
		return parseSourceOrganization(raw);
	},
	async write(state) {
		const valid = parseSourceOrganization(state);
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_kv_set", { key: "source_organization", value: valid });
		} else {
			await setMemoryKv("source_organization", valid);
		}
		emit("sources-changed", {});
	},
};

export { emptySourceOrganization, parseSourceOrganization };
