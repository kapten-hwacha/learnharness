import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { effectivePromptSegments } from "../agent/prompt-segments.ts";
import {
	buildDeterministicLearnerProfile,
	computeMetacognitiveMetrics,
	DEFAULT_PROFILER_INTERVAL_SESSIONS,
	emptyProfilerState,
	LEARNER_PROFILE_SEGMENT_PATH,
	shouldAutoTriggerProfiler,
	type ChatRecord,
	type MetacognitiveMetrics,
	type ProfilerProposal,
	type ProfilerState,
	type ProfilerStatusResponse,
	type ReviewCard,
} from "../core/profiler.ts";
import type { UserSettings } from "../core/settings.ts";
import { promptOverrides } from "../store/prompt-overrides.ts";
import { settingsStore } from "../store/settings.ts";
import * as reviewModule from "./review.ts";
import { stores } from "./stores.ts";

function profilerStateFile(): string {
	const dataDir = (PATHS as { dataDir?: string }).dataDir ?? PATHS.data;
	return path.join(dataDir, "profiler-state.json");
}

export function readProfilerState(): ProfilerState {
	const file = profilerStateFile();
	try {
		const raw = fs.readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return {
				lastAnalyzedSessionCount:
					typeof parsed.lastAnalyzedSessionCount === "number" ? parsed.lastAnalyzedSessionCount : 0,
				lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
				metrics: parsed.metrics ?? null,
				pendingProposal: parsed.pendingProposal ?? null,
			};
		}
	} catch {
		// absent or unreadable
	}
	return emptyProfilerState();
}

export function writeProfilerState(state: ProfilerState): void {
	const file = profilerStateFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
}

function readAllChats(): ChatRecord[] {
	const chatStore = stores.chatStore;
	const summaries =
		typeof chatStore.listChats === "function"
			? chatStore.listChats()
			: typeof (chatStore as unknown as { list?: () => Array<{ id: string }> }).list === "function"
				? (chatStore as unknown as { list: () => Array<{ id: string }> }).list()
				: [];

	const records: ChatRecord[] = [];
	for (const summary of summaries) {
		const record =
			typeof chatStore.getChat === "function"
				? chatStore.getChat(summary.id)
				: typeof (chatStore as unknown as { get?: (id: string) => ChatRecord | null }).get === "function"
					? (chatStore as unknown as { get: (id: string) => ChatRecord | null }).get(summary.id)
					: null;
		if (record) {
			records.push(record);
		}
	}
	return records;
}

export function readReviewLedger(): ReviewCard[] {
	try {
		if (typeof reviewModule.readPracticeHistory === "function") {
			const history = reviewModule.readPracticeHistory();
			const byTarget = new Map<string, Array<{ rating?: number }>>();
			for (const rec of history.records) {
				if (rec.outcome === "dismissed") continue;
				const rating = rec.rating ?? (rec.outcome === "solved" ? 3 : rec.outcome === "surrendered" || rec.outcome === "movedOn" ? 1 : 2);
				for (const target of rec.targets) {
					const list = byTarget.get(target) ?? [];
					list.push({ rating });
					byTarget.set(target, list);
				}
			}
			return Array.from(byTarget.entries()).map(([id, list]) => ({ id, history: list }));
		}
	} catch {
		// fallback to empty
	}
	return [];
}

function readCurrentSettings(): UserSettings | null {
	if (typeof settingsStore.readSettings === "function") {
		return settingsStore.readSettings();
	}
	if (typeof (settingsStore as unknown as { read?: () => UserSettings | null }).read === "function") {
		return (settingsStore as unknown as { read: () => UserSettings | null }).read();
	}
	return null;
}

function writeCurrentSettings(settings: UserSettings): void {
	if (typeof settingsStore.writeSettings === "function") {
		settingsStore.writeSettings(settings);
	} else if (typeof (settingsStore as unknown as { write?: (s: unknown) => void }).write === "function") {
		(settingsStore as unknown as { write: (s: unknown) => void }).write(settings);
	}
}

export interface ProfilerDeps {
	chats?: readonly ChatRecord[];
	reviews?: readonly ReviewCard[];
	state?: ProfilerState;
	settings?: UserSettings | null;
	generateProfileText?: (
		metrics: MetacognitiveMetrics,
		currentText: string,
	) => Promise<{ proposedText: string; summary: string }>;
}

export async function getProfilerStatus(deps?: ProfilerDeps): Promise<ProfilerStatusResponse> {
	const state = deps?.state ?? readProfilerState();
	const chats = deps?.chats ?? readAllChats();
	const reviews = deps?.reviews ?? readReviewLedger();
	const metrics = computeMetacognitiveMetrics(chats, reviews);

	const settings = deps?.settings !== undefined ? deps.settings : readCurrentSettings();
	const intervalSessions =
		typeof settings?.agent?.profilerIntervalSessions === "number"
			? settings.agent.profilerIntervalSessions
			: DEFAULT_PROFILER_INTERVAL_SESSIONS;
	const autoApply = settings?.agent?.profilerAutoApply === true;

	const switches = settings?.agent?.prompts ?? {};
	const overrideText = promptOverrides.readOverride(LEARNER_PROFILE_SEGMENT_PATH);
	const overrideEnabled = switches[LEARNER_PROFILE_SEGMENT_PATH] === true && overrideText !== null;

	let sourceText = "";
	try {
		const segments = effectivePromptSegments("teacher", switches);
		const targetSegment = segments.find((s) => s.path === LEARNER_PROFILE_SEGMENT_PATH);
		if (targetSegment) {
			sourceText = targetSegment.sourceText;
		}
	} catch {
		// fallback if segments discovery fails
	}

	const currentSegmentText = overrideEnabled && overrideText !== null ? overrideText : sourceText || overrideText || "";
	const shouldAutoTrigger = shouldAutoTriggerProfiler(metrics, state, intervalSessions);

	return {
		state,
		metrics,
		shouldAutoTrigger,
		currentSegmentText,
		overrideText,
		overrideEnabled,
		intervalSessions,
		autoApply,
	};
}

export async function runMetacognitiveProfiler(deps?: ProfilerDeps): Promise<ProfilerStatusResponse> {
	const state = deps?.state ?? readProfilerState();
	const chats = deps?.chats ?? readAllChats();
	const reviews = deps?.reviews ?? readReviewLedger();
	const metrics = computeMetacognitiveMetrics(chats, reviews);

	const settings = deps?.settings !== undefined ? deps.settings : readCurrentSettings();
	const autoApply = settings?.agent?.profilerAutoApply === true;

	const currentStatus = await getProfilerStatus({ ...deps, state, chats, reviews, settings });
	const currentText = currentStatus.currentSegmentText;

	let profileResult: { proposedText: string; summary: string };
	if (deps?.generateProfileText) {
		profileResult = await deps.generateProfileText(metrics, currentText);
	} else {
		profileResult = buildDeterministicLearnerProfile(metrics);
	}

	const { proposedText, summary } = profileResult;
	state.lastAnalyzedSessionCount = metrics.eligibleSessions;
	state.lastRunAt = new Date().toISOString();
	state.metrics = metrics;

	if (autoApply) {
		promptOverrides.writeOverride(LEARNER_PROFILE_SEGMENT_PATH, proposedText);

		const current = settings ?? ({} as UserSettings);
		const updated: UserSettings = {
			...current,
			agent: {
				...current.agent,
				prompts: {
					...current.agent?.prompts,
					[LEARNER_PROFILE_SEGMENT_PATH]: true,
				},
			},
		};
		writeCurrentSettings(updated);

		state.pendingProposal = null;
		writeProfilerState(state);
		return getProfilerStatus({ ...deps, state, chats, reviews, settings: updated });
	}

	state.pendingProposal = {
		proposedText,
		currentText,
		summary,
		createdAt: new Date().toISOString(),
		basedOnSessions: metrics.eligibleSessions,
	};
	writeProfilerState(state);

	return getProfilerStatus({ ...deps, state, chats, reviews, settings });
}

export async function approveProfilerProposal(customText?: string): Promise<ProfilerStatusResponse> {
	const state = readProfilerState();
	const textToApply = (customText?.trim() || state.pendingProposal?.proposedText || "").trim();

	if (textToApply) {
		promptOverrides.writeOverride(LEARNER_PROFILE_SEGMENT_PATH, textToApply);

		const current = readCurrentSettings() ?? ({} as UserSettings);
		const updated: UserSettings = {
			...current,
			agent: {
				...current.agent,
				prompts: {
					...current.agent?.prompts,
					[LEARNER_PROFILE_SEGMENT_PATH]: true,
				},
			},
		};
		writeCurrentSettings(updated);
	}

	state.pendingProposal = null;
	writeProfilerState(state);
	return getProfilerStatus();
}

export async function dismissProfilerProposal(): Promise<ProfilerStatusResponse> {
	const state = readProfilerState();
	state.pendingProposal = null;
	writeProfilerState(state);
	return getProfilerStatus();
}

let autoRunInFlight: Promise<void> | null = null;

export async function maybeAutoRunProfiler(): Promise<void> {
	if (autoRunInFlight) return autoRunInFlight;
	autoRunInFlight = (async () => {
		try {
			const status = await getProfilerStatus();
			if (status.shouldAutoTrigger && !status.state.pendingProposal) {
				await runMetacognitiveProfiler();
			}
		} catch (err) {
			console.error("[profiler] maybeAutoRunProfiler failed:", err);
		} finally {
			autoRunInFlight = null;
		}
	})();
	return autoRunInFlight;
}
