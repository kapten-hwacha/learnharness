/**
 * THE canonical prompt-segment discovery + override resolution (P2
 * reconciliation, 2026-09-19). The agent layer owns it because composition
 * lives here: composeInstructions (teacher-agent.ts) composes through
 * effectivePromptSegments, and the discovery reads THIS layer's own tree
 * (src/agent/prompts — base, shared/, per-agent fragments) — the exact
 * rules the pre-P2 loader used, now in one place.
 *
 * The architecture law pins the layout: the agent layer never imports the
 * store adapters, so the override-file READ lives here too (config-anchored
 * static file, same discipline as reading the source fragments); the
 * override-file CRUD (write/delete/list — the mutating store behind the
 * core port) stays in src/store/prompt-overrides.ts. Both sides share the
 * pure path grammar (src/core/prompt-segments.ts).
 *
 * SEGMENTS: the SHARED base (src/agent/system-prompt.md), then every
 * numeric-prefix *.md fragment in the agent's own directory (sorted by
 * filename), then the shared/ fragments directory (composed by BOTH
 * agents as a trailing appendix — the 2026-09-27 reorder). The segment
 * list adapts to the code: an override keyed to a segment the source no
 * longer ships stops composing automatically.
 *
 * OVERRIDES: override files mirror the source layout under
 * config.PROMPTS_OVERRIDE_DIR — "system-prompt.md" at the root,
 * "shared/<file>", "teacher/<file>" / "prober/<file>". File presence is NOT
 * the override: the settings SWITCH is (owner decision) — the user keeps
 * their file and flips back to the source default to compare.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS, PROMPTS_OVERRIDE_DIR } from "../../config.ts";
import { isValidSegmentPath, type PromptAgent, type PromptSegmentInfo } from "../core/prompt-segments.ts";
import { hasTauriBridge } from "../worker/host-bridge.ts";
import { getBundledPrompt, listBundledPromptFiles } from "./bundled-assets.ts";

function promptsDir(): string {
	return path.join(PATHS.root, "src", "agent", "prompts");
}

/** Shared fragments the PRACTICE agent composes: the VOICE, ACCURACY,
 *  and MENTAL-MODEL chunks joined the formatting guide (owner rounds 13
 *  and the prompt-refinement round of 2026-10-07) — personality, the
 *  truth contract, and the thinking-fields doctrine are ONE law across
 *  every agent. The question/confidence/file mechanics stay out
 *  (practice has no such tools). */
const PRACTICE_SHARED_FRAGMENTS = ["10-voice.md", "15-accuracy.md", "16-mental-model.md", "40-formatting.md", "90-learner-profile.md"];

/** Absolute path for an override file (unchecked — validate first). */
function overrideFileFor(segmentPath: string): string {
	return path.join(PROMPTS_OVERRIDE_DIR, ...segmentPath.split("/"));
}

/** In-memory cache for prompt overrides in worker / client environments. */
export const promptOverrideCache = new Map<string, string | null>();

export function setPromptOverrideCacheEntry(segmentPath: string, text: string | null): void {
	promptOverrideCache.set(segmentPath, text);
}

export function replacePromptOverrideCache(entries: Record<string, string>): void {
	promptOverrideCache.clear();
	for (const [key, value] of Object.entries(entries)) {
		promptOverrideCache.set(key, value);
	}
}

export function clearPromptOverrideCache(): void {
	promptOverrideCache.clear();
}

/** Read one override file, or null when absent/invalid — the composition
 *  side's reader (the store's readOverride is the same mirror layout,
 *  kept separate because the layers may not import each other). */
export function readPromptOverride(segmentPath: string): string | null {
	if (!isValidSegmentPath(segmentPath)) return null;
	if (promptOverrideCache.has(segmentPath)) {
		return promptOverrideCache.get(segmentPath) ?? null;
	}
	if (!hasTauriBridge()) {
		try {
			return fs.readFileSync(overrideFileFor(segmentPath), "utf-8");
		} catch {
			return null;
		}
	}
	return null;
}

/** List the SOURCE segments for one agent, in composition order — the
 *  shared base, then the agent's own fragments sorted by filename, then
 *  the shared/ fragments (the 2026-09-27 reorder: the agent's job and
 *  method lead; the shared tool/file/format mechanics are an appendix).
 *  The exact order composeInstructions composes them in. */
export function listSourceSegments(agent: PromptAgent): Array<{ path: string; shared: boolean; file: string }> {
	const segments: Array<{ path: string; shared: boolean; file: string }> = agent === "practice" ? [] : [
		{ path: "system-prompt.md", shared: true, file: PATHS.teacherPrompt },
	];

	const agentFiles = listBundledPromptFiles(agent);
	for (const f of agentFiles) {
		segments.push({ path: `${agent}/${f}`, shared: false, file: path.join(promptsDir(), agent, f) });
	}

	const allow = agent === "practice" ? PRACTICE_SHARED_FRAGMENTS : null;
	const sharedFiles = listBundledPromptFiles("shared").filter((f) => allow === null || allow.includes(f));
	for (const f of sharedFiles) {
		segments.push({ path: `shared/${f}`, shared: true, file: path.join(promptsDir(), "shared", f) });
	}

	return segments;
}

/**
 * The effective segment view for one agent — every segment with its source
 * text, override text, and effective switch state. `switches` is the
 * settings record's agent.prompts map (absent key = off); enabled =
 * switch on AND the override file exists.
 */
export function effectivePromptSegments(
	agent: PromptAgent,
	switches: Record<string, boolean>,
): PromptSegmentInfo[] {
	return listSourceSegments(agent).map((segment) => {
		let sourceText = getBundledPrompt(segment.path);
		if (sourceText === null) {
			try {
				sourceText = fs.readFileSync(segment.file, "utf-8");
			} catch {
				sourceText = ""; // source unreadable — the agent loader would crash anyway
			}
		}
		const overrideText = readPromptOverride(segment.path);
		return {
			path: segment.path,
			sourceText,
			overrideText,
			enabled: switches[segment.path] === true && overrideText !== null,
			shared: segment.shared,
		};
	});
}

/** Every known segment path across both agents (route validation). */
export function allSegmentPaths(): string[] {
	const paths = new Set<string>();
	for (const agent of ["prober", "teacher", "practice"] as const) {
		for (const segment of listSourceSegments(agent)) paths.add(segment.path);
	}
	return [...paths].sort();
}
