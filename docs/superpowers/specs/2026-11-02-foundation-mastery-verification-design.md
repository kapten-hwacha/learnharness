# Foundation Mastery Verification & Prerequisite Advisement — Design Specification

**Date:** 2026-11-02  
**Status:** Draft (Pending User Spec Review)  
**Topic:** Verifying genuine prerequisite digestion and advising learners to master missing foundations before advancing

---

## 1. Problem & Context

When a learner wants to learn an advanced topic that builds upon underlying prerequisites, four failure modes can undermine genuine mastery ("the click" — loose facts collapsing into a generative structure):

1. **Knowledge Graph Familiarity ≠ Live Digestion:** The prober currently treats propositions found in `list_propositions` from earlier sessions as "held solid" without requiring a cold verification question, and `search_propositions` does not surface FSRS review status (`stage`, `last practised Xd ago`, `due`). A concept learned weeks ago (or never practiced) may be decayed or unchunked in working memory today.
2. **Formula Recall Masquerading as Understanding:** Learners often pass a prerequisite check by recognizing textbook definitions, plugging into a memorized formula, or eliminating multiple-choice options without holding the underlying structural or geometric intuition.
3. **Lack of Structured Digestion State at Handoff:** `ProbeStrand` in `probe_done` (`src/core/contracts/probe.ts`) only carries free-form strings (`strand` and `assessment`), neither requiring the prober to explicitly classify whether each strand is genuinely digested (`"digested"`), held only as a rote formula (`"rote"`), or missing (`"gap"`), nor showing that status as a badge on `ProbeDoneCard`.
4. **Silent Over-Scoping on Deep Foundational Gaps:** When probing reveals that a deep prerequisite strand is missing or only held by rote, the prober concludes and hands off to the teacher without explicitly advising the learner of the prerequisite risk or offering to pivot the session's goal to mastering the foundation first.

---

## 2. Goals & User Experience

1. **Full Epistemic Visibility in Cross-Subject Graph Search:** `search_propositions` in `src/agent/tools/graph.ts` outputs the same FSRS review state (`stage`, `last practised Xd ago` / `never practised`, `due`) as `list_propositions`.
2. **Mandatory Cold-Checks on Every Prerequisite Strand:** Prior Knowledge Graph propositions calibrate where the prober enters a strand, but never exempt a prerequisite strand from at least one live verification question.
3. **Perturbation & Mechanism Verification + 1-Step Deeper Probing on Rote Answers:**
   - Probing and foundation checks test qualitative perturbation, invariance, or causal mechanism (*"What happens to Y if X changes, and why?"*) rather than textbook definition recognition or mechanical plug-and-chug.
   - When a learner answers correctly, the agent audits `confidence` and `thinking`. If the response relies on rote formula recall, option elimination, or low confidence, the prober asks one deeper follow-up question on the underlying mechanism ("why/mechanism check"). If intuition is still absent, the strand is classified as `"rote"`.
4. **Explicit Prerequisite Advisement Fork Before `probe_done`:**
   - When probing reveals that a critical underlying foundation is `"gap"` or `"rote"` (more than a 1–3 step local prerequisite), the prober explains *why* building the advanced topic on an unchunked foundation leads to fragile formula memorization, and calls `ask_user_question` with three options:
     1. **(Recommended) Pivot this session's goal to mastering the missing foundation first** (keeping the original target as the motivating horizon).
     2. **Expand this session's plan downward** to build and lock in the foundation from unconditional truths before climbing to the original goal.
     3. **Proceed directly to the original goal** with a minimal bridge.
5. **Structured `ProbeStrand` Status & UI Badges:**
   - Each `ProbeStrand` in `probeDoneInputSchema` carries `status?: "digested" | "rote" | "gap"`.
   - `ProbeDoneCard` renders a semantic badge for each strand (`Digested`, `Rote`, `Gap`).
6. **Teacher Plan & Check Alignment:**
   - The teacher prunes only `"digested"` strands, plans intuition-derivation nodes for `"rote"` strands before building on them, and builds `"gap"` strands from unconditional roots (or makes the foundation the primary session goal if the learner selected the pivot).
   - During teaching, foundation `check` questions test perturbation/causal mechanism and reinforce intuition whenever a correct answer relies on rote/hedged reasoning.

---

## 3. Architecture & Data Contracts

### 3.1 Probe Contracts (`src/core/contracts/probe.ts`, `src/core/contracts.ts`)

Add `ProbeStrandStatus` and extend `ProbeStrand` and `probeDoneInputSchema`:

```ts
export type ProbeStrandStatus = "digested" | "rote" | "gap";

export interface ProbeStrand {
	/** Name/description of the strand (e.g. "the derivative as a limit"). */
	strand: string;
	/** Classification of the learner's foundation state on this strand:
	 *  - "digested": verified structural/causal intuition; safe to build on.
	 *  - "rote": formula/rule recall without underlying intuition; needs intuition repair.
	 *  - "gap": missing or broken foundation; must be built from unconditional truths. */
	status?: ProbeStrandStatus;
	/** Free-form: where the learner's edge sits on this strand — floor,
	 *  ceiling, misconceptions found, what to build from. */
	assessment: string;
}
```

In `probeDoneInputSchema`:
```ts
status: Type.Optional(
	Type.Union(
		[
			Type.Literal("digested"),
			Type.Literal("rote"),
			Type.Literal("gap"),
		],
		{
			description:
				"Classification of his foundation on this strand: 'digested' (verified structural intuition, safe to build on), " +
				"'rote' (formula or rule recall without underlying causal intuition — needs intuition repair), or " +
				"'gap' (missing or broken foundation — must be built from unconditional truths). Always supply this for every strand.",
		},
	),
),
```

`status` is optional at the schema boundary so existing persisted transcripts without `status` continue to parse and render cleanly in `ProbeDoneCard`, while schema descriptions and prompt doctrine instruct the prober to supply `status` on every strand.

Re-export `ProbeStrandStatus` from `src/core/contracts.ts` and `src/core/index.ts`.

### 3.2 Graph Tool Review State Parity (`src/agent/tools/graph.ts`)

Extract a shared helper in `src/agent/tools/graph.ts` for formatting a proposition's FSRS review state:

```ts
function formatPropositionReviewSuffix(
	review: PropositionReviewState | undefined,
	now: number,
): string {
	if (!review?.lastReview) {
		return `${review?.stage ?? "practiced"} · never practised${review && review.dueAt <= now ? " · due" : ""}`;
	}
	const days = Math.max(0, Math.floor((now - review.lastReview) / 86_400_000));
	return `${review.stage} · last practised ${days}d ago${review.dueAt <= now ? " · due" : ""}`;
}
```

- **`list_propositions`** uses `formatPropositionReviewSuffix(state.get(p.nodeId), now)` to produce its existing format:
  `- ${p.name} · ${formatPropositionReviewSuffix(state.get(p.nodeId), now)}`
- **`search_propositions`** computes `now` and `state = reviewState(...)` identically to `list_propositions` and includes the review suffix in each candidate line:
  `${i + 1}. [${c.node.id}] "${c.node.name}": ${c.node.statement} (Current subject: "${subject}" · ${formatPropositionReviewSuffix(state.get(c.node.id), now)})`

---

## 4. UI Surface Updates

### 4.1 `ProbeDoneCard` (`components/artifacts/probe-done-card.tsx`)

When rendering each strand `s` in `ProbeDoneCard`:
- Display the strand title `s.strand` alongside a compact status badge when `s.status` is present:
  - `"digested"`: label `"Digested"`, emerald styling (`bg-emerald-500/15 text-emerald-600 dark:text-emerald-400`)
  - `"rote"`: label `"Rote"`, amber styling (`bg-amber-500/15 text-amber-600 dark:text-amber-400`)
  - `"gap"`: label `"Gap"`, rose styling (`bg-rose-500/15 text-rose-600 dark:text-rose-400`)
- If `s.status` is absent (legacy transcripts), render `s.strand` without a badge.

---

## 5. Agent Prompt Doctrines

### 5.1 Prober Doctrine (`src/agent/prompts/prober/10-probe-doctrine.md`)

1. **Section 1 ("Read his persistent map"):**
   - Replace *"a strand held solid needs no re-probing"* with the **Mandatory Cold-Check Rule**:
     - `list_sessions`, `list_propositions`, and `search_propositions` show what he has covered previously and its FSRS retention state (`practiced` / `demonstrated` / `retained`, `last practised Xd ago` / `never practised`, `due`).
     - Use the graph to calibrate *where* to enter a strand (high for fresh `retained`/`demonstrated` nodes, lower for `due` or `never practised` nodes), but **always cold-check every prerequisite strand with at least one probing question** regardless of its Knowledge Graph stage or due status. Familiarity in a prior session is never a substitute for live verification today.
2. **Section 4 ("Binary-search every strand — the quizzing tool"):**
   - **Test Digestion via Perturbation & Mechanism:** Design prerequisite probe questions to test qualitative perturbation, invariance, boundary conditions, or causal mechanism (*"What happens to Y if we scale/perturb/violate X, and why?"*) rather than definition recognition or mechanical plug-and-chug calculation.
   - **Audit `thinking` and `confidence` for Rote vs. Digested:**
     - **Digested (`status: "digested"`):** Correct + confident + causal/structural reasoning in `thinking` (or free-recall explanation).
     - **Rote / Formula-only (`status: "rote"`):** If he answers correctly, *but* his `thinking` relies on memorized syntax ("I remember the formula has a transpose here"), option elimination, or low confidence, **do not accept it as a solid floor yet**. Probe **1 step deeper** on the same foundation ("why/mechanism check") to test whether the structural intuition is actually there. If the follow-up misses or remains formula-bound, classify the strand as `"rote"` so the lesson repairs the intuition before building on it.
3. **Section 5 ("Prerequisite Advisement & Conclude — `probe_done`"):**
   - **Distinguish Local vs. Deep Foundational Gaps:**
     - If missing or rote prerequisites are small, local steps (1–3 reasoning steps), they can be absorbed directly at the bottom of the lesson plan.
     - If probing reveals that a **deep foundational strand** the target topic heavily depends on is `"gap"` or `"rote"`, **urge him to master the foundation first** before calling `probe_done`.
   - **The Prerequisite Advisement Fork (`ask_user_question`):**
     - Explain clearly *why* jumping directly into the target topic without this foundation chunked will force surface memorization instead of "the click."
     - Call `ask_user_question` with three options:
       1. `"(Recommended) Master [Foundation] first in this session (keeping [Original Goal] as the target horizon)"`
       2. `"Expand this session's plan downward to build [Foundation] from scratch before tackling [Original Goal]"`
       3. `"Proceed directly to [Original Goal] with a minimal bridge"`
   - **Concluding with `probe_done`:**
     - Every strand entry must include `status` (`"digested"`, `"rote"`, or `"gap"`) along with `strand` and `assessment`.
     - Record the agreed session goal (including any prerequisite pivot decision) in `summary`.

### 5.2 Teacher Planning Doctrine (`src/agent/prompts/teacher/10-planning.md`)

In Section 1 ("Planning — think hard here"):
- **Respect the Prober's Strand Statuses (`digested` / `rote` / `gap`):**
  - **`"digested"` strands:** Prune from teaching — build directly from them as held floors.
  - **`"rote"` strands:** Never treat a `"rote"` strand as a held floor. Include a dedicated intuition-repair node in `plan_init` that derives *why* the rule or formula must be true from unconditional truths before any node that depends on it.
  - **`"gap"` strands:** Build upward from unconditional truths at the roots of `plan_init`. If the learner chose to pivot the session goal to mastering a missing foundation first (recorded in `probe_done.assessment.summary`), make that foundation the sink goal of `plan_init` and plan a concise closing bridge at the end showing how it unlocks their original motivating topic.

### 5.3 Teacher Execution & Question Principles (`src/agent/prompts/teacher/20-teaching.md`, `src/agent/prompts/teacher/30-question-principles.md`)

- **`20-teaching.md`:**
  - When verifying a foundational or prerequisite node with `check`, audit `thinking` and `confidence` even when the verdict is `correct`. If the learner answered via rote formula substitution, elimination, or low confidence, do not advance to a dependent node yet — give a concise structural reinforcement and verify the causal intuition first.
- **`30-question-principles.md`:**
  - Add an explicit principle on **Perturbation & Mechanism over Formula Substitution**: checks on foundational and prerequisite nodes must test qualitative perturbation, invariance, or causal mechanism (*why* the relationship holds or how it behaves when an assumption shifts) so that surface formula memorization cannot pass masquerading as digestion.

---

## 6. Verification & Testing Plan

1. **Contract & Parser Unit Tests (`tests/tool-parts.test.ts`, `tests/probe-done.test.ts`):**
   - Verify `probeDoneInputSchema` and `parseProbeDoneInput` accept strands with `status: "digested" | "rote" | "gap"` as well as legacy strands omitting `status`.
   - Verify `probeDoneInputSchema` rejects invalid `status` values (e.g., `status: "unknown"`).
2. **UI Component Test (`tests/probe-done-card.test.tsx` or existing artifact tests):**
   - Verify `ProbeDoneCard` renders the `"Digested"`, `"Rote"`, and `"Gap"` badges when `status` is present on strands, and renders cleanly when `status` is omitted.
3. **Graph Tool Unit Tests (`tests/prober-regroup-tools.test.ts` / `tests/graph-tools.test.ts`):**
   - Verify `search_propositions` includes the FSRS review state (`practiced` / `demonstrated` / `retained`, `last practised Xd ago` / `never practised`, `due`) in its formatted output.
4. **Prompt Composition & Doctrine Tests (`tests/prompt-overrides.test.ts`):**
   - Verify all prompt segments compose cleanly and contain the updated prober and teacher foundation-verification doctrines.
5. **Typecheck & Lint:**
   - Run `npx tsc --noEmit` and `npm run lint` to confirm zero type or lint errors.
