/**
 * Spaced-repetition (FSRS-6) & Delayed Epistemic Gate contracts.
 * Derived deterministically from persisted teaching + practice transcripts
 * and knowledge-graph nodes — no separate review ledger is stored.
 */

export type ReviewRating = 1 | 2 | 3 | 4;
export type ReviewRatingName = "Again" | "Hard" | "Good" | "Easy";
export type EpistemicStage = "practiced" | "demonstrated" | "retained";

export interface PracticeRecord {
  chatId: string;
  at: number;
  targets: string[];
  outcome: "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";
  rung: "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | null;
  missClass: "cue" | "discrimination" | "execution" | "careless" | "structural" | null;
  missed?: string[];
  rating?: ReviewRating;
}

export interface PracticeHistory {
  records: readonly PracticeRecord[];
  teachChatIds: ReadonlySet<string>;
  teachRatings?: ReadonlyMap<string, ReviewRating>;
}

export interface PropositionReviewState {
  stability: number | null;
  difficulty: number | null;
  lastReview: number | null;
  reviews: number;
  retrievability: number | null;
  dueAt: number;
  lane: "review" | "new";
  seedRating: ReviewRating;
  stage: EpistemicStage;
}

export interface ReviewNodeSummary {
  stage: EpistemicStage;
  retrievability: number | null;
  dueAt: number;
  lastReview: number | null;
  seedRating: ReviewRating;
}
