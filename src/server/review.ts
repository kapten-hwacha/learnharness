import { dueReviews, reviewState } from "../core/review.ts";
import type { FsrsCardRow, PracticeHistory, ReviewNodeSummary } from "../core/contracts.ts";
import { stores } from "./stores.ts";

export async function readPracticeHistory(): Promise<PracticeHistory> {
	return stores.graphStore.readPracticeHistory();
}

export async function readReview(now = Date.now()): Promise<{ due: string[]; nextDueAt: number | null; state: ReturnType<typeof reviewState>; stages: Record<string, ReviewNodeSummary> }> {
	const nodes = await stores.graphStore.readNodes();
	const chains = await stores.graphStore.readChains();
	const history = await readPracticeHistory();
	const settings = await stores.settingsStore.readSettings();
	const retention = settings?.agent?.desiredRetention ?? 0.9;
	const state = reviewState(history, nodes, now, retention);
	const cards: FsrsCardRow[] = Array.from(state.entries()).map(([nodeId, item]) => ({
		nodeId,
		stability: item.stability,
		difficulty: item.difficulty,
		lastReviewMs: item.lastReview,
		reviews: item.reviews,
		dueAtMs: item.dueAt,
		lane: item.lane,
		seedRating: item.seedRating,
		stage: item.stage,
	}));
	await stores.graphStore.syncFsrsCards(cards);
	const { due, nextDueAt } = dueReviews(state, nodes, chains, now);
	const stages: Record<string, ReviewNodeSummary> = {};
	for (const [id, item] of state) stages[id] = { stage: item.stage, retrievability: item.retrievability, dueAt: item.dueAt, lastReview: item.lastReview, seedRating: item.seedRating };
	return { due, nextDueAt, state, stages };
}
