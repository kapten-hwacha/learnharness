/**
 * Prompt-override store behind the core port.
 *
 * Implements core/ports.ts PromptOverrideStore.
 * When getTauriInvoke() is non-null, calls Rust Tauri commands.
 * When getTauriInvoke() is null, falls back to memory-backend.ts (Node tests).
 */

import { isValidSegmentPath } from "../core/prompt-segments.ts";
import type { PromptOverrideStore } from "../core/ports.ts";
import { getTauriInvoke } from "../worker/host-bridge.ts";
import {
	deleteMemoryPromptOverride,
	listMemoryPromptOverrides,
	readMemoryPromptOverride,
	writeMemoryPromptOverride,
} from "./memory-backend.ts";

function getPromptOverrideCache(): Map<string, string | null> {
	return ((globalThis as any).__LH_PROMPT_OVERRIDE_CACHE__ ??= new Map<string, string | null>());
}

export const promptOverrides: PromptOverrideStore = {
	async listOverrides(): Promise<string[]> {
		const invoke = getTauriInvoke();
		if (invoke) {
			const raw = await invoke<string[]>("lh_prompt_override_list");
			return (raw ?? []).sort();
		}
		return await listMemoryPromptOverrides();
	},

	async readOverride(segmentPath: string): Promise<string | null> {
		if (!isValidSegmentPath(segmentPath)) return null;
		const invoke = getTauriInvoke();
		if (invoke) {
			return await invoke<string | null>("lh_prompt_override_read", { segmentPath });
		}
		return await readMemoryPromptOverride(segmentPath);
	},

	async writeOverride(segmentPath: string, text: string): Promise<void> {
		if (!isValidSegmentPath(segmentPath)) return;
		getPromptOverrideCache().set(segmentPath, text);
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_prompt_override_write", { segmentPath, content: text });
		} else {
			await writeMemoryPromptOverride(segmentPath, text);
		}
	},

	async deleteOverride(segmentPath: string): Promise<void> {
		if (!isValidSegmentPath(segmentPath)) return;
		getPromptOverrideCache().delete(segmentPath);
		const invoke = getTauriInvoke();
		if (invoke) {
			await invoke("lh_prompt_override_delete", { segmentPath });
		} else {
			await deleteMemoryPromptOverride(segmentPath);
		}
	},
};
