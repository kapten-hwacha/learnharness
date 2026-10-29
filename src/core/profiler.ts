/**
 * Pure browser-safe Metacognitive Profiler analytics and generators.
 * No node:* imports permitted.
 */

import type { ChatRecord } from "./contracts/chat.ts";
export type { ChatRecord } from "./contracts/chat.ts";
import {
	DEFAULT_PROFILER_INTERVAL_SESSIONS,
	LEARNER_PROFILE_SEGMENT_PATH,
	PROFILER_INTERVAL_SESSIONS_MAX,
	PROFILER_INTERVAL_SESSIONS_MIN,
	type MetacognitiveMetrics,
	type ProfilerActionRequest,
	type ProfilerProposal,
	type ProfilerState,
	type ProfilerStatusResponse,
} from "./contracts/profiler.ts";

export * from "./contracts/profiler.ts";

export interface ReviewCard {
	id?: string;
	history: readonly { rating?: number; outcome?: string; [key: string]: unknown }[];
	[key: string]: unknown;
}

/**
 * Empty baseline profiler state.
 */
export function emptyProfilerState(): ProfilerState {
	return {
		lastAnalyzedSessionCount: 0,
		lastRunAt: null,
		metrics: null,
		pendingProposal: null,
	};
}

/**
 * Aggregates metacognitive learning metrics across chat sessions and review history.
 */
export function computeMetacognitiveMetrics(
	chats: readonly ChatRecord[],
	reviews: readonly ReviewCard[] = [],
): MetacognitiveMetrics {
	let eligibleSessions = 0;
	let gradedQuizCount = 0;
	let correctQuizCount = 0;
	let confidenceSampleCount = 0;
	let sumConfidence = 0;
	let sumBrier = 0;
	let sumBias = 0;
	let thinkingSampleCount = 0;
	let totalThinkingChars = 0;
	let terseCount = 0;
	let clarifyCount = 0;
	let dontKnowCount = 0;
	let strategyCount = 0;
	let transferCount = 0;
	let pdfAttachmentCount = 0;

	for (const chat of chats) {
		const messages = chat.messages ?? [];
		let sessionEligible = false;

		// Clarification side-chats
		if (chat.clarifications) {
			clarifyCount += Object.values(chat.clarifications).reduce(
				(sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
				0,
			);
		}

		for (const m of messages) {
			// Eligibility: answered question or concluded practice problem
			if (m.role === "toolResult") {
				const toolMsg = m as {
					toolName?: string;
					isError?: boolean;
					details?: Record<string, unknown>;
				};

				if (toolMsg.details && typeof toolMsg.details.answeredAt === "string") {
					sessionEligible = true;
				} else if (toolMsg.toolName === "conclude" && !toolMsg.isError) {
					sessionEligible = true;
				}

				// Answered question metrics
				if (
					toolMsg.details &&
					typeof toolMsg.details === "object" &&
					(toolMsg.details.kind !== undefined || toolMsg.details.answeredAt !== undefined) &&
					!toolMsg.details.dismissed
				) {
					const d = toolMsg.details;

					if (d.dontKnow === true) {
						dontKnowCount++;
					}

					if (d.questionType === "strategy") {
						strategyCount++;
					} else if (d.questionType === "transfer") {
						transferCount++;
					}

					const isQuiz = typeof d.correct === "boolean" && !d.dontKnow;
					if (isQuiz) {
						gradedQuizCount++;
						if (d.correct === true) {
							correctQuizCount++;
						}

						if (typeof d.confidence === "number") {
							confidenceSampleCount++;
							sumConfidence += d.confidence;
							const cNorm = d.confidence / 100;
							const outcome = d.correct === true ? 1 : 0;
							sumBrier += (cNorm - outcome) ** 2;
							sumBias += cNorm - outcome;
						}
					}

					// Question thinking traces
					const thinkingTraces = [d.thinking ?? d.note, d.readingThinking];
					for (const trace of thinkingTraces) {
						if (typeof trace === "string") {
							const trimmed = trace.trim();
							if (trimmed.length > 0) {
								thinkingSampleCount++;
								totalThinkingChars += trimmed.length;
								if (trimmed.length <= 80) {
									terseCount++;
								}
							}
						}
					}

					// Attachments in question answer
					if (
						Array.isArray(d.attachments) &&
						d.attachments.some((a) => (a as { mimeType?: string })?.mimeType === "application/pdf")
					) {
						pdfAttachmentCount++;
					}
				}
			} else if (m.role === "custom") {
				const customMsg = m as { customType?: string; details?: Record<string, unknown> };
				if (customMsg.customType === "practice-thinking") {
					const text = customMsg.details?.text;
					if (typeof text === "string") {
						const trimmed = text.trim();
						if (trimmed.length > 0) {
							thinkingSampleCount++;
							totalThinkingChars += trimmed.length;
							if (trimmed.length <= 80) {
								terseCount++;
							}
						}
					}
				}
			} else if (m.role === "user") {
				const userMsg = m as { attachments?: unknown[] };
				if (
					Array.isArray(userMsg.attachments) &&
					userMsg.attachments.some((a) => (a as { mimeType?: string })?.mimeType === "application/pdf")
				) {
					pdfAttachmentCount++;
				}
			}
		}

		if (sessionEligible) {
			eligibleSessions++;
		}
	}

	// Reviews
	let fsrsReviewCount = 0;
	let lapses = 0;
	for (const review of reviews) {
		if (Array.isArray(review.history)) {
			fsrsReviewCount += review.history.length;
			for (const item of review.history) {
				if (item?.rating === 1 || item?.rating === 2) {
					lapses++;
				}
			}
		}
	}

	const accuracyRate = gradedQuizCount > 0 ? Math.round((correctQuizCount / gradedQuizCount) * 10000) / 10000 : null;
	const meanConfidence = confidenceSampleCount > 0 ? Math.round((sumConfidence / confidenceSampleCount) * 100) / 100 : null;
	const brierScore = confidenceSampleCount > 0 ? Math.round((sumBrier / confidenceSampleCount) * 10000) / 10000 : null;
	const calibrationBias = confidenceSampleCount > 0 ? Math.round((sumBias / confidenceSampleCount) * 10000) / 10000 : null;
	const meanThinkingChars = thinkingSampleCount > 0 ? Math.round(totalThinkingChars / thinkingSampleCount) : 0;
	const terseThinkingRatio = thinkingSampleCount > 0 ? Math.round((terseCount / thinkingSampleCount) * 10000) / 10000 : null;
	const fsrsLapseRate = fsrsReviewCount > 0 ? Math.round((lapses / fsrsReviewCount) * 10000) / 10000 : null;

	return {
		totalSessions: chats.length,
		eligibleSessions,
		gradedQuizCount,
		correctQuizCount,
		accuracyRate,
		confidenceSampleCount,
		meanConfidence,
		brierScore,
		calibrationBias,
		thinkingSampleCount,
		meanThinkingChars,
		terseThinkingRatio,
		clarifyCount,
		dontKnowCount,
		strategyCount,
		transferCount,
		pdfAttachmentCount,
		fsrsReviewCount,
		fsrsLapseRate,
	};
}

/**
 * Checks whether the metacognitive profiler should automatically trigger.
 */
export function shouldAutoTriggerProfiler(
	metrics: MetacognitiveMetrics,
	state: ProfilerState,
	intervalSessions: number = DEFAULT_PROFILER_INTERVAL_SESSIONS,
): boolean {
	if (intervalSessions <= 0) return false;
	return metrics.eligibleSessions >= state.lastAnalyzedSessionCount + intervalSessions;
}

/**
 * Builds a deterministic, evidence-backed learner profile markdown fragment.
 */
export function buildDeterministicLearnerProfile(metrics: MetacognitiveMetrics): {
	proposedText: string;
	summary: string;
} {
	const bullets: string[] = [];

	// Bullet 1: Calibration & Scaffolding
	if (metrics.calibrationBias !== null && metrics.calibrationBias > 0.1) {
		bullets.push(
			"- **Calibration & Scaffolding**: Watch for overconfidence bias. Probe assumptions with counterexample challenges and require explicit edge-case verifications before proceeding.",
		);
	} else if (metrics.calibrationBias !== null && metrics.calibrationBias < -0.1) {
		bullets.push(
			"- **Calibration & Scaffolding**: Learner tends toward underconfidence. Actively validate sound first-principles deductions and reinforce grounded reasoning when correct.",
		);
	} else {
		bullets.push(
			"- **Calibration & Scaffolding**: Confidence alignment is well-calibrated. Maintain balanced scaffolding depth matched to demonstrated mastery.",
		);
	}

	// Bullet 2: Reasoning & Expression Style
	if ((metrics.terseThinkingRatio !== null && metrics.terseThinkingRatio >= 0.5) || metrics.pdfAttachmentCount > 0) {
		bullets.push(
			"- **Reasoning & Expression Style**: Welcome concise mathematical shorthand (e.g. `A is SPD -> eig > 0`) and handwritten derivations on attached PDFs without demanding verbose prose explanations.",
		);
	} else {
		bullets.push(
			"- **Reasoning & Expression Style**: Support step-by-step conceptual walkthroughs with clear definitions and structured worked examples.",
		);
	}

	// Bullet 3: Macro-Navigation & Spaced Retrieval
	if (metrics.fsrsLapseRate !== null && metrics.fsrsLapseRate > 0.3) {
		bullets.push(
			"- **Macro-Navigation & Spaced Retrieval**: Higher lapse rate observed; prioritize frequent spaced retrieval check-ins and decompose complex multi-step derivations into smaller milestones.",
		);
	} else if (metrics.strategyCount > 0 || metrics.transferCount > 0) {
		bullets.push(
			"- **Macro-Navigation & Spaced Retrieval**: Emphasize multi-step strategy decomposition and cross-domain transfer problems once foundational premises are established.",
		);
	} else {
		bullets.push(
			"- **Macro-Navigation & Spaced Retrieval**: Reinforce core concepts with periodic retrieval checks and progressive problem difficulty.",
		);
	}

	const proposedText = [
		"## Learner Profile & Studying Style",
		"",
		"Adapt explanations, step granularity, and problem framing to the learner's demonstrated reasoning habits:",
		...bullets,
	].join("\n");

	const summary = `Profile synthesized from ${metrics.eligibleSessions} learning session${metrics.eligibleSessions === 1 ? "" : "s"}.`;

	return { proposedText, summary };
}

export const PROFILER_SYSTEM_PROMPT = `You are an expert metacognitive learning profiler.
Your task is to analyze aggregated learning metrics across study sessions and synthesize a concise, evidence-grounded learner profile markdown section.
Maintain the exact markdown heading:
## Learner Profile & Studying Style

Follow these guidelines:
- Adapt explanations, step granularity, and problem framing to the learner's demonstrated reasoning habits.
- Respect concise mathematical shorthand (e.g. \`A is SPD -> eig > 0\`) and handwritten Quaderno PDF derivations when the learner works tersely.
- Calibrate scaffolding depth to the learner's observed confidence calibration and retrieval stability.`;

export function buildProfilerPrompt(metrics: MetacognitiveMetrics, currentText: string): string {
	return `Analyze the following metacognitive learning metrics from ${metrics.eligibleSessions} completed sessions:

Metrics:
${JSON.stringify(metrics, null, 2)}

Current Learner Profile:
${currentText || "(None configured yet)"}

Synthesize an updated learner profile under the heading "## Learner Profile & Studying Style" with 3-4 bullet points covering Calibration & Scaffolding, Reasoning & Expression Style, and Macro-Navigation & Spaced Retrieval.`;
}
