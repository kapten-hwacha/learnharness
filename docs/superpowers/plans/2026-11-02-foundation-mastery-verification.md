# Foundation Mastery Verification & Prerequisite Advisement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the prober and teacher agents to verify genuine prerequisite digestion, track structured strand readiness (`"digested" | "rote" | "gap"`) in `probe_done` and `ProbeDoneCard`, surface FSRS review status in cross-subject proposition searches, and explicitly urge learners to master missing foundations before advancing.

**Architecture:** `ProbeStrand` in `src/core/contracts/probe.ts` gains an optional `status?: "digested" | "rote" | "gap"` field shared by tool boundary validation and `ProbeDoneCard` rendering. `search_propositions` in `src/agent/tools/graph.ts` reuses `reviewState` to format FSRS stage, practice recency, and `due` status identically to `list_propositions`. Prober and teacher prompt segments in `src/agent/prompts/` codify mandatory cold-checks on prerequisite strands, perturbation/mechanism questions, 1-step deeper probing on rote answers, and the `ask_user_question` prerequisite advisement fork before `probe_done`.

**Tech Stack:** TypeScript, Node.js (`node:test`), React (`renderToStaticMarkup`), TypeBox.

**Spec:** `docs/superpowers/specs/2026-11-02-foundation-mastery-verification-design.md`

## Global Constraints

- `probeDoneInputSchema` in `src/core/contracts/probe.ts` is the single source of truth for both boundary validation (`src/agent/tools/probe.ts`) and UI parsing (`src/core/tool-parts.ts`).
- `status` on `ProbeStrand` must be `Type.Optional(Type.Union([Type.Literal("digested"), Type.Literal("rote"), Type.Literal("gap")]))` so legacy persisted transcripts without `status` still parse and render cleanly.
- Browser-safe modules under `src/core/` and `components/` must not import Node built-ins or `fs`.
- Every modified file must pass `npm run typecheck` (`npx tsc --noEmit`) and `npm run lint`.

## Review Focus

1. Legacy `probe_done` transcripts without `status` on strands: `parseProbeDoneInput` and `ProbeDoneCard` must still accept and render them without badges or crashes.
2. Invalid `status` values on `probe_done` (e.g., `status: "solid"`): `probeDoneInputSchema` boundary check and `parseProbeDoneInput` must reject them cleanly.
3. Imported-notes propositions in `search_propositions`: Notes sources are not teach chats (`reviewState` returns `undefined`), so `formatPropositionReviewSuffix` must fall back to `"practiced · never practised"` without throwing.
4. Practiced vs. never-practiced teach-chat propositions in `search_propositions`: Must accurately show `last practised Xd ago` when `lastReview` exists and `never practised` when `lastReview` is `null`, plus ` · due` when `dueAt <= now`.
5. Prompt override & composition invariants: Updated markdown fragments under `src/agent/prompts/` must preserve segment numbering and pass `tests/prompt-overrides.test.ts`.

---

### Task 1: `ProbeStrand` Status Contract, Schema & `ProbeDoneCard` Badges

**Files:**
- Modify: `src/core/contracts/probe.ts:20-78`
- Modify: `components/artifacts/probe-done-card.tsx:1-71`
- Test: `tests/tool-parts.test.ts`
- Test: `tests/render-cards.test.tsx`

**Interfaces:**
- Consumes: `Type`, `Static` from `"typebox"`; `parseProbeDoneInput` from `@/src/core`
- Produces:
  - `export type ProbeStrandStatus = "digested" | "rote" | "gap"` in `src/core/contracts/probe.ts` (re-exported via `src/core/contracts.ts` and `src/core/index.ts`)
  - `ProbeStrand.status?: ProbeStrandStatus` in `src/core/contracts/probe.ts`
  - Status badge rendering (`Digested`, `Rote`, `Gap`) in `ProbeDoneCard` (`components/artifacts/probe-done-card.tsx`)

- [ ] **Step 1: Write failing tests in `tests/tool-parts.test.ts` and `tests/render-cards.test.tsx`**

In `tests/tool-parts.test.ts` inside `describe("parseProbeDoneInput", ...)`:
```ts
	it("accepts strands with status ('digested' | 'rote' | 'gap') and rejects invalid status values", () => {
		const withStatus = {
			assessment: {
				strands: [
					{ strand: "eigenvalues", status: "digested", assessment: "Solid geometric intuition." },
					{ strand: "covariance matrix", status: "rote", assessment: "Recalls formula, shaky on geometry." },
					{ strand: "Gaussian conditioning", status: "gap", assessment: "Needs derivation from joint density." },
				],
				summary: "Master Gaussian conditioning first.",
			},
		};
		assert.ok(Value.Check(probeDoneInputSchema, withStatus));
		const parsed = parseProbeDoneInput(withStatus);
		assert.ok(parsed);
		assert.equal(parsed.assessment.strands[0]?.status, "digested");
		assert.equal(parsed.assessment.strands[1]?.status, "rote");
		assert.equal(parsed.assessment.strands[2]?.status, "gap");

		const invalidStatus = {
			assessment: {
				strands: [{ strand: "eigenvalues", status: "mastered", assessment: "Invalid enum." }],
			},
		};
		assert.equal(Value.Check(probeDoneInputSchema, invalidStatus), false);
		assert.equal(parseProbeDoneInput(invalidStatus), undefined);
	});
```

In `tests/render-cards.test.tsx` inside `describe("ProbeDoneCard", ...)`:
```ts
	it("renders Digested, Rote, and Gap status badges when status is present on strands", () => {
		const withBadges = {
			strands: [
				{ strand: "linear independence", status: "digested", assessment: "Solid geometric grasp." },
				{ strand: "characteristic polynomial", status: "rote", assessment: "Computes det(A - λI) mechanically." },
				{ strand: "spectral theorem", status: "gap", assessment: "Not yet encountered." },
			],
		};
		const html = renderToStaticMarkup(
			<ProbeDoneCard
				part={{ state: "output-available", input: { assessment: withBadges }, output: { ok: true } } as never}
			/>,
		);
		assert.match(html, /Digested/);
		assert.match(html, /Rote/);
		assert.match(html, /Gap/);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/tool-parts.test.ts tests/render-cards.test.tsx`
Expected: FAIL (`ProbeDoneCard` does not render `Digested` / `Rote` / `Gap` badges).

- [ ] **Step 3: Implement `ProbeStrandStatus` in `src/core/contracts/probe.ts` and badges in `components/artifacts/probe-done-card.tsx`**

In `src/core/contracts/probe.ts`:
- Define `export type ProbeStrandStatus = "digested" | "rote" | "gap";`
- Add `status?: ProbeStrandStatus;` to `ProbeStrand`.
- Add `status: Type.Optional(Type.Union([Type.Literal("digested"), Type.Literal("rote"), Type.Literal("gap")], { description: "Classification of his foundation on this strand: 'digested' (verified structural intuition, safe to build on), 'rote' (formula or rule recall without underlying causal intuition — needs intuition repair), or 'gap' (missing or broken foundation — must be built from unconditional truths). Always supply this for every strand." }))` to each strand item in `probeDoneInputSchema`.

In `components/artifacts/probe-done-card.tsx`:
- Add a helper mapping `ProbeStrandStatus` to label and badge class names:
  - `"digested"` → `{ label: "Digested", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" }`
  - `"rote"` → `{ label: "Rote", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" }`
  - `"gap"` → `{ label: "Gap", className: "bg-rose-500/15 text-rose-600 dark:text-rose-400" }`
- Render the badge beside `s.strand` when `s.status` is present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/tool-parts.test.ts tests/render-cards.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/probe.ts components/artifacts/probe-done-card.tsx tests/tool-parts.test.ts tests/render-cards.test.tsx
git commit -m "feat(probe): add structured strand digestion status to probe_done and ProbeDoneCard"
```

---

### Task 2: FSRS Review State in `search_propositions` (`src/agent/tools/graph.ts`)

**Files:**
- Modify: `src/agent/tools/graph.ts:60-161`
- Test: `tests/prober-regroup-tools.test.ts`

**Interfaces:**
- Consumes: `reviewState` from `../../core/review.ts`; `PropositionReviewState` from `../../core/contracts.ts`
- Produces:
  - `formatPropositionReviewSuffix(review: PropositionReviewState | undefined, now: number): string` in `src/agent/tools/graph.ts`
  - Updated `search_propositions` candidate line format:
    `${i + 1}. [${c.node.id}] "${c.node.name}": ${c.node.statement} (Current subject: "${subject}" · ${formatPropositionReviewSuffix(state.get(c.node.id), now)})`

- [ ] **Step 1: Write failing tests in `tests/prober-regroup-tools.test.ts`**

Update existing subject format assertions in `tests/prober-regroup-tools.test.ts` and add a dedicated test verifying FSRS review status (`stage`, `last practised Xd ago` / `never practised`, `due`) in `search_propositions`:
```ts
	it("includes FSRS review status (stage, practice recency, and due flag) in search_propositions output", async () => {
		const DAY = 86_400_000;
		const now = Date.parse("2026-11-10T00:00:00.000Z");
		const { chatStore, graphStore } = fakeStores(
			[
				node(
					"n_due",
					"Bayes Rule",
					"Posterior is proportional to likelihood times prior.",
					[pt("chat_prob")],
				),
				node(
					"n_retained",
					"Law of Total Probability",
					"Marginal probability is the sum of joint probabilities over a partition.",
					[pt("chat_prob")],
				),
			],
			{
				chats: [
					{ id: "chat_prob", title: "Probability", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" },
					{ id: "chat_kalman", title: "Kalman Filters", createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" },
				],
			},
		);

		const tools = proberGraphTools({
			chatStore,
			graphStore,
			chatId: "chat_kalman",
			now: () => now,
			history: () => ({
				teachChatIds: new Set(["chat_prob"]),
				teachRatings: new Map([["chat_prob", 3]]),
				records: [
					{
						chatId: "prac_1",
						at: now - 1 * DAY,
						targets: ["n_retained"],
						outcome: "solved",
						rung: null,
						missClass: null,
						rating: 4,
					},
				],
			}),
		});

		const res = (await tools.search_propositions!.execute!("tc_rev", { query: "probability prior" })).details as string;
		assert.match(res, /\[n_due\] "Bayes Rule".*\(Current subject: "Probability" · practiced · never practised · due\)/);
		assert.match(res, /\[n_retained\] "Law of Total Probability".*\(Current subject: "Probability" · demonstrated · last practised 1d ago\)/);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/prober-regroup-tools.test.ts`
Expected: FAIL (`search_propositions` currently outputs `(Current subject: "Probability")` without review state).

- [ ] **Step 3: Implement `formatPropositionReviewSuffix` and update `search_propositions` in `src/agent/tools/graph.ts`**

In `src/agent/tools/graph.ts`:
- Extract `formatPropositionReviewSuffix(review: PropositionReviewState | undefined, now: number): string` and use it in both `list_propositions` and `search_propositions`.
- In `search_propositions`, compute `const now = ctx.now?.() ?? Date.now();` and `const state = reviewState(ctx.history?.() ?? history(), nodes, now, ctx.settingsStore?.readSettings()?.agent?.desiredRetention ?? 0.9);`, then format each candidate line with `(Current subject: "${subject}" · ${formatPropositionReviewSuffix(state.get(c.node.id), now)})`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/prober-regroup-tools.test.ts tests/graph-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/graph.ts tests/prober-regroup-tools.test.ts
git commit -m "feat(graph): surface FSRS review status in search_propositions"
```

---

### Task 3: Prober & Teacher Foundation Verification Doctrines

**Files:**
- Modify: `src/agent/prompts/prober/10-probe-doctrine.md`
- Modify: `src/agent/prompts/teacher/10-planning.md`
- Modify: `src/agent/prompts/teacher/20-teaching.md`
- Modify: `src/agent/prompts/teacher/30-question-principles.md`
- Modify: `src/agent/tools/probe.ts:53-62`
- Test: `tests/prober-doctrine.test.ts`
- Test: `tests/prompt-overrides.test.ts`

**Interfaces:**
- Consumes: `composeInstructions` from `src/agent/teacher-agent.ts`
- Produces: Updated prober and teacher composed system instructions enforcing mandatory prerequisite cold-checks, qualitative perturbation/mechanism probing, 1-step deeper probing on rote answers, prerequisite advisement fork via `ask_user_question`, and strand-status-driven lesson planning.

- [ ] **Step 1: Write failing tests in `tests/prober-doctrine.test.ts`**

Add tests in `tests/prober-doctrine.test.ts` checking both `composeInstructions("prober")` and `composeInstructions("teacher")`:
```ts
	it("enforces mandatory cold-check on prerequisite strands, perturbation checks, 1-step deeper probing on rote answers, and prerequisite advisement fork in prober prompt", () => {
		const proberPrompt = composeInstructions("prober");

		assert.match(proberPrompt, /cold-check|at least one.*question/i, "must require cold-checking prerequisite strands even when present in graph");
		assert.match(proberPrompt, /perturbation|causal mechanism|invariance/i, "must require testing perturbation/mechanism over surface formula recall");
		assert.match(proberPrompt, /1 step deeper|one step deeper/i, "must require probing 1 step deeper when answer relies on rote formula memory");
		assert.match(proberPrompt, /"digested".*"rote".*"gap"/s, "must instruct prober to classify strands as digested, rote, or gap");
		assert.match(proberPrompt, /ask_user_question.*master.*foundation|pivot.*foundation/is, "must instruct prober to advise and offer a prerequisite pivot via ask_user_question before probe_done");
	});

	it("instructs teacher to plan from digested, rote, and gap strand statuses and verify perturbation/intuition on checks", () => {
		const teacherPrompt = composeInstructions("teacher");

		assert.match(teacherPrompt, /"digested"/, "teacher planning prompt must reference digested strands");
		assert.match(teacherPrompt, /"rote"/, "teacher planning prompt must reference intuition repair for rote strands");
		assert.match(teacherPrompt, /"gap"/, "teacher planning prompt must reference gap strands");
		assert.match(teacherPrompt, /perturbation|causal mechanism/i, "teacher question principles must require perturbation/causal checks on foundations");
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/prober-doctrine.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Update prompt fragments and `probe_done` tool description**

1. **`src/agent/prompts/prober/10-probe-doctrine.md`:**
   - In Section 1 ("Read his persistent map"): Replace *"a strand held solid needs no re-probing"* with the **Mandatory Cold-Check Rule**: `list_sessions`, `list_propositions`, and `search_propositions` reveal what he has seen before and its FSRS retention state (`practiced` / `demonstrated` / `retained`, `last practised Xd ago` / `never practised`, `due`) to calibrate opening question height, but **always cold-check every prerequisite strand with at least one probing question** regardless of its Knowledge Graph stage or due status.
   - In Section 4 ("Binary-search every strand — the quizzing tool"):
     - Add **Test digestion via perturbation & causal mechanism**: prerequisite questions must test qualitative perturbation, invariance, boundary behavior, or causal mechanism (*"What happens to Y if we scale/perturb/violate X, and why?"*) rather than definition recognition or plug-and-chug calculation.
     - Add **Audit `thinking` and `confidence` for rote vs. digested**: if he answers correctly, but his `thinking` relies on memorized formula syntax, option elimination, or low confidence, **probe 1 step deeper** on the same foundation ("why/mechanism check") to test if the structural intuition is actually there. If it isn't, classify the strand as `"rote"` so the lesson repairs the intuition before building on it.
   - In Section 5 ("Prerequisite advisement & Conclude — `probe_done`"):
     - When probing reveals that a **deep foundational strand** the target topic heavily depends on is `"gap"` or `"rote"` (more than a 1–3 step local prerequisite), explain clearly *why* jumping directly into the target topic without this foundation chunked forces surface memorization instead of "the click," and call `ask_user_question` before `probe_done` offering:
       1. `(Recommended) Master [Foundation] first in this session (keeping [Original Goal] as the target horizon)`
       2. `Expand this session's plan downward to build [Foundation] from scratch before tackling [Original Goal]`
       3. `Proceed directly to [Original Goal] with a minimal bridge`
     - Require every strand in `probe_done` to set `status` to `"digested"`, `"rote"`, or `"gap"`, and record the agreed goal/scope in `summary`.
2. **`src/agent/tools/probe.ts`:**
   - Mention `status` (`"digested" | "rote" | "gap"`) in the `probe_done` tool description.
3. **`src/agent/prompts/teacher/10-planning.md`:**
   - In Section 1 ("Planning — think hard here"): Specify how to plan from `probe_done` strand statuses:
     - `"digested"`: prune from teaching; build directly on them as held floors.
     - `"rote"`: never treat as a held floor; include an intuition-repair node deriving *why* the rule/formula works from unconditional truths before any dependent node.
     - `"gap"`: build upward from unconditional truths at the roots of `plan_init` (or if the learner chose the prerequisite pivot in `probe_done.assessment.summary`, make mastering that foundation the sink goal of `plan_init` with a concise closing bridge back to their original motivating target).
4. **`src/agent/prompts/teacher/20-teaching.md` & `src/agent/prompts/teacher/30-question-principles.md`:**
   - In `20-teaching.md`: When checking a foundational or prerequisite node, audit `thinking` and `confidence` even on a `correct` answer; if the learner relied on rote formula substitution or low-confidence guessing, reinforce the structural intuition before advancing to dependent nodes.
   - In `30-question-principles.md`: Require foundation and prerequisite checks to test qualitative perturbation, invariance, or causal mechanism so rote formula substitution cannot pass masquerading as digestion.

- [ ] **Step 4: Run tests, typecheck, and lint**

Run: `npx tsx --test tests/prober-doctrine.test.ts tests/prompt-overrides.test.ts`
Run: `npm run typecheck && npm run lint`
Expected: PASS with zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompts/prober/10-probe-doctrine.md src/agent/prompts/teacher/10-planning.md src/agent/prompts/teacher/20-teaching.md src/agent/prompts/teacher/30-question-principles.md src/agent/tools/probe.ts tests/prober-doctrine.test.ts
git commit -m "feat(prompts): add foundation mastery verification and prerequisite advisement doctrines"
```
