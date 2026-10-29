/**
 * Metacognitive Profiler contracts (`shared/90-learner-profile.md`).
 */

export const LEARNER_PROFILE_SEGMENT_PATH = "shared/90-learner-profile.md";
export const DEFAULT_PROFILER_INTERVAL_SESSIONS = 5;
export const PROFILER_INTERVAL_SESSIONS_MIN = 0;
export const PROFILER_INTERVAL_SESSIONS_MAX = 50;

export interface MetacognitiveMetrics {
	totalSessions: number;
	eligibleSessions: number;
	gradedQuizCount: number;
	correctQuizCount: number;
	accuracyRate: number | null;
	confidenceSampleCount: number;
	meanConfidence: number | null;
	brierScore: number | null;
	/** Signed mean (confidence/100 - outcome): > 0 = overconfident, < 0 = underconfident. */
	calibrationBias: number | null;
	thinkingSampleCount: number;
	meanThinkingChars: number;
	/** Share of thinking traces with <= 80 characters (math shorthand / terse notes). */
	terseThinkingRatio: number | null;
	clarifyCount: number;
	dontKnowCount: number;
	strategyCount: number;
	transferCount: number;
	pdfAttachmentCount: number;
	fsrsReviewCount: number;
	/** Share of FSRS reviews rated 1 (Again) or 2 (Hard). */
	fsrsLapseRate: number | null;
}

export interface ProfilerProposal {
	proposedText: string;
	currentText: string;
	summary: string;
	createdAt: string;
	basedOnSessions: number;
}

export interface ProfilerState {
	lastAnalyzedSessionCount: number;
	lastRunAt: string | null;
	metrics: MetacognitiveMetrics | null;
	pendingProposal: ProfilerProposal | null;
}

export interface ProfilerStatusResponse {
	state: ProfilerState;
	metrics: MetacognitiveMetrics;
	shouldAutoTrigger: boolean;
	currentSegmentText: string;
	overrideText: string | null;
	overrideEnabled: boolean;
	intervalSessions: number;
	autoApply: boolean;
}

export type ProfilerActionRequest =
	| { action: "analyze" }
	| { action: "approve"; text?: string }
	| { action: "dismiss" };
