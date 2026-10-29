import type { GraphChain, GraphNode, EpistemicStage, PracticeHistory, PracticeRecord, PropositionReviewState, ReviewNodeSummary, ReviewRating, ReviewRatingName } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";

const DAY = 86_400_000;
export const REVIEW_PICK_LIMIT = 64;
export function dueIncludedMessage(count: number): string | null {
	return count > REVIEW_PICK_LIMIT ? `${REVIEW_PICK_LIMIT} of ${count} due included` : null;
}
export function epistemicStageLabel(stage: EpistemicStage | undefined): string {
	return stage === "demonstrated" ? "Demonstrated" : stage === "retained" ? "Retained" : "Practiced";
}
export const FSRS_W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542] as const;
const FACTOR = 0.9 ** (-1 / FSRS_W[20]) - 1;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function fsrsRetrievability(stability: number, elapsedDays: number): number {
	return (1 + FACTOR * elapsedDays / stability) ** -FSRS_W[20];
}
export function fsrsInterval(stability: number, retention: number): number {
	return stability / FACTOR * (retention ** (-1 / FSRS_W[20]) - 1);
}
export function fsrsUpdate(previous: { stability: number; difficulty: number } | null, rating: ReviewRating | ReviewRatingName, elapsedDays = 0): { stability: number; difficulty: number } {
	const n: ReviewRating = typeof rating === "number" ? rating : ({ Again: 1, Hard: 2, Good: 3, Easy: 4 } as const)[rating];
	if (!previous) return { stability: FSRS_W[n - 1]!, difficulty: clamp(FSRS_W[4] - Math.exp(FSRS_W[5] * (n - 1)) + 1, 1, 10) };
	const { stability: s, difficulty: d } = previous;
	const r = fsrsRetrievability(s, elapsedDays);
	const nextDifficulty = clamp(FSRS_W[7] * (FSRS_W[4] - Math.exp(FSRS_W[5] * 3) + 1) + (1 - FSRS_W[7]) * (d + (10 - d) * (-FSRS_W[6] * (n - 3)) / 9), 1, 10);
	let nextStability: number;
	if (n === 1) nextStability = Math.min(FSRS_W[11] * d ** -FSRS_W[12] * ((s + 1) ** FSRS_W[13] - 1) * Math.exp((1 - r) * FSRS_W[14]), s / Math.exp(FSRS_W[17] * FSRS_W[18]));
	else {
		const hardPenalty = n === 2 ? FSRS_W[15] : 1;
		const easyBonus = n === 4 ? FSRS_W[16] : 1;
		nextStability = s * (1 + Math.exp(FSRS_W[8]) * (11 - d) * s ** -FSRS_W[9] * (Math.exp((1 - r) * FSRS_W[10]) - 1) * hardPenalty * easyBonus);
	}
	return { stability: Math.max(0.001, nextStability), difficulty: nextDifficulty };
}

function isRating(value: unknown): value is ReviewRating { return value === 1 || value === 2 || value === 3 || value === 4; }
function parseTimestamp(iso: string | undefined, fallback = 0): number {
	const parsed = Date.parse(iso ?? "");
	return Number.isFinite(parsed) ? parsed : fallback;
}
export function teachSessionSeedRating(messages: readonly LhMessage[]): ReviewRating {
	const ratings: ReviewRating[] = [];
	for (const message of messages) {
		if (message.role === "assistant") for (const block of message.content) {
			if (block.type === "toolCall" && (block.name === "explain" || block.name === "quiz") && isRating(block.arguments.priorRating)) ratings.push(block.arguments.priorRating);
		}
		if (message.role !== "toolResult" && !((message as { role: string; customType?: string }).role === "custom" && (message as { customType?: string }).customType === "lh_question_answered")) continue;
		const details = (message as { details?: unknown }).details as Partial<QuestionAnswerData> | undefined;
		if (!details || !(details.questionType === "check" || details.questionType === "transfer" || (details.kind === "quiz" && !details.questionType))) continue;
		if (typeof details.correct !== "boolean" && details.dontKnow !== true) continue;
		ratings.push(details.dontKnow || !details.correct ? 1 : (details.confidence ?? 50) < 70 ? 2 : (details.confidence ?? 50) >= 90 ? 4 : 3);
	}
	if (!ratings.length) return 3;
	return clamp(Math.round(ratings.reduce((sum, value) => sum + value, 0) / ratings.length), 1, 4) as ReviewRating;
}

export function reviewRating(record: PracticeRecord, target: string): ReviewRating | null {
	if (record.outcome === "dismissed") return null;
	if (record.missed) {
		if (record.missed.includes(target)) {
			if (record.outcome !== "movedOn" && record.outcome !== "surrendered" && (!record.rung || record.rung < "R3") && (record.missClass === "execution" || record.missClass === "careless")) return 2;
			return 1;
		}
		if (record.outcome === "movedOn" || record.outcome === "surrendered" || (record.rung && record.rung >= "R3")) return 3;
	}
	if (record.outcome === "movedOn" || record.outcome === "surrendered" || (record.rung && record.rung >= "R3")) return 1;
	if (record.missClass === "execution" || record.missClass === "careless") return 2;
	if (isRating(record.rating)) return record.rating;
	if (record.outcome === "solved" && record.rung === null) return 3;
	return 2;
}

export function practiceRecordsFromChat(chatId: string, messages: readonly LhMessage[]): PracticeRecord[] {
	const results = new Map<string, { isError?: boolean; timestamp?: number }>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const records: PracticeRecord[] = [];
	const events: Array<{ at: number; order: number; name: string; args: Record<string, unknown> }> = [];
	for (const message of messages) if (message.role === "assistant") for (let order = 0; order < message.content.length; order++) {
		const block = message.content[order]!;
		if (block.type === "toolCall" && (block.name === "problem" || block.name === "conclude") && results.get(block.id)?.isError === false) events.push({ at: message.timestamp, order, name: block.name, args: block.arguments as Record<string, unknown> });
	}
	events.sort((a, b) => a.at - b.at || a.order - b.order);
	let active: { targets: string[]; at: number } | null = null;
	for (const event of events) {
		if (event.name === "problem") {
			active = { targets: Array.isArray(event.args.target) ? event.args.target.filter((id): id is string => typeof id === "string") : [], at: event.at };
			continue;
		}
		if (!active) continue;
		const p = active, input = event.args;
		active = null;
		if (!p.targets.length || !["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed"].includes(String(input.outcome))) continue;
		const rung = input.rung === null || /^R[0-5]$/.test(String(input.rung)) ? input.rung as PracticeRecord["rung"] : null;
		const missClass = ["cue", "discrimination", "execution", "careless", "structural"].includes(String(input.missClass)) ? input.missClass as Exclude<PracticeRecord["missClass"], null> : null;
		records.push({ chatId, at: event.at ?? p.at, targets: p.targets, outcome: input.outcome as PracticeRecord["outcome"], rung, missClass, ...(Array.isArray(input.missed) ? { missed: input.missed.filter((id): id is string => typeof id === "string") } : {}), ...(isRating(input.rating) ? { rating: input.rating } : {}) });
	}
	return records;
}

export function reviewState(practiceRecords: PracticeHistory, graphNodes: readonly GraphNode[], now: number, retention = 0.9): Map<string, PropositionReviewState> {
	const state = new Map<string, PropositionReviewState>();
	const anchors = new Map<string, number>();
	const bornAtById = new Map<string, number>();
	for (const node of graphNodes) {
		const chatId = node.provenance[0]?.chatId ?? "";
		if (!practiceRecords.teachChatIds.has(chatId)) continue;
		const seedRating = practiceRecords.teachRatings?.get(chatId) ?? 3;
		const bornAt = parseTimestamp(node.createdAt, now);
		bornAtById.set(node.id, bornAt);
		state.set(node.id, { stability: null, difficulty: null, lastReview: null, reviews: 0, retrievability: null, dueAt: bornAt + FSRS_W[seedRating - 1]! * DAY, lane: "new", seedRating, stage: "practiced" });
		anchors.set(node.id, bornAt);
	}
	const seen = new Set<string>();
	for (const record of [...practiceRecords.records].sort((a, b) => a.at - b.at)) for (const id of record.targets) {
		const dedupeKey = `${record.chatId}\0${id}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		const current = state.get(id);
		if (!current) continue;
		const rating = reviewRating(record, id);
		if (rating === null) continue;
		const elapsed = current.lastReview === null ? Math.max(0, (record.at - (bornAtById.get(id) ?? record.at)) / DAY) : Math.max(0, (record.at - current.lastReview) / DAY);
		const updated = fsrsUpdate(current.stability === null || current.difficulty === null ? null : { stability: current.stability, difficulty: current.difficulty }, rating, elapsed);
		const priorStage = current.stage;
		let stage = current.stage;
		let anchor = anchors.get(id) ?? record.at;
		if (rating === 1) { stage = "practiced"; anchor = record.at; }
		else if (rating >= 3) {
			const since = record.at - anchor;
			if (since >= 7 * DAY && (priorStage === "demonstrated" || priorStage === "retained")) stage = "retained";
			else if (since >= DAY && priorStage === "practiced") { stage = "demonstrated"; anchor = record.at; }
		}
		anchors.set(id, anchor);
		const retrievability = fsrsRetrievability(updated.stability, Math.max(0, (now - record.at) / DAY));
		state.set(id, { ...current, ...updated, lastReview: record.at, reviews: current.reviews + 1, retrievability, dueAt: record.at + fsrsInterval(updated.stability, retention) * DAY, lane: "review", stage });
	}
	return state;
}

export function dueReviews(state: ReadonlyMap<string, PropositionReviewState>, nodes: readonly GraphNode[], chains: readonly GraphChain[], now: number): { due: string[]; nextDueAt: number | null } {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const serves = new Map<string, number>();
	for (const chain of chains) for (const premise of chain.premises) serves.set(premise, (serves.get(premise) ?? 0) + 1);
	const entries = [...state].filter(([, value]) => value.dueAt <= now);
	entries.sort(([aId, a], [bId, b]) => {
		if (a.lane !== b.lane) return a.lane === "review" ? -1 : 1;
		if (a.lane === "review" && a.retrievability !== b.retrievability) return (a.retrievability ?? 1) - (b.retrievability ?? 1);
		if (a.lane === "review" && serves.get(aId) !== serves.get(bId)) return (serves.get(bId) ?? 0) - (serves.get(aId) ?? 0);
		if (a.lane === "new") return parseTimestamp(byId.get(aId)?.createdAt) - parseTimestamp(byId.get(bId)?.createdAt) || aId.localeCompare(bId);
		return aId.localeCompare(bId);
	});
	let nextDueAt: number | null = null;
	for (const [, value] of state) if (value.dueAt > now && (nextDueAt === null || value.dueAt < nextDueAt)) nextDueAt = value.dueAt;
	return { due: entries.map(([id]) => id), nextDueAt };
}

export function reviewCalibration(records: readonly PracticeRecord[], nodes: readonly GraphNode[]): { brier: number | null; logLoss: number | null; n: number } {
	const predictions: number[] = [];
	const outcomes: number[] = [];
	const sorted = [...records].sort((a, b) => a.at - b.at);
	for (const node of nodes) {
		const id = node.id;
		let previous: { stability: number; difficulty: number } | null = null;
		let previousAt = Date.parse(node.createdAt);
		for (const record of sorted) {
			if (!record.targets.includes(id)) continue;
			const elapsed = Math.max(0, (record.at - previousAt) / DAY);
			if (previous) {
				const prediction = fsrsRetrievability(previous.stability, elapsed);
				const rating = reviewRating(record, id);
				if (rating !== null) { predictions.push(prediction); outcomes.push(rating === 1 ? 0 : 1); }
			}
		const rating = reviewRating(record, id);
			if (rating !== null) previous = fsrsUpdate(previous, rating, elapsed);
			previousAt = record.at;
		}
	}
	if (!predictions.length) return { brier: null, logLoss: null, n: 0 };
	let brier = 0, logLoss = 0;
	for (let i = 0; i < predictions.length; i++) {
		const p = predictions[i]!, y = outcomes[i]!;
		brier += (p - y) ** 2;
		logLoss -= y ? Math.log(Math.max(p, 1e-15)) : Math.log(Math.max(1 - p, 1e-15));
	}
	return { brier: brier / predictions.length, logLoss: logLoss / predictions.length, n: predictions.length };
}
