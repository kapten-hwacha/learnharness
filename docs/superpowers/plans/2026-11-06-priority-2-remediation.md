# Priority 2: Architectural Health & Maintainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `components/chat.tsx` by extracting high-cohesion sub-hooks into `components/chat-hooks/`, remove the phantom `readReviewLedger` cast in `src/server/profiler.ts`, and resolve the static `req("electron")` warning in `src/agent/subagents/headless.ts`.

**Architecture:**
1. Eliminate dead build warnings by replacing the phantom `readReviewLedger` cast in [src/server/profiler.ts](file:///Users/hwacha/work/personal/learnharness/src/server/profiler.ts) with direct `readPracticeHistory()` usage, and annotate the dynamic Electron helper in [src/agent/subagents/headless.ts](file:///Users/hwacha/work/personal/learnharness/src/agent/subagents/headless.ts) with `/*turbopackIgnore: true*/`.
2. Extract self-contained domains from [components/chat.tsx](file:///Users/hwacha/work/personal/learnharness/components/chat.tsx) into focused hooks in `components/chat-hooks/`:
   - `useChatTitleRename`: owns title draft state, input focus/blur, Esc/Enter keydown, and optimistic rename commit.
   - `useChatAbortDialog`: owns turn abort confirmation dialog state, keyboard dismiss, and abort callback triggers.
   - `useChatSoftCap`: owns teach-mode soft-cap state queries, refresh callbacks, and practice switch transitions.
3. Preserve 100% backwards compatibility for public `Chat` component props and re-exported test helpers.

**Tech Stack:** React 19, TypeScript 5.6, Next.js 16 (Turbopack), Vite 6, LinkeDOM test runner.

**Spec:** [code-quality-audit.md](file:///Users/hwacha/.gemini/antigravity/brain/776d76d3-dfd5-4041-8870-b394751f70c6/code-quality-audit.md) Section 6 (Priority 2: Architectural Health & Maintainability).

## Global Constraints
- Preserve exact import boundary architecture: `components/` only imports `@/src/core`.
- Maintain all existing named exports from [components/chat.tsx](file:///Users/hwacha/work/personal/learnharness/components/chat.tsx) that tests rely on (`shouldShowTeachSoftCapPill`, `TeachSoftCapPill`, `isSwitchToPracticeAnswer`, `escAbortTarget`, `clarifierPlacement`, etc.).
- Zero test regressions: all 3,439 tests must pass deterministically offline.
- No build warnings from `readReviewLedger` in Vite build or `Can't resolve 'electron'` in Turbopack build.

## Review Focus
1. **Chat Title Rename Atomicity:** Renaming via Enter or blur must commit the title; Esc must cancel back to the persisted title without unwanted side effects.
2. **Abort Dialog Layering:** Opening and canceling the abort confirmation dialog must preserve turn-in-flight states and integrate with existing `escAbortTarget`.
3. **Soft-Cap Pill Visibility:** Switching sessions or completing turns must accurately trigger soft-cap checks and maintain existing `shouldShowTeachSoftCapPill` assertions.
4. **Vite Build Cleanliness:** `npm run vite:build` must not log any missing export warnings for `readReviewLedger`.
5. **Turbopack Build Cleanliness:** `npm run build` must not warn about `Can't resolve 'electron'`.

---

### Task 1: Clean Phantom `readReviewLedger` and Headless Electron Stub

**Files:**
- Modify: [src/server/profiler.ts](file:///Users/hwacha/work/personal/learnharness/src/server/profiler.ts#L80-L99)
- Modify: [src/agent/subagents/headless.ts](file:///Users/hwacha/work/personal/learnharness/src/agent/subagents/headless.ts#L151-L160)
- Test: `tests/profiler.test.ts`

**Interfaces:**
- Consumes: `readPracticeHistory` from [src/server/review.ts](file:///Users/hwacha/work/personal/learnharness/src/server/review.ts)
- Produces: `readReviewLedger(): ReviewCard[]` in [src/server/profiler.ts](file:///Users/hwacha/work/personal/learnharness/src/server/profiler.ts) without unexported casts.

- [ ] **Step 1: Refactor `readReviewLedger` in `src/server/profiler.ts`**

In [src/server/profiler.ts](file:///Users/hwacha/work/personal/learnharness/src/server/profiler.ts), remove the unexported check and cast:
```ts
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
```

- [ ] **Step 2: Silence static electron require in `src/agent/subagents/headless.ts`**

In [src/agent/subagents/headless.ts](file:///Users/hwacha/work/personal/learnharness/src/agent/subagents/headless.ts), update `browserServiceBinary`:
```ts
export function browserServiceBinary(): string | null {
	if (proc.versions?.electron) return proc.execPath;
	try {
		const req = createRequire(import.meta.url);
		const p = req(/*turbopackIgnore: true*/ "electron") as unknown as string;
		return typeof p === "string" && p.length > 0 ? p : null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 3: Verify elimination of build warnings**

1. Run: `npm run vite:build`
   Expected: 0 warnings regarding `readReviewLedger`.
2. Run: `npm run build`
   Expected: 0 warnings regarding `Can't resolve 'electron'`.

- [ ] **Step 4: Commit cleanup**

```bash
git add src/server/profiler.ts src/agent/subagents/headless.ts
git commit -m "fix(build): clean phantom readReviewLedger cast and suppress static electron require warning"
```

---

### Task 2: Extract `useChatTitleRename` and `useChatAbortDialog` Hooks

**Files:**
- Create: `components/chat-hooks/use-chat-title-rename.ts`
- Create: `components/chat-hooks/use-chat-abort-dialog.ts`
- Modify: [components/chat.tsx](file:///Users/hwacha/work/personal/learnharness/components/chat.tsx)
- Create: `tests/chat-subhooks.test.tsx`

**Interfaces:**
- Consumes: React hooks (`useState`, `useRef`, `useCallback`, `useEffect`)
- Produces: `useChatTitleRename`, `useChatAbortDialog`

- [ ] **Step 1: Write test in `tests/chat-subhooks.test.tsx` for the sub-hooks**

```tsx
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderHook, act } from "./test-utils.ts"; // or LinkeDOM hook test wrapper
import { useChatTitleRename } from "../components/chat-hooks/use-chat-title-rename.ts";
import { useChatAbortDialog } from "../components/chat-hooks/use-chat-abort-dialog.ts";

describe("useChatTitleRename", () => {
	it("initializes with current title and commits rename on save", () => {
		let committed = "";
		const { result } = renderHook(() => useChatTitleRename({
			title: "Initial Title",
			onCommit: (newTitle) => { committed = newTitle; },
		}));
		assert.equal(result.current.titleText, "Initial Title");
		assert.equal(result.current.renaming, false);

		act(() => { result.current.startRename(); });
		assert.equal(result.current.renaming, true);
		assert.equal(result.current.titleDraft, "Initial Title");

		act(() => { result.current.setTitleDraft("Updated Title"); });
		act(() => { result.current.commitRename(); });
		assert.equal(committed, "Updated Title");
		assert.equal(result.current.renaming, false);
	});
});

describe("useChatAbortDialog", () => {
	it("manages abort request dialog state", () => {
		let aborted = false;
		const { result } = renderHook(() => useChatAbortDialog({
			onAbort: () => { aborted = true; },
		}));
		assert.equal(result.current.abortAsk, null);

		act(() => { result.current.requestAbort("turn-1"); });
		assert.equal(result.current.abortAsk, "turn-1");

		act(() => { result.current.confirmAbort(); });
		assert.equal(aborted, true);
		assert.equal(result.current.abortAsk, null);
	});
});
```

- [ ] **Step 2: Run test to verify failure before creation**

Run: `NODE_ENV=test npx tsx --test tests/chat-subhooks.test.tsx`
Expected: FAIL with module not found for `use-chat-title-rename.ts`.

- [ ] **Step 3: Implement `useChatTitleRename` and `useChatAbortDialog`**

Create `components/chat-hooks/use-chat-title-rename.ts`:
Extract title text, draft, renaming boolean, input auto-focus effect, Esc/Enter key handler, and rename commit logic.

Create `components/chat-hooks/use-chat-abort-dialog.ts`:
Extract `abortAsk`, `abortAskRef`, `requestAbort`, `confirmAbort`, and `cancelAbort`.

- [ ] **Step 4: Integrate into `components/chat.tsx`**

Import and invoke `useChatTitleRename` and `useChatAbortDialog` inside `Chat`, replacing lines 365-420 and 458-500.

- [ ] **Step 5: Run tests and typecheck**

1. Run: `NODE_ENV=test npx tsx --test tests/chat-subhooks.test.tsx tests/esc-layering.test.ts tests/client-chat-switch.test.tsx`
   Expected: PASS
2. Run: `npm run typecheck`
   Expected: 0 errors.

- [ ] **Step 6: Commit hook extraction**

```bash
git add components/chat-hooks/ components/chat.tsx tests/chat-subhooks.test.tsx
git commit -m "refactor(chat): extract useChatTitleRename and useChatAbortDialog into chat-hooks"
```

---

### Task 3: Extract `useChatSoftCap` Hook

**Files:**
- Create: `components/chat-hooks/use-chat-soft-cap.ts`
- Modify: [components/chat.tsx](file:///Users/hwacha/work/personal/learnharness/components/chat.tsx)
- Test: `tests/render-teach-soft-cap.test.tsx`

**Interfaces:**
- Consumes: `chatId`, `chatKind`, `turnInFlight`, `fetchSoftCap`
- Produces: `useChatSoftCap` returning `softCapData`, `fetchSoftCap`, `onSwitchToPractice`

- [ ] **Step 1: Implement `useChatSoftCap` in `components/chat-hooks/use-chat-soft-cap.ts`**

Extract `softCapData`, `fetchSoftCap`, the polling effect on turn settlement, and `onSwitchToPractice` into `useChatSoftCap`.

- [ ] **Step 2: Wire `useChatSoftCap` in `components/chat.tsx`**

Import `useChatSoftCap` in `components/chat.tsx`.
Ensure `shouldShowTeachSoftCapPill`, `TeachSoftCapPill`, and `isSwitchToPracticeAnswer` remain exported from `components/chat.tsx`.

- [ ] **Step 3: Run soft-cap tests**

Run: `NODE_ENV=test npx tsx --test tests/render-teach-soft-cap.test.tsx`
Expected: All tests pass.

- [ ] **Step 4: Commit hook extraction**

```bash
git add components/chat-hooks/use-chat-soft-cap.ts components/chat.tsx
git commit -m "refactor(chat): extract useChatSoftCap into chat-hooks"
```

---

### Task 4: Full Suite End-to-End Verification

**Files:** None

- [ ] **Step 1: Run TypeScript typecheck**
Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run ESLint**
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Run full offline test suite**
Run: `npm test`
Expected: All 3,440+ tests pass.

- [ ] **Step 4: Run Vite build**
Run: `npm run vite:build`
Expected: Exits 0 with 0 warnings for `readReviewLedger`.

- [ ] **Step 5: Run Next.js production build**
Run: `npm run build`
Expected: Exits 0 with 0 warnings for `Can't resolve 'electron'`.
