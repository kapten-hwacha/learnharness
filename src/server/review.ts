import { dueReviews, practiceRecordsFromChat, reviewState, teachSessionSeedRating } from "../core/review.ts";
import type { PracticeHistory, ReviewNodeSummary } from "../core/contracts.ts";
import { stores } from "./stores.ts";

export function readPracticeHistory(): PracticeHistory {
	const records = [] as ReturnType<typeof practiceRecordsFromChat>[number][];
	const teachChatIds = new Set<string>();
	const teachRatings = new Map<string, ReturnType<typeof teachSessionSeedRating>>();
	for (const summary of stores.chatStore.listChats()) {
		const chat = stores.chatStore.getChat(summary.id);
		if (!chat) continue;
		if (chat.kind !== "practice") {
			teachChatIds.add(summary.id);
			teachRatings.set(summary.id, teachSessionSeedRating(chat.messages));
		} else records.push(...practiceRecordsFromChat(summary.id, chat.messages));
	}
	return { records, teachChatIds, teachRatings };
}

export function readReview(now = Date.now()): { due: string[]; nextDueAt: number | null; state: ReturnType<typeof reviewState>; stages: Record<string, ReviewNodeSummary> } {
	const nodes = stores.graphStore.readNodes();
	const chains = stores.graphStore.readChains();
	const history = readPracticeHistory();
	const retention = stores.settingsStore.readSettings()?.agent?.desiredRetention ?? 0.9;
	const state = reviewState(history, nodes, now, retention);
	const { due, nextDueAt } = dueReviews(state, nodes, chains, now);
	const stages: Record<string, ReviewNodeSummary> = {};
	for (const [id, item] of state) stages[id] = { stage: item.stage, retrievability: item.retrievability, dueAt: item.dueAt, lastReview: item.lastReview, seedRating: item.seedRating };
	return { due, nextDueAt, state, stages };
}
