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
import { getTauriInvoke } from "../worker/host-bridge.ts";
import { getMemoryKv, setMemoryKv } from "../store/memory-backend.ts";
import * as reviewModule from "./review.ts";
import { stores } from "./stores.ts";

export async function readProfilerState(): Promise<ProfilerState> {
	try {
		const invoke = getTauriInvoke();
		let raw: unknown = null;
		if (invoke) {
			raw = await invoke<unknown | null>("lh_kv_get", { key: "profiler_state" });
		} else {
			raw = await getMemoryKv("profiler_state");
		}
		if (raw && typeof raw === "object") {
			const parsed = raw as Record<string, unknown>;
			return {
				lastAnalyzedSessionCount:
					typeof parsed.lastAnalyzedSessionCount === "number" ? parsed.lastAnalyzedSessionCount : 0,
				lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
				metrics: (parsed.metrics as MetacognitiveMetrics) ?? null,
				pendingProposal: (parsed.pendingProposal as ProfilerProposal) ?? null,
			};
		}
	} catch {
		// absent or unreadable
	}
	return emptyProfilerState();
}

export async function writeProfilerState(state: ProfilerState): Promise<void> {
	const invoke = getTauriInvoke();
	if (invoke) {
		await invoke("lh_kv_set", { key: "profiler_state", value: state });
	} else {
		await setMemoryKv("profiler_state", state);
	}
}

async function readAllChats(): Promise<ChatRecord[]> {
	const chatStore = stores.chatStore;
	const summaries =
		typeof chatStore.listChats === "function"
			? await chatStore.listChats()
			: typeof (chatStore as unknown as { list?: () => Promise<Array<{ id: string }>> | Array<{ id: string }> }).list === "function"
				? await (chatStore as unknown as { list: () => Promise<Array<{ id: string }>> | Array<{ id: string }> }).list()
				: [];

	const records: ChatRecord[] = [];
	for (const summary of summaries) {
		const record =
			typeof chatStore.getChat === "function"
				? await chatStore.getChat(summary.id)
				: typeof (chatStore as unknown as { get?: (id: string) => Promise<ChatRecord | null> | ChatRecord | null }).get === "function"
					? await (chatStore as unknown as { get: (id: string) => Promise<ChatRecord | null> | ChatRecord | null }).get(summary.id)
					: null;
		if (record) {
			records.push(record);
		}
	}
	return records;
}

export async function readReviewLedger(): Promise<ReviewCard[]> {
	try {
		if (typeof reviewModule.readPracticeHistory === "function") {
			const history = await reviewModule.readPracticeHistory();
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

async function readCurrentSettings(): Promise<UserSettings | null> {
	if (typeof settingsStore.readSettings === "function") {
		return await settingsStore.readSettings();
	}
	if (typeof (settingsStore as unknown as { read?: () => Promise<UserSettings | null> | UserSettings | null }).read === "function") {
		return await (settingsStore as unknown as { read: () => Promise<UserSettings | null> | UserSettings | null }).read();
	}
	return null;
}

async function writeCurrentSettings(settings: UserSettings): Promise<void> {
	if (typeof settingsStore.writeSettings === "function") {
		await settingsStore.writeSettings(settings);
	} else if (typeof (settingsStore as unknown as { write?: (s: unknown) => Promise<void> | void }).write === "function") {
		await (settingsStore as unknown as { write: (s: unknown) => Promise<void> | void }).write(settings);
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
	const state = deps?.state ?? (await readProfilerState());
	const chats = deps?.chats ?? (await readAllChats());
	const reviews = deps?.reviews ?? (await readReviewLedger());
	const metrics = computeMetacognitiveMetrics(chats, reviews);

	const settings = deps?.settings !== undefined ? deps.settings : (await readCurrentSettings());
	const intervalSessions =
		typeof settings?.agent?.profilerIntervalSessions === "number"
			? settings.agent.profilerIntervalSessions
			: DEFAULT_PROFILER_INTERVAL_SESSIONS;
	const autoApply = settings?.agent?.profilerAutoApply === true;

	const switches = settings?.agent?.prompts ?? {};
	const overrideText = await promptOverrides.readOverride(LEARNER_PROFILE_SEGMENT_PATH);
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
	const state = deps?.state ?? (await readProfilerState());
	const chats = deps?.chats ?? (await readAllChats());
	const reviews = deps?.reviews ?? (await readReviewLedger());
	const metrics = computeMetacognitiveMetrics(chats, reviews);

	const settings = deps?.settings !== undefined ? deps.settings : (await readCurrentSettings());
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
		await promptOverrides.writeOverride(LEARNER_PROFILE_SEGMENT_PATH, proposedText);

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
		await writeCurrentSettings(updated);

		state.pendingProposal = null;
		await writeProfilerState(state);
		return getProfilerStatus({ ...deps, state, chats, reviews, settings: updated });
	}

	state.pendingProposal = {
		proposedText,
		currentText,
		summary,
		createdAt: new Date().toISOString(),
		basedOnSessions: metrics.eligibleSessions,
	};
	await writeProfilerState(state);

	return getProfilerStatus({ ...deps, state, chats, reviews, settings });
}

export async function approveProfilerProposal(customText?: string): Promise<ProfilerStatusResponse> {
	const state = await readProfilerState();
	const textToApply = (customText?.trim() || state.pendingProposal?.proposedText || "").trim();

	if (textToApply) {
		await promptOverrides.writeOverride(LEARNER_PROFILE_SEGMENT_PATH, textToApply);

		const current = (await readCurrentSettings()) ?? ({} as UserSettings);
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
		await writeCurrentSettings(updated);
	}

	state.pendingProposal = null;
	await writeProfilerState(state);
	return getProfilerStatus();
}

export async function dismissProfilerProposal(): Promise<ProfilerStatusResponse> {
	const state = await readProfilerState();
	state.pendingProposal = null;
	await writeProfilerState(state);
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
